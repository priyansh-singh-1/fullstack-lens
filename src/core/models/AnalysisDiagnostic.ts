export type AnalysisDiagnosticSeverity =
    | 'error'
    | 'warning'
    | 'information';

export interface AnalysisDiagnostic {
    filePath: string;
    line: number;
    message: string;
    severity: AnalysisDiagnosticSeverity;
    code: string;
}