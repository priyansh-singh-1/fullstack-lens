import { HttpCall } from '../models/HttpCall';
import { HttpEndpoint } from '../models/HttpEndpoint';
import { MatchResult } from '../models/MatchResult';

export class EndpointMatcher {

    private normalizePath(path: string): string {
        return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    }

    private isPathVariable(segment: string): boolean {
        return segment.startsWith('{') && segment.endsWith('}');
    }

    private specificity(path: string): number {
        return this.normalizePath(path).split('/').filter(
            segment => segment.length > 0 && !this.isPathVariable(segment)
        ).length;
    }

    public pathMatch(
        frontendPath: string,
        backendPath: string
    ): boolean{

        const normalizedFrontendPath = this.normalizePath(frontendPath);
        const normalizedBackendPath = this.normalizePath(backendPath);
        
        const frontendParts = normalizedFrontendPath.split('/');
        const backendParts= normalizedBackendPath.split('/');

        if(frontendParts.length !== backendParts.length){
            return false;
        }

        for(let i=0;i< backendParts.length;i++){
            const backendpart= backendParts[i];
            const frontendPart= frontendParts[i];

            const isPathVariable = this.isPathVariable(backendpart);

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
        // Reverse navigation records only the equally most-specific matches.
        usages?: Map<HttpEndpoint, HttpCall[]>
    ): MatchResult[] {

        const results: MatchResult[] = [];

        for (const call of calls) {

            const candidateEndpoints: HttpEndpoint[] = [];
            let bestSpecificity = -1;
            for (const candidate of endpoints) {
                if (candidate.method !== call.method ||
                    !this.pathMatch(call.path, candidate.path)) {
                    continue;
                }
                const specificity = this.specificity(candidate.path);
                if (specificity < bestSpecificity) {
                    continue;
                }
                if (specificity > bestSpecificity) {
                    candidateEndpoints.length = 0;
                    bestSpecificity = specificity;
                }
                candidateEndpoints.push(candidate);
            }

            // Keep ambiguity, but make the navigation target independent of scan order.
            candidateEndpoints.sort((a, b) => {
                for (const [left, right] of [[a.path, b.path], [a.filePath, b.filePath]]) {
                    if (left !== right) {
                        return left < right ? -1 : 1;
                    }
                }
                return a.line - b.line;
            });

            if (usages) {
                for (const candidate of candidateEndpoints) {
                    const callsForEndpoint = usages.get(candidate) ?? [];
                    callsForEndpoint.push(call);
                    usages.set(candidate, callsForEndpoint);
                }
            }

            results.push({
                call,
                matched: candidateEndpoints.length > 0,
                endpoint: candidateEndpoints[0],
                candidateEndpoints
            });
        }

        return results;
    }
}
