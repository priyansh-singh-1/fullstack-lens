import * as vscode from 'vscode';
import * as path from 'path';
import { MatchResult } from './core/models/MatchResult';

import { FullStackCodeLensProvider } from './core/codelens/FullStackCodeLensProvider';

import { AnalysisService } from './core/analysis/AnalysisService';
import { registerAnalysisSaveRefresh } from './core/analysis/registerAnalysisSaveRefresh';
import { FullStackDiagnosticManager } from './core/diagnostics/FullStackDiagnosticManager';
import { METHODS } from 'http';






interface NavigationTarget {
    type: 'rest' | 'websocket';
    filePath: string;
    line: number;
    revision?: number;
    method?: string;
    path?: string;
}

interface BackendNavigationTarget {
    type: 'rest'| 'websocket';
    filePath: string,
    line: number;
    revision?: number;
}

function sameFilePath(
    path1: string,
    path2: string
): boolean {
    return path1.toLowerCase() === path2.toLowerCase();
}

function isStaleTarget(target: NavigationTarget | undefined, revision: number): boolean {
    if (target && (typeof target.filePath !== 'string' || !target.filePath ||
        !Number.isInteger(target.line) || target.line < 0 ||
        (target.type !== 'rest' && target.type !== 'websocket'))) {
        vscode.window.showWarningMessage('The CodeLens navigation target is unavailable.');
        return true;
    }
    if (!analysisService.isCurrentRevision(revision) ||
        (target?.revision !== undefined && target.revision !== revision)) {
        vscode.window.showWarningMessage('This CodeLens is out of date. Wait for it to refresh and try again.');
        return true;
    }
    return false;
}

// ==========================================
// SHARED SERVICES
// ==========================================

const analysisService = new AnalysisService();

// Navigation commands reuse the cached snapshot; Scan Workspace forces refresh.
// AnalysisService shares concurrent analysis requests with CodeLens.

// Activation publishes initial diagnostics from the shared analysis snapshot.


// ==========================================
// EXTENSION ACTIVATION
// ==========================================

