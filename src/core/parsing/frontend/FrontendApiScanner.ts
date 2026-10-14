import * as fs from 'fs';
import { ProjectFile } from '../../models/ProjectFile';
import { HttpCall } from '../../models/HttpCall';

import { AxiosInstance } from '../../models/AxiosInstance';
import * as path from 'path';
import { p } from 'framer-motion/client';



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
                resolution: this.classifyTemplateResolution(match[2]),
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
                resolution: this.classifyTemplateResolution(match[1]),
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
                resolution: this.classifyTemplateResolution(match[2]),
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

            const regex = new RegExp(
                 `${escapedName}\\.(get|post|put|delete|patch)\\s*\\(`,
                  'gi'
            );

            let match: RegExpExecArray | null;

            while((match=regex.exec(content))!==null){

                const argumentEnd = this.findTopLevelDelimiter(content, regex.lastIndex, ',)');
                if (argumentEnd === null || argumentEnd === content.length) {
                    continue;
                }
                const parsedRoute = this.parseRouteExpression(
                    content.slice(regex.lastIndex, argumentEnd)
                );

                if(!parsedRoute){
                    continue;
                }
                const fullUrl= this.combineUrls(
                    instance.baseUrl,
                    parsedRoute.path
                );

                const beforeMatch= content.substring(0,match.index);

                const line= beforeMatch.split('\n').length-1;

                calls.push({
                    method: match[1].toUpperCase(),
                    path: this.normalizeUrl(fullUrl),
                    resolution: this.classifyTemplateResolution(instance.baseUrl) === 'partial'
                        ? 'partial' : parsedRoute.resolution,
                    filePath,
                    line
                });
            }
        }
    }

    // Locate separators only outside nested expressions, strings and comments.
    // The caller owns the opening call parenthesis, so its closing ')' is a delimiter.
    private findTopLevelDelimiter(source: string, start: number, delimiters: string): number | null {
        const closing: string[] = [];
        for (let index = start; index < source.length; index++) {
            const char = source[index];
            if (closing.length === 0 && delimiters.includes(char)) {
                return index;
            }
            if (char === '"' || char === "'" || char === '`') {
                const end = this.findStringEnd(source, index);
                if (end === null) {
                    return null;
                }
                index = end;
            } else if (source.startsWith('//', index)) {
                const end = source.indexOf('\n', index + 2);
                index = end < 0 ? source.length : end;
            } else if (source.startsWith('/*', index)) {
                const end = source.indexOf('*/', index + 2);
                if (end < 0) {
                    return null;
                }
                index = end + 1;
            } else if ('([{'.includes(char)) {
                closing.push({ '(': ')', '[': ']', '{': '}' }[char]!);
            } else if (')]}'.includes(char)) {
                if (closing.pop() !== char) {
                    return null;
                }
            } else if (char === ';' && closing.length === 0) {
                return null;
            }
        }
        return closing.length === 0 ? source.length : null;
    }

    private findStringEnd(source: string, start: number): number | null {
        const quote = source[start];
        for (let index = start + 1; index < source.length; index++) {
            if (source[index] === '\\') {
                index++;
            } else if (source[index] === quote) {
                return index;
            } else if (quote === '`' && source.startsWith('${', index)) {
                const end = this.findTopLevelDelimiter(source, index + 2, '}');
                if (end === null || end === source.length) {
                    return null;
                }
                index = end;
            }
        }
        return null;
    }

    private stringLiteralValue(expression: string): string | null {
        if (!['"', "'", '`'].includes(expression[0]) ||
            this.findStringEnd(expression, 0) !== expression.length - 1) {
            return null;
        }
        return expression.slice(1, -1);
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

        // Convert JS template variables:
        // ${id} -> {id}
        // ${userId} -> {userId}
        const normalizedTemplate = url.replace(
        /\$\{([^}]+)\}/g,
        '{$1}'
        );

        try{
            const parsedUrl= new URL(normalizedTemplate);

            return decodeURIComponent(parsedUrl.pathname);
        }catch{
            const pathname = normalizedTemplate.split(/[?#]/)[0];
            if(!pathname.startsWith('/')){
                return `/${pathname}`;
            }
            return pathname;
        }
    }
    private escapeRegex(value: string): string{
        return value.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
        );
    }

    private classifyTemplateResolution(url: string):
        'resolved'| 'partial' {

        const pathOnly = url.split(/[?#]/)[0];

        const expressions =[
            ...pathOnly.matchAll(/\$\{([^}]+)\}/g)
        ];

        for(const expression of expressions){
            const value= expression[1].trim();

            const simpleIdentifier =
                /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);

                if(!simpleIdentifier){
                    return 'partial';
                }
        }

        return 'resolved';
    }

    private normalizeConcatenatedRoute(expression: string): {
        path: string;
        resolution: 'resolved'| 'partial';
    } | null{
        const parts: string[] = [];
        let start = 0;
        while (start < expression.length) {
            const end = this.findTopLevelDelimiter(expression, start, '+');
            if (end === null) {
                return null;
            }
            parts.push(expression.slice(start, end).trim());
            start = end + 1;
        }

        if(parts.length<2 || parts.some(part => part.length === 0) || expression.endsWith('+')){
            return null;
        }

        let path='';
        let resolution :  'resolved' | 'partial' = 'resolved';

        for (const part of parts){
            const stringValue = this.stringLiteralValue(part);
            if(stringValue !== null){
                if (!/[?#]/.test(path) && this.classifyTemplateResolution(stringValue) === 'partial') {
                    resolution = 'partial';
                }
                path += stringValue;
                continue;
            }

            const simpleIdentifier =/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part);

            if(simpleIdentifier){
                path += `{${part}}`;
                continue;
            }

            if (!/[?#]/.test(path)) {
                resolution = 'partial';
            }
            path += '{dynamic}';

        }

        return{
            path,
            resolution
        };
    }

    private parseRouteExpression(expression: string): {
    path: string;
    resolution: 'resolved' | 'partial';
} | null {

    const trimmed = expression.trim();

    const rawUrl = this.stringLiteralValue(trimmed);

    if (rawUrl !== null) {

        return {
            path: this.normalizeUrl(rawUrl),
            resolution: rawUrl.includes('${')
                ? this.classifyTemplateResolution(rawUrl)
                : 'resolved'
        };
    }

    if (trimmed.includes('+')) {
        const concatenated =
            this.normalizeConcatenatedRoute(trimmed);

        if (!concatenated) {
            return null;
        }

        return {
            path: this.normalizeUrl(concatenated.path),
            resolution: concatenated.resolution
        };
    }

    return null;
}
}
