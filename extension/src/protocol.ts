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
  | BaseRequest;

export interface TerminalDescriptor {
  id: string;
  name: string;
  pid: number | null;
  hasShellIntegration: boolean;
  active: boolean;
  logPath: string | null;
  wrapped: boolean;
  /** 'unknown' is emitted for terminals the manager has never adopted. */
  status?: 'adopted' | 'unknown';
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
