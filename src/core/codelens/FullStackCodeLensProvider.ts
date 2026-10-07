import * as vscode from 'vscode';
import { AnalysisService } from '../analysis/AnalysisService';
import { EndpointMatcher } from '../matching/EndPointMatcher';



 export class FullStackCodeLensProvider implements vscode.CodeLensProvider{

    constructor(
        private readonly analysisService: AnalysisService
    ) {}

    

   
    async provideCodeLenses(
        document: vscode.TextDocument
    ): Promise<vscode.CodeLens[]>{

        const startTime = performance.now();

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
            document.languageId !== 'typescriptreact' &&
            document.languageId !== 'java'
        ){
            return codeLenses;
        }

        console.log('[FSL] Requesting analysis');

const analysis =
    await this.analysisService.getAnalysis();

console.log(
    '[FSL] Analysis ready in',
    Math.round(performance.now() - startTime),
    'ms'
);

        const frontendCalls =
            analysis.restCalls;

        const websocketCalls =
            analysis.websocketCalls;

        const currentFile =
            document.uri.fsPath;

        

        if(document.languageId === 'java'){

            const endpoints= analysis.restEndpoints;

            const endpointInCurrentFile= endpoints.filter(
                endpoint => 
                    endpoint.filePath.toLowerCase() === 
                currentFile.toLowerCase()
            );

            for(const endpoint of endpointInCurrentFile){
                const endpointMatcher = new EndpointMatcher;
                const matches= endpointMatcher.match(
                    frontendCalls,
                    [endpoint]
                );

                const usages= matches
                    .filter(result => result.matched)
                    .map(result=> result.call);

                const position = new vscode.Position(
                    endpoint.line,0
                );

                const range= new vscode.Range(
                    position,
                    position
                );

                codeLenses.push(
            new vscode.CodeLens(
                range,
                {
                    title: `$(references) ${usages.length} Frontend Usage${usages.length === 1 ? '' : 's'} ${endpoint.method} ${endpoint.path}`,
                    command: 'fullstack-lens.findFrontendUsages',

                    arguments:[
                        {
                            type:'rest',
                            filePath: endpoint.filePath,
                            line: endpoint.line
                        }
                    ]
                }
                
                    )
                );
            }

            const websocketEndpoints= analysis.websocketEndpoints;

            const websocketEndpointsInCurrentFile= 
            websocketEndpoints.filter(
                endpoint =>
                    endpoint.filePath.toLowerCase() === currentFile.toLowerCase()
            );

            for(const endpoint of websocketEndpointsInCurrentFile){
                const usages= 
                websocketCalls.filter(
                    call => 
                        call.type === 'publish' &&
                    call.destination === endpoint.inboundDestination
                );

                const position = new vscode.Position(
                    endpoint.line,
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
                            title: `$(references) ${usages.length} Frontend Usage${usages.length=== 1 ? '' : 's'} . Publish ${endpoint.inboundDestination}`,

                            command: 'fullstack-lens.findFrontendUsages',

                            arguments: [
                                {
                                    type: 'websocket',
                                    filePath: endpoint.filePath,
                                    line: endpoint.line
                                }
                            ]
                        }
                    )
                );
            }
            return codeLenses;
        }

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

        const websocketCallsInCurrentFile =websocketCalls.filter(
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
