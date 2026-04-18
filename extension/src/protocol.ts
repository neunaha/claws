export interface BaseRequest {
  id?: number | string;
  cmd: string;
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
  | BaseRequest;

export interface TerminalDescriptor {
  id: string;
  name: string;
  pid: number | null;
  hasShellIntegration: boolean;
  active: boolean;
  logPath: string | null;
  wrapped: boolean;
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
  [key: string]: unknown;
}
