import * as fs from 'fs';
import { ProjectFile } from '../../models/ProjectFile';
import { HttpCall } from '../../models/HttpCall';

import { AxiosInstance } from '../../models/AxiosInstance';
export interface ScannedAxiosInstance extends AxiosInstance {
    filePath: string;
    resolution: HttpCall['resolution'];
}



export class FrontendApiScanner{
    public scan(files: ProjectFile[]): HttpCall[] {
        const sources = files.filter(file =>
            file.language === 'javascript' || file.language === 'typescript'
        ).map(file => ({ file, source: fs.readFileSync(file.path, 'utf-8') }));
        const instances = sources.flatMap(({ file, source }) =>
            this.discoverAxiosInstances(file, source)
        );
        return sources.flatMap(({ file, source }) => this.scanFile(file, source, instances));
    }

    /** Extract definitions without reading disk; collect all files before resolving calls. */
    public discoverAxiosInstances(file: ProjectFile, source: string): ScannedAxiosInstance[] {
        if (file.language !== 'javascript' && file.language !== 'typescript') { return []; }
        return this.findAxiosInstance(source, file.path);
    }

    /** Resolve one source using the complete, ordered workspace definition list. */
    public scanFile(
        file: ProjectFile,
        source: string,
        instances: readonly ScannedAxiosInstance[]
    ): HttpCall[] {
        if (file.language !== 'javascript' && file.language !== 'typescript') { return []; }
        const calls: HttpCall[] = [];
        this.scanDirectAxiosCalls(source, file.path, calls);
        this.scanAxiosInstanceCalls(source, file.path, instances, calls);
        this.scanFetchCalls(source, file.path, calls);
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
): void {

    const fetchRegex = /(?<![\w$.])fetch\s*\(/g;
    const code = this.codeOnly(content);

    let match: RegExpExecArray | null;

    while ((match = fetchRegex.exec(code)) !== null) {

        const firstArgumentEnd  =
            this.findTopLevelDelimiter(
                content,
                fetchRegex.lastIndex,
                ',)'
            );

        if (
            firstArgumentEnd  === null ||
            firstArgumentEnd  === content.length
        ) {
            continue;
        }

        const expression =
            content.slice(
                fetchRegex.lastIndex,
                firstArgumentEnd 
            );

        const parsedRoute =
            this.parseRouteExpression(expression);

        if (!parsedRoute) {
            continue;
        }

        let method='GET';
        if(content[firstArgumentEnd]===','){
            const secondArgumentStart = firstArgumentEnd+1;

            const secondArgumentEnd =
                this.findTopLevelDelimiter(
                    content,
                    secondArgumentStart,
                    ')'
                );

                if(secondArgumentEnd !==null && secondArgumentEnd!== content.length){
                    const optionsExpression = 
                    content.slice(
                        secondArgumentStart,
                        secondArgumentEnd
                    );

                    method = this.extractFetchMethod(optionsExpression);
                }
        }


        const beforeMatch =
            content.substring(0, match.index);

        const line =
            beforeMatch.split('\n').length - 1;

        calls.push({
            method,
            path: parsedRoute.path,
            resolution: parsedRoute.resolution,
            filePath,
            line
        });
    }
}


    private findAxiosInstance(content: string, filePath: string): ScannedAxiosInstance[]{
        const instnace: ScannedAxiosInstance[]=[];
        const code = this.codeOnly(content);
        const regex= /\b(?:const|let|var)\s+([\w$]+)\s*=\s*axios\.create\s*\(\s*\{/g;

        let match: RegExpExecArray| null;

        while((match = regex.exec(code))!==null){
            const end = this.findTopLevelDelimiter(content, regex.lastIndex, '}');
            if (end === null || end === content.length) { continue; }
            const options = content.slice(regex.lastIndex, end);
            const baseExpression = this.objectProperty(options, 'baseURL');
            if (baseExpression === null) { continue; }
            const base = this.parseRouteExpression(baseExpression, false);
            if (!base) { continue; }
            instnace.push({
                name: match[1],
                baseUrl: base.resolution === 'unresolved' ? '' : base.path,
                resolution: base.resolution,
                filePath
            });
        }
        return instnace;

    }

    private scanDirectAxiosCalls(
        content: string, filePath: string, calls: HttpCall[]
    ): void{
        const regex=  /(?<![\w$.])axios\.(get|post|put|delete|patch)\s*\(/g;
        const code = this.codeOnly(content);

        let match: RegExpExecArray | null;

        while((match= regex.exec(code))!==null){

            const argumentEnd =
            this.findTopLevelDelimiter(
                content,
                regex.lastIndex,
                ',)'
            );

            if(argumentEnd === null || argumentEnd === content.length){
                continue;
            }

            const expression = content.slice(
                                        regex.lastIndex,
                                        argumentEnd
                                        );
            const parsedRoute= this.parseRouteExpression(expression);
            if(!parsedRoute){
                continue;
            }

            const beforeMatch= content.substring(0,match.index);

            const line= beforeMatch.split('\n').length-1;

            calls.push({
                method: match[1].toUpperCase(),
                path: parsedRoute.path,
                resolution: parsedRoute.resolution,
                filePath,
                line
            });
        }
    }

    private scanAxiosInstanceCalls(
        content: string, filePath: string, instances: readonly ScannedAxiosInstance[], calls: HttpCall[]
    ): void{
        const code = this.codeOnly(content);
        const names = new Set(instances.map(instance => instance.name));
        for(const name of names){
            const candidates = instances.filter(instance => instance.name === name);
            const local = candidates.filter(instance => instance.filePath === filePath);
            const applicable = local.length > 0 ? local : candidates;
            // Without import/scope analysis, conflicting definitions are unknown.
            const instance = applicable[0];
            const conflicting = applicable.some(candidate => candidate.baseUrl !== instance.baseUrl ||
                candidate.resolution !== instance.resolution);
            const escapedName= 
            this.escapeRegex(name);

            const regex = new RegExp(
                 `(?<![\\w$.])${escapedName}\\.(get|post|put|delete|patch)\\s*\\(`,
                  'g'
            );

            let match: RegExpExecArray | null;

            while((match=regex.exec(code))!==null){

                const argumentEnd = this.findTopLevelDelimiter(content, regex.lastIndex, ',)');
                if (argumentEnd === null || argumentEnd === content.length) {
                    continue;
                }
                const parsedRoute = this.parseRouteExpression(
                    content.slice(regex.lastIndex, argumentEnd), false
                );

                if(!parsedRoute){
                    continue;
                }
                const absolute = /^https?:\/\//i.test(parsedRoute.path);
                const fullUrl= absolute ? parsedRoute.path : this.combineUrls(
                    instance.baseUrl,
                    parsedRoute.path
                );

                const beforeMatch= content.substring(0,match.index);

                const line= beforeMatch.split('\n').length-1;

                calls.push({
                    method: match[1].toUpperCase(),
                    path: this.normalizeUrl(fullUrl),
                    resolution: parsedRoute.resolution === 'unresolved' ||
                        (!absolute && (conflicting || instance.resolution === 'unresolved')) ? 'unresolved' :
                        !absolute && instance.resolution === 'partial' ? 'partial' : parsedRoute.resolution,
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

    // Keep offsets/newlines stable so discovery cannot match examples or comments.
    private codeOnly(source: string, maskStrings = true): string {
        let result = '';
        for (let index = 0; index < source.length;) {
            let end: number | null = null;
            if ('"\'`'.includes(source[index])) {
                const stringEnd = this.findStringEnd(source, index);
                end = stringEnd === null ? source.length : stringEnd + 1;
                if (!maskStrings) {
                    result += source.slice(index, end);
                    index = end;
                    continue;
                }
                if (source[index] === '`') {
                    // Template text is inert; interpolation bodies are executable code.
                    let cursor = index;
                    let template = '';
                    for (let offset = index + 1; offset < end; offset++) {
                        if (source[offset] === '\\') { offset++; continue; }
                        if (!source.startsWith('${', offset)) { continue; }
                        const close = this.findTopLevelDelimiter(source, offset + 2, '}');
                        if (close === null || close >= end) { break; }
                        template += source.slice(cursor, offset + 2).replace(/[^\r\n]/g, ' ');
                        template += this.codeOnly(source.slice(offset + 2, close));
                        cursor = close;
                        offset = close;
                    }
                    result += template + source.slice(cursor, end).replace(/[^\r\n]/g, ' ');
                    index = end;
                    continue;
                }
            } else if (source.startsWith('//', index)) {
                const newline = source.indexOf('\n', index + 2);
                end = newline < 0 ? source.length : newline;
            } else if (source.startsWith('/*', index)) {
                const commentEnd = source.indexOf('*/', index + 2);
                end = commentEnd < 0 ? source.length : commentEnd + 2;
            }
            if (end !== null) {
                result += source.slice(index, end).replace(/[^\r\n]/g, ' ');
                index = end;
            } else {
                result += source[index++];
            }
        }
        return result;
    }

    // Inspect only immediate object properties, never nested headers/config.
    private objectProperty(properties: string, name: string): string | null {
        properties = this.codeOnly(properties, false);
        let start = 0;
        let value: string | null = null;
        while (start < properties.length) {
            const end = this.findTopLevelDelimiter(properties, start, ',');
            if (end === null) { return null; }
            const property = properties.slice(start, end).trim();
            const key = /^(?:([\w$]+)|["']([^"']+)["'])\s*:/.exec(property);
            if (key && (key[1] ?? key[2]) === name) {
                value = property.slice(key[0].length).trim();
            }
            start = end + 1;
        }
        return value;
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
        const normalizedTemplate = this.pathnameTemplate(url, true);

        try{
            const parsedUrl= new URL(normalizedTemplate);
            try { return decodeURIComponent(parsedUrl.pathname); }
            catch { return parsedUrl.pathname; }
        }catch{
            const pathname = normalizedTemplate;
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
        return this.pathnameTemplate(url, false) === 'partial' ? 'partial' : 'resolved';
    }

    // Query/fragment delimiters inside ${...} belong to the expression.
    // Encode placeholders during URL parsing so operators cannot change URL structure.
    private pathnameTemplate(url: string, normalize: boolean): string {
        let path = '';
        for (let index = 0; index < url.length; index++) {
            if (url[index] === '?' || url[index] === '#') { break; }
            if (url.startsWith('${', index)) {
                const end = this.findTopLevelDelimiter(url, index + 2, '}');
                if (end === null || end === url.length) { return normalize ? path + '{dynamic}' : 'partial'; }
                const expression = url.slice(index + 2, end).trim();
                if (!normalize && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expression)) { return 'partial'; }
                const placeholder = `{${expression}}`;
                path += normalize && /^[a-z][a-z\d+.-]*:\/\//i.test(url)
                    ? encodeURIComponent(placeholder) : placeholder;
                index = end;
            } else {
                path += url[index];
            }
        }
        return normalize ? path : 'resolved';
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

    private parseRouteExpression(expression: string, normalize = true): {
    path: string;
    resolution: 'resolved' | 'partial' | 'unresolved';
} | null {

    const trimmed = expression.trim();

    const rawUrl = this.stringLiteralValue(trimmed);

    if (rawUrl !== null) {

        return {
            path: normalize ? this.normalizeUrl(rawUrl) : rawUrl,
            resolution: rawUrl.includes('${')
                ? this.classifyTemplateResolution(rawUrl)
                : 'resolved'
        };
    }

    if (this.findTopLevelDelimiter(trimmed, 0, '+') !== trimmed.length) {
        const concatenated =
            this.normalizeConcatenatedRoute(trimmed);

        if (!concatenated) {
            return null;
        }

        return {
            path: normalize ? this.normalizeUrl(concatenated.path) : concatenated.path,
            resolution: concatenated.resolution
        };
    }

    return trimmed ? { path: trimmed, resolution: 'unresolved' } : null;
}

private extractFetchMethod(optionsExpression: string | null): string {

    if (!optionsExpression) {
        return 'GET';
    }

    const options = optionsExpression.trim();
    const value = options.startsWith('{') && options.endsWith('}')
        ? this.objectProperty(options.slice(1, -1), 'method') : null;
    const methodMatch = value?.match(/^["'`](GET|POST|PUT|DELETE|PATCH)["'`]$/i);

    if (!methodMatch) {
        return 'GET';
    }

    return methodMatch[1].toUpperCase();
}
}
