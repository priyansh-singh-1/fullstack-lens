import { AnalysisDiagnostic } from '../models/AnalysisDiagnostic';
import { MatchResult } from '../models/MatchResult';
import { HttpEndpoint } from '../models/HttpEndpoint';
import { EndpointMatcher } from '../matching/EndPointMatcher';



export class RestDiagnosticAnalyzer {

    private endpointMatcher = new EndpointMatcher();
    public analyze(
        matches: MatchResult[],
        endpoints: HttpEndpoint[]

    ): AnalysisDiagnostic[]{
        const diagnostics: AnalysisDiagnostic[]=[];



        for(const result of matches){

            const call= result.call;

            if(call.resolution === 'partial' || call.resolution==='unresolved'){
                diagnostics.push({
                    filePath:call.filePath,
                    line:call.line,
                    message: `Frontend route could not be fully resolved: ${call.method} ${call.path}`,
                    severity: 'information',
                    code: 'FSL004'
                });
                continue;
            }

            if(result.matched && result.candidateEndpoints && result.candidateEndpoints.length>1){
                diagnostics.push({
                    filePath:result.call.filePath,
                    line: result.call.line,
                    message:
                    `Ambiguous backend route: ${result.call.method} ${result.call.path} ` +
            `matches ${result.candidateEndpoints.length} Spring endpoints.`,
                    severity:'warning',
                    code:'FSL003'

                });
                continue;
            }

             if (result.matched) {
                continue;
            }



            const samePathEndpoints = endpoints.filter(endpoint =>
                this.endpointMatcher.pathMatch(
                    call.path,
                    endpoint.path
                )
            );

            if(samePathEndpoints.length > 0){

                const backendMethods=[
                    ...new Set(
                        samePathEndpoints.map(endpoint => endpoint.method)
                    )
                ];

                 diagnostics.push({
                filePath: call.filePath,
                line: call.line,
                message:
                `Route exists, but HTTP method does not match. ` +
                `Frontend: ${call.method} ${call.path}. ` +
                `Backend: ${backendMethods.join(', ')}.`,
                severity: 'warning',
                code: 'FSL002'
                });

                continue;

            }

            diagnostics.push({
                filePath: call.filePath,
                line: call.line,
                message: `No matching Spring Boot endpoint found for ${call.method} ${call.path}`,
                severity: 'warning',
                code: 'FSL001'
            });
        }
        return diagnostics;
    }
}