export async function activate(context: vscode.ExtensionContext) {

    console.log('FullStack Lens is active');
    const codeLensProvider = new FullStackCodeLensProvider(analysisService);

    const diagnosticManager = new FullStackDiagnosticManager();

    context.subscriptions.push(diagnosticManager);

    const outputChannel =
        vscode.window.createOutputChannel('FullStack Lens');

    

    const scanWorkspaceCommand =
        vscode.commands.registerCommand(
            'fullstack-lens.scanWorkspace',
            async () => {
                await scanWorkspace(outputChannel, diagnosticManager);
                codeLensProvider.refresh();
            }
        );

    const goToBackendCommand =
        vscode.commands.registerCommand(
            'fullstack-lens.goToBackend',

            async(target?: NavigationTarget)=>{
                const editor = vscode.window.activeTextEditor;

                if(!editor){
                    vscode.window.showWarningMessage(
                        'No active editor found.'
                    );
                    return;
                }

                const currentFile = target?.filePath ??
                editor.document.uri.fsPath;

                const currentLine= target?.line??
                editor.selection.active.line;

                const analysis = await analysisService.getAnalysis();
                if (isStaleTarget(target, analysis.revision)) {
                    return;
                }

                console.log('TARGET:', target);
                console.log('CURRENT FILE:', currentFile);
                console.log('CURRENT LINE:', currentLine);

                // ==================================
                // REST
                // ==================================4

                if(!target || target.type==='rest'){
                    const frontendCall = analysis.restCalls;
                    const matches = analysis.restMatches;

                    const currentCall= frontendCall.find(
                        call =>
                            sameFilePath(call.filePath, currentFile) &&
                        call.line===currentLine
                        && (target?.method === undefined || target.method === call.method)
                        && (target?.path === undefined || target.path === call.path)
                        
                    );

                    console.log('CURRENT CALL:', currentCall);

                    if(currentCall){
                        const result= matches.find(
                            match =>
                                match.call === currentCall
                        );

                        if(result?.matched){
                            await navigateRestMatch(result, analysis.revision);
                            return;
                        }
                    }
                }

                const frontendCall = analysis.restCalls;
                console.log('REST CALLS:',
                    frontendCall.map(call => ({
                    path: call.path,
                    filePath: call.filePath,
                    line: call.line
                }))
            );

                // ==================================
                // WEBSOCKET
                // ==================================

                if(!target || target.type==='websocket'){

                    const webSocketCalls = analysis.websocketCalls;
                    const websocketMatches = analysis.websocketMatches;

                    const currentWebSocketCall= webSocketCalls.find(
                        call =>
                            sameFilePath(call.filePath, currentFile) &&
                        call.line === currentLine &&
                        call.type==='publish'
                    );

                    if(currentWebSocketCall){
                        const result= websocketMatches.find(
                            match =>
                                match.call === currentWebSocketCall
                        );

                        if(result?.endpoint){
                            await openAndHighlight(
                                result.endpoint.filePath,
                                result.endpoint.line,
                                analysis.revision
                            );

                            return;
                        }
                    }
                }
                vscode.window.showWarningMessage(
                 'No matching REST or WebSocket backend endpoint found.'
            );

            }
            
        );


    const findFrontendUsagesCommand =
        vscode.commands.registerCommand(
            'fullstack-lens.findFrontendUsages',
             
            findFrontendUsages
        );

    const selectBackendEndpointCommand = vscode.commands.registerCommand(
        'fullstack-lens.selectBackendEndpoint',
        async (target?: NavigationTarget) => {
            if (!target || target.type !== 'rest' || !Number.isInteger(target.revision) ||
                typeof target.method !== 'string' || typeof target.path !== 'string') {
                vscode.window.showWarningMessage('The CodeLens navigation target is unavailable.');
                return;
            }
            const analysis = await analysisService.getAnalysis();
            if (isStaleTarget(target, analysis.revision)) { return; }
            const result = analysis.restMatches.find(match =>
                sameFilePath(match.call.filePath, target.filePath) && match.call.line === target.line &&
                match.call.method === target.method && match.call.path === target.path
            );
            if (!result?.matched) {
                vscode.window.showWarningMessage('No matching REST backend endpoint found. Refresh CodeLens and try again.');
                return;
            }
            await navigateRestMatch(result, analysis.revision);
        }
    );

    const showUnresolvedRouteInfoCommand = 
            vscode.commands.registerCommand(
                'fullstack-lens.showUnresolvedRouteInfo',
                (target?:{
                    method?: string;
                    path?: string;
                }) =>{
                    const method = target?.method??  'UNKNOWN';
                    const path = target?.path?? '';

                    vscode.window.showInformationMessage(
                         `FullStack Lens could not fully resolve this frontend route: ${method} ${path}`
                    );
                }
            );

    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        [
            {scheme: 'file',language: 'javascript'},
            {scheme: 'file',language: 'javascriptreact'},
            {scheme: 'file',language: 'typescript'},
            {scheme: 'file',language: 'typescriptreact'},
            {scheme: 'file', language:'java'}
        ],
        codeLensProvider
    );
    const refreshDiagnostics = async () => {
        const analysis = await analysisService.getAnalysis();
        diagnosticManager.update(analysis.diagnostics);
    };

    context.subscriptions.push(
        outputChannel,
        scanWorkspaceCommand,
        goToBackendCommand,
        selectBackendEndpointCommand,
        findFrontendUsagesCommand,
        codeLensDisposable,
        codeLensProvider,
        showUnresolvedRouteInfoCommand,
        registerAnalysisSaveRefresh(analysisService, codeLensProvider)
    );

    await refreshDiagnostics();

    // Expose the same shared instances for extension integration tests/consumers.
    return { analysisService, codeLensProvider };
}


// ==========================================
// SCAN WORKSPACE
// ==========================================

async function scanWorkspace(
    outputChannel: vscode.OutputChannel,
    diagnosticManager: FullStackDiagnosticManager
): Promise<void> {

    const analysis = await analysisService.getAnalysis(true);
    diagnosticManager.update(analysis.diagnostics);

    const {
        files,
        restEndpoints: endpoints,
        restCalls: frontendCalls,
        restMatches: matches,
        websocketEndpoints,
        websocketCalls,
        websocketMatches
    } = analysis;

    outputChannel.clear();

    printIndexedFiles(outputChannel, files);

    printRestEndpoints(
        outputChannel,
        endpoints
    );

    printFrontendApiCalls(
        outputChannel,
        frontendCalls
    );

    printEndpointMatches(
        outputChannel,
        matches
    );

    printWebSocketEndpoints(
        outputChannel,
        websocketEndpoints
    );

    printFrontendWebSocketCalls(
        outputChannel,
        websocketCalls
    );

    printWebSocketMatches(
        outputChannel,
        websocketMatches
    );

    outputChannel.show();

    showScanSummary(files);
}


