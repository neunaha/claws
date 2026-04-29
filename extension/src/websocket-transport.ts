/**
 * L19 TRANSPORT-X — WebSocket server that adapts the ws:// protocol to the
 * same newline-delimited JSON frame contract used by the Unix socket transport.
 *
 * Each WebSocket message = one JSON frame (no newline needed; WebSocket has
 * its own message boundaries). The adapter wraps each WebSocket connection
 * in a thin net.Socket-compatible shim so `ClawsServer.handleConnection()`
 * can be reused without modification.
 *
 * Loaded lazily — require('ws') is only called when webSocket.enabled=true,
 * so the extension imposes no load-time cost when WebSocket is disabled.
 */

import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import { EventEmitter } from 'events';

/** Minimal subset of ws.WebSocket we use — avoids a hard import at the top level. */
interface WsSocket extends EventEmitter {
  send(data: string): void;
  terminate(): void;
  readyState: number;
}

/** Minimal subset of ws.WebSocketServer options we use. */
interface WsServerOptions {
  server: http.Server | https.Server;
}

/** Minimal subset of ws.WebSocketServer we use. */
interface WsServer extends EventEmitter {
  close(cb?: () => void): void;
}

/** WsSocketAdapter wraps a ws.WebSocket in a net.Socket-like interface. */
class WsSocketAdapter extends EventEmitter {
  private _destroyed = false;

  constructor(private readonly ws: WsSocket) {
    super();
    ws.on('message', (data: Buffer | string) => {
      // Each WebSocket message is one complete JSON frame; append \n so the
      // server's line-buffering logic sees a complete line.
      const str = typeof data === 'string' ? data : data.toString('utf8');
      this.emit('data', Buffer.from(str + '\n'));
    });
    ws.on('close', () => {
      if (!this._destroyed) {
        this._destroyed = true;
        this.emit('end');
        this.emit('close');
      }
    });
    ws.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  write(data: string | Buffer): boolean {
    if (this._destroyed) return false;
    const str = typeof data === 'string' ? data : data.toString('utf8');
    // Strip the trailing \n that the server appends — WebSocket framing
    // handles message boundaries without it.
    const frame = str.endsWith('\n') ? str.slice(0, -1) : str;
    try {
      this.ws.send(frame);
    } catch { /* connection may have closed between check and send */ }
    return true;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    try { this.ws.terminate(); } catch { /* ignore */ }
    this.emit('close');
  }

  get destroyed(): boolean { return this._destroyed; }

  /** Compatibility stub — WebSocket has its own backpressure, always report no pressure. */
  get writableLength(): number { return 0; }
}

export interface WebSocketTransportOptions {
  port: number;
  certPath?: string;
  keyPath?: string;
  logger: (msg: string) => void;
  /** Called for each new WebSocket connection with the adapted socket shim. */
  onConnection: (socket: net.Socket) => void;
}

export class WebSocketTransport {
  private wsServer: WsServer | null = null;
  private httpServer: http.Server | https.Server | null = null;

  start(opts: WebSocketTransportOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      let WS: new (opts: WsServerOptions) => WsServer;
      try {
        const wsModule = require('ws') as { WebSocketServer: typeof WS };
        WS = wsModule.WebSocketServer;
      } catch {
        return reject(new Error(
          'ws module not available — install it as an optional dependency: npm install ws',
        ));
      }

      const useTls = Boolean(opts.certPath && opts.keyPath);
      if (useTls) {
        let cert: Buffer;
        let key: Buffer;
        try {
          cert = fs.readFileSync(opts.certPath!);
          key = fs.readFileSync(opts.keyPath!);
        } catch (err) {
          return reject(new Error(`WebSocket TLS: failed to read cert/key — ${(err as Error).message}`));
        }
        this.httpServer = https.createServer({ cert, key });
      } else {
        this.httpServer = http.createServer();
      }

      this.wsServer = new WS({ server: this.httpServer });

      this.wsServer.on('connection', (ws: WsSocket) => {
        const adapter = new WsSocketAdapter(ws);
        // Cast: our adapter satisfies the interface ClawsServer.handleConnection expects
        opts.onConnection(adapter as unknown as net.Socket);
      });

      this.httpServer.once('error', (err) => {
        reject(err);
      });

      this.httpServer.listen(opts.port, '127.0.0.1', () => {
        const proto = useTls ? 'wss' : 'ws';
        opts.logger(`[claws/ws] listening on ${proto}://127.0.0.1:${opts.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    try { this.wsServer?.close(); } catch { /* ignore */ }
    try { this.httpServer?.close(); } catch { /* ignore */ }
    this.wsServer = null;
    this.httpServer = null;
  }
}
