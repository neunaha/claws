import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { CaptureStore } from './capture-store';
import { TerminalManager } from './terminal-manager';
import { ClawsRequest, ClawsResponse, HistoryEvent, PROTOCOL_VERSION, PROTOCOL_VERSION_V2, SubWorkerRole } from './protocol';
import { WaveRegistry } from './wave-registry';
import { stripAnsi } from './ansi-strip';
import {
  ServerConfigProvider,
  defaultServerConfig,
} from './server-config';
import { PeerConnection, DisconnectedPeer, ClawsRole, allocPeerId, fingerprintPeer, matchTopic } from './peer-registry';
import { TaskRecord, allocTaskId } from './task-registry';
import { LifecycleStore } from './lifecycle-store';
import { canTransition, explainIllegalTransition, canReflect } from './lifecycle-rules';
import { LifecycleEngine } from './lifecycle-engine';
import { EnvelopeV1, SCHEMA_BY_NAME } from './event-schemas';
import { schemaForTopic } from './topic-registry';
import { EventLogWriter, EventLogReader, parseCursor } from './event-log';
import { PipelineRegistry } from './pipeline-registry';
import { WebSocketTransport } from './websocket-transport';

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
/** L18 AUTH — maximum token age before it is rejected as stale (5 minutes). */
const AUTH_MAX_TOKEN_AGE_MS = 5 * 60 * 1000;
// How long to wait for an existing socket to respond before declaring it
// stale. 250ms is a live-server SLA on localhost — a real server answers in
// single-digit ms; no answer means nobody's there.
const STALE_PROBE_TIMEOUT_MS = 250;
const SHELL_BASENAMES = new Set([
  'bash', 'zsh', 'fish', 'sh', 'dash', 'tcsh', 'csh', 'ksh', '-bash', '-zsh', '-sh',
]);