// ==========================================
// GO TO BACKEND
// ==========================================

async function goToBackend(): Promise<void> {

    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showWarningMessage(
            'No active editor found.'
        );
        return;
    }

    const currentFile = editor.document.uri.fsPath;
    const currentLine = editor.selection.active.line;

    const analysis = await analysisService.getAnalysis(true);


    // ======================================
    // REST
    // ======================================

    const frontendCalls = analysis.restCalls;

    const matches = analysis.restMatches;

    const currentCall = frontendCalls.find(
        call =>
            call.filePath === currentFile &&
            Math.abs(call.line - currentLine) <= 2
    );

    if (currentCall) {

        const result = matches.find(
            match => match.call === currentCall
        );

        if (result?.matched) {
            await navigateRestMatch(result, analysis.revision);

            return;
        }
    }


    // ======================================
    // WEBSOCKET
    // ======================================

    const websocketCalls = analysis.websocketCalls;

    const websocketMatches = analysis.websocketMatches;

    const currentWebSocketCall =
        websocketCalls.find(
            call =>
                call.filePath === currentFile &&
                call.type === 'publish' &&
                Math.abs(call.line - currentLine) <= 3
        );

    if (currentWebSocketCall) {

        const result = websocketMatches.find(
            match => match.call === currentWebSocketCall
        );

        if (result?.endpoint) {

            await openAndHighlight(
                result.endpoint.filePath,
                result.endpoint.line
            );

            return;
        }
    }


    vscode.window.showWarningMessage(
        'No matching REST or WebSocket backend endpoint found near this line.'
    );
}


// ==========================================
// FIND FRONTEND USAGES
// ==========================================

async function findFrontendUsages(target?: BackendNavigationTarget): Promise<void> {

    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showWarningMessage(
            'No active editor found.'
        );
        return;
    }

    const currentFile =target?.filePath ?? editor.document.uri.fsPath;
    const currentLine =target?.line ?? editor.selection.active.line;

    const analysis = await analysisService.getAnalysis();
    if (isStaleTarget(target, analysis.revision)) {
        return;
    }


    // ======================================
    // REST
    // ======================================

    const endpoints = analysis.restEndpoints;

    const currentEndpoint = target?.type === 'websocket' ? undefined : endpoints.find(
        endpoint =>
            endpoint.filePath.toLowerCase() === currentFile.toLowerCase() &&
            (
                target?.type === 'rest' 
                ? endpoint.line ===  currentLine
                : Math.abs(endpoint.line - currentLine)<=2
            )
    );

    if (currentEndpoint) {

        const usages = analysis.restUsages.get(currentEndpoint) ?? [];

        if (usages.length === 0) {

            vscode.window.showInformationMessage(
                `No frontend usages found for ${currentEndpoint.method} ${currentEndpoint.path}`
            );

            return;
        }

        if (usages.length === 1) {

            await openAndHighlight(
                usages[0].filePath,
                usages[0].line,
                analysis.revision
            );

            return;
        }

        const selected =
            await vscode.window.showQuickPick(
                usages.map(call => ({
                    label: `${call.method} ${call.path}`,
                    description:
                        `${call.filePath} : ${call.line + 1}`,
                    call
                })),
                {
                    placeHolder:
                        `Select frontend usage for ${currentEndpoint.method} ${currentEndpoint.path}`
                }
            );

        if (!selected) {
            return;
        }

        await openAndHighlight(
            selected.call.filePath,
            selected.call.line,
            analysis.revision
        );

        return;
    }


    // ======================================
    // WEBSOCKET
    // ======================================

    const websocketEndpoints = analysis.websocketEndpoints;

    const currentWebSocketEndpoint =
        target?.type === 'rest' ? undefined : websocketEndpoints.find(
            endpoint =>
                endpoint.filePath.toLowerCase() === currentFile.toLowerCase() &&
                (
                    target?.type === 'websocket'
                    ? endpoint.line === currentLine 
                    : Math.abs(
                        endpoint.line - currentLine
                    )<=2
                )
        );

    if (currentWebSocketEndpoint) {

        const usages = analysis.websocketUsages.get(currentWebSocketEndpoint) ?? [];

        if (usages.length === 0) {

            vscode.window.showInformationMessage(
                `No frontend WebSocket usages found for ${currentWebSocketEndpoint.inboundDestination}`
            );

            return;
        }

        if (usages.length === 1) {

            await openAndHighlight(
                usages[0].filePath,
                usages[0].line,
                analysis.revision
            );

            return;
        }

        const selected =
            await vscode.window.showQuickPick(
                usages.map(call => ({
                    label:
                        `PUBLISH ${call.destination}`,
                    description:
                        `${call.filePath} : ${call.line + 1}`,
                    call
                })),
                {
                    placeHolder:
                        `Select frontend WebSocket usage for ${currentWebSocketEndpoint.inboundDestination}`
                }
            );

        if (!selected) {
            return;
        }

        await openAndHighlight(
            selected.call.filePath,
            selected.call.line,
            analysis.revision
        );

        return;
    }


    vscode.window.showWarningMessage(
        'No REST or WebSocket backend endpoint found near this line.'
    );
}


