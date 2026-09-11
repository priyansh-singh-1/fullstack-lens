import { HttpCall } from '../models/HttpCall';
import { HttpEndpoint } from '../models/HttpEndpoint';
import { MatchResult } from '../models/MatchResult';

export class EndpointMatcher {

    public match(
        calls: HttpCall[],
        endpoints: HttpEndpoint[]
    ): MatchResult[] {

        const results: MatchResult[] = [];

        for (const call of calls) {

            const endpoint = endpoints.find(
                endpoint =>
                    endpoint.method === call.method &&
                    endpoint.path === call.path
            );

            if (endpoint) {
                results.push({
                    call,
                    endpoint,
                    matched: true
                });
            } else {
                results.push({
                    call,
                    endpoint: undefined,
                    matched: false
                });
            }
        }

        return results;
    }
}