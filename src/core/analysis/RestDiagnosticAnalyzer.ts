import { AnalysisDiagnostic } from '../models/AnalysisDiagnostic';
import { MatchResult } from '../models/MatchResult';


export class RestDiagnosticAnalyzer {
    public analyze(
        matches: MatchResult[]

    ): AnalysisDiagnostic[]{
        const diagnostics: AnalysisDiagnostic[]=[];

        for(const result of matches){
            if(result.matched){
                continue;
            }

            const call= result.call;

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