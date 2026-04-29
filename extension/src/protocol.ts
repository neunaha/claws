// Claws wire protocol — v1.
//
// Requests and responses are newline-delimited JSON frames. Clients MAY
// include `protocol: "claws/1"` on any request; if the server sees a
// different protocol tag it will reject with `ok:false, error: "incompatible
// protocol version"`. Absent = treated as claws/1 (current).
//
// Every response includes `protocol: "claws/1"` and `rid` (request id) —
// `id` is preserved too for legacy clients, but `rid` is always the request
// id regardless of whether a response field shadows it (e.g. `create`
// returns a terminal `id`).

export const PROTOCOL_VERSION = 'claws/1';
export const PROTOCOL_VERSION_V2 = 'claws/2';

// ── Wave army protocol types ───────────────────────────────────────────────

/** Sub-worker roles in the wave army protocol. */
export type SubWorkerRole = 'lead' | 'tester' | 'reviewer' | 'auditor' | 'bench' | 'doc';

/** All contracted sub-worker roles with their discipline obligations. */
export const ContractedRoles: Record<SubWorkerRole, string> = {
  lead:     'Implementer — owns the diff, commits, builds, PIAFEUR loop',
  tester:   'TDD — writes red tests before impl, validates green after',
  reviewer: 'Read-only code review — watches git diff, publishes findings',
  auditor:  'Read-only — sweeps for race conditions, schema correctness, regression risks',
  bench:    'Read-only — runs perf benchmarks after green, publishes metrics',
  doc:      'Docs only — updates CHANGELOG, gap doc, templates',
};

export interface BaseRequest {
  id?: number | string;
  cmd: string;
  /** Optional client-declared protocol tag. Must be 'claws/1' or absent. */
  protocol?: string;
}

export interface ListRequest extends BaseRequest { cmd: 'list'; }

export interface CreateRequest extends BaseRequest {
  cmd: 'create';
  name?: string;
  cwd?: string;
  show?: boolean;
  preserveFocus?: boolean;
  wrapped?: boolean;
  shellPath?: string;
  env?: Record<string, string>;
}

export interface ShowRequest extends BaseRequest {
  cmd: 'show';
  id: string | number;
  preserveFocus?: boolean;
}

/**
 * `send` semantics differ slightly between wrapped and unwrapped terminals
 * because VS Code exposes two distinct APIs:
 *
 *   - UNWRAPPED → `Terminal.sendText(text, withNewline)`. VS Code owns the
 *     input decode path; `paste` bracketing is best-effort (sent as literal
 *     bytes) and newline is ALWAYS `\n` regardless of platform. Multi-line
 *     strings may be fragmented if the shell lacks bracketed-paste support.
 *
 *   - WRAPPED → `Pseudoterminal.handleInput(data)` via ClawsPty.writeInjected.
 *     We fully control the byte stream: bracketed paste (`\x1b[200~…\x1b[201~`)
 *     is injected verbatim, and newline is sent as `\r` to match tty input
 *     conventions (terminals convert it to \n through icrnl). This path is
 *     what you want for sending prompts into TUI sessions like Claude Code.
 *
 * The server's `send` response includes `mode: 'wrapped' | 'unwrapped'` so
 * clients can reason about which path they got.
 */
export interface SendRequest extends BaseRequest {
  cmd: 'send';
  id: string | number;
  text: string;
  newline?: boolean;
  show?: boolean;
  paste?: boolean;
}

export interface ExecRequest extends BaseRequest {
  cmd: 'exec';
  id: string | number;
  command: string;
  timeoutMs?: number;
  show?: boolean;
}

export interface ReadRequest extends BaseRequest {
  cmd: 'read';
  id?: string | number;
  since?: number;
  limit?: number;
}

export interface PollRequest extends BaseRequest {
  cmd: 'poll';
  since?: number;
  /** Optional client-requested cap. Server enforces its own cap via config. */
  limit?: number;
}

export interface CloseRequest extends BaseRequest {
  cmd: 'close';
  id: string | number;
}

export interface ReadLogRequest extends BaseRequest {
  cmd: 'readLog';
  id: string | number;
  offset?: number;
  limit?: number;
  strip?: boolean;
}

/**
 * Runtime introspection — returns extension + runtime metadata for
 * health-checks and client-side version compatibility checks.
 */
