export type WebSocketCallType= 
| 'publish'
| 'subscribe';

export interface WebSocketCall{
    type: WebSocketCallType;
    destination: string;
    filePath: string;
    line: number;
}