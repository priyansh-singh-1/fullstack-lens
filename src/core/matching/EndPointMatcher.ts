import { HttpCall } from '../models/HttpCall';
import { HttpEndpoint } from '../models/HttpEndpoint';
import { MatchResult } from '../models/MatchResult';

export class EndpointMatcher {

    private pathMatch(
        frontendPath: string,
        backendPath: string
    ): boolean{
        
        const frontendParts = frontendPath.split('/');
        const backendParts= backendPath.split('/');

        if(frontendParts.length !== backendParts.length){
            return false;
        }

        for(let i=0;i< backendParts.length;i++){
            const backendpart= backendParts[i];
            const frontendPart= frontendParts[i];

            const isPathVariable= 
                backendpart.startsWith('{') && backendpart.endsWith('}');

                if(isPathVariable){
                    continue;
                }

                if(backendpart !== frontendPart){
                    return false;
                }
        }
        return true;
    }

    public match(
        calls: HttpCall[],
        endpoints: HttpEndpoint[],
        // Collect every compatible endpoint for reverse navigation, while
        // keeping the first endpoint as the frontend navigation target.
        usages?: Map<HttpEndpoint, HttpCall[]>
    ): MatchResult[] {

        const results: MatchResult[] = [];

        for (const call of calls) {

            let endpoint: HttpEndpoint | undefined;
            for (const candidate of endpoints) {
                if (candidate.method !== call.method ||
                    !this.pathMatch(call.path, candidate.path)) {
                    continue;
                }
                endpoint ??= candidate;
                if (!usages) {
                    break;
                }
                const callsForEndpoint = usages.get(candidate) ?? [];
                callsForEndpoint.push(call);
                usages.set(candidate, callsForEndpoint);
            }

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