export interface IntrospectRequest extends BaseRequest {
  cmd: 'introspect';
  /** Optional client-declared version string; server logs a warning on drift. */
  clientVersion?: string;
  /** Optional client name for the server log line. */
  clientName?: string;
}

/**
 * claws/2 handshake. Must be the first frame a peer sends on a new
 * connection when speaking the v2 protocol. Server replies with the
 * allocated peerId and its capability set. A second `hello` with
 * `role: 'orchestrator'` while one is already registered is rejected.
 */
export interface HelloRequest extends BaseRequest {
  cmd: 'hello';
  /** MUST be 'claws/2' — the server rejects any other value on hello. */
  protocol: string;
  role: 'orchestrator' | 'worker' | 'observer';
  peerName: string;
  terminalId?: string;
  capabilities?: string[];
  /**
   * Optional stable identity nonce. When present, the server derives a
   * fingerprint-based peerId (`fp_` + sha256(peerName+role+nonce)[:12]).
   * Reconnecting with the same nonce restores subscriptions and re-binds
   * any orphaned tasks assigned to the previous connection session.
   */
  instanceNonce?: string;
  /** Wave id this peer belongs to (wave army protocol). */
  waveId?: string;
  /** Sub-worker role within the wave (wave army protocol). */
  subWorkerRole?: SubWorkerRole;
}

/** Create a new wave, registering expected sub-worker roles and heartbeat manifest. */
export interface WaveCreateRequest extends BaseRequest {
  cmd: 'wave.create';
  waveId: string;
  /** Human-readable layers or goals this wave covers. */
  layers: string[];
  /** Expected sub-worker roles — server tracks heartbeats for each. */
  manifest: SubWorkerRole[];
}

/** Mark a wave as complete. Only the LEAD should call this. */
export interface WaveCompleteRequest extends BaseRequest {
  cmd: 'wave.complete';
  waveId: string;
  summary: string;
  commits?: string[];
  regressionClean?: boolean;
}

/** Read-only status snapshot for a wave. */
export interface WaveStatusRequest extends BaseRequest {
  cmd: 'wave.status';
  waveId: string;
}

/**
 * Liveness probe. No state change, server responds with `serverTime`.
 */
export interface PingRequest extends BaseRequest {
  cmd: 'ping';
}

/** Subscribe to a topic pattern. Returns a subscriptionId. */
export interface SubscribeRequest extends BaseRequest {
  cmd: 'subscribe';
  topic: string;
  /**
   * Optional cursor for catch-up replay. When present, the server will replay
   * all matching events from this cursor before switching to live delivery.
   * Format: "<4-digit-segment-id>:<decimal-byte-offset>" (same as publish response cursor).
   * TODO(P1 v0.7.6): full replay not yet implemented — server accepts the field and logs a
   * warning, then falls through to live delivery only.
   */
  fromCursor?: string;
}

/** Response to a subscribe command. replayedCount is populated when fromCursor replay is used. */
export interface SubscribeResponse extends ClawsResponse {
  ok: true;
  subscriptionId: string;
  replayedCount?: number;
}

/** Remove a subscription by id. */
export interface UnsubscribeRequest extends BaseRequest {
  cmd: 'unsubscribe';
  subscriptionId: string;
}

/** Publish a payload to a topic. Server fans out to all matching subscribers. */
export interface PublishRequest extends BaseRequest {
  cmd: 'publish';
  topic: string;
  payload: unknown;
  /** If true, also deliver to the sender. Default false. */
  echo?: boolean;
}

/** Orchestrator-only: fan out a message to all workers (or all peers). */
export interface BroadcastRequest extends BaseRequest {
  cmd: 'broadcast';
  text: string;
  targetRole?: 'worker' | 'orchestrator' | 'observer' | 'all';
  /** If true, also send the text into each target's associated terminalId via bracketed paste. */
  inject?: boolean;
}

/** Orchestrator: create a task and assign it to a worker peer. */
export interface TaskAssignRequest extends BaseRequest {
  cmd: 'task.assign';
  title: string;
  assignee: string;
  prompt: string;
  timeoutMs?: number;
  /** How to deliver the task to the worker. 'publish' sends a pub/sub message; 'inject' also sends the prompt into the terminal; 'both' does both. */
  deliver?: 'publish' | 'inject' | 'both';
}

