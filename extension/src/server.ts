import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { CaptureStore } from './capture-store';
import { TerminalManager } from './terminal-manager';
import { ClawsRequest, ClawsResponse, HistoryEvent, PROTOCOL_VERSION, PROTOCOL_VERSION_V2 } from './protocol';
import { stripAnsi } from './ansi-strip';
import {
  ServerConfigProvider,
  defaultServerConfig,
} from './server-config';
import { PeerConnection, ClawsRole, allocPeerId, matchTopic } from './peer-registry';
import { TaskRecord, allocTaskId } from './task-registry';
import { LifecycleStore } from './lifecycle-store';
import { EnvelopeV1 } from './event-schemas';
import { schemaForTopic } from './topic-registry';
import { EventLogWriter } from './event-log';

/**
 * Per-connection context threaded into `handle()`. Holds the raw socket
 * plus closures for reading/writing the peerId and negotiated protocol
 * captured in the `handleConnection` local scope.
 */
interface ConnCtx {
  socket: net.Socket;
  getPeerId(): string | null;
  setPeerId(id: string): void;
  getNegotiatedProtocol(): string;
  setNegotiatedProtocol(p: string): void;
}

const MAX_READLOG_BYTES = 512 * 1024;
const DEFAULT_SOCKET_REL = '.claws/claws.sock';
const MAX_LINE_BYTES = 1024 * 1024;
// How long to wait for an existing socket to respond before declaring it
// stale. 250ms is a live-server SLA on localhost — a real server answers in
// single-digit ms; no answer means nobody's there.
const STALE_PROBE_TIMEOUT_MS = 250;

/**
 * Lightweight snapshot of extension state used by the `introspect` command.
 * The extension passes in an accessor that returns this shape — the server
 * has no direct vscode dependency for introspect data.
 */
export interface IntrospectSnapshot {
  extensionVersion: string;
  nodePty: { loaded: boolean; loadedFrom?: string | null; error?: string };
  servers: Array<{ workspace: string; socket: string | null }>;
  terminals: number;
}

export type IntrospectProvider = () => IntrospectSnapshot;

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
  /**
   * Optional provider that returns a structured snapshot of extension + host
   * state — powers the `introspect` command and feeds the in-UI health-check
   * so both paths render the same data.
   */
  getIntrospect?: IntrospectProvider;
}

export class ClawsServer {
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private startError: Error | null = null;
  private readonly startedAt: number = Date.now();
  /** Client versions we've already warned about — one warning per run per version. */
  private readonly versionWarned = new Set<string>();
  /** claws/2 peer registry. Keyed by peerId. Cleared on stop(). */
  private readonly peers = new Map<string, PeerConnection>();
  /** Back-reference from raw socket → peerId, used during connection teardown. */
  private readonly socketToPeer = new WeakMap<net.Socket, string>();
  /** Monotonic peerId counter (the wire id itself is "p_" + hex). */
  private peerSeq = 0;
  /** topicPattern string → set of subscribing peerIds. Used by publish fan-out. */
  private readonly subscriptionIndex = new Map<string, Set<string>>();
  /** Monotonic subscriptionId counter. */
  private subSeq = 0;
  /** claws/2 task registry. Keyed by taskId. Cleared on stop(). */
  private readonly tasks = new Map<string, TaskRecord>();
  /** Monotonic taskId counter (wire id is "t_" + zero-padded 3 digits). */
  private taskSeq = 0;
  /** Server-owned lifecycle state. Gate checks and lifecycle.* commands use this. */
  private readonly lifecycleStore: LifecycleStore;

