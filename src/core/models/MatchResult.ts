import { HttpCall } from './HttpCall';
import { HttpEndpoint } from './HttpEndpoint';

export interface MatchResult{
    call: HttpCall;
    /** Deterministic navigation target among the best matches; undefined if unmatched. */
    endpoint?: HttpEndpoint;
    matched:boolean;
    /** Equally most-specific same-method matches, excluding fallback routes. */
    candidateEndpoints?: HttpEndpoint[];
}
