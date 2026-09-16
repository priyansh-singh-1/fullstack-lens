import * as fs from 'fs';
import { ProjectFile } from '../../models/ProjectFile';
import { WebSocketCall } from '../../models/WebSocketCall';
import { label } from 'framer-motion/client';

export class FrontendWebSocketScanner{

    public scan(files: ProjectFile[]): WebSocketCall[]{
        const calls: WebSocketCall[]=[];

        const frontendFiles= files.filter(
            file=>
                file.language==='javascript'||
                file.language==='typescript'
        );

        for(const file of frontendFiles){
            const content= fs.readFileSync(
                file.path,
                'utf-8'
            );

            this.scanPublishCalls(
                content,
                file.path,
                calls
            );

            this.scanSubscribeCalls(
                content,
                file.path,
                calls
            );
        }

        return calls;

    }

        // Detect:
    //
    // client.publish({
    //     destination: "/app/chat.send"
    // })

    private scanPublishCalls( //stompClient.publish
        content: string,
        filePath: string,
        calls: WebSocketCall[]
    ): void{
        
        const regex= /\.publish\s*\(\s*\{[\s\S]*?destination\s*:\s*["'`]([^"'`]+)["'`][\s\S]*?\}\s*\)/gi;

        let match: RegExpExecArray | null;

        while((match = regex.exec(content))!==null){
            const line= content
            .substring(0,match.index)
            .split('\n')
            .length-1;

            calls.push({
                type:'publish',
                destination: match[1],
                filePath,
                line
            });
        }
    }

        // Detect:
    //
    // client.subscribe(
    //     "/topic/messages",
    //     callback
    // )

    private scanSubscribeCalls( //stompClient.subscribe
        content: string,
        filePath: string,
        calls: WebSocketCall[]
    ): void{
        const regex= /\.subscribe\s*\(\s*["'`]([^"'`]+)["'`]/gi;

        let match: RegExpExecArray| null;

        while((match = regex.exec(content))!==null){
            const line= 
            content 
            .substring(0,match.index)
            .split('\n')
            .length-1;

            calls.push({
                type:'subscribe',
                destination:match[1],
                filePath,
                line
            });
        }
    }
}