  private readonly eventLog = new EventLogWriter();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ServerOptions) {
    this.lifecycleStore = new LifecycleStore(opts.workspaceRoot);
  }

  /** Milliseconds since this server instance was constructed. */
  uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * Appends an event to the log and fans it out to subscribers. Skips both
   * steps if the event log is degraded. Errors are swallowed so callers
   * (heartbeat timer, task handlers) never crash the extension.
   */
  private async emitSystemEvent(topic: string, payload: unknown): Promise<void> {
    if (this.eventLog.isDegraded) return;
    try {
      const result = await this.eventLog.append({
        topic,
        from: 'server',
        ts_server: new Date().toISOString(),
        payload,
      });
      const sequence = result.sequence >= 0 ? result.sequence : undefined;
      this.fanOut(topic, 'server', payload, false, sequence);
    } catch {
      // heartbeat failures must never crash the extension
    }
  }

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
    return this.prepareSocket(this.socketPath)
      .then(() => this.eventLog.open(this.opts.workspaceRoot).catch((err: unknown) => {
        // Event log is non-fatal: log a warning and continue in degraded mode.
        this.opts.logger(`[claws] event log disabled at startup: ${String(err)}`);
      }))
      .then(() => this.bind(this.socketPath!))
      .then(() => {
        const intervalMs = this.getConfig().heartbeatIntervalMs;
        if (intervalMs > 0) {
          this.heartbeatTimer = setInterval(() => {
            void this.emitSystemEvent('system.heartbeat', {
              uptimeMs: this.uptimeMs(),
              peers: this.peers.size,
              terminals: this.opts.terminalManager.terminalCount,
            });
          }, intervalMs);
        }
      })
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
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Best-effort flush: manifest is written synchronously inside close(); the
    // stream.end() drain is async but VS Code deactivation gives it time.
    this.eventLog.close().catch(() => { /* best-effort */ });
    try { this.server?.close(); } catch { /* ignore */ }
    try { if (this.socketPath) fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
    this.server = null;
    this.peers.clear();
    this.subscriptionIndex.clear();
    this.subSeq = 0;
    this.tasks.clear();
    this.taskSeq = 0;
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
    // Per-connection state. `_peerId` is set by the `hello` handler once
    // the peer registers; remains null for plain claws/1 clients. The
    // negotiated protocol starts at 'claws/1' and is upgraded to 'claws/2'
    // on a successful hello handshake.
    let _peerId: string | null = null;
    let _protocol = 'claws/1';
    const ctx: ConnCtx = {
      socket,
      getPeerId: () => _peerId,
      setPeerId: (id) => { _peerId = id; },
      getNegotiatedProtocol: () => _protocol,
      setNegotiatedProtocol: (p) => { _protocol = p; },
    };
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
        // Protocol tag check. Absent = claws/1. Both v1 and v2 are accepted
        // on the wire; v2-only commands (hello/ping/publish/etc) enforce
        // stricter protocol requirements inside their individual handlers.
        const SUPPORTED_PROTOCOLS = ['claws/1', 'claws/2'];
        if (req.protocol && !SUPPORTED_PROTOCOLS.includes(req.protocol)) {
          socket.write(this.encode(req.id, { ok: false, error: 'incompatible protocol version' }) + '\n');
          continue;
        }
        // Client-version drift detection — warn once per version per run.
        const asAny = req as ClawsRequest & { clientVersion?: string; clientName?: string };
        if (asAny.clientVersion) this.maybeWarnClientVersion(asAny.clientVersion, asAny.clientName);
        this.handle(req, ctx).then((resp) => {
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
    socket.on('close', () => this.handleDisconnect(socket));
  }

  /**
   * Tear down all claws/2 bookkeeping for a socket that has closed. Plain
   * claws/1 connections were never registered and are a no-op. Removes the
   * peer from `peers` and prunes the subscription index.
   */
  private handleDisconnect(socket: net.Socket): void {
    const peerId = this.socketToPeer.get(socket);
    if (!peerId) return;
    const peer = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (peer) {
      for (const pattern of peer.subscriptions.values()) {
        const set = this.subscriptionIndex.get(pattern);
        if (set) { set.delete(peerId); if (set.size === 0) this.subscriptionIndex.delete(pattern); }
      }
    }
    // Close may fire after extension deactivate has torn down the output
    // channel; guard the logger so a teardown log line never crashes node.
    try { this.opts.logger(`[claws/2] peer disconnected: ${peerId}`); } catch { /* ignore */ }
  }

  // Emit a response frame. Includes `id` (legacy correlation key), `rid`
  // (guaranteed-unshadowed request id), and `protocol` tag. `rid` is
  // forced at the end so body cannot shadow it. `protocol` defaults to
  // claws/1 but body may override (e.g. the `hello` handler tags its
  // reply with claws/2 so the client can confirm negotiation).
  private encode(reqId: number | string | undefined, body: ClawsResponse | Record<string, unknown>): string {
    return JSON.stringify({
      id: reqId,
      protocol: PROTOCOL_VERSION,
      ...body,
      rid: reqId,
    });
  }

  /**
   * Sends an unsolicited push frame to a peer socket.
   * Push frames intentionally omit `rid` so clients can distinguish them
   * from responses (a frame with `rid` is a response; without is a push).
   */
  private pushFrame(
    socket: net.Socket, topic: string, from: string, payload: unknown, sequence?: number,
  ): void {
    const frame = JSON.stringify({
      push: 'message',
      protocol: PROTOCOL_VERSION_V2,
      topic,
      from,
      payload,
      sentAt: Date.now(),
      ...(sequence !== undefined ? { sequence } : {}),
    }) + '\n';
    try {
      socket.write(frame);
    } catch (err) {
      this.opts.logger(`[claws/2] push write failed for ${from}: ${err}`);
    }
  }

  /**
   * Delivers a published message to all peers subscribed to a matching pattern.
   * Returns the count of peers that received the message.
   */
  private fanOut(
    topic: string, from: string, payload: unknown, echo: boolean, sequence?: number,
  ): number {
    let count = 0;
    for (const [pattern, peerIds] of this.subscriptionIndex) {
      if (!matchTopic(topic, pattern)) continue;
      for (const peerId of peerIds) {
        if (!echo && peerId === from) continue;
        const peer = this.peers.get(peerId);
        if (!peer) continue;
        this.pushFrame(peer.socket, topic, from, payload, sequence);
        count++;
      }
    }
    return count;
  }

  /**
   * Durably append a server-originated event to the event log, then fan it out
   * to subscribers. Mirrors the publish handler's persist-then-fanout contract
   * for events the server emits on its own behalf (task.*, system.malformed.*).
   *
   * Degraded mode (sequence === -1): skips sequence in the push frame.
   * Real I/O error: falls back to fanOut without sequence so delivery still happens.
   */
  private async emitServerEvent(topic: string, payload: unknown): Promise<void> {
    let sequence: number | undefined;
    try {
      const logResult = await this.eventLog.append({
        topic,
        from: 'server',
        ts_server: new Date().toISOString(),
        payload,
      });
      sequence = logResult.sequence >= 0 ? logResult.sequence : undefined;
    } catch {
      // Real I/O error — fall through with no sequence so fan-out still fires.
    }
    this.fanOut(topic, 'server', payload, false, sequence);
  }

  private getConfig() {
    return this.opts.getConfig ? this.opts.getConfig() : defaultServerConfig;
  }

  /**
   * Compare a reported client version against the current extension version
   * (via the introspect provider) and log a one-shot warning on drift ≥ 1
   * minor release. Exact match and unknown-extension-version are silent.
   */
  private maybeWarnClientVersion(clientVersion: string, clientName?: string): void {
    if (!this.opts.getIntrospect) return;
    if (this.versionWarned.has(clientVersion)) return;
    const extVersion = this.opts.getIntrospect().extensionVersion;
    if (!extVersion || extVersion === '0.4.x') return;
    if (clientVersion === extVersion) return;
    const drift = compareMinorDrift(clientVersion, extVersion);
    if (drift >= 1) {
      this.versionWarned.add(clientVersion);
      const who = clientName ? ` ${clientName}` : '';
      this.opts.logger(
        `[claws] MCP server${who} version ${clientVersion} < extension version ${extVersion} — consider /claws-update`,
      );
    }
  }

  /** True if some peer has already registered with role 'orchestrator'. */
  private hasOrchestrator(): boolean {
    for (const p of this.peers.values()) if (p.role === 'orchestrator') return true;
    return false;
  }

  /** Allocate the next peerId for this server instance. */
  private allocPeerId(): string { return allocPeerId(++this.peerSeq); }

  /**
   * Reject a request if the peer hasn't completed `hello` or is not in
   * one of the accepted roles. Returns null when the peer is allowed to
   * proceed, or a ready-to-send error response otherwise. Unused by the
   * W3 handshake but the v2 handlers that follow (publish, task dispatch)
   * will rely on this gate.
   */
  private requireRole(ctx: ConnCtx, roles: ClawsRole[]): ClawsResponse | null {
    const pid = ctx.getPeerId();
    if (!pid) return { ok: false, error: 'call hello first' };
    const peer = this.peers.get(pid);
    if (!peer) return { ok: false, error: 'peer unknown' };
    if (!roles.includes(peer.role)) return { ok: false, error: `requires role: ${roles.join('|')}` };
    return null;
  }

  private async handle(req: ClawsRequest, ctx: ConnCtx): Promise<ClawsResponse> {
    const { cmd } = req;
    const tm = this.opts.terminalManager;

    if (cmd === 'list') {
      return { ok: true, terminals: await tm.describeAll() };
    }

    if (cmd === 'create') {
      if (!this.lifecycleStore.hasPlan()) {
        return {
          ok: false,
          error: 'lifecycle:plan-required',
          message: '[LIFECYCLE GATE] No PLAN logged. Call mcp__claws__claws_lifecycle_plan first.',
        };
      }
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

    if (cmd === 'introspect') {
      const snap = this.opts.getIntrospect ? this.opts.getIntrospect() : null;
      return {
        ok: true,
        protocol: PROTOCOL_VERSION,
        extensionVersion: snap?.extensionVersion ?? 'unknown',
        nodeVersion: process.version,
        electronAbi: Number(process.versions.modules),
        platform: `${process.platform}-${process.arch}`,
        nodePty: snap?.nodePty ?? { loaded: false },
        servers: snap?.servers ?? [{ workspace: this.opts.workspaceRoot, socket: this.socketPath }],
        terminals: snap?.terminals ?? 0,
        uptime_ms: this.uptimeMs(),
      };
    }

    if (cmd === 'hello') {
      const r = req as import('./protocol').HelloRequest;
      if (r.protocol !== 'claws/2') return { ok: false, error: 'hello requires protocol: claws/2' };
      if (r.role === 'orchestrator' && this.hasOrchestrator()) {
        return { ok: false, error: 'orchestrator already registered' };
      }
      const peerId = this.allocPeerId();
      const peer: PeerConnection = {
        peerId,
        role: r.role as ClawsRole,
        peerName: r.peerName ?? 'unnamed',
        terminalId: r.terminalId,
        capabilities: r.capabilities ?? [],
        socket: ctx.socket,
        subscriptions: new Map(),
        lastSeen: Date.now(),
        connectedAt: Date.now(),
      };
      this.peers.set(peerId, peer);
      this.socketToPeer.set(ctx.socket, peerId);
      ctx.setPeerId(peerId);
      ctx.setNegotiatedProtocol('claws/2');
      this.opts.logger(`[claws/2] peer registered: ${peerId} role=${peer.role} name=${peer.peerName}`);
      return {
        ok: true,
        peerId,
        protocol: PROTOCOL_VERSION_V2,
        serverCapabilities: ['push', 'broadcast', 'tasks'],
        orchestratorPresent: this.hasOrchestrator(),
      };
    }

    if (cmd === 'ping') {
      return { ok: true, serverTime: Date.now() };
    }

    if (cmd === 'subscribe') {
      const denied = this.requireRole(ctx, ['orchestrator', 'worker', 'observer']);
      if (denied) return denied;
      const r = req as import('./protocol').SubscribeRequest;
      if (!r.topic || typeof r.topic !== 'string') return { ok: false, error: 'topic required' };
      const peerId = ctx.getPeerId()!;
      const peer = this.peers.get(peerId)!;
      const subId = `s_${(++this.subSeq).toString(16).padStart(4, '0')}`;
      peer.subscriptions.set(subId, r.topic);
      if (!this.subscriptionIndex.has(r.topic)) this.subscriptionIndex.set(r.topic, new Set());
      this.subscriptionIndex.get(r.topic)!.add(peerId);
      return { ok: true, subscriptionId: subId };
    }

    if (cmd === 'unsubscribe') {
      const denied = this.requireRole(ctx, ['orchestrator', 'worker', 'observer']);
      if (denied) return denied;
      const r = req as import('./protocol').UnsubscribeRequest;
      const peerId = ctx.getPeerId()!;
      const peer = this.peers.get(peerId)!;
      const pattern = peer.subscriptions.get(r.subscriptionId);
      if (!pattern) return { ok: false, error: 'subscription not found' };
      peer.subscriptions.delete(r.subscriptionId);
      const set = this.subscriptionIndex.get(pattern);
      if (set) { set.delete(peerId); if (set.size === 0) this.subscriptionIndex.delete(pattern); }
      return { ok: true };
    }

    if (cmd === 'publish') {
      const denied = this.requireRole(ctx, ['orchestrator', 'worker', 'observer']);
      if (denied) return denied;
      const r = req as import('./protocol').PublishRequest;
      if (!r.topic || typeof r.topic !== 'string') return { ok: false, error: 'topic required' };
      const peerId = ctx.getPeerId()!;
      const strict = this.getConfig().strictEventValidation;

      const dataSchema = schemaForTopic(r.topic);
      if (dataSchema !== null) {
        const envelopeResult = EnvelopeV1.safeParse(r.payload);
        if (!envelopeResult.success) {
          this.opts.logger(`[claws/schema] malformed envelope from ${peerId} on ${r.topic}`);
          await this.emitServerEvent('system.malformed.received', {
            from: peerId, topic: r.topic, error: envelopeResult.error.issues,
          });
          if (strict) {
            return { ok: false, error: 'envelope:invalid', details: envelopeResult.error.issues };
          }
        } else {
          const dataResult = dataSchema.safeParse(envelopeResult.data.data);
          if (!dataResult.success) {
            this.opts.logger(`[claws/schema] malformed data from ${peerId} on ${r.topic}`);
            await this.emitServerEvent('system.malformed.received', {
              from: peerId, topic: r.topic, error: dataResult.error.issues,
            });
            if (strict) {
              return { ok: false, error: 'payload:invalid', details: dataResult.error.issues };
            }
          }
        }
      }

      // Durably append to the event log before fan-out.
      // If append() throws (non-degraded I/O error), we refuse to publish so
      // the caller is not told ok:true for an event that was not persisted.
      // In degraded mode (log disabled at startup) append() returns sequence -1
      // without throwing and fan-out proceeds normally.
      let sequence: number | undefined;
      try {
        const logResult = await this.eventLog.append({
          topic: r.topic,
          from: peerId,
          ts_server: new Date().toISOString(),
          payload: r.payload,
        });
        sequence = logResult.sequence >= 0 ? logResult.sequence : undefined;
      } catch {
        return { ok: false, error: 'event-log:write-failed' };
      }

      const delivered = this.fanOut(r.topic, peerId, r.payload, r.echo ?? false, sequence);
      return { ok: true, deliveredTo: delivered };
    }

    if (cmd === 'broadcast') {
      const denied = this.requireRole(ctx, ['orchestrator']);
      if (denied) return denied;
      const r = req as import('./protocol').BroadcastRequest;
      const from = ctx.getPeerId()!;
      const targetRole = r.targetRole ?? 'worker';
      let count = 0;
      for (const peer of this.peers.values()) {
        if (targetRole !== 'all' && peer.role !== targetRole) continue;
        this.pushFrame(peer.socket, 'system.broadcast', from, { text: r.text });
        count++;
        if (r.inject && peer.terminalId) {
          const rec = this.opts.terminalManager.recordById(String(peer.terminalId));
          if (rec) {
            if (rec.pty) {
              rec.pty.writeInjected(r.text, true, true);
            } else {
              rec.terminal.sendText(r.text, true);
            }
          }
        }
      }
      return { ok: true, deliveredTo: count };
    }

    if (cmd === 'task.assign') {
      const denied = this.requireRole(ctx, ['orchestrator']);
      if (denied) return denied;
      const r = req as import('./protocol').TaskAssignRequest;
      if (!r.title || !r.assignee || !r.prompt) {
        return { ok: false, error: 'title, assignee, and prompt are required' };
      }
      if (!this.peers.has(r.assignee)) {
        return { ok: false, error: `assignee peer not found: ${r.assignee}` };
      }
      const taskId = allocTaskId(++this.taskSeq);
      const now = Date.now();
      const task: TaskRecord = {
        taskId,
        title: r.title,
        prompt: r.prompt,
        assignee: r.assignee,
        assignedBy: ctx.getPeerId()!,
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
        timeoutMs: r.timeoutMs,
      };
      this.tasks.set(taskId, task);
      const deliver = r.deliver ?? 'publish';
      // Publish task.assigned.<assignee> so the worker learns about the task
      if (deliver === 'publish' || deliver === 'both') {
        await this.emitServerEvent(`task.assigned.${r.assignee}`, { ...task });
      }
      // Inject prompt into the worker's terminal if requested
      if (deliver === 'inject' || deliver === 'both') {
        const assigneePeer = this.peers.get(r.assignee);
        if (assigneePeer?.terminalId) {
          const rec = this.opts.terminalManager.recordById(String(assigneePeer.terminalId));
          if (rec) {
            if (rec.pty) {
              rec.pty.writeInjected(r.prompt, true, true);
            } else {
              rec.terminal.sendText(r.prompt, true);
            }
          }
        }
      }
      this.opts.logger(`[claws/2] task assigned: ${taskId} to ${r.assignee}`);
      return { ok: true, taskId, assignedAt: now };
    }

    if (cmd === 'task.update') {
      const denied = this.requireRole(ctx, ['worker']);
      if (denied) return denied;
      const r = req as import('./protocol').TaskUpdateRequest;
      const task = this.tasks.get(r.taskId);
      if (!task) return { ok: false, error: `task not found: ${r.taskId}` };
      if (task.assignee !== ctx.getPeerId()) return { ok: false, error: 'not your task' };
      if (['succeeded', 'failed', 'skipped'].includes(task.status)) {
        return { ok: false, error: 'task already completed' };
      }
      task.status = r.status;
      if (r.progressPct !== undefined) task.progressPct = r.progressPct;
      if (r.note !== undefined) task.note = r.note;
      task.updatedAt = Date.now();
      // Publish task.status for orchestrator subscribers
      await this.emitServerEvent('task.status', {
        taskId: task.taskId,
        assignee: task.assignee,
        status: task.status,
        progressPct: task.progressPct,
        note: task.note,
      });
      return { ok: true };
    }

    if (cmd === 'task.complete') {
      const denied = this.requireRole(ctx, ['worker']);
      if (denied) return denied;
      const r = req as import('./protocol').TaskCompleteRequest;
      const task = this.tasks.get(r.taskId);
      if (!task) return { ok: false, error: `task not found: ${r.taskId}` };
      if (task.assignee !== ctx.getPeerId()) return { ok: false, error: 'not your task' };
      // Idempotent: if already completed, return ok without re-firing a push
      if (['succeeded', 'failed', 'skipped'].includes(task.status)) return { ok: true };
      const now = Date.now();
      task.status = r.status;
      task.result = r.result;
      task.artifacts = r.artifacts;
      task.completedAt = now;
      task.updatedAt = now;
      await this.emitServerEvent('task.completed', {
        taskId: task.taskId,
        status: task.status,
        result: task.result,
        artifacts: task.artifacts,
      });
      this.opts.logger(`[claws/2] task completed: ${task.taskId} status=${task.status}`);
      return { ok: true };
    }

    if (cmd === 'task.cancel') {
      const denied = this.requireRole(ctx, ['orchestrator']);
      if (denied) return denied;
      const r = req as import('./protocol').TaskCancelRequest;
      const task = this.tasks.get(r.taskId);
      if (!task) return { ok: false, error: `task not found: ${r.taskId}` };
      task.cancelRequested = true;
      task.cancelReason = r.reason;
      task.updatedAt = Date.now();
      await this.emitServerEvent(`task.cancel_requested.${task.assignee}`, {
        taskId: task.taskId,
        reason: r.reason,
      });
      return { ok: true };
    }

    if (cmd === 'task.list') {
      const r = req as import('./protocol').TaskListRequest;
      let list = Array.from(this.tasks.values());
      if (r.assignee) list = list.filter((t) => t.assignee === r.assignee);
      if (r.status) list = list.filter((t) => t.status === r.status);
      if (r.since) list = list.filter((t) => t.updatedAt >= r.since!);
      return { ok: true, tasks: list };
    }

    if (cmd === 'lifecycle.plan') {
      const r = req as import('./protocol').LifecyclePlanRequest;
      if (!r.plan || !r.plan.trim()) {
        return { ok: false, error: 'lifecycle:plan-empty', message: 'plan text must be non-empty' };
      }
      const existingState = this.lifecycleStore.snapshot();
      const isResettingFromReflect = existingState !== null && existingState.phase === 'REFLECT';
      const state = this.lifecycleStore.plan(r.plan);
      const idempotent = existingState !== null && !isResettingFromReflect;
      return { ok: true, state, idempotent };
    }

    if (cmd === 'lifecycle.advance') {
      const r = req as import('./protocol').LifecycleAdvanceRequest;
      try {
        const prevPhase = this.lifecycleStore.snapshot()?.phase;
        const state = this.lifecycleStore.advance(r.to as import('./lifecycle-store').Phase, r.reason);
        // Return idempotent:true when the phase did not change (no-op transition)
        if (prevPhase === r.to) return { ok: true, state, idempotent: true };
        return { ok: true, state };
      } catch (err) {
        // Split "lifecycle:code — human message" into stable code + readable detail (M1)
        const msg = (err as Error).message;
        const sepIdx = msg.indexOf(' — ');
        if (sepIdx !== -1) return { ok: false, error: msg.slice(0, sepIdx), message: msg.slice(sepIdx + 3) };
        return { ok: false, error: msg, message: msg };
      }
    }

    if (cmd === 'lifecycle.snapshot') {
      return { ok: true, state: this.lifecycleStore.snapshot() };
    }

    if (cmd === 'lifecycle.reflect') {
      const r = req as import('./protocol').LifecycleReflectRequest;
      if (!r.reflect || !r.reflect.trim()) {
        return { ok: false, error: 'lifecycle:reflect-empty', message: 'reflect text must be non-empty' };
      }
      try {
        const state = this.lifecycleStore.reflect(r.reflect);
        return { ok: true, state };
      } catch (err) {
        // Split "lifecycle:code — human message" into stable code + readable detail
        const msg = (err as Error).message;
        const sepIdx = msg.indexOf(' — ');
        if (sepIdx !== -1) return { ok: false, error: msg.slice(0, sepIdx), message: msg.slice(sepIdx + 3) };
        return { ok: false, error: msg, message: msg };
      }
    }

    return { ok: false, error: `unknown cmd: ${cmd}` };
  }
}

/**
 * Return the minor-version drift between two "major.minor.patch" strings.
 *
 *   compareMinorDrift('0.4.0', '0.5.0') === 1
 *   compareMinorDrift('0.5.1', '0.5.0') === -1  (client newer)
 *   compareMinorDrift('1.0.0', '0.5.0') === 5   (crude, cross-major-bump)
 *
 * Non-semver strings return 0 (silently skip warning).
 */
export function compareMinorDrift(client: string, server: string): number {
  const parse = (s: string): [number, number] | null => {
    const m = /^(\d+)\.(\d+)\./.exec(s);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10)];
  };
  const c = parse(client);
  const s = parse(server);
  if (!c || !s) return 0;
  // Crude drift: server-minor minus client-minor plus 10x major-drift. Good
  // enough to flag "client is 1+ minor releases behind".
  return (s[0] - c[0]) * 10 + (s[1] - c[1]);
}
