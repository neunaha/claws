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
};