/** Worker: report progress on an assigned task (also acts as a heartbeat). */
export interface TaskUpdateRequest extends BaseRequest {
  cmd: 'task.update';
  taskId: string;
  status: 'pending' | 'running' | 'blocked';
  progressPct?: number;
  note?: string;
}

/** Worker: mark a task as finished. Idempotent if already completed. */
export interface TaskCompleteRequest extends BaseRequest {
  cmd: 'task.complete';
  taskId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  result?: unknown;
  artifacts?: Array<{ type: string; path: string }>;
}

/** Orchestrator: request cancellation of a task. */
export interface TaskCancelRequest extends BaseRequest {
  cmd: 'task.cancel';
  taskId: string;
  reason?: string;
}

/** Any role: list tasks with optional filters. */
export interface TaskListRequest extends BaseRequest {
  cmd: 'task.list';
  assignee?: string;
  status?: string;
  since?: number;
}

/** Lifecycle state shape — server-owned, never written by clients. */
export interface LifecycleState {
  v: 1;
  phase: string;
  phases_completed: string[];
  plan: string;
  workers: Array<{ id: string; closed: boolean }>;
  started_at: string;
  reflect?: string;
}

/** Start or reset the lifecycle. plan text must be non-empty. */
export interface LifecyclePlanRequest extends BaseRequest {
  cmd: 'lifecycle.plan';
  plan: string;
}

/** Advance the phase state machine one step. */
export interface LifecycleAdvanceRequest extends BaseRequest {
  cmd: 'lifecycle.advance';
  to: string;
  reason?: string;
}

/** Read-only snapshot of current lifecycle state. */
export interface LifecycleSnapshotRequest extends BaseRequest {
  cmd: 'lifecycle.snapshot';
}

/** Terminal transition to REFLECT with persisted reflection text. */
export interface LifecycleReflectRequest extends BaseRequest {
  cmd: 'lifecycle.reflect';
  reflect: string;
}

export type ClawsRequest =
  | ListRequest
  | CreateRequest
  | ShowRequest
  | SendRequest
  | ExecRequest
  | ReadRequest
  | PollRequest
  | CloseRequest
  | ReadLogRequest
  | IntrospectRequest
  | HelloRequest
  | PingRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | PublishRequest
  | BroadcastRequest
  | TaskAssignRequest
  | TaskUpdateRequest
  | TaskCompleteRequest
  | TaskCancelRequest
  | TaskListRequest
  | LifecyclePlanRequest
  | LifecycleAdvanceRequest
  | LifecycleSnapshotRequest
  | LifecycleReflectRequest
  | WaveCreateRequest
  | WaveCompleteRequest
  | WaveStatusRequest
  | BaseRequest;

export interface TerminalDescriptor {
  id: string;
  name: string;
  pid: number | null;
  /**
   * Real shell pid when the wrapped pty has spawned successfully. VS Code's
   * `terminal.processId` returns null/-1 for Pseudoterminal-based terminals
   * (because VS Code didn't spawn the process — we did), so we expose the
   * underlying ptyProc/childProc pid here. Null when not wrapped or when
   * pty.open() has not yet fired.
   */
  ptyPid?: number | null;
  /**
   * 'pty' = real pseudoterminal via node-pty (TUIs work)
   * 'pipe' = child_process fallback when node-pty unavailable (TUIs broken)
   * 'none' = pty.open() has not been called yet by VS Code
   * undefined = unwrapped terminal (no pty at all)
   */
  ptyMode?: 'pty' | 'pipe' | 'none';
  hasShellIntegration: boolean;
  active: boolean;
  logPath: string | null;
  wrapped: boolean;
  /** 'unknown' is emitted for terminals the manager has never adopted. */
  status?: 'adopted' | 'unknown';
  /** Current vehicle lifecycle state. Absent for unwrapped (non-pty) terminals. */
  vehicleState?: 'PROVISIONING' | 'BOOTING' | 'READY' | 'BUSY' | 'IDLE' | 'CLOSING' | 'CLOSED';
}

export interface HistoryEvent {
  seq: number;
  terminalId: string;
  terminalName: string;
  commandLine: string;
  output: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number;
}

export interface ClawsResponse {
  id?: number | string;
  ok: boolean;
  error?: string;
  /** Always 'claws/1' on a successful server response. */
  protocol?: string;
  [key: string]: unknown;
}
