import * as vscode from 'vscode';
import { WorkspaceIndexer } from '../workspace/WorkspaceIndexer';
import { FrontendApiScanner } from '../parsing/frontend/FrontendApiScanner';
import { FrontendWebSocketScanner } from '../parsing/frontend/FrontendWebSocketScanner';



 export class FullStackCodeLensProvider implements vscode.CodeLensProvider{

    private indexer=  new WorkspaceIndexer();

    private frontendScanner= new FrontendApiScanner();

    private frontendWebSocketScanner = new FrontendWebSocketScanner();

    

    async provideCodeLenses(
        document: vscode.TextDocument
    ): Promise<vscode.CodeLens[]>{

         console.log(
        'CODELENS CALLED:',
        document.fileName,
        document.languageId
    );

    //  return [
    //     new vscode.CodeLens(
    //         new vscode.Range(0, 0, 0, 0),
    //         {
    //             title: '$(link) FullStack Lens TEST',
    //             command: 'fullstack-lens.scanWorkspace'
    //         }
    //     )
    // ];

        const codeLenses: vscode.CodeLens[]=[];

        if( document.languageId !== 'javascript' &&
             document.languageId !== 'javascriptreact' &&
            document.languageId !== 'typescript' &&
            document.languageId !== 'typescriptreact'
        ){
            return codeLenses;
        }

        const files= await this.indexer.indexWorkspace();

        const frontendCalls= this.frontendScanner.scan(files);

        const webSocketCalls= this.frontendWebSocketScanner.scan(files);

        const currentFile= document.uri.fsPath;

        const callsInCurrentFile= frontendCalls.filter(
            call =>
                 call.filePath === currentFile
        );

        for(const call of callsInCurrentFile){
            const position = 
            new vscode.Position(
                call.line,
                0
            );

            const range= new vscode.Range(
                position,
                position
            );

            const codeLens= 
            new vscode.CodeLens(
                range,
                {
                    title: `→ Go to Backend · ${call.method} ${call.path}`,
                    command: `fullstack-lens.goToBackend`,
                    arguments:[
                        {
                            type: 'rest',
                        filePath:call.filePath,
                        line: call.line
                    }
                        
                    ]
                }
            );

            codeLenses.push(codeLens);
        }

        const websocketCallsInCurrentFile =webSocketCalls.filter(
            call => 
                call.filePath === currentFile
            &&
                call.type === 'publish'
        );

        for(const call of websocketCallsInCurrentFile){
            const position = new vscode.Position(
                call.line,
                0
            );

            const range= new vscode.Range(
                position,
                position
            );

            codeLenses.push(
                new vscode.CodeLens(
                    range,
                    {
                        title: `$(radio-tower) Go to Backend .PUBLISH ${call.destination}`,
                        command: `fullstack-lens.goToBackend`,
                        arguments: [
                            {
                                type: 'websocket',
                                filePath: call.filePath,
                                line: call.line
                            }
                        ]
                    }
                )
            );

        }

        return codeLenses;
    }

 }