function classifyContentType(basename: string | null): string {
  if (!basename) return 'unknown';
  const name = path.basename(basename).toLowerCase();
  if (SHELL_BASENAMES.has(name) || name.startsWith('bash') || name.startsWith('zsh') || name.startsWith('sh')) return 'shell';
  if (name.startsWith('python')) return 'python';
  if (name === 'node' || name === 'nodejs') return 'node';
  if (name === 'vim' || name === 'nvim' || name === 'vi') return 'vim';
  if (name === 'htop' || name === 'top') return 'htop';
  if (name.includes('claude')) return 'claude';
  return 'unknown';
}


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
  /** Monotonic sequence number stamped into [CLAWS_CMD] broadcast text for idempotency. */
  private broadcastSeq = 0;
  /**
   * Tombstones for fingerprinted peers that have disconnected. Keyed by fingerprint.
   * On reconnect with the same instanceNonce, subscriptions and tasks are restored
   * without requiring re-assignment. Cleared on stop().
   */
  private readonly disconnectedPeers = new Map<string, DisconnectedPeer>();
  /** Set of peerIds whose socket is currently under backpressure (write returned false). */
  private readonly pausedPeers = new Set<string>();
  /** BUG-21 fix: per-peer outbound queue for frames that arrive during backpressure.
   *  Bounded at MAX_PENDING_FRAMES to prevent unbounded memory growth. */
  private readonly pendingFrames = new Map<string, string[]>();
  private static readonly MAX_PENDING_FRAMES = 500;
  /** Dropped push-frame counts per peerId during backpressure windows. */
  private readonly droppedFrames = new Map<string, number>();
  /** Per-peer rate-limit bucket: {count, windowStart} reset every 1000ms. */
  private readonly publishRateTracker = new Map<string, { count: number; windowStart: number }>();
  /** Accumulated rate-limit rejections per peer since last heartbeat. */
  private readonly peerRateLimitHits = new Map<string, number>();
  /** Total publish count since last heartbeat (resets each heartbeat cycle). */
  private publishCountSinceHeartbeat = 0;
  /**
   * Count of publish handlers currently in-flight (passed rate + admission checks
   * but not yet responded). Incremented synchronously before any await so concurrent
   * handlers see an accurate backlog count at admission-control check time.
   */
  private serverInFlight = 0;
  /** Server-owned lifecycle state. Gate checks and lifecycle.* commands use this. */
  private readonly lifecycleStore: LifecycleStore;
  /** Auto-advance engine: subscribes to worker state changes, self-progresses phases. */
  private readonly lifecycleEngine: LifecycleEngine;
  /** Wave army registry — tracks active waves, sub-worker heartbeats, and violation detection. */
  private readonly waveRegistry: WaveRegistry;
  /** Monotonic sequence counter for deliver-cmd frames. */
  private cmdSeq = 0;
  /** Idempotency map: idempotencyKey → {seq, targetPeerId}. Prevents re-delivery on retry. */
  private readonly cmdIdempotencyMap = new Map<string, { seq: number; targetPeerId: string }>();
  /** Delivery record: seq → {targetPeerId, from, cmdTopic}. Needed to fan-out cmd.ack to orchestrator. */
  private readonly cmdDeliveryMap = new Map<number, { targetPeerId: string; from: string; cmdTopic: string }>();

  /**
   * L16 TYPED-RPC correlation map. Keyed by requestId (UUID). Each entry holds the
   * resolve callback for the pending `rpc.call` handler and a timeout timer. Entries
   * are deleted on response receipt or timeout — no unbounded growth.
   */
  private readonly rpcPending = new Map<string, {
    resolve: (res: ClawsResponse) => void;
    callerPeerId: string;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly eventLog = new EventLogWriter();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** LH-9: TTL watchdog interval — scans expired workers every 30s. */
  private ttlWatchdogTimer: NodeJS.Timeout | null = null;
  /** L11 Pipeline composition registry. */
  private readonly pipelineRegistry = new PipelineRegistry();
  /**
   * L18 AUTH — consumed nonce set. Nonces are single-use; a second hello
   * with an already-seen nonce is rejected as a replay attack. Cleared on stop().
   */
  private readonly usedNonces = new Set<string>();
  /** L19 TRANSPORT-X — optional WebSocket transport alongside the Unix socket. */
  private readonly wsTransport = new WebSocketTransport();

  constructor(private readonly opts: ServerOptions) {
    this.lifecycleStore = new LifecycleStore(opts.workspaceRoot);
    // LH-9 1D: reconcile against live terminals AFTER loadFromDisk has
    // populated state from JSON. extension.ts has already called
    // terminalManager.adoptExisting(vscode.window.terminals) by this point,
    // so liveTerminalIds() reflects whatever VS Code preserved across the
    // last extension reload. Anything in spawned_workers that isn't live
    // is a stale entry from a prior session and gets marked closed.
    try {
      const liveIds = opts.terminalManager.liveTerminalIds();
      const reconciled = this.lifecycleStore.reconcileWithLiveTerminals(liveIds);
      if (reconciled.length > 0) {
        opts.logger(`[claws] lifecycle reconcile on boot: ${reconciled.length} stale worker(s) marked closed: ${reconciled.join(', ')}`);
      }
    } catch (err) {
      opts.logger(`[claws] lifecycle reconcile failed (non-fatal): ${(err as Error).message}`);
    }
    // LH-9: tap CaptureStore so every PTY byte refreshes the worker's
    // last_activity_at. markActivity is a no-op for non-lifecycle terminals
    // and self-throttles disk flushes (>5s gap).
    opts.captureStore.setOnAppend((id, _bytes) => {
      try { this.lifecycleStore.markActivity(String(id)); } catch { /* non-fatal */ }
    });
    this.lifecycleEngine = new LifecycleEngine({
      store: this.lifecycleStore,
      emitEvent: (topic, payload) => this.emitServerEvent(topic, payload),
      logger: opts.logger,
    });
    this.waveRegistry = new WaveRegistry(
      (waveId, role, silentMs) => {
        void this.emitSystemEvent(`wave.${waveId}.violation`, {
          waveId,
          subWorker: role,
          silentMs,
          ts: new Date().toISOString(),
        });
        const { terminalId } = this.waveRegistry.markSubWorkerAutoClosed(waveId, role);
        if (terminalId) {
          opts.terminalManager.close(terminalId, 'wave_violation');
        }
      },
      (waveId, subWorkerCount) => {
        void this.emitSystemEvent(`wave.${waveId}.violation`, {
          waveId,
          kind: 'silent_lead_with_active_subs',
          subWorkerCount,
          ts: new Date().toISOString(),
        });
      },
    );
    opts.terminalManager.setStateChangeCallback((id, from, to) => {
      const payload = { terminalId: id, from, to, ts: new Date().toISOString() };
      void this.emitSystemEvent(`vehicle.${id}.state`, payload);
    });
    opts.terminalManager.setContentChangeCallback((id, pid, basename) => {
      const payload = {
        terminalId:    id,
        contentType:   classifyContentType(basename),
        foregroundPid: pid,
        basename:      basename ?? null,
        detectedAt:    new Date().toISOString(),
        confidence:    pid !== null ? ('high' as const) : ('low' as const),
      };
      void this.emitSystemEvent(`vehicle.${id}.content`, payload);
    });
    opts.terminalManager.setTerminalCloseCallback((id, wrapped, origin) => {
      void this.emitSystemEvent('system.terminal.closed', {
        terminal_id: id,
        close_origin: origin,
        closed_at: new Date().toISOString(),
      });
      if (wrapped) {
        void this.emitSystemEvent('system.worker.terminated', {
          terminal_id: id,
          terminated_at: new Date().toISOString(),
        });
      }
      // LH-9 1A: every close path — UI X-button, programmatic close, pty
      // exit, VS Code reload — funnels through this callback. Mark the
      // worker closed in lifecycle so .claws/lifecycle-state.json never
      // drifts from reality. Best-effort: non-lifecycle terminals (plain
      // claws_create with no register-spawn) return null, which is fine.
      try {
        const updated = this.lifecycleStore.markWorkerStatus(String(id), 'closed');
        if (updated) this.lifecycleEngine.onWorkerEvent('terminal-close-callback:' + id);
      } catch (_err) { /* non-fatal */ }
    });
  }

  /** Milliseconds since this server instance was constructed. */
  uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * L18 AUTH — validate a hello token against the configured shared secret.
   * Returns null on success, or an error string ('auth:required'|'auth:invalid').
   *
   * Token = HMAC-SHA256(secret, `${peerName}:${role}:${nonce}:${timestamp}`).
   * Checks: token present, timestamp not stale, nonce not reused, HMAC correct.
   */
  private validateAuthToken(r: import('./protocol').HelloRequest): string | null {
    const cfg = this.getConfig().auth;
    if (!cfg?.enabled) return null;

    if (!r.token || !r.nonce || r.timestamp === undefined) {
      return 'auth:required';
    }

    // Reject stale tokens (replay window).
    const age = Date.now() - r.timestamp;
    if (age < 0 || age > AUTH_MAX_TOKEN_AGE_MS) {
      return 'auth:invalid';
    }

    // Reject replayed nonces.
    if (this.usedNonces.has(r.nonce)) {
      return 'auth:invalid';
    }

    // Load and validate HMAC.
    let secret: string;
    try {
      const tokenPath = path.isAbsolute(cfg.tokenPath)
        ? cfg.tokenPath
        : path.join(this.opts.workspaceRoot, cfg.tokenPath);
      secret = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch {
      // Token file missing or unreadable — auth is misconfigured, reject all.
      return 'auth:invalid';
    }

    const expected = createHmac('sha256', secret)
      .update(`${r.peerName}:${r.role}:${r.nonce}:${r.timestamp}`)
      .digest('hex');

    let valid = false;
    try {
      valid = timingSafeEqual(Buffer.from(r.token, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      // Mismatched buffer lengths (malformed token) → not equal.
      valid = false;
    }

    if (!valid) return 'auth:invalid';

    // Consume the nonce — prevents replay on a second connection.
    this.usedNonces.add(r.nonce);
    return null;
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
      .then(() => {
        // Startup compaction: merge tiny segments left from previous runs.
        if (this.getConfig().eventLog.compact) {
          return this.eventLog.compact().catch(() => { /* non-fatal */ });
        }
        return undefined;
      })
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

            // L13: emit system.metrics with throughput + queue depth snapshot.
            const intervalSec = Math.max(1, intervalMs / 1000);
            const publishRate = this.publishCountSinceHeartbeat / intervalSec;
            this.publishCountSinceHeartbeat = 0;
            void this.emitSystemEvent('system.metrics', {
              publishRate_per_sec: publishRate,
              queueDepth:          this.serverInFlight,
              peerCount:           this.peers.size,
              eventLogLastSeq:     this.eventLog.lastSequence,
              uptimeMs:            this.uptimeMs(),
              ts:                  new Date().toISOString(),
            });

            // L13: emit per-peer metrics for peers with drops or rate-limit hits.
            for (const peer of this.peers.values()) {
              const dropped = this.droppedFrames.get(peer.peerId) ?? 0;
              const rateLimitHits = this.peerRateLimitHits.get(peer.peerId) ?? 0;
              const bucket = this.publishRateTracker.get(peer.peerId);
              const publishCount = bucket?.count ?? 0;
              if (dropped > 0 || rateLimitHits > 0) {
                void this.emitSystemEvent(`system.peer.metrics.${peer.peerId}`, {
                  peerId:        peer.peerId,
                  peerName:      peer.peerName,
                  droppedFrames: dropped,
                  rateLimitHits,
                  publishCount,
                  ts:            new Date().toISOString(),
                });
                this.peerRateLimitHits.delete(peer.peerId);
              }
            }

            // Retention: delete segments older than the configured threshold.
            const retentionDays = this.getConfig().eventLog.retentionDays;
            if (retentionDays > 0) {
              void this.eventLog.runRetention(retentionDays).catch(() => { /* non-fatal */ });
            }
          }, intervalMs);
        }
      })
      .then(() => {
        // LH-9: TTL watchdog. Scans spawned_workers every 30s and closes any
        // that have exceeded their idle window (default 10min) or hard
        // ceiling (default 4h). The close call funnels through tm.close,
        // which fires the close-callback, which marks lifecycle closed.
        // No state drift possible — single chokepoint.
        const TTL_SCAN_INTERVAL_MS = 30_000;
        this.ttlWatchdogTimer = setInterval(() => {
          try {
            const expired = this.lifecycleStore.findExpiredWorkers();
            for (const { id, reason } of expired) {
              this.opts.logger(`[claws/ttl] worker ${id} expired (${reason}) — closing`);
              try {
                this.opts.terminalManager.close(id, reason);
              } catch (err) {
                this.opts.logger(`[claws/ttl] close ${id} failed: ${(err as Error).message}`);
              }
            }
          } catch (err) {
            this.opts.logger(`[claws/ttl] watchdog scan failed: ${(err as Error).message}`);
          }
        }, TTL_SCAN_INTERVAL_MS);
        if (typeof this.ttlWatchdogTimer.unref === 'function') {
          this.ttlWatchdogTimer.unref();
        }
      })
      .then(() => {
        // L19 TRANSPORT-X — start WebSocket server alongside Unix socket if enabled.
        const wsCfg = this.getConfig().webSocket;
        if (wsCfg?.enabled) {
          return this.wsTransport.start({
            port: wsCfg.port,
            certPath: wsCfg.certPath || undefined,
            keyPath: wsCfg.keyPath || undefined,
            logger: this.opts.logger,
            onConnection: (socket) => this.handleConnection(socket),
          }).catch((err: unknown) => {
            // WebSocket failure is non-fatal — Unix socket still works.
            this.opts.logger(`[claws/ws] failed to start: ${String(err)}`);
          });
        }
        return undefined;
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
    if (this.ttlWatchdogTimer !== null) {
      clearInterval(this.ttlWatchdogTimer);
      this.ttlWatchdogTimer = null;
    }
    // LH-9: detach activity sink so server stop doesn't leak references.
    this.opts.captureStore.setOnAppend(null);
    this.waveRegistry.dispose();
    // L19 TRANSPORT-X — stop WebSocket server if running.
    this.wsTransport.stop();
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
    this.usedNonces.clear();
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
      // For fingerprinted peers, save a tombstone so subscriptions and tasks
      // can be restored on reconnect. For non-fingerprinted peers, clean up
      // the subscription index immediately.
      if (peer.fingerprint) {
        this.disconnectedPeers.set(peer.fingerprint, {
          peerId: peer.peerId,
          fingerprint: peer.fingerprint,
          role: peer.role,
          peerName: peer.peerName,
          capabilities: peer.capabilities,
          subscriptions: new Map(peer.subscriptions),
          disconnectedAt: Date.now(),
        });
        // Remove from subscriptionIndex but keep tasks alive — they can be
        // re-bound when the peer reconnects with the same nonce.
        for (const pattern of peer.subscriptions.values()) {
          const set = this.subscriptionIndex.get(pattern);
          if (set) { set.delete(peerId); if (set.size === 0) this.subscriptionIndex.delete(pattern); }
        }
      } else {
        for (const pattern of peer.subscriptions.values()) {
          const set = this.subscriptionIndex.get(pattern);
          if (set) { set.delete(peerId); if (set.size === 0) this.subscriptionIndex.delete(pattern); }
        }
        // Fail tasks only for non-fingerprinted peers. Fingerprinted peers
        // may reconnect and continue their tasks.
        const now = Date.now();
        for (const task of this.tasks.values()) {
          if (task.assignee === peerId && ['pending', 'running', 'blocked'].includes(task.status)) {
            task.status = 'failed';
            task.note = 'assignee disconnected';
            task.updatedAt = now;
            this.emitServerEvent('task.completed', {
              taskId: task.taskId, status: 'failed', result: null,
            }).catch(() => { /* best-effort — never block disconnect */ });
          }
        }
      }
    }
    // Notify wave registry so it can cancel violation timers for this peer.
    if (peerId) this.waveRegistry.handlePeerDisconnect(peerId);
    // Clean up backpressure state for the disconnected peer.
    this.pausedPeers.delete(peerId);
    this.pendingFrames.delete(peerId);
    this.droppedFrames.delete(peerId);
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
    const targetPeerId = this.socketToPeer.get(socket);
    const frame = JSON.stringify({
      push: 'message',
      protocol: PROTOCOL_VERSION_V2,
      topic,
      from,
      payload,
      sentAt: Date.now(),
      ...(sequence !== undefined ? { sequence } : {}),
    }) + '\n';

    // BUG-21 fix: queue frames during backpressure instead of dropping them.
    // wave.*.complete and other one-shot signals must not be silently lost.
    if (targetPeerId && this.pausedPeers.has(targetPeerId)) {
      const queue = this.pendingFrames.get(targetPeerId) ?? [];
      if (queue.length < ClawsServer.MAX_PENDING_FRAMES) {
        queue.push(frame);
        this.pendingFrames.set(targetPeerId, queue);
      } else {
        this.droppedFrames.set(targetPeerId, (this.droppedFrames.get(targetPeerId) ?? 0) + 1);
      }
      return;
    }

    try {
      const drained = socket.write(frame);
      if (!drained && targetPeerId && !this.pausedPeers.has(targetPeerId)) {
        this.pausedPeers.add(targetPeerId);
        this.opts.logger(`[claws/2] backpressure on push to ${targetPeerId}; pausing`);
        socket.once('drain', () => {
          this.pausedPeers.delete(targetPeerId);
          // Flush frames that arrived during the backpressure window.
          const queued = this.pendingFrames.get(targetPeerId) ?? [];
          this.pendingFrames.delete(targetPeerId);
          for (const qf of queued) {
            try { socket.write(qf); } catch { /* socket may have closed */ }
          }
          const dropped = this.droppedFrames.get(targetPeerId) ?? 0;
          if (dropped > 0) {
            if (dropped >= 100) {
              this.opts.logger(`[claws/2] drain for ${targetPeerId}; ${dropped} frames dropped (queue full)`);
            } else {
              this.opts.logger(`[claws/2] drain for ${targetPeerId}; ${dropped} frames dropped`);
            }
            this.droppedFrames.delete(targetPeerId);
          }
          if (queued.length > 0) {
            this.opts.logger(`[claws/2] drain for ${targetPeerId}; flushed ${queued.length} queued frames`);
          }
        });
      }
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

  private async replayFromCursor(
    cursor: string,
    topicPattern: string,
    subId: string,
    socket: net.Socket,
  ): Promise<void> {
    const reader = new EventLogReader(this.opts.workspaceRoot);
    let count = 0;
    try {
      for await (const record of reader.scanFrom(cursor, topicPattern)) {
        if (socket.destroyed) return;
        const frame = JSON.stringify({
          push: 'message',
          protocol: PROTOCOL_VERSION_V2,
          topic: record.topic,
          from: record.from ?? 'server',
          payload: record.payload,
          sentAt: Date.now(),
          replayed: true,
          ...(record.sequence !== undefined ? { sequence: record.sequence } : {}),
        }) + '\n';
        socket.write(frame);
        count++;
      }
    } catch { /* I/O error during replay — fall through */ }
    if (socket.destroyed) return;
    socket.write(JSON.stringify({
      push: 'caught-up',
      protocol: PROTOCOL_VERSION_V2,
      subscriptionId: subId,
      replayedCount: count,
      resumeCursor: this.eventLog.currentCursor(),
    }) + '\n');
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
        // BUG-09: explicit wave affiliation for dispatch_subworker path (fallback when peer has no waveId)
        waveId?: string; waveRole?: string;
      };
      // Wave affiliation from the calling peer's stored waveId (registered via hello).
      const callerPeerId3 = ctx.getPeerId();
      const callerPeer3 = callerPeerId3 ? this.peers.get(callerPeerId3) : undefined;
      const callerWaveId = callerPeer3?.waveId ?? r.waveId;
      const callerRole = (callerPeer3?.subWorkerRole ?? r.waveRole) as SubWorkerRole | undefined;

      if (r.wrapped === true) {
        const { id } = tm.createWrapped(r);
        if (callerWaveId) this.waveRegistry.trackTerminal(callerWaveId, String(id), callerRole);
        return { ok: true, id, logPath: null, wrapped: true };
      }
      const { id } = tm.createStandard(r);
      if (callerWaveId) this.waveRegistry.trackTerminal(callerWaveId, String(id), callerRole);
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
      const startedAt = new Date().toISOString();
      void this.emitSystemEvent(`command.${rec.id}.start`, {
        terminalId: rec.id,
        command:    r.command,
        startedAt,
      });
      if (!rec.terminal.shellIntegration) {
        if (rec.pty) {
          rec.pty.writeInjected(r.command, true, false);
        } else {
          rec.terminal.sendText(r.command, true);
        }
        void this.emitSystemEvent(`command.${rec.id}.end`, {
          terminalId: rec.id,
          command:    r.command,
          exitCode:   null,
          durationMs: 0,
          degraded:   true,
          endedAt:    new Date().toISOString(),
        });
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
      void this.emitSystemEvent(`command.${rec.id}.end`, {
        terminalId: rec.id,
        command:    r.command,
        exitCode:   (event as unknown as { exitCode?: number }).exitCode ?? null,
        durationMs: Date.now() - new Date(startedAt).getTime(),
        endedAt:    new Date().toISOString(),
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
      const r = req as ClawsRequest & { id: string | number; close_origin?: string };
      // BUG-13: kill foreground process before disposing so Claude TUI
      // processes don't orphan and keep publishing bus events.
      const rec = tm.recordById(r.id);
      if (rec?.pty) {
        const fgPid = rec.pty.getForegroundProcess().pid ?? rec.pty.pid;
        if (fgPid != null) {
          try { process.kill(fgPid, 'SIGTERM'); } catch { /* already gone */ }
          const killTimer = setTimeout(() => {
            try {
              process.kill(fgPid, 0); // throws if already gone
              process.kill(fgPid, 'SIGKILL');
            } catch { /* already gone */ }
          }, 5000);
          if (typeof killTimer.unref === 'function') killTimer.unref();
        }
      }
      // Use caller-supplied close_origin so semantic accuracy flows through
      // (e.g. mcp_server.js watchers pass 'marker'/'error'/'timeout').
      const closeOrigin = (['marker','error','timeout','orchestrator','user','pub_complete','wave_violation','idle_timeout','ttl_max'] as const)
        .find(o => o === r.close_origin) ?? 'orchestrator';
      const idStr = String(r.id);
      // LH-9 1B: mark lifecycle closed BEFORE attempting tm.close so that an
      // already-gone terminal still produces a healed state record. Previously
      // this lived after the alreadyClosed early-return, which left the JSON
      // with closed:false forever for any terminal that died via VS Code's
      // close-X / reload / pty exit but happened to be re-targeted by a
      // belt-and-suspenders close call. The setTerminalCloseCallback covers
      // the live path; this covers the stale path.
      try {
        const updated = this.lifecycleStore.markWorkerStatus(idStr, 'closed');
        if (updated) this.lifecycleEngine.onWorkerEvent('claws-close:' + idStr);
      } catch (_e) { /* non-fatal */ }
      const ok = tm.close(r.id, closeOrigin);
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

      // L18 AUTH — validate token before any other checks.
      const authErr = this.validateAuthToken(r);
      if (authErr) return { ok: false, error: authErr };

      // BUG-03: idempotent hello — same socket re-registering updates capabilities and re-uses peerId
      const existingPeerIdForSocket = ctx.getPeerId();
      if (existingPeerIdForSocket) {
        const existingPeer = this.peers.get(existingPeerIdForSocket);
        if (existingPeer) {
          if (r.capabilities !== undefined) {
            const caps = new Set<string>(r.capabilities);
            caps.add('push'); // T2/Q6: auto-grant — idempotent hello still ensures push
            existingPeer.capabilities = Array.from(caps);
          }
          if (r.waveId !== undefined) existingPeer.waveId = r.waveId;
          if (r.subWorkerRole !== undefined) existingPeer.subWorkerRole = r.subWorkerRole;
          existingPeer.lastSeen = Date.now();
          return {
            ok: true, peerId: existingPeerIdForSocket, protocol: PROTOCOL_VERSION_V2,
            serverCapabilities: ['push', 'broadcast', 'tasks'],
            orchestratorPresent: this.hasOrchestrator(), restored: false, idempotent: true,
          };
        }
      }

      if (r.role === 'orchestrator' && this.hasOrchestrator()) {
        return { ok: false, error: 'orchestrator already registered' };
      }

      // Compute stable fingerprint when instanceNonce is provided.
      const fingerprint = r.instanceNonce
        ? fingerprintPeer(r.peerName ?? 'unnamed', r.role, r.instanceNonce)
        : undefined;
      const peerId = fingerprint ? `fp_${fingerprint}` : this.allocPeerId();
      // T2/Q6: auto-grant push to every registered peer — publish is a core capability.
      const capSet = new Set<string>(r.capabilities ?? []);
      capSet.add('push');
      const capabilities = Array.from(capSet);

      // Check for a disconnected peer with the same fingerprint.
      const tombstone = fingerprint ? this.disconnectedPeers.get(fingerprint) : undefined;
      if (tombstone) this.disconnectedPeers.delete(fingerprint!);

      // Subscriptions: restore from tombstone or start fresh.
      const subscriptions: Map<string, string> = tombstone
        ? new Map(tombstone.subscriptions)
        : new Map();

      const peer: PeerConnection = {
        peerId,
        role: r.role as ClawsRole,
        peerName: r.peerName ?? 'unnamed',
        terminalId: r.terminalId,
        capabilities,
        socket: ctx.socket,
        waveId: r.waveId,
        subWorkerRole: r.subWorkerRole,
        subscriptions,
        lastSeen: Date.now(),
        connectedAt: Date.now(),
        fingerprint,
      };
      this.peers.set(peerId, peer);
      this.socketToPeer.set(ctx.socket, peerId);
      ctx.setPeerId(peerId);
      ctx.setNegotiatedProtocol('claws/2');

      // Re-add restored subscriptions to the subscription index.
      if (tombstone) {
        for (const pattern of peer.subscriptions.values()) {
          if (!this.subscriptionIndex.has(pattern)) this.subscriptionIndex.set(pattern, new Set());
          this.subscriptionIndex.get(pattern)!.add(peerId);
        }
        // Re-bind any tasks that were assigned to this peerId while disconnected.
        for (const task of this.tasks.values()) {
          if (task.assignee === peerId && ['pending', 'running', 'blocked'].includes(task.status)) {
            task.updatedAt = Date.now();
          }
        }
        this.opts.logger(`[claws/2] peer reconnected (restored): ${peerId} name=${peer.peerName} subs=${peer.subscriptions.size}`);
      } else {
        this.opts.logger(`[claws/2] peer registered: ${peerId} role=${peer.role} name=${peer.peerName}`);
      }

      // Auto-subscribe workers to their cmd channel (skip if already restored).
      if (peer.role === 'worker') {
        const cmdTopic = `cmd.${peerId}.**`;
        const alreadySubscribed = Array.from(peer.subscriptions.values()).includes(cmdTopic);
        if (!alreadySubscribed) {
          const subId = `s_${(++this.subSeq).toString(16).padStart(4, '0')}`;
          peer.subscriptions.set(subId, cmdTopic);
          if (!this.subscriptionIndex.has(cmdTopic)) this.subscriptionIndex.set(cmdTopic, new Set());
          this.subscriptionIndex.get(cmdTopic)!.add(peerId);
        }
      }
      // If this peer is a wave sub-worker, record its heartbeat.
      if (r.waveId && r.subWorkerRole) {
        this.waveRegistry.recordHeartbeat(r.waveId, r.subWorkerRole as SubWorkerRole, peerId);
      }

      return {
        ok: true,
        peerId,
        protocol: PROTOCOL_VERSION_V2,
        serverCapabilities: ['push', 'broadcast', 'tasks'],
        orchestratorPresent: this.hasOrchestrator(),
        restored: tombstone !== undefined,
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
      if (r.fromCursor !== undefined && parseCursor(r.fromCursor) === null) {
        return { ok: false, error: 'invalid cursor format' };
      }
      const peerId = ctx.getPeerId()!;
      const peer = this.peers.get(peerId)!;
      const subId = `s_${(++this.subSeq).toString(16).padStart(4, '0')}`;
      peer.subscriptions.set(subId, r.topic);
      if (!this.subscriptionIndex.has(r.topic)) this.subscriptionIndex.set(r.topic, new Set());
      this.subscriptionIndex.get(r.topic)!.add(peerId);
      if (r.fromCursor) {
        const cursor = r.fromCursor;
        const topicPattern = r.topic;
        const socket = ctx.socket;
        setImmediate(() => { void this.replayFromCursor(cursor, topicPattern, subId, socket); });
      }
      // Return the current event-log cursor so callers can detect what they may
      // have missed before this subscription was established (BUG-21 mitigation).
      return { ok: true, subscriptionId: subId, resumeCursor: this.eventLog.currentCursor() };
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
      // BUG-03: removed requireCapability('publish') — roles already gate access; undocumented cap check blocked SDK-less workers
      const r = req as import('./protocol').PublishRequest;
      if (!r.topic || typeof r.topic !== 'string') return { ok: false, error: 'topic required' };
      const peerId = ctx.getPeerId()!;
      const cfg = this.getConfig();

      // L14: Per-peer rate limiter — orchestrators are exempt so management
      // commands are never self-rate-limited during high-volume waves.
      const peerRole = this.peers.get(peerId)?.role;
      if (peerRole !== 'orchestrator') {
        const nowMs = Date.now();
        const bucket = this.publishRateTracker.get(peerId) ?? { count: 0, windowStart: nowMs };
        if (nowMs - bucket.windowStart >= 1000) { bucket.count = 0; bucket.windowStart = nowMs; }
        bucket.count++;
        this.publishRateTracker.set(peerId, bucket);
        if (bucket.count > cfg.maxPublishRateHz) {
          this.peerRateLimitHits.set(peerId, (this.peerRateLimitHits.get(peerId) ?? 0) + 1);
          return { ok: false, error: 'rate-limit-exceeded' };
        }
      }

      // L14: Queue-depth admission control — serverInFlight is incremented
      // synchronously before any await so concurrent handlers see an accurate count.
      if (this.serverInFlight > cfg.maxQueueDepth) {
        return { ok: false, error: 'admission-control:backlog' };
      }
      this.serverInFlight++;
      this.publishCountSinceHeartbeat++;

      try {
        const strict = cfg.strictEventValidation;
        const dataSchema = schemaForTopic(r.topic);
        // BUG-02: envelope is server-applied; auto-fill missing fields for SDK-less workers
        let effectivePayload: unknown = r.payload;
        if (dataSchema !== null) {
          const envelopeResult = EnvelopeV1.safeParse(r.payload);
          if (!envelopeResult.success) {
            const senderPeer = this.peers.get(peerId);
            effectivePayload = {
              v: 1, id: randomUUID(), from_peer: peerId,
              from_name: senderPeer?.peerName ?? peerId,
              ts_published: new Date().toISOString(), schema: 'claws/2', data: r.payload,
            };
            const innerResult = dataSchema.safeParse(r.payload);
            if (!innerResult.success) {
              this.opts.logger(`[claws/schema] malformed data from ${peerId} on ${r.topic}`);
              await this.emitServerEvent('system.malformed.received', {
                from: peerId, topic: r.topic, error: innerResult.error.issues,
              });
              if (strict) return { ok: false, error: 'payload:invalid', details: innerResult.error.issues };
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
            payload: effectivePayload,
          });
          sequence = logResult.sequence >= 0 ? logResult.sequence : undefined;
        } catch {
          return { ok: false, error: 'event-log:write-failed' };
        }

        const delivered = this.fanOut(r.topic, peerId, effectivePayload, r.echo ?? false, sequence);

        // BUG-06: heartbeat publishes reset wave violation timers (not just hello-time recordHeartbeat)
        if (/^worker\.[^.]+\.heartbeat$/.test(r.topic)) {
          const hbPeer = this.peers.get(peerId);
          if (hbPeer?.waveId && hbPeer?.subWorkerRole) {
            this.waveRegistry.recordHeartbeat(hbPeer.waveId, hbPeer.subWorkerRole as SubWorkerRole, peerId);
          }
        }

        // L16 TYPED-RPC: resolve any pending rpc.call waiting on this response topic.
        // Topic: rpc.response.<callerPeerId>.<requestId> — parts[3] is the requestId.
        if (r.topic.startsWith('rpc.response.')) {
          const parts = r.topic.split('.');
          if (parts.length >= 4) {
            const requestId = parts[parts.length - 1];
            const pending = this.rpcPending.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this.rpcPending.delete(requestId);
              pending.resolve({ ok: true, requestId, result: r.payload });
            }
          }
        }

        // L11 Pipeline: if topic matches output.<sourceId>.*, route output to sink terminals.
        const outputMatch = /^output\.([^.]+)\./.exec(r.topic);
        if (outputMatch) {
          const sourceTerminalId = outputMatch[1];
          const activePipelines = this.pipelineRegistry.findBySource(sourceTerminalId);
          for (const pipeline of activePipelines) {
            const sourceStep = pipeline.steps.find((s) => s.role === 'source');
            const sinkStep = pipeline.steps.find((s) => s.role === 'sink');
            if (!sourceStep || !sinkStep) continue;
            const payloadObj = typeof r.payload === 'object' && r.payload !== null
              ? r.payload as Record<string, unknown>
              : {};
            const text = typeof payloadObj['text'] === 'string'
              ? payloadObj['text']
              : JSON.stringify(r.payload);
            const sinkRec = this.opts.terminalManager.recordById(sinkStep.terminalId);
            if (sinkRec) {
              if (sinkRec.pty) {
                sinkRec.pty.writeInjected(text, true, false);
              } else {
                sinkRec.terminal.sendText(text, true);
              }
            }
            void this.emitSystemEvent(`pipeline.${pipeline.pipelineId}.step.${sourceStep.stepId}`, {
              pipelineId: pipeline.pipelineId,
              stepId:     sourceStep.stepId,
              role:       'source',
              terminalId: sourceTerminalId,
              state:      'active',
              ts:         new Date().toISOString(),
            });
          }
        }

        return { ok: true, deliveredTo: delivered };
      } finally {
        this.serverInFlight--;
      }
    }

    if (cmd === 'broadcast') {
      const denied = this.requireRole(ctx, ['orchestrator']);
      if (denied) return denied;
      const r = req as import('./protocol').BroadcastRequest;
      const from = ctx.getPeerId()!;
      const targetRole = r.targetRole ?? 'worker';
      let injectText = r.text;
      if (r.inject && r.text.startsWith('[CLAWS_CMD ')) {
        this.broadcastSeq++;
        injectText = r.text.replace('[CLAWS_CMD ', `[CLAWS_CMD seq=${this.broadcastSeq} `);
      }
      let count = 0;
      for (const peer of this.peers.values()) {
        if (targetRole !== 'all' && peer.role !== targetRole) continue;
        this.pushFrame(peer.socket, 'system.broadcast', from, { text: injectText });
        count++;
        if (r.inject && peer.terminalId) {
          const rec = this.opts.terminalManager.recordById(String(peer.terminalId));
          if (rec) {
            if (rec.pty) {
              rec.pty.writeInjected(injectText, true, true);
            } else {
              rec.terminal.sendText(injectText, true);
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
      if (!r.workerMode) {
        return { ok: false, error: 'lifecycle:worker-mode-required', message: 'workerMode required (single|fleet|army)' };
      }
      if (typeof r.expectedWorkers !== 'number' || r.expectedWorkers < 1) {
        return { ok: false, error: 'lifecycle:expected-workers-required', message: 'expectedWorkers must be positive integer' };
      }
      try {
        const existingState = this.lifecycleStore.snapshot();
        const isResettingFromReflect = existingState !== null && existingState.phase === 'REFLECT';
        const state = this.lifecycleStore.plan(r.plan, r.workerMode, r.expectedWorkers);
        const inActiveMission = existingState !== null
          && existingState.phase !== 'SESSION-BOOT'
          && existingState.phase !== 'REFLECT'
          && existingState.phase !== 'SESSION-END';
        const idempotent = inActiveMission && !isResettingFromReflect;
        return { ok: true, state, idempotent };
      } catch (err) {
        const msg = (err as Error).message;
        const sepIdx = msg.indexOf(' — ');
        if (sepIdx !== -1) return { ok: false, error: msg.slice(0, sepIdx), message: msg.slice(sepIdx + 3) };
        return { ok: false, error: msg, message: msg };
      }
    }

    if (cmd === 'lifecycle.advance') {
      const r = req as import('./protocol').LifecycleAdvanceRequest;
      const cur = this.lifecycleStore.snapshot();
      if (!cur) {
        return { ok: false, error: 'lifecycle:plan-required', message: 'no lifecycle state — call lifecycle.plan first' };
      }
      const to = r.to as import('./lifecycle-store').Phase;
      if (cur.phase === to) {
        return { ok: true, state: cur, idempotent: true };
      }
      // Validate transition via pure rules
      if (!canTransition(cur.phase, to)) {
        const reason = explainIllegalTransition(cur.phase, to);
        return { ok: false, error: 'lifecycle:invalid-transition', message: reason ?? `${cur.phase} → ${to} not allowed` };
      }
      // Gate-check REFLECT specifically (CLEANUP gate is enforced earlier when entering CLEANUP)
      if (to === 'REFLECT') {
        const gate = canReflect(cur);
        if (!gate.ok) {
          return { ok: false, error: 'lifecycle:reflect-gate', message: gate.reason };
        }
      }
      const state = this.lifecycleStore.setPhase(to);
      return { ok: true, state };
    }

    if (cmd === 'lifecycle.snapshot') {
      return { ok: true, state: this.lifecycleStore.snapshot() };
    }

    if (cmd === 'lifecycle.reflect') {
      const r = req as import('./protocol').LifecycleReflectRequest;
      if (!r.reflect || !r.reflect.trim()) {
        return { ok: false, error: 'lifecycle:reflect-empty', message: 'reflect text must be non-empty' };
      }
      const cur = this.lifecycleStore.snapshot();
      if (!cur) {
        return { ok: false, error: 'lifecycle:plan-required', message: 'no lifecycle state' };
      }
      // REFLECT must be reachable from current phase + reflect-gate must pass
      if (!canTransition(cur.phase, 'REFLECT')) {
        const reason = explainIllegalTransition(cur.phase, 'REFLECT');
        return { ok: false, error: 'lifecycle:invalid-transition', message: reason ?? `cannot REFLECT from ${cur.phase}` };
      }
      const gate = canReflect(cur);
      if (!gate.ok) {
        return { ok: false, error: 'lifecycle:reflect-gate', message: gate.reason };
      }
      const state = this.lifecycleStore.reflect(r.reflect);
      return { ok: true, state };
    }

    // ─── D+F: per-worker spawn + monitor registration (v0.7.10) ──────────────

    if (cmd === 'lifecycle.register-spawn') {
      const r = req as import('./protocol').LifecycleRegisterSpawnRequest;
      if (!r.terminalId || !r.correlationId || !r.name) {
        return { ok: false, error: 'lifecycle:register-spawn-args', message: 'terminalId, correlationId, name required' };
      }
      try {
        const worker = this.lifecycleStore.registerSpawn(r.terminalId, r.correlationId, r.name);
        this.lifecycleEngine.onWorkerEvent('register-spawn');
        return { ok: true, worker };
      } catch (err) {
        const msg = (err as Error).message;
        const sepIdx = msg.indexOf(' — ');
        if (sepIdx !== -1) return { ok: false, error: msg.slice(0, sepIdx), message: msg.slice(sepIdx + 3) };
        return { ok: false, error: msg, message: msg };
      }
    }

    if (cmd === 'lifecycle.register-monitor') {
      const r = req as import('./protocol').LifecycleRegisterMonitorRequest;
      if (!r.terminalId || !r.correlationId || !r.command) {
        return { ok: false, error: 'lifecycle:register-monitor-args', message: 'terminalId, correlationId, command required' };
      }
      try {
        const monitor = this.lifecycleStore.registerMonitor(r.terminalId, r.correlationId, r.command);
        this.lifecycleEngine.onWorkerEvent('register-monitor');
        return { ok: true, monitor };
      } catch (err) {
        const msg = (err as Error).message;
        return { ok: false, error: msg, message: msg };
      }
    }

    if (cmd === 'lifecycle.mark-worker-status') {
      const r = req as import('./protocol').LifecycleMarkWorkerStatusRequest;
      if (!r.terminalId || !r.status) {
        return { ok: false, error: 'lifecycle:mark-status-args', message: 'terminalId, status required' };
      }
      const updated = this.lifecycleStore.markWorkerStatus(r.terminalId, r.status as import('./lifecycle-store').WorkerStatus);
      this.lifecycleEngine.onWorkerEvent('mark-worker-status:' + r.status);
      return { ok: true, worker: updated };
    }

    // ── Wave army commands ──────────────────────────────────────────────────

    if (cmd === 'wave.create') {
      const r = req as import('./protocol').WaveCreateRequest;
      if (!r.waveId) return { ok: false, error: 'wave.create:missing-waveId' };
      if (!Array.isArray(r.manifest) || r.manifest.length === 0) {
        return { ok: false, error: 'wave.create:missing-manifest' };
      }
      const peerId = ctx.getPeerId() ?? 'unknown';
      const wave = this.waveRegistry.createWave(
        r.waveId,
        Array.isArray(r.layers) ? r.layers : [],
        r.manifest as SubWorkerRole[],
        peerId,
      );
      void this.emitSystemEvent(`wave.${r.waveId}.lead.boot`, {
        waveId: r.waveId,
        peerName: this.peers.get(peerId)?.peerName ?? peerId,
        layers: wave.layers,
        manifest: r.manifest,
        started_at: new Date(wave.createdAt).toISOString(),
      });
      return { ok: true, waveId: wave.waveId, createdAt: wave.createdAt };
    }

    if (cmd === 'wave.status') {
      const r = req as import('./protocol').WaveStatusRequest;
      if (!r.waveId) return { ok: false, error: 'wave.status:missing-waveId' };
      const wave = this.waveRegistry.getWave(r.waveId);
      if (!wave) return { ok: false, error: `wave.status:not-found:${r.waveId}` };
      const subWorkers = [...wave.subWorkers.entries()].map(([role, entry]) => {
        const peerConn = entry.peerId ? this.peers.get(entry.peerId) : undefined;
        return {
          role,
          peerId: entry.peerId ?? null,
          peerName: peerConn?.peerName ?? null,
          terminalId: entry.terminalId ?? peerConn?.terminalId ?? null,
          lastHeartbeatMs: entry.lastHeartbeatMs,
          complete: entry.complete,
        };
      });
      const leadPeer = this.peers.get(wave.leadPeerId);
      return {
        ok: true,
        waveId: wave.waveId,
        layers: wave.layers,
        leadPeerId: wave.leadPeerId,
        leadPeerName: leadPeer?.peerName ?? null,
        leadTerminalId: leadPeer?.terminalId ?? null,
        // Nested lead tree (mission: claws_wave_status nested tree format)
        lead: {
          peerId: wave.leadPeerId,
          peerName: leadPeer?.peerName ?? null,
          terminalId: leadPeer?.terminalId ?? null,
          status: wave.complete ? 'complete' : 'active',
          lastSeenMs: leadPeer?.lastSeen ?? null,
        },
        subWorkers,
        subWorkerTerminals: wave.subWorkerTerminals,
        orphanedTerminals: wave.orphanedTerminals,
        harvestedAt: wave.harvestedAt ?? null,
        complete: wave.complete,
        createdAt: wave.createdAt,
        completedAt: wave.completedAt ?? null,
        summary: wave.summary ?? null,
        commits: wave.commits ?? [],
        regressionClean: wave.regressionClean ?? null,
      };
    }

    if (cmd === 'wave.complete') {
      const r = req as import('./protocol').WaveCompleteRequest;
      if (!r.waveId) return { ok: false, error: 'wave.complete:missing-waveId' };
      const peerId = ctx.getPeerId() ?? 'unknown';
      const wave = this.waveRegistry.getWave(r.waveId);
      if (!wave) return { ok: false, error: `wave.complete:not-found:${r.waveId}` };
      if (wave.leadPeerId !== peerId) {
        return { ok: false, error: 'wave.complete:not-lead — only the LEAD peer may complete a wave' };
      }
      const completed = this.waveRegistry.completeWave(
        r.waveId,
        r.summary,
        r.commits,
        r.regressionClean,
      );
      if (!completed) return { ok: false, error: `wave.complete:already-complete:${r.waveId}` };
      void this.emitSystemEvent(`wave.${r.waveId}.complete`, {
        waveId: r.waveId,
        status: 'ok',
        commits: r.commits ?? [],
        regression_clean: r.regressionClean ?? false,
      });

      // HARVEST: close any sub-worker terminals registered to this wave
      const terminalIdsToClose = this.waveRegistry.harvestWave(r.waveId);
      const closedTerminals: string[] = [];
      const alreadyClosed: string[] = [];
      for (const tid of terminalIdsToClose) {
        const closed = tm.close(tid);
        if (closed) { closedTerminals.push(tid); } else { alreadyClosed.push(tid); }
      }
      // Always emit harvested so orchestrators can confirm lifecycle closed.
      void this.emitSystemEvent(`wave.${r.waveId}.harvested`, {
        waveId: r.waveId,
        orphaned_count: terminalIdsToClose.length,
        closed_terminals: closedTerminals,
        already_closed: alreadyClosed,
        ts: new Date().toISOString(),
      });

      return { ok: true, waveId: r.waveId, completedAt: completed.completedAt, harvested: closedTerminals.length };
    }

    if (cmd === 'deliver-cmd') {
      const denied = this.requireRole(ctx, ['orchestrator']);
      if (denied) return denied;
      const r = req as import('./protocol').DeliverCmdRequest;
      if (!r.targetPeerId) return { ok: false, error: 'deliver-cmd:missing-targetPeerId' };
      if (!r.cmdTopic)     return { ok: false, error: 'deliver-cmd:missing-cmdTopic' };
      if (!r.idempotencyKey) return { ok: false, error: 'deliver-cmd:missing-idempotencyKey' };
      const targetPeer = this.peers.get(r.targetPeerId);
      if (!targetPeer) return { ok: false, error: `deliver-cmd:target-not-found:${r.targetPeerId}` };
      const existing = this.cmdIdempotencyMap.get(r.idempotencyKey);
      if (existing) return { ok: true, duplicate: true, seq: existing.seq };
      const seq = ++this.cmdSeq;
      const from = ctx.getPeerId() ?? 'unknown';
      this.cmdIdempotencyMap.set(r.idempotencyKey, { seq, targetPeerId: r.targetPeerId });
      this.cmdDeliveryMap.set(seq, { targetPeerId: r.targetPeerId, from, cmdTopic: r.cmdTopic });
      try {
        await this.eventLog.append({
          schema: 'cmd-deliver-v1',
          topic: r.cmdTopic,
          peerId: from,
          peerName: ctx.getPeerId() ?? 'unknown',
          payload: { targetPeerId: r.targetPeerId, cmdTopic: r.cmdTopic, idempotencyKey: r.idempotencyKey, seq },
        });
      } catch { /* non-fatal: delivery continues even if log fails */ }
      this.pushFrame(targetPeer.socket, r.cmdTopic, from, r.payload, seq);
      return { ok: true, seq };
    }

    if (cmd === 'cmd.ack') {
      const denied = this.requireRole(ctx, ['worker']);
      if (denied) return denied;
      const r = req as import('./protocol').CmdAckRequest;
      const workerPeerId = ctx.getPeerId() ?? 'unknown';
      const ackTopic = `cmd.${workerPeerId}.ack`;
      const ackPayload: Record<string, unknown> = { seq: r.seq, status: r.status, workerPeerId };
      if (r.correlation_id) ackPayload.correlation_id = r.correlation_id;
      let sequence: number | undefined;
      try {
        const logResult = await this.eventLog.append({
          schema: 'cmd-ack-v1',
          topic: ackTopic,
          peerId: workerPeerId,
          peerName: workerPeerId,
          payload: ackPayload,
        });
        sequence = logResult.sequence >= 0 ? logResult.sequence : undefined;
      } catch { /* non-fatal */ }
      this.fanOut(ackTopic, workerPeerId, ackPayload, false, sequence);
      return { ok: true };
    }

    if (cmd === 'pipeline.create') {
      const denied = this.requireRole(ctx, ['orchestrator']);
      if (denied) return denied;
      const r = req as import('./protocol').PipelineCreateRequest;
      if (!Array.isArray(r.steps) || r.steps.length < 2) {
        return { ok: false, error: 'pipeline.create:steps-required (min 2 steps)' };
      }
      if (!r.steps.some((s) => s.role === 'source')) {
        return { ok: false, error: 'pipeline.create:source-step-required' };
      }
      if (!r.steps.some((s) => s.role === 'sink')) {
        return { ok: false, error: 'pipeline.create:sink-step-required' };
      }
      const pipeline = this.pipelineRegistry.create(r.name ?? 'pipeline', r.steps);
      await this.emitSystemEvent(`pipeline.${pipeline.pipelineId}.created`, {
        pipelineId: pipeline.pipelineId,
        name:       pipeline.name,
        steps:      pipeline.steps,
        state:      pipeline.state,
        createdAt:  pipeline.createdAt,
      });
      return { ok: true, pipelineId: pipeline.pipelineId, pipeline };
    }

    if (cmd === 'pipeline.list') {
      return { ok: true, pipelines: this.pipelineRegistry.list() };
    }

    if (cmd === 'pipeline.close') {
      const denied = this.requireRole(ctx, ['orchestrator']);
      if (denied) return denied;
      const r = req as import('./protocol').PipelineCloseRequest;
      if (!r.pipelineId) return { ok: false, error: 'pipeline.close:pipelineId-required' };
      const closed = this.pipelineRegistry.close(r.pipelineId);
      if (!closed) return { ok: false, error: `pipeline.close:not-found:${r.pipelineId}` };
      await this.emitSystemEvent(`pipeline.${r.pipelineId}.closed`, {
        pipelineId: r.pipelineId,
        state:      'closed',
        closedAt:   closed.closedAt,
        steps:      closed.steps,
      });
      return { ok: true, pipelineId: r.pipelineId };
    }

    // ── L16 TYPED-RPC ───────────────────────────────────────────────────────

    if (cmd === 'rpc.call') {
      const denied = this.requireRole(ctx, ['orchestrator', 'worker', 'observer']);
      if (denied) return denied;
      const r = req as import('./protocol').RpcCallRequest;
      if (!r.targetPeerId) return { ok: false, error: 'rpc.call:missing-targetPeerId' };
      if (!r.method)       return { ok: false, error: 'rpc.call:missing-method' };

      const targetPeer = this.peers.get(r.targetPeerId);
      if (!targetPeer) return { ok: false, error: `rpc.call:target-not-found:${r.targetPeerId}` };

      const requestId = randomUUID();
      const callerPeerId = ctx.getPeerId()!;
      const timeoutMs = r.timeoutMs ?? 5000;

      // Returns a Promise held open until the worker responds or times out.
      return new Promise<ClawsResponse>((resolve) => {
        const timer = setTimeout(() => {
          if (this.rpcPending.delete(requestId)) {
            resolve({ ok: false, error: 'rpc.call:timeout', requestId });
          }
        }, timeoutMs);

        this.rpcPending.set(requestId, { resolve, callerPeerId, timer });

        this.pushFrame(targetPeer.socket, `rpc.${r.targetPeerId}.request`, callerPeerId, {
          requestId,
          method: r.method,
          params: r.params ?? {},
          callerPeerId,
        });
      });
    }

    // ── L7 Schema Registry ──────────────────────────────────────────────────

    if (cmd === 'schema.list') {
      return { ok: true, schemas: Object.keys(SCHEMA_BY_NAME).sort() };
    }

    if (cmd === 'schema.get') {
      const r = req as import('./protocol').SchemaGetRequest;
      if (!r.name) return { ok: false, error: 'schema.get:missing-name' };
      const schema = SCHEMA_BY_NAME[r.name];
      if (!schema) return { ok: false, error: `schema.get:not-found:${r.name}` };
      return { ok: true, name: r.name, schema: serializeZodSchema(schema) };
    }

    return { ok: false, error: `unknown cmd: ${cmd}` };
  }
}

/**
 * Serialize a Zod schema to a plain JSON-compatible object suitable for the
 * schema registry `schema.get` response. Covers the shapes used in
 * event-schemas.ts; unknown wrapper types fall back to `{ type: typeName }`.
 */
function serializeZodSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def as Record<string, unknown>;
  const typeName = String(def.typeName ?? 'unknown');

  switch (typeName) {
    case 'ZodObject': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shapeMap = (schema as any).shape as Record<string, z.ZodTypeAny>;
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shapeMap)) {
        fields[k] = serializeZodSchema(v);
      }
      return { type: 'object', fields };
    }
    case 'ZodString':  return { type: 'string' };
    case 'ZodNumber':  return { type: 'number' };
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodArray':
      return { type: 'array', items: serializeZodSchema(def.type as z.ZodTypeAny) };
    case 'ZodEnum':
      return { type: 'enum', values: def.values as string[] };
    case 'ZodOptional':
      return { ...serializeZodSchema(def.innerType as z.ZodTypeAny), optional: true };
    case 'ZodNullable':
      return { ...serializeZodSchema(def.innerType as z.ZodTypeAny), nullable: true };
    case 'ZodLiteral':
      return { type: 'literal', value: def.value as unknown };
    case 'ZodRecord':
      return { type: 'record', values: serializeZodSchema(def.valueType as z.ZodTypeAny) };
    case 'ZodUnknown': return { type: 'unknown' };
    default:           return { type: typeName };
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
