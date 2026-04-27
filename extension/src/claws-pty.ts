import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CaptureStore } from './capture-store';

interface NodePtyModule {
  spawn(
    shell: string,
    args: string[],
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ): NodePtyProcess;
}

interface NodePtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface LoadAttempt {
  path: string;
  message: string;
  code?: string;
}

let nodePtyCache: NodePtyModule | null = null;
let loadedFromPath: string | null = null;
let lastLoadError: { message: string; code?: string; stack?: string; attempts: LoadAttempt[] } | null = null;

// Resolution order for node-pty. We always prefer the bundled copy at
// <extension>/native/node-pty because it ships with the VSIX — it works even
// when node_modules/ is stripped (which is what .vscodeignore does). Standard
// resolution is kept as a fallback so `npm link`'d dev installs still work.
function resolveCandidates(): string[] {
  // __dirname is <extension>/dist at runtime (esbuild output) or
  // <extension>/out in ts-node/dev. Either way, ../native/node-pty lands on
  // the bundled copy.
  const bundled = path.join(__dirname, '..', 'native', 'node-pty');
  return [bundled, 'node-pty'];
}

// Load node-pty. We cache ONLY successful loads — failures are retried on
// the next spawn so that if node-pty appears on disk mid-session (e.g. after
// /claws-update compiles it), new terminals pick it up without a VS Code
// reload. The full error from EACH failed require() is captured for the
// diagnostic surface (exposed via loadNodePtyStatus() for the Health Check
// command).
function loadNodePty(logger?: (msg: string) => void): NodePtyModule | null {
  if (nodePtyCache) return nodePtyCache;

  const attempts: LoadAttempt[] = [];
  for (const candidate of resolveCandidates()) {
    try {
      logger?.(`[node-pty] trying ${candidate}`);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(candidate) as NodePtyModule;
      nodePtyCache = mod;
      loadedFromPath = candidate;
      lastLoadError = null;
      logger?.(`[node-pty] loaded successfully from ${candidate}`);
      return nodePtyCache;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      const attempt: LoadAttempt = {
        path: candidate,
        message: e.message || String(err),
        code: e.code,
      };
      attempts.push(attempt);
      logger?.(`[node-pty]   FAILED: ${attempt.message}${attempt.code ? ` (code=${attempt.code})` : ''}`);
    }
  }

  const primary = attempts[0] ?? { path: '(none)', message: 'no candidates' };
  lastLoadError = {
    message: primary.message,
    code: primary.code,
    attempts,
    stack: attempts.map((a) => `  ${a.path}: ${a.message}`).join('\n'),
  };
  if (logger) {
    logger(`[node-pty] load FAILED — tried ${attempts.length} candidate(s):`);
    for (const a of attempts) {
      logger(`[node-pty]   ${a.path}: ${a.message}${a.code ? ` (${a.code})` : ''}`);
    }
    logger(`[node-pty] this causes wrapped terminals to fall back to pipe-mode.`);
    logger(`[node-pty] fix: run 'Claws: Rebuild Native PTY' from the command palette`);
  }
  return null;
}

export function loadNodePtyStatus(): {
  loaded: boolean;
  loadedFrom?: string;
  error?: { message: string; code?: string; attempts: LoadAttempt[] };
} {
  if (nodePtyCache) return { loaded: true, loadedFrom: loadedFromPath ?? undefined };
  if (lastLoadError) {
    return {
      loaded: false,
      error: {
        message: lastLoadError.message,
        code: lastLoadError.code,
        attempts: lastLoadError.attempts,
      },
    };
  }
  return { loaded: false };
}

export interface ClawsPtyOptions {
  terminalId: string;
  shellPath?: string;
  shellArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  captureStore: CaptureStore;
  logger: (msg: string) => void;
}

