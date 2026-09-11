import * as vscode from 'vscode';

import { ProjectFile, ProjectLanguage } from '../models/ProjectFile';

export class WorkspaceIndexer{
    public async indexWorkspace(): Promise<ProjectFile[]>{
        const javaFiles = await vscode.workspace.findFiles(
            '**/*.java',
            '**/{node_modules,target,build,dist}/**'
        );

        const frontendFiles= await vscode.workspace.findFiles(
            '**/*.{js,jsx,ts,tsx}',
            '**/{node_modules,target,build,dist}'
        );

        const projectFiles: ProjectFile[]=[];

        for (const file of javaFiles){
            projectFiles.push({
                path: file.fsPath,
                language: 'java'
            });
        }

        for(const file of frontendFiles){
            const language = 
            file.fsPath.endsWith('.ts')||
            file.fsPath.endsWith('.tsx')
            ? 'typescript'
            : 'javascript';

            projectFiles.push({
                path: file.fsPath,
                language
            });
        }
        return projectFiles;
    }
}