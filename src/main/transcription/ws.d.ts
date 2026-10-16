/** Minimal surface of ws 8.22.0 used by the main-only transport; checked against upstream doc/ws.md. */
declare module 'ws' {
  import { EventEmitter } from 'node:events';
  export default class WebSocket extends EventEmitter {
    constructor(url: string, options: { headers: Record<string, string>; perMessageDeflate: false; maxPayload: number; handshakeTimeout: number; followRedirects: false });
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: Uint8Array | string, options: { binary: boolean; compress: false }, callback: (error?: Error) => void): void;
    terminate(): void;
  }
}
