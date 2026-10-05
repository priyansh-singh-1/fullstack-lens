import { ProjectFile } from '../models/ProjectFile';
import { HttpCall } from '../models/HttpCall';
import { HttpEndpoint } from '../models/HttpEndpoint';
import { WebSocketCall } from '../models/WebSocketCall';
import { WebSocketEndpoint } from '../models/WebSocketEndpoint';


export interface AnalysisResult{
    files: ProjectFile[];

    restEndpoints: HttpEndpoint[];
    restCalls: HttpCall[];

    websocketEndpoints: WebSocketEndpoint[];
    websocketCalls: WebSocketCall[];

    


}
