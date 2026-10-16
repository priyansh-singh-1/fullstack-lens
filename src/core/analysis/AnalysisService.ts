import { promises as fs } from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { EndpointMatcher } from '../matching/EndPointMatcher';
import { WebSocketMatcher } from '../matching/WebSocketMatcher';
import { WorkspaceIndexer } from '../workspace/WorkspaceIndexer';
import { SpringEndpointScanner } from '../parsing/spring/SpringEndpointScanner';
import { SpringWebSocketScanner } from '../parsing/spring/SpringWebSocketScanner';
import { FrontendApiScanner } from '../parsing/frontend/FrontendApiScanner';
import { FrontendWebSocketScanner } from '../parsing/frontend/FrontendWebSocketScanner';
import { AnalysisResult } from './AnalysisResult';
import { RestDiagnosticAnalyzer } from './RestDiagnosticAnalyzer';
import { ProjectFile } from '../models/ProjectFile';
import { FileAnalysis } from './FileAnalysis';

interface AnalysisState {
    result: AnalysisResult;
    files: Map<string, FileAnalysis>;
}


export class AnalysisService{
    private indexer= new WorkspaceIndexer();

    private springScanner = new SpringEndpointScanner();

    private frontendScanner = new FrontendApiScanner();

    private frontendWebSocketScanner = new FrontendWebSocketScanner();

    private springwebsocketScanner= new SpringWebSocketScanner();

    private restDiagnosticAnalyzer = new RestDiagnosticAnalyzer();

    private cachedResult: AnalysisResult | undefined;

    private pendingAnalysis: Promise<AnalysisResult> | undefined;
    private revision = 0;
    private committedState: AnalysisState | undefined;
    private candidateState: AnalysisState | undefined;
    // Retain dirty paths until a current transaction commits, including across retries.
    private dirtyFiles = new Set<string>();
    private fullRebuildRequired = true;

    public async getAnalysis(
        forceRefresh: boolean = false
    ): Promise<AnalysisResult>{

        console.log(
            '[FSL] Cache available:',this.cachedResult !== undefined
        );
        
        if (forceRefresh) {
            this.clearCache();
        }

        for (;;) {
            if (this.cachedResult) {
                return this.cachedResult;
            }
            if (!this.pendingAnalysis) {
                this.pendingAnalysis = this.analyzeLatest().finally(() => {
                    this.pendingAnalysis = undefined;
                });
            }
            const result = await this.pendingAnalysis;
            // A save can occur between publication and this await resuming.
            if (this.isCurrentRevision(result.revision)) {
                return result;
            }
        }
    }

    private async analyzeLatest(): Promise<AnalysisResult> {
        for (;;) {
            const revision = this.revision;
            this.candidateState = undefined;
            let result: AnalysisResult;
            try {
                let incremental: AnalysisResult | undefined;
                if (!this.fullRebuildRequired && this.committedState) {
                    try {
                        incremental = await this.analyzeChangedFiles(revision);
                    } catch (error) {
                        if (!this.isCurrentRevision(revision)) { continue; }
                        // One full attempt repairs read/scan failures or invalid state.
                        console.log('[FSL] Incremental analysis failed; rebuilding:', error);
                    }
                    if (!this.isCurrentRevision(revision)) { continue; }
                }
                if (incremental) {
                    result = incremental;
                } else {
                    this.fullRebuildRequired = true;
                    result = await this.analyzeWorkspace(revision);
                }
            } catch (error) {
                if (this.isCurrentRevision(revision)) {
                    throw error;
                }
                // An obsolete scan can fail while files are changing as well.
                continue;
            }
            if (this.isCurrentRevision(revision)) {
                this.commitResult(result);
                return result;
            }
            // Finish obsolete work before retrying; never run parallel scans.
        }
    }

    public isCurrentRevision(revision: number): boolean {
        return revision === this.revision;
    }

    private commitResult(result: AnalysisResult): void {
        // Candidate entries and the public result become committed together.
        this.committedState = this.candidateState?.result === result ? this.candidateState : undefined;
        this.candidateState = undefined;
        this.cachedResult = result;
        this.dirtyFiles.clear();
        this.fullRebuildRequired = false;
    }

