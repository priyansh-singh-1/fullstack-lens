import { ProjectFile } from '../models/ProjectFile';
import { HttpEndpoint } from '../models/HttpEndpoint';
import { HttpCall } from '../models/HttpCall';
import { WebSocketEndpoint } from '../models/WebSocketEndpoint';
import { WebSocketCall } from '../models/WebSocketCall';
import { ScannedAxiosInstance } from '../parsing/frontend/FrontendApiScanner';

/** Internal committed or candidate entry, including files with no detected entities. */
export interface FileAnalysis {
    file: ProjectFile;
    restEndpoints: HttpEndpoint[];
    restCalls: HttpCall[];
    websocketEndpoints: WebSocketEndpoint[];
    websocketCalls: WebSocketCall[];
    /** Configuration facts only; source text is not retained between builds. */
    axiosInstances: ScannedAxiosInstance[];
    applicationPrefix: string | undefined;
}
