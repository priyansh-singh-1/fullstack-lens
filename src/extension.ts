import * as vscode from 'vscode';
import { WorkspaceIndexer } from './core/workspace/WorkspaceIndexer';
import { SpringEndpointScanner } from './core/parsing/spring/SpringEndpointScanner';
import { FrontendApiScanner } from './core/parsing/frontend/FrontendApiScanner';
import { EndpointMatcher } from './core/matching/EndPointMatcher';

import { SpringWebSocketScanner } from './core/parsing/spring/SpringWebSocketScanner';
import { FrontendWebSocketScanner } from './core/parsing/frontend/FrontendWebSocketScanner';
import { WebSocketMatcher } from './core/matching/WebSocketMatcher';
import { WebSocketCall } from './core/models/WebSocketCall';





export function activate(context: vscode.ExtensionContext) {
    console.log('FullStack Lens is active');

    const indexer = new WorkspaceIndexer();
    const springScanner = new SpringEndpointScanner();
    const frontendScanner = new FrontendApiScanner();
    const endpointMatcher = new EndpointMatcher();
    const frontendWebSocketScanner = new FrontendWebSocketScanner();
    const webSocketMatcher = new WebSocketMatcher();
    const outputChannel = vscode.window.createOutputChannel('FullStack Lens');

    
    context.subscriptions.push(outputChannel);

    const disposable = vscode.commands.registerCommand(
        'fullstack-lens.scanWorkspace',
        async () => {
            const files = await indexer.indexWorkspace();
            const endpoints = springScanner.scan(files);
            const frontendCalls = frontendScanner.scan(files);
            const matches = endpointMatcher.match(frontendCalls, endpoints);

            const springWebSocketScanner = new SpringWebSocketScanner();
            outputChannel.clear();

            const websocketEndpoints = springWebSocketScanner.scan(files);

            const webSocketCalls= frontendWebSocketScanner.scan(files);

            const websocketMatches= webSocketMatcher.match(
                webSocketCalls,
                websocketEndpoints
            );

            // List indexed files
            for (const file of files) {
                outputChannel.appendLine(`${file.language} -> ${file.path}`);
            }

            outputChannel.appendLine('');
            outputChannel.appendLine('Spring Endpoints');
            outputChannel.appendLine('----------------');

            for (const endpoint of endpoints) {
                outputChannel.appendLine(`${endpoint.method} ${endpoint.path} -> ${endpoint.filePath}`);
                outputChannel.appendLine(`${endpoint.method} ${endpoint.path} ${endpoint.line + 1}`);
            }

            outputChannel.appendLine('');
            outputChannel.appendLine('Frontend API Calls');
            outputChannel.appendLine('------------------');

            for (const call of frontendCalls) {
                outputChannel.appendLine(`${call.method} ${call.path} ${call.filePath}`);
                outputChannel.appendLine(`${call.method} ${call.path} ${call.line + 1}`);
            }

            outputChannel.show();

            outputChannel.appendLine('');
            outputChannel.appendLine('Endpoint Matches');
            outputChannel.appendLine('----------------');

            for (const result of matches) {
                if (result.matched && result.endpoint) {
                    outputChannel.appendLine(`Matched ${result.call.method} ${result.call.path}`);
                    outputChannel.appendLine(`Frontend ${result.call.filePath}`);
                    outputChannel.appendLine(`Backend ${result.endpoint.filePath}`);
                    outputChannel.appendLine('');
                } else {
                    outputChannel.appendLine(`NOT FOUND ${result.call.method} ${result.call.path}`);
                    outputChannel.appendLine(`Frontend: ${result.call.filePath}`);
                    outputChannel.appendLine('');
                }
                outputChannel.appendLine('');
            }

            // ========================
            // WEBSOCKET ENDPOINTS
            // ========================
            outputChannel.appendLine('');
            outputChannel.appendLine('WebSocket Endpoints');
            outputChannel.appendLine('-------------------');

            for (const endpoint of websocketEndpoints) {

                outputChannel.appendLine(`IN ${endpoint.inboundDestination}`);
                if (endpoint.outboundDestination) {
                    outputChannel.appendLine(`OUT ${endpoint.outboundDestination}`);
                }
                outputChannel.appendLine(`${endpoint.filePath} line=${endpoint.line + 1}`);
                outputChannel.appendLine('');
            }

            outputChannel.appendLine('');
            outputChannel.appendLine('Frontend WebSocket Calls');
            outputChannel.appendLine('------------------------');

            for(const call of webSocketCalls){
                outputChannel.appendLine(
                    `${call.type.toUpperCase()} ${call.destination}`
                );

                outputChannel.appendLine(
                    `${call.filePath} line=${call.line+1}`
                );

                outputChannel.appendLine('');
            }

            outputChannel.appendLine('');
            outputChannel.appendLine('WebSocket Matches');
            outputChannel.appendLine('-----------------');

            for(const result of websocketMatches){
                if(result.matched && result.endpoint){
                    outputChannel.appendLine(
                        `MATCHED ${result.call.destination}`
                    );

                    outputChannel.appendLine(
                        `Frontend ${result.call.filePath} line=${result.call.line+1}` 
                    );

                    outputChannel.appendLine(
                        `Backend ${result.endpoint.filePath} line=${result.endpoint.line+1}`
                    );
                }else{
                    outputChannel.appendLine(
                        `NOT FOUND ${result.call.destination}`
                    );

                    outputChannel.appendLine(
                        `Frontend ${result.call.filePath} line=${result.call.line+1}`
                    );

                    
                }

                outputChannel.appendLine('');

            }



            const javaCount = files.filter(file => file.language === 'java').length;
            const frontendCount = files.filter(
                file => file.language === 'javascript' || file.language === 'typescript'
            ).length;

            vscode.window.showInformationMessage(
                `FullStack Lens - Java: ${javaCount}, Frontend: ${frontendCount}`
            );
        }
    );

    const goTOBackend = vscode.commands.registerCommand(
    'fullstack-lens.goToBackend',
    async () => {

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

        // =========================
        // REST
        // =========================

        const endpoints = springScanner.scan(files);
        const frontendCalls = frontendScanner.scan(files);
        const matches = endpointMatcher.match(frontendCalls, endpoints);

        const currentCall = frontendCalls.find(
            call =>
                call.filePath === currentFile &&
                call.line === currentLine
        );

        // REST mila?
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

        // =========================
        // WEBSOCKET
        // =========================

        const springWebSocketScanner = new SpringWebSocketScanner();
        const websocketEndpoints = springWebSocketScanner.scan(files);
        const websocketCalls = frontendWebSocketScanner.scan(files);
        const websocketMatches = webSocketMatcher.match(websocketCalls, websocketEndpoints);

        const currentWebSocketCall = websocketCalls.find(
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

        // =========================
        // NOTHING FOUND
        // =========================

        vscode.window.showWarningMessage(
            'No matching REST or WebSocket backend endpoint found on this line.'
        );
    }
);


    const findFrontendUsages = vscode.commands.registerCommand(
        'fullstack-lens.findFrontendUsages',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor found.');
                return;
            }

            const currentFile = editor.document.uri.fsPath;
            const currentLine = editor.selection.active.line;

            const files = await indexer.indexWorkspace();
            const endpoints = springScanner.scan(files);
            const frontendCalls = frontendScanner.scan(files);

            const currentEndpoint = endpoints.find(
                endpoint => endpoint.filePath === currentFile && endpoint.line === currentLine
            );

            if (!currentEndpoint) {
                vscode.window.showWarningMessage('No Spring endpoint found on this line.');
                return;
            }

            const usages = frontendCalls.filter(
                call => call.method === currentEndpoint.method && call.path === currentEndpoint.path
            );

            if (usages.length === 0) {
                vscode.window.showInformationMessage(
                    `No frontend usages found for ${currentEndpoint.method} ${currentEndpoint.path}`
                );
            }

            if (usages.length === 1) {
                await openAndHighlight(usages[0].filePath, usages[0].line);
                return;
            }

            const selected = await vscode.window.showQuickPick(
                usages.map(call => ({
                    label: `${call.method} ${call.path}`,
                    description: call.filePath,
                    call
                })),
                {
                    placeHolder: `Select frontend usage for ${currentEndpoint.method} ${currentEndpoint.path}`
                }
            );

            if (!selected) return;

            await openAndHighlight(selected.call.filePath, selected.call.line);
        }
    );

    async function openAndHighlight(filePath: string, line: number): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);

        const lineText = document.lineAt(line);
        const range = new vscode.Range(line, 0, line, lineText.text.length);

        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

        const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 215, 0, 0.25)',
            isWholeLine: true
        });

        editor.setDecorations(decoration, [range]);

        setTimeout(() => {
            decoration.dispose();
        }, 2000);
    }

    context.subscriptions.push(disposable, goTOBackend, findFrontendUsages);
}

export function deactivate() {}
