import * as vscode from 'vscode';
import * as path from 'path';
import { AnalysisService } from './AnalysisService';

const excludedFolders = new Set(['node_modules', 'dist', 'build', 'target']);

export function isRelevantAnalysisFile(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (uri.scheme !== 'file' || !folder) {
        return false;
    }
    const segments = path.relative(folder.uri.fsPath, uri.fsPath).split(/[\\/]/);
    return /\.(java|js|jsx|ts|tsx)$/i.test(segments.at(-1) ?? '') &&
        !segments.slice(0, -1).some(segment => excludedFolders.has(segment.toLowerCase()));
}

/** Invalidate immediately; coalesce save-triggered requests for fresh lenses. */
export function registerAnalysisSaveRefresh(
    analysisService: AnalysisService,
    provider: { refresh(): void },
    debounceMs = 400
): vscode.Disposable {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = vscode.workspace.onDidSaveTextDocument(document => {
        if (!isRelevantAnalysisFile(document.uri)) {
            return;
        }
        analysisService.clearCache();
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = undefined;
            provider.refresh();
        }, debounceMs);
    });

    return new vscode.Disposable(() => {
        listener.dispose();
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    });
}
