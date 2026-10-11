import { MatchResult } from '../models/MatchResult';
import { WebSocketMatchResult } from '../models/WebSocketMatchResult';
import { ProjectFile } from '../models/ProjectFile';
import { HttpCall } from '../models/HttpCall';
import { HttpEndpoint } from '../models/HttpEndpoint';
import { WebSocketCall } from '../models/WebSocketCall';
import { WebSocketEndpoint } from '../models/WebSocketEndpoint';


export interface AnalysisResult{
    /** Cache generation that produced this saved-file snapshot. */
    revision: number;
    files: ProjectFile[];

    restEndpoints: HttpEndpoint[];
    restCalls: HttpCall[];
    restMatches: MatchResult[];
    /** All compatible calls, including endpoints shadowed by an earlier match. */
    restUsages: Map<HttpEndpoint, HttpCall[]>;

    websocketEndpoints: WebSocketEndpoint[];
    websocketCalls: WebSocketCall[];
    websocketMatches: WebSocketMatchResult[];
    websocketUsages: Map<WebSocketEndpoint, WebSocketCall[]>;

    


}
