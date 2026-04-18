import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { CaptureStore } from './capture-store';
import { TerminalManager } from './terminal-manager';
import { ClawsRequest, ClawsResponse, HistoryEvent, PROTOCOL_VERSION } from './protocol';
import { stripAnsi } from './ansi-strip';
import {
  ServerConfigProvider,
  defaultServerConfig,
} from './server-config';

const MAX_READLOG_BYTES = 512 * 1024;
const DEFAULT_SOCKET_REL = '.claws/claws.sock';
const MAX_LINE_BYTES = 1024 * 1024;
// How long to wait for an existing socket to respond before declaring it
// stale. 250ms is a live-server SLA on localhost — a real server answers in
// single-digit ms; no answer means nobody's there.
const STALE_PROBE_TIMEOUT_MS = 250;

export interface ServerOptions {
  workspaceRoot: string;
  socketRel: string;
  captureStore: CaptureStore;
  terminalManager: TerminalManager;
  logger: (msg: string) => void;
  history: HistoryEvent[];
  execWaiters: WeakMap<vscode.Terminal, Array<(ev: HistoryEvent) => void>>;
  /**
   * Optional live-config reader. If omitted the server uses hard-coded
   * defaults (180s exec timeout, 100 poll limit). The extension wires this
   * up to `vscode.workspace.getConfiguration('claws')` so the values react
   * to `settings.json` edits without a reload.
   */
  getConfig?: ServerConfigProvider;
}

export class ClawsServer {
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private startError: Error | null = null;

  constructor(private readonly opts: ServerOptions) {}

  /**
   * Begin listening on the Unix socket. This method is "fire-and-forget"
   * from the caller's perspective but internally runs an async stale-socket
   * probe before bind — on collision with a live server it logs to the
   * diagnostic channel and stashes `startError` for later inspection via
   * `getStartError()`. The caller may also `await start()` directly to wait
   * on bind completion.
   */
  start(): Promise<void> {
    const socketRel = this.opts.socketRel || DEFAULT_SOCKET_REL;
    this.socketPath = path.join(this.opts.workspaceRoot, socketRel);
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    // NB: this promise resolves on success OR failure — failure is captured
    // in `startError` for the caller to inspect. Returning a never-rejecting
    // promise keeps fire-and-forget callers (`srv.start()`) safe from
    // unhandledRejection noise.
    return this.prepareSocket(this.socketPath).then(() => this.bind(this.socketPath!))
      .catch((err) => {
        this.startError = err instanceof Error ? err : new Error(String(err));
        this.opts.logger(`[claws] server start failed: ${this.startError.message}`);
      });
  }

  /** Null unless a previous start() rejected. */
  getStartError(): Error | null {
    return this.startError;
  }

  stop(): void {
    try { this.server?.close(); } catch { /* ignore */ }
    try { if (this.socketPath) fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
    this.server = null;
  }

  getSocketPath(): string | null { return this.socketPath; }

  /**
   * Stale-socket check + unlink. If another live server is already bound to
   * this path, reject loudly — silently stealing the socket is how two
   * VS Code windows race each other into client confusion.
   */
  private async prepareSocket(sockPath: string): Promise<void> {
    if (!fs.existsSync(sockPath)) return;
    const occupied = await this.probeSocket(sockPath);
    if (occupied) {
      throw new Error(
        `refusing to start: another server is already listening on ${sockPath}. ` +
        `Close the other VS Code window or delete the socket manually.`,
      );
    }
    try { fs.unlinkSync(sockPath); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new Error(`unable to remove stale socket ${sockPath}: ${(err as Error).message}`);
      }
    }
  }

