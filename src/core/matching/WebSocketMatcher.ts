import { calcChildStagger } from 'framer-motion';
import { WebSocketCall } from '../models/WebSocketCall';
import { WebSocketEndpoint } from '../models/WebSocketEndpoint';
import { WebSocketMatchResult } from '../models/WebSocketMatchResult';
import { SpringEndpointScanner } from '../parsing/spring/SpringEndpointScanner';
import { resourceLimits } from 'node:worker_threads';


export class WebSocketMatcher{

    public match(
        calls: WebSocketCall[],
        endpoints: WebSocketEndpoint[],

    ): WebSocketMatchResult[]{

        const results: WebSocketMatchResult[]=[];

        const publishCalls= calls.filter(
            call => call.type==='publish'
        );

        for(const call of publishCalls){
            const endpoint = endpoints.find(
                endpoint => 
                    endpoint.inboundDestination === call.destination
            );

            results.push({
                call,
                endpoint,
                matched: endpoint !==undefined
            });
        }

        return results;

    }
}