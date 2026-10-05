import { WorkspaceIndexer } from '../workspace/WorkspaceIndexer';
import { SpringEndpointScanner } from '../parsing/spring/SpringEndpointScanner';
import { SpringWebSocketScanner } from '../parsing/spring/SpringWebSocketScanner';
import { FrontendApiScanner } from '../parsing/frontend/FrontendApiScanner';
import { FrontendWebSocketScanner } from '../parsing/frontend/FrontendWebSocketScanner';
import { AnalysisResult } from './AnalysisResult';


export class AnalysisService{
    private indexer= new WorkspaceIndexer();

    private springScanner = new SpringEndpointScanner();

    private frontendScanner = new FrontendApiScanner();

    private frontendWebSocketScanner = new FrontendWebSocketScanner();

    private springwebsocketScanner= new SpringWebSocketScanner();

    private cachedResult: AnalysisResult | undefined;

    private pendingAnalysis: Promise<AnalysisResult> | undefined;

    public async getAnalysis(
        forceRefresh: boolean = false
    ): Promise<AnalysisResult>{

        console.log(
            '[FSL] Cache available:',this.cachedResult !== undefined
        );
        
        if(this.cachedResult && !forceRefresh){
            return this.cachedResult;
        }

        if (this.pendingAnalysis) {
            return this.pendingAnalysis;
        }

        this.pendingAnalysis = this.analyzeWorkspace();
        try {
            return await this.pendingAnalysis;
        } finally {
            this.pendingAnalysis = undefined;
        }
    }

    private async analyzeWorkspace(): Promise<AnalysisResult> {
        console.log('[FSL] Starting full workspace scan');

        // 1. Index workspace
        const files =
            await this.indexer.indexWorkspace();


        // 2. Scan REST
        const restEndpoints =
            this.springScanner.scan(files);

        const restCalls =
            this.frontendScanner.scan(files);


        // 3. Scan WebSocket
        const websocketEndpoints =
            this.springwebsocketScanner.scan(files);

        const websocketCalls =
            this.frontendWebSocketScanner.scan(files);


        //4. Create analysis snapshot
        this.cachedResult= {
            files,
            restEndpoints,
            restCalls,
            websocketEndpoints,
            websocketCalls
        };

        return this.cachedResult;
    }

     public clearCache(): void {
        this.cachedResult = undefined;
    } 


}