    private fileKey(filePath: string): string {
        const normalized = path.resolve(filePath);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    /** Invalidate immediately; loading remains demand-driven and shared by callers. */
    public enqueueFileChange(filePath: string): void {
        this.revision++;
        this.cachedResult = undefined;
        this.dirtyFiles.add(this.fileKey(filePath));
    }

    private async readSource(file: ProjectFile): Promise<string> {
        return fs.readFile(file.path, 'utf-8');
    }

    private async analyzeFiles(files: ProjectFile[]): Promise<FileAnalysis[]> {
        // Sources live only for this build. Sequential reads bound open file handles
        // and preserve the indexer's order without sorting or grouping the files.
        const sources: { file: ProjectFile; source: string }[] = [];
        for (const file of files) {
            sources.push({ file, source: await this.readSource(file) });
        }

        const extracted = sources.map(({ file, source }) => ({
            file, source,
            axiosInstances: this.frontendScanner.discoverAxiosInstances(file, source),
            applicationPrefix: this.springwebsocketScanner.discoverApplicationPrefix(file, source)
        }));
        const axiosInstances = extracted.flatMap(entry => entry.axiosInstances);
        const applicationPrefix = extracted.find(entry => entry.applicationPrefix !== undefined)?.applicationPrefix ?? '';

        // Every scanner guards its supported languages. Empty entries are intentional.
        return extracted.map(({ file, source, axiosInstances: definitions, applicationPrefix: prefix }) => ({
            file,
            restEndpoints: this.springScanner.scanFile(file, source),
            restCalls: this.frontendScanner.scanFile(file, source, axiosInstances),
            websocketEndpoints: this.springwebsocketScanner.scanFile(file, source, applicationPrefix),
            websocketCalls: this.frontendWebSocketScanner.scanFile(file, source),
            axiosInstances: definitions,
            applicationPrefix: prefix
        }));
    }

    private async analyzeChangedFiles(revision: number): Promise<AnalysisResult | undefined> {
        const committed = this.committedState;
        if (!committed || this.dirtyFiles.size === 0) { return undefined; }
        const entries = Array.from(committed.files.values());
        if (entries.length !== committed.result.files.length || entries.some((entry, index) =>
            entry.file !== committed.result.files[index]
        )) { return undefined; }

        const candidate = new Map(committed.files);
        const axiosInstances = entries.flatMap(entry => entry.axiosInstances);
        const applicationPrefix = entries.find(entry => entry.applicationPrefix !== undefined)?.applicationPrefix ?? '';
        for (const key of Array.from(this.dirtyFiles)) {
            const previous = candidate.get(key);
            if (!previous) { return undefined; } // Unindexed saves use full discovery.
            const file = previous.file;
            const source = await this.readSource(file);
            if (!this.isCurrentRevision(revision)) { return undefined; }
            const definitions = this.frontendScanner.discoverAxiosInstances(file, source);
            const prefix = this.springwebsocketScanner.discoverApplicationPrefix(file, source);
            // Any definition or prefix-candidate change conservatively rebuilds context.
            if (!isDeepStrictEqual(definitions, previous.axiosInstances) || prefix !== previous.applicationPrefix) {
                return undefined;
            }
            candidate.set(key, {
                file,
                restEndpoints: this.springScanner.scanFile(file, source),
                restCalls: this.frontendScanner.scanFile(file, source, axiosInstances),
                websocketEndpoints: this.springwebsocketScanner.scanFile(file, source, applicationPrefix),
                websocketCalls: this.frontendWebSocketScanner.scanFile(file, source),
                axiosInstances: definitions,
                applicationPrefix: prefix
            });
        }
        return this.deriveResult(Array.from(candidate.values()), revision);
    }

    private async analyzeWorkspace(revision: number): Promise<AnalysisResult> {
        const start = performance.now();
        let stageStart = start;
        console.log('[FSL] Starting full workspace scan');

        // 1. Index workspace
        const files =
            await this.indexer.indexWorkspace();


        console.log(`[FSL] Indexing: ${Math.round(performance.now() - stageStart)} ms`);
        stageStart = performance.now();

        // 2. Read once, resolve workspace context, and build file-local entries.
        // Keep this state local until the existing revision guard publishes the result.
        const fileAnalyses = await this.analyzeFiles(files);
        console.log(`[FSL] Source loading and scanning: ${Math.round(performance.now() - stageStart)} ms`);
        const result = this.deriveResult(fileAnalyses, revision);
        console.log(`[FSL] Total analysis: ${Math.round(performance.now() - start)} ms`);
        return result;
    }

    private deriveResult(fileAnalyses: FileAnalysis[], revision: number): AnalysisResult {
        const files = fileAnalyses.map(entry => entry.file);
        const restEndpoints = fileAnalyses.flatMap(file => file.restEndpoints);
        const restCalls = fileAnalyses.flatMap(file => file.restCalls);
        const websocketEndpoints = fileAnalyses.flatMap(file => file.websocketEndpoints);
        const websocketCalls = fileAnalyses.flatMap(file => file.websocketCalls);

        const restUsages: AnalysisResult['restUsages'] = new Map();
        const websocketUsages: AnalysisResult['websocketUsages'] = new Map();
        const restMatches = new EndpointMatcher().match(restCalls, restEndpoints, restUsages);
        const websocketMatches = new WebSocketMatcher().match(
            websocketCalls, websocketEndpoints, websocketUsages
        );

        const diagnostics = this.restDiagnosticAnalyzer.analyze(restMatches,restEndpoints);

        //4. Create analysis snapshot
        const result: AnalysisResult = {
            revision,
            files,
            restEndpoints,
            restCalls,
            restMatches,
            restUsages,
            websocketEndpoints,
            websocketCalls,
            websocketMatches,
            websocketUsages,
            
            diagnostics
        };

        const entries = new Map(fileAnalyses.map(entry => [this.fileKey(entry.file.path), entry]));
        // Duplicate identities cannot safely be represented by the incremental map.
        this.candidateState = entries.size === fileAnalyses.length ? { result, files: entries } : undefined;
        return result;
    }

     public clearCache(): void {
        this.revision++;
        this.cachedResult = undefined;
        this.fullRebuildRequired = true;
    } 


}