export class ClawsPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();

  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;

  private ptyProc: NodePtyProcess | null = null;
  private childProc: ChildProcessWithoutNullStreams | null = null;
  private isOpen = false;
  private openedAt: number | null = null;
  private readonly createdAt = Date.now();

  constructor(private readonly opts: ClawsPtyOptions) {}

  get pid(): number | null {
    return this.ptyProc?.pid ?? this.childProc?.pid ?? null;
  }

  get mode(): 'pty' | 'pipe' | 'none' {
    if (this.ptyProc) return 'pty';
    if (this.childProc) return 'pipe';
    return 'none';
  }

  /** True once VS Code has invoked our `open()` hook. */
  hasOpened(): boolean {
    return this.openedAt != null;
  }

  /** Wall-clock ms since this ClawsPty was constructed. */
  ageMs(): number {
    return Date.now() - this.createdAt;
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.isOpen = true;
    this.openedAt = Date.now();
    const shell = this.opts.shellPath || defaultShell();
    const args = this.opts.shellArgs ?? defaultShellArgs(shell);
    const cwd = this.opts.cwd || os.homedir();
    const env = sanitizeEnv(process.env, { ...(this.opts.env || {}), TERM: 'xterm-256color' });
    const cols = initialDimensions?.columns ?? 80;
    const rows = initialDimensions?.rows ?? 24;

    const nodePty = loadNodePty(this.opts.logger);
    if (nodePty) {
      try {
        this.ptyProc = nodePty.spawn(shell, args, { cols, rows, cwd, env, name: 'xterm-256color' });
        this.ptyProc.onData((data) => this.handleOutput(data));
        this.ptyProc.onExit(({ exitCode }) => this.handleExit(exitCode));
        this.opts.logger(`[claws-pty ${this.opts.terminalId}] node-pty spawned ${shell} pid=${this.ptyProc.pid} (real pty)`);
        return;
      } catch (err) {
        this.opts.logger(`[claws-pty ${this.opts.terminalId}] node-pty spawn failed: ${(err as Error).message}. Falling back to child_process pipe-mode.`);
        this.ptyProc = null;
      }
    }

    // Pipe-mode fallback. Log loudly to the Output channel AND emit the
    // yellow banner into the terminal so the user sees it both ways.
    try {
      this.childProc = spawn(shell, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.childProc.stdout.on('data', (d: Buffer) => this.handleOutput(d.toString('utf8')));
      this.childProc.stderr.on('data', (d: Buffer) => this.handleOutput(d.toString('utf8')));
      this.childProc.on('exit', (code) => this.handleExit(code ?? 0));
      const loadErr = lastLoadError?.message || 'unknown reason';
      this.opts.logger(`[claws-pty ${this.opts.terminalId}] PIPE-MODE active (node-pty unavailable): ${loadErr}`);
      this.opts.logger(`[claws-pty ${this.opts.terminalId}] TUIs will not render correctly. Run 'Claws: Health Check' for diagnostics.`);
      this.opts.logger(`[claws-pty ${this.opts.terminalId}] child_process fallback ${shell} pid=${this.childProc.pid}`);
      this.writeEmitter.fire('\x1b[33m[claws] running in pipe-mode (node-pty unavailable); TUIs may render poorly\x1b[0m\r\n');
      this.writeEmitter.fire('\x1b[2m[claws] run "Claws: Health Check" in the command palette for why\x1b[0m\r\n');
    } catch (err) {
      this.opts.logger(`[claws-pty ${this.opts.terminalId}] SPAWN FAILED: ${(err as Error).message}`);
      this.writeEmitter.fire(`\x1b[31m[claws] failed to spawn shell: ${(err as Error).message}\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
    }
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.ptyProc) {
      try { this.ptyProc.kill(); } catch { /* ignore */ }
      this.ptyProc = null;
    }
    if (this.childProc) {
      try { this.childProc.kill(); } catch { /* ignore */ }
      this.childProc = null;
    }
  }

  handleInput(data: string): void {
    if (!this.isOpen) return;
    if (this.ptyProc) {
      this.ptyProc.write(data);
    } else if (this.childProc?.stdin.writable) {
      this.childProc.stdin.write(data);
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.ptyProc) {
      try { this.ptyProc.resize(dimensions.columns, dimensions.rows); } catch { /* ignore */ }
    }
  }

  writeInjected(text: string, withNewline: boolean, bracketedPaste: boolean): void {
    if (!this.isOpen) return;
    const body = bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text;
    this.writeRaw(body);
    if (!withNewline) return;
    // For bracketed paste, the trailing CR must arrive in a separate write
    // after a short delay so the TUI's paste-detection window closes first.
    // Otherwise Ink-based TUIs (Claude Code) bundle the CR into the paste
    // burst and it never registers as a discrete Enter keypress.
    if (bracketedPaste) {
      setTimeout(() => this.writeRaw('\r'), 30);
    } else {
      this.writeRaw('\r');
    }
  }

  private writeRaw(data: string): void {
    if (!this.isOpen) return;
    if (this.ptyProc) {
      this.ptyProc.write(data);
    } else if (this.childProc?.stdin.writable) {
      this.childProc.stdin.write(data);
    }
  }

  private handleOutput(data: string): void {
    this.writeEmitter.fire(data);
    this.opts.captureStore.append(this.opts.terminalId, data);
  }

  private handleExit(code: number): void {
    if (this.isOpen) {
      this.isOpen = false;
      this.closeEmitter.fire(code);
    }
  }
}

// ─── Shell resolution ─────────────────────────────────────────────────────

/**
 * Pick the shell to spawn a wrapped terminal under.
 *
 * Order:
 *   1. $SHELL (user's configured login shell — respect their choice)
 *   2. /bin/bash (more common default on Linux)
 *   3. /bin/zsh (default on macOS Catalina+)
 *   4. /bin/sh (POSIX bottom floor — always present)
 *
 * We deliberately don't hardcode zsh: on headless Linux boxes, zsh often
 * isn't installed at all and falling back to it produces ENOENT at spawn.
 */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  if (process.env.SHELL) return process.env.SHELL;
  const candidates = ['/bin/bash', '/bin/zsh', '/bin/sh'];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return '/bin/sh';
}

/**
 * Pick default argv for the chosen shell.
 *
 * We always pass `-i` (interactive) so the shell reads its per-user rc file
 * (`.zshrc`, `.bashrc`, `fish.config`) — this is what makes aliases, PATH
 * adjustments, and prompt customisation show up.
 *
 * We add `-l` (login) ONLY when the user has a login-shell profile file on
 * disk (`.zprofile`, `.bash_profile`, `.profile`). Adding `-l` unconditionally
 * is a footgun: many users have slow `.profile` scripts (nvm init, asdf init,
 * cargo env…) that would then run on EVERY wrapped-terminal creation.
 * Defaulting to `-i` alone is the fast path — explicit login-profile files
 * signal the user actually wants login-shell semantics.
 */
export function defaultShellArgs(shell: string): string[] {
  if (process.platform === 'win32') return [];
  const base = shell.split('/').pop() || shell;
  if (base === 'zsh' || base === 'bash' || base === 'fish' || base === 'sh') {
    const home = process.env.HOME || os.homedir();
    const loginFiles = ['.zprofile', '.bash_profile', '.profile'];
    let hasLoginProfile = false;
    for (const f of loginFiles) {
      try {
        if (fs.existsSync(path.join(home, f))) { hasLoginProfile = true; break; }
      } catch { /* ignore */ }
    }
    return hasLoginProfile ? ['-i', '-l'] : ['-i'];
  }
  return [];
}

// ─── Env sanitization ─────────────────────────────────────────────────────

/**
 * Strip VS Code/Electron/npm-lifecycle environment vars before forwarding to
 * the user's shell. Leaves standard user env (PATH, HOME, USER, LANG, LC_*,
 * SHELL, EDITOR, VISUAL, TERM, DISPLAY, etc.) intact.
 *
 * Why: VS Code's process environment is polluted with internal variables
 * like VSCODE_IPC_HOOK, VSCODE_PID, ELECTRON_RUN_AS_NODE, plus npm_* vars
 * from however it was started. Propagating these to the user's shell
 * confuses `claude` (which inspects ELECTRON_*) and produces bogus
 * "running inside Electron" warnings.
 *
 * `overrides` wins over `baseEnv`, and any `undefined` in `overrides`
 * explicitly deletes the key from the result.
 */
export function sanitizeEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const DROP_PREFIXES = ['VSCODE_', 'ELECTRON_', 'CHROME_', 'GOOGLE_API_', 'npm_'];
  const DROP_EXACT = new Set([
    'INIT_CWD',
    'VSCODE_PID',
    'VSCODE_CWD',
    'VSCODE_IPC_HOOK',
    'VSCODE_IPC_HOOK_CLI',
    'VSCODE_NLS_CONFIG',
    'VSCODE_CODE_CACHE_PATH',
    'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
    'VSCODE_HANDLES_UNCAUGHT_ERRORS',
    'VSCODE_INJECTION',
    'VSCODE_L10N_BUNDLE_LOCATION',
    'NODE_OPTIONS', // Often set to --inspect by debug; let user shell pick its own.
  ]);

  const shouldDrop = (key: string): boolean => {
    const upper = key.toUpperCase();
    if (DROP_EXACT.has(key) || DROP_EXACT.has(upper)) return true;
    for (const p of DROP_PREFIXES) {
      if (upper.startsWith(p.toUpperCase())) return true;
    }
    return false;
  };

  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (shouldDrop(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}
