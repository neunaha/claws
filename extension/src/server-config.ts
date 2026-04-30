// Runtime-readable configuration for the socket server. Extension-level code
// reads values from vscode.workspace.getConfiguration('claws') and passes a
// ServerConfigProvider into the server so the server itself has no direct
// dependency on vscode — keeps it mockable in unit tests.

export interface EventLogConfig {
  /** Days to retain segment files. Segments older than this are deleted on the
   *  heartbeat timer. Default: 7. Set to 0 to disable retention. */
  retentionDays: number;
  /** When true, tiny segments (< 1 KB) are merged on startup. Default: true. */
  compact: boolean;
}

/** L18 AUTH — token-based authentication configuration. */
export interface AuthConfig {
  /** When true, hello requests without a valid HMAC token are rejected. Default: false. */
  enabled: boolean;
  /**
   * Path to a file containing the shared secret used for HMAC-SHA256 token
   * validation. Required when enabled=true. May be absolute or relative to
   * the workspace root.
   */
  tokenPath: string;
}

/** L19 TRANSPORT-X — optional WebSocket server configuration. */
export interface WebSocketConfig {
  /** When true, a WebSocket server is started alongside the Unix socket. Default: false. */
  enabled: boolean;
  /** TCP port for the WebSocket server. Default: 5678. */
  port: number;
  /** Absolute path to TLS certificate file. Empty string = plain ws://. */
  certPath: string;
  /** Absolute path to TLS private key file. Empty string = plain ws://. */
  keyPath: string;
}

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
  /**
   * Maximum publish operations allowed per peer per second (L14 rate limiter).
   * Peers that exceed this limit receive {ok:false,error:'rate-limit-exceeded'}.
   * Default: 10 000.
   */
  maxPublishRateHz: number;
  /**
   * Maximum number of publish handlers that may be in-flight simultaneously
   * before new publish requests are rejected with admission-control:backlog.
   * Default: 500.
   */
  maxQueueDepth: number;
  /** Event log durability settings. */
  eventLog: EventLogConfig;
  /** L18 AUTH — token-based authentication. */
  auth: AuthConfig;
  /** L19 TRANSPORT-X — optional WebSocket transport. */
  webSocket: WebSocketConfig;
}

export type ServerConfigProvider = () => ServerConfig;

export const DEFAULT_EXEC_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_LIMIT = 100;
export const DEFAULT_STRICT_EVENT_VALIDATION = false;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_EVENT_LOG_RETENTION_DAYS = 7;
export const DEFAULT_EVENT_LOG_COMPACT = true;
export const DEFAULT_MAX_PUBLISH_RATE_HZ = 10_000;
export const DEFAULT_MAX_QUEUE_DEPTH = 500;

export const defaultServerConfig: ServerConfig = {
  execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
  pollLimit: DEFAULT_POLL_LIMIT,
  strictEventValidation: DEFAULT_STRICT_EVENT_VALIDATION,
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  maxPublishRateHz: DEFAULT_MAX_PUBLISH_RATE_HZ,
  maxQueueDepth: DEFAULT_MAX_QUEUE_DEPTH,
  eventLog: {
    retentionDays: DEFAULT_EVENT_LOG_RETENTION_DAYS,
    compact: DEFAULT_EVENT_LOG_COMPACT,
  },
  auth: { enabled: false, tokenPath: '' },
  webSocket: { enabled: false, port: 5678, certPath: '', keyPath: '' },
};
