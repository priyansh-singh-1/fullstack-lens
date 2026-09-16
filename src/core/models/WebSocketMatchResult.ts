import { WebSocketCall } from "./WebSocketCall";
import { WebSocketEndpoint } from "./WebSocketEndpoint";

export interface WebSocketMatchResult{
    call: WebSocketCall;
    endpoint?: WebSocketEndpoint;
    matched: boolean
}
