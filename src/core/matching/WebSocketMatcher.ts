import { WebSocketCall } from '../models/WebSocketCall';
import { WebSocketEndpoint } from '../models/WebSocketEndpoint';
import { WebSocketMatchResult } from '../models/WebSocketMatchResult';


export class WebSocketMatcher{

    public match(
        calls: WebSocketCall[],
        endpoints: WebSocketEndpoint[],
        usages?: Map<WebSocketEndpoint, WebSocketCall[]>,

    ): WebSocketMatchResult[]{

        const results: WebSocketMatchResult[]=[];

        const callsByDestination = new Map<string, WebSocketCall[]>();
        for (const call of calls) {
            if (call.type !== 'publish') {
                continue;
            }
            const destinationCalls = callsByDestination.get(call.destination) ?? [];
            destinationCalls.push(call);
            callsByDestination.set(call.destination, destinationCalls);
        }
        const firstEndpointByDestination = new Map<string, WebSocketEndpoint>();
        for (const endpoint of endpoints) {
            if (!firstEndpointByDestination.has(endpoint.inboundDestination)) {
                firstEndpointByDestination.set(endpoint.inboundDestination, endpoint);
            }
            usages?.set(endpoint, callsByDestination.get(endpoint.inboundDestination) ?? []);
        }
        for (const call of calls) {
            if (call.type !== 'publish') {
                continue;
            }
            const endpoint = firstEndpointByDestination.get(call.destination);

            results.push({
                call,
                endpoint,
                matched: endpoint !==undefined
            });
        }

        return results;

    }
}