// ==========================================
// OUTPUT HELPERS
// ==========================================

function printSection(
    outputChannel: vscode.OutputChannel,
    title: string
): void {

    outputChannel.appendLine('');
    outputChannel.appendLine(title);
    outputChannel.appendLine(
        '-'.repeat(title.length)
    );
}


function printIndexedFiles(
    outputChannel: vscode.OutputChannel,
    files: any[]
): void {

    printSection(
        outputChannel,
        'Indexed Files'
    );

    for (const file of files) {
        outputChannel.appendLine(
            `${file.language} -> ${file.path}`
        );
    }
}


function printRestEndpoints(
    outputChannel: vscode.OutputChannel,
    endpoints: any[]
): void {

    printSection(
        outputChannel,
        'Spring Endpoints'
    );

    for (const endpoint of endpoints) {

        outputChannel.appendLine(
            `${endpoint.method} ${endpoint.path}`
        );

        outputChannel.appendLine(
            `${endpoint.filePath} line=${endpoint.line + 1}`
        );

        outputChannel.appendLine('');
    }
}


function printFrontendApiCalls(
    outputChannel: vscode.OutputChannel,
    calls: any[]
): void {

    printSection(
        outputChannel,
        'Frontend API Calls'
    );

    for (const call of calls) {

        outputChannel.appendLine(
            `${call.method} ${call.path}`
        );

        outputChannel.appendLine(
            `${call.filePath} line=${call.line + 1}`
        );

        outputChannel.appendLine('');
    }
}


function printEndpointMatches(
    outputChannel: vscode.OutputChannel,
    matches: any[]
): void {

    printSection(
        outputChannel,
        'Endpoint Matches'
    );

    for (const result of matches) {

        if (result.matched && result.endpoint) {

            outputChannel.appendLine(
                `MATCHED ${result.call.method} ${result.call.path}`
            );

            outputChannel.appendLine(
                `Frontend: ${result.call.filePath}`
            );

            outputChannel.appendLine(
                `Backend: ${result.endpoint.filePath}`
            );

        } else {

            outputChannel.appendLine(
                `NOT FOUND ${result.call.method} ${result.call.path}`
            );

            outputChannel.appendLine(
                `Frontend: ${result.call.filePath}`
            );
        }

        outputChannel.appendLine('');
    }
}


function printWebSocketEndpoints(
    outputChannel: vscode.OutputChannel,
    endpoints: any[]
): void {

    printSection(
        outputChannel,
        'WebSocket Endpoints'
    );

    for (const endpoint of endpoints) {

        outputChannel.appendLine(
            `IN ${endpoint.inboundDestination}`
        );

        if (endpoint.outboundDestination) {
            outputChannel.appendLine(
                `OUT ${endpoint.outboundDestination}`
            );
        }

        outputChannel.appendLine(
            `${endpoint.filePath} line=${endpoint.line + 1}`
        );

        outputChannel.appendLine('');
    }
}


