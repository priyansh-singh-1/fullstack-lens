import { EndpointMatcher } from '../matching/EndPointMatcher';
import { WebSocketMatcher } from '../matching/WebSocketMatcher';
import { WorkspaceIndexer } from '../workspace/WorkspaceIndexer';
import { SpringEndpointScanner } from '../parsing/spring/SpringEndpointScanner';
import { SpringWebSocketScanner } from '../parsing/spring/SpringWebSocketScanner';
import { FrontendApiScanner } from '../parsing/frontend/FrontendApiScanner';
import { FrontendWebSocketScanner } from '../parsing/frontend/FrontendWebSocketScanner';
import { AnalysisResult } from './AnalysisResult';
import { RestDiagnosticAnalyzer } from './RestDiagnosticAnalyzer';



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
            let result: AnalysisResult;
            try {
                result = await this.analyzeWorkspace(revision);
            } catch (error) {
                if (this.isCurrentRevision(revision)) {
                    throw error;
                }
                // An obsolete scan can fail while files are changing as well.
                continue;
            }
            if (this.isCurrentRevision(revision)) {
                this.cachedResult = result;
                return result;
            }
            // Finish obsolete work before retrying; never run parallel scans.
        }
    }

    public isCurrentRevision(revision: number): boolean {
        return revision === this.revision;
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

        // 2. Scan REST
        const restEndpoints =
            this.springScanner.scan(files);

        const restCalls =
            this.frontendScanner.scan(files);


        console.log(`[FSL] REST scanning: ${Math.round(performance.now() - stageStart)} ms`);
        stageStart = performance.now();

        // 3. Scan WebSocket
        const websocketEndpoints =
            this.springwebsocketScanner.scan(files);

        const websocketCalls =
            this.frontendWebSocketScanner.scan(files);

        


        console.log(`[FSL] WebSocket scanning: ${Math.round(performance.now() - stageStart)} ms`);
        stageStart = performance.now();

        const restUsages: AnalysisResult['restUsages'] = new Map();
        const websocketUsages: AnalysisResult['websocketUsages'] = new Map();
        const restMatches = new EndpointMatcher().match(restCalls, restEndpoints, restUsages);
        const websocketMatches = new WebSocketMatcher().match(
            websocketCalls, websocketEndpoints, websocketUsages
        );

        const diagnostics = this.restDiagnosticAnalyzer.analyze(restMatches,restEndpoints);
        console.log(`[FSL] Matching: ${Math.round(performance.now() - stageStart)} ms`);

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

        console.log(`[FSL] Total analysis: ${Math.round(performance.now() - start)} ms`);
        return result;
    }

     public clearCache(): void {
        this.revision++;
        this.cachedResult = undefined;
    } 


}
