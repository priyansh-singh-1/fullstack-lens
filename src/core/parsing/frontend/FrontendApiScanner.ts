import * as fs from 'fs';
import { ProjectFile } from '../../models/ProjectFile';
import { HttpCall } from '../../models/HttpCall';

import { AxiosInstance } from '../../models/AxiosInstance';



export class FrontendApiScanner{
    public scan(files: ProjectFile[]): HttpCall[] {

    const calls: HttpCall[] = [];

    const frontendFiles = files.filter(
        file =>
            file.language === 'javascript' ||
            file.language === 'typescript'
    );

    // STEP 1: find axios instances from all frontend files
    const axiosInstances: AxiosInstance[] = [];

    for (const file of frontendFiles) {

        const content = fs.readFileSync(
            file.path,
            'utf-8'
        );

        const instances = this.findAxiosInstance(content);

        axiosInstances.push(...instances);
    }

    // STEP 2: scan all frontend files for API calls
    for (const file of frontendFiles) {

        const content = fs.readFileSync(
            file.path,
            'utf-8'
        );

        this.scanDirectAxiosCalls(
            content,
            file.path,
            calls
        );

        this.scanAxiosInstanceCalls(
            content,
            file.path,
            axiosInstances,
            calls
        );

        this.scanFetchCalls(
            content,
            file.path,
            calls
        );
    }

    return calls;
}

    private scanAxiosCalls(
        content: string,
        filePath: string,
        calls: HttpCall[]
    ): void{
        const axiosRegex = /axios\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi;

        let match: RegExpExecArray | null;


        while((match = axiosRegex.exec(content))!==null){

            const beforeMatch= content.substring(0,match.index);

            const line= beforeMatch.split('\n').length-1;

            calls.push({
                method: match[1].toUpperCase(),
                path: match[2],
                filePath,
                line
            });
        }
    }

    private scanFetchCalls(
        content: string,
        filePath: string,
        calls: HttpCall[]
    ): void{
        const fetchRegex= /fetch\s*\(\s*["'`]([^"'`]+)["'`]/gi;

        let match: RegExpExecArray| null;

        while((match= fetchRegex.exec(content))!==null){
            const beforeMatch= content.substring(0,match.index);

            const line= beforeMatch.split('\n').length-1;
            
            calls.push({
                method: 'GET',
                path: this.normalizeUrl(match[1]),
                filePath,
                line
            });
        }
    }


    private findAxiosInstance(content: string): AxiosInstance[]{
        const instnace: AxiosInstance[]=[];

        const regex=/(?:const|let|var)\s+(\w+)\s*=\s*axios\.create\s*\(\s*\{[\s\S]*?baseURL\s*:\s*["'`]([^"'`]+)["'`][\s\S]*?\}\s*\)/gi;

        let match: RegExpExecArray| null;

        while((match = regex.exec(content))!==null){
            instnace.push({
                name: match[1],
                baseUrl: match[2]
            });
        }
        return instnace;

    }

    private scanDirectAxiosCalls(
        content: string, filePath: string, calls: HttpCall[]
    ): void{
        const regex=  /axios\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi;

        let match: RegExpExecArray | null;

        while((match= regex.exec(content))!==null){

            const beforeMatch= content.substring(0,match.index);

            const line= beforeMatch.split('\n').length-1;

            calls.push({
                method: match[1].toUpperCase(),
                path: this.normalizeUrl(match[2]),
                filePath,
                line
            });
        }
    }

    private scanAxiosInstanceCalls(
        content: string, filePath: string, instances: AxiosInstance[], calls: HttpCall[]
    ): void{
        for(const instance of instances){
            const escapedName= 
            this.escapeRegex(instance.name);

            const regex= new RegExp(
                `${escapedName}\\.(get|post|put|delete|patch)\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`,
                'gi'
            );

            let match: RegExpExecArray | null;

            while((match=regex.exec(content))!==null){
                const fullUrl= this.combineUrls(
                    instance.baseUrl,
                    match[2]
                );

                const beforeMatch= content.substring(0,match.index);

            const line= beforeMatch.split('\n').length-1;

                calls.push({
                    method: match[1].toUpperCase(),
                    path: this.normalizeUrl(fullUrl),
                    filePath,
                    line
                });
            }
        }
    }

    private combineUrls(
        baseUrl: string,
        path: string
    ): string{
        const base= baseUrl.replace(/\/+$/,'');

        const route= path.replace(/^\/+/, '');

        return `${base}/${route}`;
    }

    private normalizeUrl(url: string):string{
        try{
            const parsedUrl= new URL(url);

            return parsedUrl.pathname;
        }catch{
            if(!url.startsWith('/')){
                return `/${url}`;
            }
            return url;
        }
    }
    private escapeRegex(value: string): string{
        return value.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
        );
    }
}
