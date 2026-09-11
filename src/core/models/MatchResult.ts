import { HttpCall } from './HttpCall';
import { HttpEndpoint } from './HttpEndpoint';

export interface MatchResult{
    call: HttpCall;
    /** Undefined when no Spring endpoint matches the frontend call. */
    endpoint?: HttpEndpoint;
    matched:boolean;
}
