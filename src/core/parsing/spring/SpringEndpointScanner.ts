import * as fs from 'fs';
import { HttpEndpoint } from '../../models/HttpEndpoint';
import { ProjectFile } from '../../models/ProjectFile';

export class SpringEndpointScanner {

    public scan(files: ProjectFile[]): HttpEndpoint[] {
        return files.filter(file => file.language === 'java').flatMap(file =>
            this.scanFile(file, fs.readFileSync(file.path, 'utf-8'))
        );
    }

    /** Scan supplied content only; preserve annotation-group ordering and offsets. */
    public scanFile(file: ProjectFile, source: string): HttpEndpoint[] {
        const endpoints: HttpEndpoint[] = [];
        if (file.language !== 'java') { return endpoints; }
        const content = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
                token => token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token);

        if(!content.includes("@RestController")){
            return endpoints;
        }

        const basePath = this.findBasePath(content);

        const mappings = [
            { annotation: 'GetMapping', method: 'GET' },
            { annotation: 'PostMapping', method: 'POST' },
            { annotation: 'PutMapping', method: 'PUT' },
            { annotation: 'DeleteMapping', method: 'DELETE' },
            { annotation: 'PatchMapping', method: 'PATCH' }
        ];

        for (const mapping of mappings) {

            const regex = new RegExp(
                `@${mapping.annotation}\\s*\\(\\s*["']([^"']+)["']\\s*\\)`,
                'g'
            );

            let match : RegExpExecArray | null;

            while ((match = regex.exec(content)) !== null) {

                const methodPath= match[1];
                const beforeMatch= content.substring(0,match.index);

                const line= beforeMatch.split('\n').length-1;

                const fullPath= this.combinePaths(
                    basePath,
                    methodPath
                );

                endpoints.push({
                    method: mapping.method,
                    path: fullPath,
                    filePath: file.path,
                    line,
                });
            }
        }
        return endpoints;
    }

    private findBasePath(content: string):string{
        const regex= /@RequestMapping\s*\(\s*["']([^"']*)["']\s*\)/;

        const match= regex.exec(content);

        if(!match){
            return '';
        }

        return match[1];


    }
    private combinePaths (basePath: string, methodPath: string):string {
        const base= basePath.replace(/\/+$/,'');
        const method = methodPath.replace(/^\/+/,'');

        if(!base && !method){
            return '/';
        }

        if(!base){
            return `/${method}`;
        }

        if(!method){
            return base.startsWith('/') ? base: `/${base}`;
            
        }

        const normalizedBase= base.startsWith('/') ? base : `/${base}`;

        return `${normalizedBase}/${method}`;

    }


}
