import { label } from 'framer-motion/client';
export interface WebSocketEndpoint{
    inboundDestination: string; //where frontend will publish the message (@MessageMapping)
    outboundDestination?: string; // where backend will broadcast (@SendTO)
    filePath: string;
    line: number
}