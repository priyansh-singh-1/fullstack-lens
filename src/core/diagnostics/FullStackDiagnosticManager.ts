import * as vscode from 'vscode';
import { AnalysisDiagnostic } from '../models/AnalysisDiagnostic';



export class FullStackDiagnosticManager{
    private collection = vscode.languages.createDiagnosticCollection('fullstack-lens');
    public update(
        diagnostics: AnalysisDiagnostic[]
    ): void{
        this.collection.clear();

        const grouped= new Map<string, vscode.Diagnostic[]>();

        for( const item of diagnostics){
            const uri= vscode.Uri.file(item.filePath);

            const range= new vscode.Range(
                item.line,
                0,
                item.line,
                Number.MAX_SAFE_INTEGER
            );

            const severity = this.mapSeverity(item.severity);

            const diagnostic= new vscode.Diagnostic(
                range,
                item.message,
                severity
            );

            diagnostic.code= item.code;
            diagnostic.source= 'FullStack Lens';

            const key= uri.fsPath;
            if(!grouped.has(key)){
                grouped.set(key,[]);
            }

            grouped.get(key)!.push(diagnostic);
        }

        for(const [filePath, fileDiagnostics] of grouped){
            this.collection.set(
            vscode.Uri.file(filePath),
            fileDiagnostics
            );
        }
        
    }
     public clear(): void {
        this.collection.clear();
    }

    public dispose(): void {
        this.collection.dispose();
    }

    private mapSeverity(
        severity: AnalysisDiagnostic['severity']
    ): vscode.DiagnosticSeverity{
        switch(severity){
            case 'error':
                return vscode.DiagnosticSeverity.Error;

            case 'information':
                return vscode.DiagnosticSeverity.Information;

            case 'warning':
                default:
                    return vscode.DiagnosticSeverity.Warning;
        }
    }

}

    
