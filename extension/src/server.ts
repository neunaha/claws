import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { CaptureStore } from './capture-store';
import { TerminalManager } from './terminal-manager';
import { ClawsRequest, ClawsResponse, HistoryEvent } from './protocol';
import { stripAnsi } from './ansi-strip';

const MAX_READLOG_BYTES = 512 * 1024;
const DEFAULT_SOCKET_REL = '.claws/claws.sock';

export interface ServerOptions {
  workspaceRoot: string;
  socketRel: string;
  captureStore: CaptureStore;
  terminalManager: TerminalManager;
  logger: (msg: string) => void;
  history: HistoryEvent[];
  execWaiters: WeakMap<vscode.Terminal, Array<(ev: HistoryEvent) => void>>;
}

export class ClawsServer {
  private server: net.Server | null = null;
  private socketPath: string | null = null;

  constructor(private readonly opts: ServerOptions) {}

  start(): void {
    const socketRel = this.opts.socketRel || DEFAULT_SOCKET_REL;
    this.socketPath = path.join(this.opts.workspaceRoot, socketRel);
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }

    this.server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (data) => {
        buf += data.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let req: ClawsRequest;
          try {
            req = JSON.parse(line);
          } catch {
            socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n');
            continue;
          }
          this.handle(req).then((resp) => {
            socket.write(JSON.stringify({ id: req.id, ...resp }) + '\n');
          }).catch((err) => {
            socket.write(JSON.stringify({
              id: req.id,
              ok: false,
              error: String((err && err.message) || err),
            }) + '\n');
          });
        }
      });
      socket.on('error', (err) => this.opts.logger(`[socket error] ${err}`));
    });

    this.server.listen(this.socketPath, () => {
      try { fs.chmodSync(this.socketPath!, 0o600); } catch { /* ignore */ }
      this.opts.logger(`[claws] listening on ${this.socketPath}`);
    });
    this.server.on('error', (err) => this.opts.logger(`[server error] ${err}`));
  }

  stop(): void {
    try { this.server?.close(); } catch { /* ignore */ }
    try { if (this.socketPath) fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
    this.server = null;
  }

  getSocketPath(): string | null { return this.socketPath; }

  private async handle(req: ClawsRequest): Promise<ClawsResponse> {
    const { cmd } = req;
    const tm = this.opts.terminalManager;

    if (cmd === 'list') {
      return { ok: true, terminals: await tm.describeAll() };
    }

    if (cmd === 'create') {
      const r = req as ClawsRequest & {
        name?: string; cwd?: string; wrapped?: boolean; shellPath?: string;
        env?: Record<string, string>; show?: boolean; preserveFocus?: boolean;
      };
      if (r.wrapped === true) {
        const { id } = tm.createWrapped(r);
        return { ok: true, id, logPath: null, wrapped: true };
      }
      const { id } = tm.createStandard(r);
      return { ok: true, id, wrapped: false };
    }

    if (cmd === 'show') {
      const r = req as ClawsRequest & { id: string | number; preserveFocus?: boolean };
      const t = tm.terminalById(r.id);
      if (!t) return { ok: false, error: `unknown terminal id ${r.id}` };
      t.show(r.preserveFocus !== false);
      return { ok: true };
    }

    if (cmd === 'send') {
      const r = req as ClawsRequest & {
        id: string | number; text?: string; newline?: boolean;
        show?: boolean; paste?: boolean;
      };
      const rec = tm.recordById(r.id);
      if (!rec) return { ok: false, error: `unknown terminal id ${r.id}` };
      if (r.show !== false) rec.terminal.show(true);
      const text = r.text ?? '';
      const newline = r.newline !== false;
      if (rec.pty) {
        rec.pty.writeInjected(text, newline, r.paste === true);
      } else {
        rec.terminal.sendText(text, newline);
      }
      return { ok: true };
    }

    if (cmd === 'exec') {
      const r = req as ClawsRequest & {
        id: string | number; command: string; timeoutMs?: number; show?: boolean;
      };
      const rec = tm.recordById(r.id);
      if (!rec) return { ok: false, error: `unknown terminal id ${r.id}` };
      if (r.show !== false) rec.terminal.show(true);
      if (!rec.terminal.shellIntegration) {
        if (rec.pty) {
          rec.pty.writeInjected(r.command, true, false);
        } else {
          rec.terminal.sendText(r.command, true);
        }
        return {
          ok: true,
          degraded: true,
          note: 'no shell integration active; output not captured via exec — use readLog on wrapped terminals',
        };
      }
      const timeoutMs = r.timeoutMs || 180000;
      const event = await new Promise<HistoryEvent>((resolve, reject) => {
        const list = this.opts.execWaiters.get(rec.terminal) || [];
        const resolver = (ev: HistoryEvent) => { clearTimeout(timer); resolve(ev); };
        const timer = setTimeout(() => {
          const i = list.indexOf(resolver);
          if (i >= 0) list.splice(i, 1);
          reject(new Error(`exec timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        list.push(resolver);
        this.opts.execWaiters.set(rec.terminal, list);
        try {
          rec.terminal.shellIntegration!.executeCommand(r.command);
        } catch (err) {
          clearTimeout(timer);
          const i = list.indexOf(resolver);
          if (i >= 0) list.splice(i, 1);
          reject(err);
        }
      });
      return { ok: true, event };
    }

    if (cmd === 'read') {
      const r = req as ClawsRequest & { id?: string | number; since?: number; limit?: number };
      const sinceSeq = r.since ?? 0;
      const limit = r.limit ?? 50;
      const filtered = this.opts.history.filter((ev) => {
        if (ev.seq <= sinceSeq) return false;
        if (r.id != null && ev.terminalId !== String(r.id)) return false;
        return true;
      });
      const slice = filtered.slice(-limit);
      return {
        ok: true,
        events: slice,
        cursor: slice.length ? slice[slice.length - 1].seq : sinceSeq,
      };
    }

    if (cmd === 'poll') {
      const r = req as ClawsRequest & { since?: number };
      const sinceSeq = r.since ?? 0;
      const events = this.opts.history.filter((ev) => ev.seq > sinceSeq);
      return {
        ok: true,
        events,
        cursor: events.length ? events[events.length - 1].seq : sinceSeq,
      };
    }

    if (cmd === 'close') {
      const r = req as ClawsRequest & { id: string | number };
      const ok = tm.close(r.id);
      if (!ok) return { ok: false, error: `unknown terminal id ${r.id}` };
      return { ok: true };
    }

    if (cmd === 'readLog') {
      const r = req as ClawsRequest & {
        id: string | number; offset?: number; limit?: number; strip?: boolean;
      };
      const rec = tm.recordById(r.id);
      if (!rec) return { ok: false, error: `unknown terminal id ${r.id}` };
      const strip = r.strip !== false;
      const limit = Math.min(r.limit || MAX_READLOG_BYTES, MAX_READLOG_BYTES);

      if (rec.wrapped && rec.pty) {
        const slice = this.opts.captureStore.read(String(r.id), r.offset, limit, strip);
        return {
          ok: true,
          bytes: slice.bytes,
          offset: slice.offset,
          nextOffset: slice.nextOffset,
          totalSize: slice.totalSize,
          truncated: slice.truncated,
          logPath: null,
        };
      }

      if (rec.logPath && fs.existsSync(rec.logPath)) {
        try {
          const stat = fs.statSync(rec.logPath);
          const totalSize = stat.size;
          let offset = r.offset;
          if (offset == null) offset = Math.max(0, totalSize - limit);
          const fd = fs.openSync(rec.logPath, 'r');
          try {
            const buf = Buffer.alloc(Math.min(limit, totalSize - offset));
            fs.readSync(fd, buf, 0, buf.length, offset);
            let text = buf.toString('utf8');
            if (strip) text = stripAnsi(text);
            return {
              ok: true,
              bytes: text,
              offset,
              nextOffset: offset + buf.length,
              totalSize,
              truncated: totalSize > offset + buf.length,
              logPath: rec.logPath,
            };
          } finally {
            fs.closeSync(fd);
          }
        } catch (err) {
          return { ok: false, error: `read failed: ${(err as Error).message}` };
        }
      }

      return { ok: false, error: `terminal ${r.id} is not wrapped (no log available)` };
    }

    return { ok: false, error: `unknown cmd: ${cmd}` };
  }
}
