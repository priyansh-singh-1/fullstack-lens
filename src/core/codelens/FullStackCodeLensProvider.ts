import * as vscode from 'vscode';
import { AnalysisService } from '../analysis/AnalysisService';
import { EndpointMatcher } from '../matching/EndPointMatcher';




 export class FullStackCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable{
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this.changeEmitter.event;

    public refresh(): void {
        this.changeEmitter.fire();
    }

    public dispose(): void {
        this.changeEmitter.dispose();
    }

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
        if (!this.analysisService.isCurrentRevision(analysis.revision)) { return []; }

console.log(
    '[FSL] Analysis ready in',
    Math.round(performance.now() - startTime),
    'ms'
);

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
                const usages = analysis.restUsages.get(endpoint) ?? [];

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
                            revision: analysis.revision,
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
                const usages = analysis.websocketUsages.get(endpoint) ?? [];

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
                                    revision: analysis.revision,
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

        const matchesInCurrentFile = analysis.restMatches.filter(
            result => result.call.filePath === currentFile
        );

        for (const matchResult of matchesInCurrentFile) {
            const call = matchResult.call;
            const position = 
            new vscode.Position(
                call.line,
                0
            );

            const range= new vscode.Range(
                position,
                position
            );

            const isUnresolved =
                call.resolution === 'partial' ||
                call.resolution === 'unresolved';

            const hasAmbiguousBackend = matchResult.matched &&
                (matchResult.candidateEndpoints?.length ?? 0) > 1;

            const hasBackend = matchResult.matched && !hasAmbiguousBackend;
            
            const hasMethodMismatch = !matchResult.matched && !isUnresolved && analysis.restEndpoints.some(endpoint =>
                new EndpointMatcher().pathMatch(call.path, endpoint.path)
            );

            const codeLens= 
            new vscode.CodeLens(
                range,
                {
                    title: isUnresolved
                        ? `$(info) Unresolved Route · ${call.method} ${call.path}`
                        : hasBackend
                            ? `→ Go to Backend · ${call.method} ${call.path}`
                            : hasAmbiguousBackend
                                ? `$(warning) Ambiguous Route · ${call.method} ${call.path}`
                                : hasMethodMismatch
                                    ? `$(warning) Method Mismatch · ${call.method} ${call.path}`
                                    : `$(warning) No Backend Found · ${call.method} ${call.path}`,
                    command: isUnresolved
                        ? 'fullstack-lens.showUnresolvedRouteInfo'
                        : hasAmbiguousBackend
                            ? 'fullstack-lens.selectBackendEndpoint'
                                : 'fullstack-lens.goToBackend',
                    arguments:[
                        {
                            type: 'rest',
                            revision: analysis.revision,
                            method: call.method,
                            path: call.path,
                        filePath:call.filePath,
                        line: call.line
                    }
                        
                    ]
                }
            );

            codeLenses.push(codeLens);
        }

        const websocketMatchesInCurrentFile = analysis.websocketMatches.filter(
            result =>
                result.call.filePath === currentFile
            &&
                result.call.type === 'publish'
        );

        for(const matchResult of websocketMatchesInCurrentFile){
            const call = matchResult.call;
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
                        title: matchResult.matched
                            ? `$(radio-tower) Go to Backend · PUBLISH ${call.destination}`
                            : `$(warning) No Backend Found · PUBLISH ${call.destination}`,
                        command: matchResult.matched
                            ? 'fullstack-lens.goToBackend'
                            : 'fullstack-lens.showNoBackendInfo',
                        arguments: [
                            {
                                type: 'websocket',
                                revision: analysis.revision,
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
