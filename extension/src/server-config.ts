// Runtime-readable configuration for the socket server. Extension-level code
// reads values from vscode.workspace.getConfiguration('claws') and passes a
// ServerConfigProvider into the server so the server itself has no direct
// dependency on vscode — keeps it mockable in unit tests.

export interface ServerConfig {
  /** Maximum wall-clock time for an `exec` request before it rejects. */
  execTimeoutMs: number;
  /** Maximum number of history events a single `poll` response returns. */
  pollLimit: number;
  /**
   * When true, publish requests that fail envelope/payload schema validation
   * are hard-rejected. When false (default), failures emit
   * system.malformed.received but the event is still fanned out.
   */
  strictEventValidation: boolean;
  /**
   * Milliseconds between automatic system.heartbeat events emitted by the
   * server. Set to 0 to disable. Default: 60 000 ms (1 minute).
   */
  heartbeatIntervalMs: number;
}

export type ServerConfigProvider = () => ServerConfig;

export const DEFAULT_EXEC_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_LIMIT = 100;
export const DEFAULT_STRICT_EVENT_VALIDATION = false;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export const defaultServerConfig: ServerConfig = {
  execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
  pollLimit: DEFAULT_POLL_LIMIT,
  strictEventValidation: DEFAULT_STRICT_EVENT_VALIDATION,
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
};
