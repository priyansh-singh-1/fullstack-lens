import * as vscode from 'vscode';
import { WorkspaceIndexer } from './core/workspace/WorkspaceIndexer';
import { SpringEndpointScanner } from './core/parsing/spring/SpringEndpointScanner';
import { FrontendApiScanner } from './core/parsing/frontend/FrontendApiScanner';
import { EndpointMatcher } from './core/matching/EndPointMatcher';
import { tr } from 'framer-motion/client';



export function activate(context: vscode.ExtensionContext) {
    console.log('FullStack Lens is active');


    const indexer = new WorkspaceIndexer();
    const springScanner = new SpringEndpointScanner();
    const frontendScanner = new FrontendApiScanner();
    const endpointMatcher= new EndpointMatcher();

    const disposable = vscode.commands.registerCommand(
        'fullstack-lens.scanWorkspace',
        async () => {
            const files = await indexer.indexWorkspace();
            const endpoints = springScanner.scan(files);
            const frontendCalls = frontendScanner.scan(files);

            const matches =endpointMatcher.match(frontendCalls,endpoints);            

            const outputChannel = vscode.window.createOutputChannel('FullStack Lens');
            outputChannel.clear();

            // List indexed files
            for (const file of files) {
                outputChannel.appendLine(`${file.language} -> ${file.path}`);
            }

            outputChannel.appendLine('');
            outputChannel.appendLine('Spring Endpoints');
            outputChannel.appendLine('----------------');

            for (const endpoint of endpoints) {
                outputChannel.appendLine(`${endpoint.method} ${endpoint.path} -> ${endpoint.filePath}`);
                outputChannel.appendLine(`${endpoint.method} ${endpoint.path} ${endpoint.line+1}`);
            }

            outputChannel.appendLine('');
            outputChannel.appendLine('Frontend API Calls');
            outputChannel.appendLine('------------------');

            for (const call of frontendCalls) {
                outputChannel.appendLine(`${call.method} ${call.path} ${call.filePath}`);
                outputChannel.appendLine(`${call.method} ${call.path} ${call.line +1}`)
            }

            outputChannel.show();

            outputChannel.appendLine('');
            outputChannel.appendLine('Endpoint Matches');
            outputChannel.appendLine('----------------');

            for(const result of matches){
                if(result.matched && result.endpoint){
                    outputChannel.appendLine(
                        `Matched ${result.call.method} ${result.call.path}`
                    );

                    outputChannel.appendLine(
                        `Frontend ${result.call.filePath}`
                    );

                    outputChannel.appendLine(
                        `Backend ${result.endpoint.filePath}`
                    );

                    outputChannel.appendLine('');
                }else{
                    outputChannel.appendLine(
                        `NOT FOUND ${result.call.method} ${result.call.path}`
                    );

                    outputChannel.appendLine(
                        `Frontend: ${result.call.filePath}`
                    );

                    outputChannel.appendLine('');
                }
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

    const goTOBackend= vscode.commands.registerCommand(
         'fullstack-lens.goToBackend',

         async()=>{
            const editor= vscode.window.activeTextEditor;

            if(!editor){
                vscode.window.showWarningMessage(
                    'No active editor found.'
                );
                return;
            }

            const currentFile= editor.document.uri.fsPath;

            const currentLine = editor.selection.active.line;

            // Scan workspace
            const files= await indexer.indexWorkspace();

            const endpoints= springScanner.scan(files);

            const frontendCalls= frontendScanner.scan(files);

            const matches= endpointMatcher.match(
                frontendCalls,
                endpoints
            );


            // Find API call near current cursor
            const currentCall= frontendCalls.find(
                call => 
                    call.filePath == currentFile &&
                call.line=== currentLine
            );

            if(!currentCall){
                vscode.window.showWarningMessage(
                    'No API call found on this line.'
                );
                return;
            }

            //Find backend match
            const result= matches.find(
                match =>
                    match.call === currentCall
            );

            if(!result || !result.endpoint){
                vscode.window.showWarningMessage(
                     `No backend endpoint found for ${currentCall.method} ${currentCall.path}`
                );
                return;
            }


            const backendUri= vscode.Uri.file(
                result.endpoint.filePath
            );

            const document= await vscode.workspace.openTextDocument(
                backendUri
            );

            const backendEditor= await vscode.window.showTextDocument(
                document
            );

            const line= result.endpoint.line;

            const lineText= document.lineAt(line);

            const range= new vscode.Range(
                line,
                0,
                line,
                lineText.text.length
            );


            
            const position = new vscode.Position(
                result.endpoint.line,
                0
            );

            backendEditor.selection= 
            new vscode.Selection(
                range.start,
                range.end
            );

            backendEditor.revealRange(
                range,
                vscode.TextEditorRevealType.InCenter
            );

            // -------------------------------
            // TEMPORARY HIGHLIGHT
            // -------------------------------

            const decoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(255, 215, 0, 0.25)',
                isWholeLine: true
            });

            backendEditor.setDecorations(
                decoration,
                [range]
            );

            // 2 seconds ke baad highlight remove
            setTimeout(()=>{
                decoration.dispose();
            },2000)

         }
    );
    context.subscriptions.push(disposable,goTOBackend);
}

export function deactivate() {}
