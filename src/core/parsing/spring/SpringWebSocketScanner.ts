import * as fs from 'fs';

import { ProjectFile } from '../../models/ProjectFile';

import {WebSocketEndpoint} from '../../models/WebSocketEndpoint';
import { SpringEndpointScanner } from './SpringEndpointScanner';
import { b } from 'framer-motion/m';


export class SpringWebSocketScanner{
    public scan(files: ProjectFile[]): WebSocketEndpoint[]{
        const endpoints: WebSocketEndpoint[]=[];
            const javaFiles= files.filter(
                file => file.language==='java'

            );

            const appPrefix= this.findApplicationPrefix(javaFiles);

            for(const file of javaFiles){
                const content= fs.readFileSync(
                    file.path,
                    'utf-8'
                );

                if(!content.includes('@MessageMapping')){
                    continue;
                }  
                
                const messageRegex= /@MessageMapping\s*\(\s*["']([^"']+)["']\s*\)/g;

                let match: RegExpExecArray | null;

                while ((match= messageRegex.exec(content))!==null){
                    const messagePath= match[1];

                    const inboundDestination= 
                    this.combinePath(
                        appPrefix,
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
            }
            return endpoints;

        
    }

    private findApplicationPrefix(
        javaFiles: ProjectFile[]
    ): string{
        for(const file of javaFiles){
            const content= fs.readFileSync(
                file.path,
                'utf-8'
            );

            const match=/setApplicationDestinationPrefixes\s*\(\s*["']([^"']+)["']\s*\)/.exec(content);

            if(match){
                return match[1];
            }
        }
        return '';
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