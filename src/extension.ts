import * as vscode from 'vscode';

import { WorkspaceIndexer } from './core/workspace/WorkspaceIndexer';
import { SpringEndpointScanner } from './core/parsing/spring/SpringEndpointScanner';
import { FrontendApiScanner } from './core/parsing/frontend/FrontendApiScanner';
import { EndpointMatcher } from './core/matching/EndPointMatcher';

import { SpringWebSocketScanner } from './core/parsing/spring/SpringWebSocketScanner';
import { FrontendWebSocketScanner } from './core/parsing/frontend/FrontendWebSocketScanner';
import { WebSocketMatcher } from './core/matching/WebSocketMatcher';


// ==========================================
// SHARED SERVICES
// ==========================================

const indexer = new WorkspaceIndexer();

const springScanner = new SpringEndpointScanner();
const frontendScanner = new FrontendApiScanner();
const endpointMatcher = new EndpointMatcher();

const springWebSocketScanner = new SpringWebSocketScanner();
const frontendWebSocketScanner = new FrontendWebSocketScanner();
const webSocketMatcher = new WebSocketMatcher();


// ==========================================
// EXTENSION ACTIVATION
// ==========================================

export function activate(context: vscode.ExtensionContext) {

    console.log('FullStack Lens is active');

    const outputChannel =
        vscode.window.createOutputChannel('FullStack Lens');

    const scanWorkspaceCommand =
        vscode.commands.registerCommand(
            'fullstack-lens.scanWorkspace',
            () => scanWorkspace(outputChannel)
        );

    const goToBackendCommand =
        vscode.commands.registerCommand(
            'fullstack-lens.goToBackend',
            goToBackend
        );

    const findFrontendUsagesCommand =
        vscode.commands.registerCommand(
            'fullstack-lens.findFrontendUsages',
            findFrontendUsages
        );

    context.subscriptions.push(
        outputChannel,
        scanWorkspaceCommand,
        goToBackendCommand,
        findFrontendUsagesCommand
    );
}


// ==========================================
// SCAN WORKSPACE
// ==========================================

async function scanWorkspace(
    outputChannel: vscode.OutputChannel
): Promise<void> {

    const files = await indexer.indexWorkspace();

    // REST
    const endpoints = springScanner.scan(files);
    const frontendCalls = frontendScanner.scan(files);
    const matches = endpointMatcher.match(
        frontendCalls,
        endpoints
    );

    // WebSocket
    const websocketEndpoints =
        springWebSocketScanner.scan(files);

    const websocketCalls =
        frontendWebSocketScanner.scan(files);

    const websocketMatches =
        webSocketMatcher.match(
            websocketCalls,
            websocketEndpoints
        );

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

    const files = await indexer.indexWorkspace();


    // ======================================
    // REST
    // ======================================

    const endpoints = springScanner.scan(files);
    const frontendCalls = frontendScanner.scan(files);

    const matches = endpointMatcher.match(
        frontendCalls,
        endpoints
    );

    const currentCall = frontendCalls.find(
        call =>
            call.filePath === currentFile &&
            Math.abs(call.line - currentLine) <= 2
    );

    if (currentCall) {

        const result = matches.find(
            match => match.call === currentCall
        );

        if (result?.endpoint) {

            await openAndHighlight(
                result.endpoint.filePath,
                result.endpoint.line
            );

            return;
        }
    }


    // ======================================
    // WEBSOCKET
    // ======================================

    const websocketEndpoints =
        springWebSocketScanner.scan(files);

    const websocketCalls =
        frontendWebSocketScanner.scan(files);

    const websocketMatches =
        webSocketMatcher.match(
            websocketCalls,
            websocketEndpoints
        );

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

async function findFrontendUsages(): Promise<void> {

    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showWarningMessage(
            'No active editor found.'
        );
        return;
    }

    const currentFile = editor.document.uri.fsPath;
    const currentLine = editor.selection.active.line;

    const files = await indexer.indexWorkspace();


    // ======================================
    // REST
    // ======================================

    const endpoints = springScanner.scan(files);
    const frontendCalls = frontendScanner.scan(files);

    const currentEndpoint = endpoints.find(
        endpoint =>
            endpoint.filePath === currentFile &&
            Math.abs(endpoint.line - currentLine) <= 2
    );

    if (currentEndpoint) {

        const usages = frontendCalls.filter(
            call =>
                call.method === currentEndpoint.method &&
                call.path === currentEndpoint.path
        );

        if (usages.length === 0) {

            vscode.window.showInformationMessage(
                `No frontend usages found for ${currentEndpoint.method} ${currentEndpoint.path}`
            );

            return;
        }

        if (usages.length === 1) {

            await openAndHighlight(
                usages[0].filePath,
                usages[0].line
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
            selected.call.line
        );

        return;
    }


    // ======================================
    // WEBSOCKET
    // ======================================

    const websocketEndpoints =
        springWebSocketScanner.scan(files);

    const websocketCalls =
        frontendWebSocketScanner.scan(files);

    const currentWebSocketEndpoint =
        websocketEndpoints.find(
            endpoint =>
                endpoint.filePath === currentFile &&
                Math.abs(
                    endpoint.line - currentLine
                ) <= 2
        );

    if (currentWebSocketEndpoint) {

        const usages = websocketCalls.filter(
            call =>
                call.type === 'publish' &&
                call.destination ===
                    currentWebSocketEndpoint.inboundDestination
        );

        if (usages.length === 0) {

            vscode.window.showInformationMessage(
                `No frontend WebSocket usages found for ${currentWebSocketEndpoint.inboundDestination}`
            );

            return;
        }

        if (usages.length === 1) {

            await openAndHighlight(
                usages[0].filePath,
                usages[0].line
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
            selected.call.line
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

async function openAndHighlight(
    filePath: string,
    line: number
): Promise<void> {

    const uri = vscode.Uri.file(filePath);

    const document =
        await vscode.workspace.openTextDocument(uri);

    const editor =
        await vscode.window.showTextDocument(document);

    const lineText = document.lineAt(line);

    const range = new vscode.Range(
        line,
        0,
        line,
        lineText.text.length
    );

    editor.selection =
        new vscode.Selection(
            range.start,
            range.end
        );

    editor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenter
    );

    const decoration =
        vscode.window.createTextEditorDecorationType({
            backgroundColor:
                'rgba(255, 215, 0, 0.25)',
            isWholeLine: true
        });

    editor.setDecorations(
        decoration,
        [range]
    );

    setTimeout(
        () => decoration.dispose(),
        2000
    );
}


export function deactivate(): void {}