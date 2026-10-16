import * as fs from 'fs';

import { ProjectFile } from '../../models/ProjectFile';

import {WebSocketEndpoint} from '../../models/WebSocketEndpoint';
import { SpringEndpointScanner } from './SpringEndpointScanner';
import { b } from 'framer-motion/m';


export class SpringWebSocketScanner{
    public scan(files: ProjectFile[]): WebSocketEndpoint[] {
        const sources = files.filter(file => file.language === 'java').map(file => ({
            file, source: fs.readFileSync(file.path, 'utf-8')
        }));
        const applicationPrefix = sources.map(({ file, source }) =>
            this.discoverApplicationPrefix(file, source)
        ).find(prefix => prefix !== undefined) ?? '';
        return sources.flatMap(({ file, source }) => this.scanFile(file, source, applicationPrefix));
    }

    /** First prefix in this Java source; callers select the first defined workspace result. */
    public discoverApplicationPrefix(file: ProjectFile, source: string): string | undefined {
        if (file.language !== 'java') { return undefined; }
        return /setApplicationDestinationPrefixes\s*\(\s*["']([^"']+)["']\s*\)/.exec(source)?.[1];
    }

    /** Resolve mappings using the workspace prefix, without reading other sources. */
    public scanFile(file: ProjectFile, source: string, applicationPrefix: string): WebSocketEndpoint[] {
        const endpoints: WebSocketEndpoint[] = [];
        if (file.language !== 'java') { return endpoints; }
        const content = source;
        if(!content.includes('@MessageMapping')){
            return endpoints;
        }

        const messageRegex= /@MessageMapping\s*\(\s*["']([^"']+)["']\s*\)/g;

        let match: RegExpExecArray | null;

        while ((match= messageRegex.exec(content))!==null){
            const messagePath= match[1];

            const inboundDestination=
            this.combinePath(
                applicationPrefix,
                messagePath
            );

            const line= content.substring(
                0,
                match.index
            ).split('\n').length-1;

            const outboundDestination=
            this.findSendToNearMatch(
                content,
                match.index
            );

            endpoints.push({
                inboundDestination,
                outboundDestination,
                filePath:file.path,
                line
            });
        }
        return endpoints;
    }

    private findSendToNearMatch(
        content: string,
        messageIndex: number
    ): string| undefined{

        const nearbyContent= content.substring(
            messageIndex,
            messageIndex+500
        );

        const match= /@SendTo\s*\(\s*["']([^"']+)["']\s*\)/.exec(
                nearbyContent
            );

            if(!match){
                return undefined;
            }

            return match[1];
    }

    private combinePath(
        base: string,
        path: string
    ): string{
        const normalizedBase = base.replace(/\/+$/,'');

        const normalizedPath= path.replace(/^\/+/, '');

        if(!normalizedBase){
            return `/${normalizedPath}`;
        }

        return `${normalizedBase}/${normalizedPath}`;
    }
}