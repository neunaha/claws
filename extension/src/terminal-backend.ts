// extension/src/terminal-backend.ts
// TerminalBackend interface — the single seam between Claws core and the
// platform that actually runs terminal processes.
//
// Implementations:
//   VsCodeBackend  — extension/src/backends/vscode/vscode-backend.ts
//   TmuxBackend    — extension/src/backends/tmux/tmux-backend.ts (v0.9)

// ─── Shared data types ────────────────────────────────────────────────────

/** Options for creating a new terminal. */
export interface BackendCreateOptions {
  name?: string;
  cwd?: string;
  /** When true, the backend MUST capture all pty output to a log. Required for readLog. */
  wrapped?: boolean;
  shellPath?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
}

/** Snapshot of one terminal as seen by the backend. */
export interface BackendTerminalInfo {
  /** Backend-assigned stable string ID (e.g. "3" for VS Code, "claws:@3" for tmux window index). */
  id: string;
  name: string;
  /** PID of the shell (or primary process) running inside the terminal. null if unknown. */
  shellPid: number | null;
  /** True if this terminal is capturing pty output to a log file. */
  wrapped: boolean;
  /** Absolute path to the log file if wrapped and file-based. null for in-memory capture. */
  logPath: string | null;
  /** Platform-specific status. */
  status: 'alive' | 'closed' | 'unknown';
}

/** Result of a readLog call. Mirrors the existing CaptureSlice shape. */
export interface BackendLogSlice {
  bytes: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
  truncated: boolean;
}

/** Options for sendText. */
export interface BackendSendOptions {
  /** Append a newline/Enter after the text. Default true. */
  newline?: boolean;
  /**
   * Use bracketed-paste mode to wrap the text (prevents line-by-line
   * fragmentation in shell/TUI programs). Default false.
   */
  paste?: boolean;
}

// ─── Events emitted by a TerminalBackend ─────────────────────────────────

export interface TerminalCreatedEvent {
  id: string;
  name: string;
  wrapped: boolean;
  logPath: string | null;
}

export interface TerminalClosedEvent {
  id: string;
  /** Who initiated the close. */
  origin: 'orchestrator' | 'user' | 'process_exit' | 'backend';
}

export interface TerminalDataEvent {
  id: string;
  /** Raw pty bytes (may contain ANSI codes). */
  data: string;
}

export interface ForegroundProcessInfo {
  pid: number | null;
  /** Basename of the foreground command (e.g. 'claude', 'bash', 'vim'). null if unknown. */
  basename: string | null;
}

// ─── The interface ────────────────────────────────────────────────────────

/**
 * TerminalBackend is the single seam between Claws core (server.ts, lifecycle,
 * wave army) and the platform that actually runs terminal processes.
 */
export interface TerminalBackend {
  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start the backend. Called once at server startup.
   * Resolves when the backend is ready to accept commands.
   */
  start(): Promise<void>;

  /**
   * Tear down the backend. Called on extension deactivate or server stop.
   * Does NOT close terminals — call closeTerminal for that.
   */
  dispose(): void;

  // ── Terminal CRUD ──────────────────────────────────────────────────────

  /**
   * Create a new terminal. If opts.wrapped is true, the backend MUST pipe pty
   * output so readLog works.
   */
  createTerminal(opts: BackendCreateOptions): Promise<{ id: string; logPath: string | null }>;

  /** List all currently live terminals managed by this backend instance. */
  listTerminals(): Promise<BackendTerminalInfo[]>;

  /**
   * Send text into the terminal's pty input stream.
   * Must be a no-op if the terminal is not alive; MUST NOT throw.
   */
  sendText(id: string, text: string, opts?: BackendSendOptions): Promise<void>;

  /**
   * Close and destroy a terminal. Idempotent — does not throw if already closed.
   */
  closeTerminal(id: string, origin?: TerminalClosedEvent['origin']): Promise<void>;

  // ── Log reading ────────────────────────────────────────────────────────

  /**
   * Read pty output from a wrapped terminal's capture log.
   * Throws if the terminal is not wrapped.
   * offset: byte position to read from (undefined → tail N bytes)
   * limit: max bytes to return
   * strip: strip ANSI escape codes before returning
   */
  readLog(id: string, offset: number | undefined, limit: number, strip: boolean): Promise<BackendLogSlice>;

  // ── Process inspection ─────────────────────────────────────────────────

  /**
   * Return the foreground process running inside the terminal.
   * Returns { pid: null, basename: null } if the backend cannot determine this.
   */
  getForegroundProcess(id: string): Promise<ForegroundProcessInfo>;

  // ── Events ─────────────────────────────────────────────────────────────

  on(event: 'terminal:created', listener: (ev: TerminalCreatedEvent) => void): this;
  on(event: 'terminal:closed',  listener: (ev: TerminalClosedEvent)  => void): this;
  on(event: 'terminal:data',    listener: (ev: TerminalDataEvent)    => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;

  // ── Optional capabilities ──────────────────────────────────────────────

  /**
   * Bring the terminal into the foreground. No-op if not supported.
   */
  focusTerminal?(id: string): Promise<void>;

  /**
   * Execute a command with output capture and exit code detection.
   * Optional — server falls back to sendText + readLog polling if absent.
   */
  execCommand?(id: string, command: string, timeoutMs: number): Promise<{
    output: string;
    exitCode: number | null;
  }>;
}

/**
 * Factory function signature. Each backend module exports a function matching this.
 */
export type TerminalBackendFactory = (opts: BackendFactoryOptions) => TerminalBackend;

export interface BackendFactoryOptions {
  workspaceRoot: string;
  logger: (msg: string) => void;
  captureStore: import('./capture-store').CaptureStore;
}