  private probeSocket(sockPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const client = net.createConnection(sockPath);
      const finish = (alive: boolean): void => {
        try { client.destroy(); } catch { /* ignore */ }
        resolve(alive);
      };
      client.once('connect', () => finish(true));
      client.once('error', (err: NodeJS.ErrnoException) => {
        // ECONNREFUSED = socket file exists but no one is accept()ing.
        // ENOENT      = file disappeared between stat and connect.
        // Anything else (EACCES, ENOTSOCK) = corrupted path — treat as
        // stale so we don't get stuck in a hard-refuse loop on a bad FS.
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') return finish(false);
        return finish(false);
      });
      setTimeout(() => finish(false), STALE_PROBE_TIMEOUT_MS);
    });
  }

  private bind(sockPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));

      // Restrict file mode from birth by tightening umask around the bind.
      // On macOS & Linux net.Server.listen creates the inode with
      // (0o777 & ~umask), so umask(0o077) yields 0700 on the socket — good
      // enough to prevent other-user access. We belt-and-brace with an
      // explicit chmod in the listen callback in case VS Code's umask is
      // unusual under Electron.
      const prevUmask = process.umask(0o077);
      try {
        this.server.once('listening', () => {
          try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
          this.opts.logger(`[claws] listening on ${sockPath}`);
          resolve();
        });
        this.server.once('error', (err) => {
          this.opts.logger(`[server error] ${err}`);
          reject(err);
        });
        this.server.listen(sockPath);
      } finally {
        process.umask(prevUmask);
      }
    });
  }

  private handleConnection(socket: net.Socket): void {
    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString('utf8');
      if (buf.length > MAX_LINE_BYTES) {
        try {
          socket.write(this.encode(undefined, { ok: false, error: 'request too large' }) + '\n');
        } catch { /* ignore */ }
        this.opts.logger(`[socket] closing — line buffer exceeded ${MAX_LINE_BYTES} bytes`);
        try { socket.destroy(); } catch { /* ignore */ }
        buf = '';
        return;
      }
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req: ClawsRequest;
        try {
          req = JSON.parse(line);
        } catch {
          socket.write(this.encode(undefined, { ok: false, error: 'bad json' }) + '\n');
          continue;
        }
        // Protocol tag check (v1 only for now). Absent = claws/1.
        if (req.protocol && req.protocol !== PROTOCOL_VERSION) {
          socket.write(this.encode(req.id, {
            ok: false,
            error: `incompatible protocol version (server: ${PROTOCOL_VERSION}, client: ${req.protocol})`,
          }) + '\n');
          continue;
        }
        this.handle(req).then((resp) => {
          socket.write(this.encode(req.id, resp) + '\n');
        }).catch((err) => {
          socket.write(this.encode(req.id, {
            ok: false,
            error: String((err && err.message) || err),
          }) + '\n');
        });
      }
    });
    socket.on('error', (err) => this.opts.logger(`[socket error] ${err}`));
  }

  // Emit a response frame. Includes `id` (legacy correlation key), `rid`
  // (guaranteed-unshadowed request id), and `protocol` tag. Fields from
  // `body` can override everything EXCEPT `rid` and `protocol`.
  private encode(reqId: number | string | undefined, body: ClawsResponse | Record<string, unknown>): string {
    return JSON.stringify({
      id: reqId,
      ...body,
      rid: reqId,
      protocol: PROTOCOL_VERSION,
    });
  }

  private getConfig() {
    return this.opts.getConfig ? this.opts.getConfig() : defaultServerConfig;
  }

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
      // `mode` is part of the contract — see protocol.ts comments on
      // SendRequest for the semantic delta between the two paths.
      if (rec.pty) {
        rec.pty.writeInjected(text, newline, r.paste === true);
        return { ok: true, mode: 'wrapped' };
      }
      rec.terminal.sendText(text, newline);
      return { ok: true, mode: 'unwrapped' };
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
      const timeoutMs = r.timeoutMs || this.getConfig().execTimeoutMs;
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
      const r = req as ClawsRequest & { since?: number; limit?: number };
      const sinceSeq = r.since ?? 0;
      const all = this.opts.history.filter((ev) => ev.seq > sinceSeq);
      const configLimit = this.getConfig().pollLimit;
      // Client-requested limit is an upper bound only — it cannot exceed
      // the server's configured max, which exists so a buggy client asking
      // for limit:1e9 doesn't blow up the JSON serialiser.
      const limit = r.limit != null ? Math.min(r.limit, configLimit) : configLimit;
      const truncated = all.length > limit;
      const events = truncated ? all.slice(-limit) : all;
      return {
        ok: true,
        events,
        cursor: events.length ? events[events.length - 1].seq : sinceSeq,
        truncated,
        limit,
      };
    }

    if (cmd === 'close') {
      const r = req as ClawsRequest & { id: string | number };
      const ok = tm.close(r.id);
      // Idempotent: closing an already-closed/unknown id is not an error.
      // Clients shouldn't need to track local state to avoid racing their
      // own cleanup with ours. `alreadyClosed` is the signal when the id
      // wasn't known at close time.
      if (!ok) return { ok: true, alreadyClosed: true };
      return { ok: true, alreadyClosed: false };
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
