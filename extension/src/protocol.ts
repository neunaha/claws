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