function printFrontendWebSocketCalls(
    outputChannel: vscode.OutputChannel,
    calls: any[]
): void {

    printSection(
        outputChannel,
        'Frontend WebSocket Calls'
    );

    for (const call of calls) {

        outputChannel.appendLine(
            `${call.type.toUpperCase()} ${call.destination}`
        );

        outputChannel.appendLine(
            `${call.filePath} line=${call.line + 1}`
        );

        outputChannel.appendLine('');
    }
}


function printWebSocketMatches(
    outputChannel: vscode.OutputChannel,
    matches: any[]
): void {

    printSection(
        outputChannel,
        'WebSocket Matches'
    );

    for (const result of matches) {

        if (result.matched && result.endpoint) {

            outputChannel.appendLine(
                `MATCHED ${result.call.destination}`
            );

            outputChannel.appendLine(
                `Frontend: ${result.call.filePath} line=${result.call.line + 1}`
            );

            outputChannel.appendLine(
                `Backend: ${result.endpoint.filePath} line=${result.endpoint.line + 1}`
            );

        } else {

            outputChannel.appendLine(
                `NOT FOUND ${result.call.destination}`
            );

            outputChannel.appendLine(
                `Frontend: ${result.call.filePath} line=${result.call.line + 1}`
            );
        }

        outputChannel.appendLine('');
    }
}


// ==========================================
// SCAN SUMMARY
// ==========================================

function showScanSummary(files: any[]): void {

    const javaCount =
        files.filter(
            file => file.language === 'java'
        ).length;

    const frontendCount =
        files.filter(
            file =>
                file.language === 'javascript' ||
                file.language === 'typescript'
        ).length;

    vscode.window.showInformationMessage(
        `FullStack Lens - Java: ${javaCount}, Frontend: ${frontendCount}`
    );
}


// ==========================================
// NAVIGATION
// ==========================================

async function navigateRestMatch(result: MatchResult, revision: number): Promise<void> {
    if (isStaleTarget(undefined, revision)) { return; }
    const candidates = result.candidateEndpoints ?? (result.endpoint ? [result.endpoint] : []);
    if (candidates.length === 0) {
        vscode.window.showWarningMessage('No matching REST backend endpoint found.');
        return;
    }
    let endpoint = candidates[0];
    if (candidates.length > 1) {
        const selected = await vscode.window.showQuickPick(
            candidates.map(candidate => ({
                label: `${path.basename(candidate.filePath)} — ${candidate.method} ${candidate.path}`,
                description: `${vscode.workspace.asRelativePath(candidate.filePath)} : ${candidate.line + 1}`,
                endpoint: candidate
            })),
            {
                placeHolder: `Select backend endpoint for ${result.call.method} ${result.call.path}`,
                matchOnDescription: true
            }
        );
        if (!selected || isStaleTarget(undefined, revision)) { return; }
        endpoint = selected.endpoint;
    }
    await openAndHighlight(endpoint.filePath, endpoint.line, revision);
}

async function openAndHighlight(
    filePath: string,
    line: number,
    revision?: number
): Promise<void> {
    try {
        if (revision !== undefined && isStaleTarget(undefined, revision)) {
            return;
        }
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);

        if (!Number.isInteger(line) || line < 0 || line >= document.lineCount) {
            vscode.window.showWarningMessage('The navigation target has moved or is unavailable. Save and refresh CodeLens.');
            return;
        }
        if (revision !== undefined && isStaleTarget(undefined, revision)) {
            return;
        }

        const editor = await vscode.window.showTextDocument(document);
        if (revision !== undefined && isStaleTarget(undefined, revision)) {
            return;
        }

        const lineText = document.lineAt(line);
        const range = new vscode.Range(line, 0, line, lineText.text.length);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

        const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 215, 0, 0.25)',
            isWholeLine: true
        });
        editor.setDecorations(decoration, [range]);
        setTimeout(() => decoration.dispose(), 2000);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showWarningMessage(`Unable to open the navigation target: ${message}`);
    }
}


export function deactivate(): void {}
