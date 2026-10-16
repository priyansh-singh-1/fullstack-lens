import * as fs from 'fs';
import { ProjectFile } from '../../models/ProjectFile';
import { WebSocketCall } from '../../models/WebSocketCall';
import { label } from 'framer-motion/client';

export class FrontendWebSocketScanner{

    public scan(files: ProjectFile[]): WebSocketCall[] {
        return files.filter(file =>
            file.language === 'javascript' || file.language === 'typescript'
        ).flatMap(file => this.scanFile(file, fs.readFileSync(file.path, 'utf-8')));
    }

    /** Publish calls precede subscriptions, matching the full-scan path. */
    public scanFile(file: ProjectFile, source: string): WebSocketCall[] {
        if (file.language !== 'javascript' && file.language !== 'typescript') { return []; }
        const calls: WebSocketCall[] = [];
        this.scanPublishCalls(source, file.path, calls);
        this.scanSubscribeCalls(source, file.path, calls);
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