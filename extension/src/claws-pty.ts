import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as os from 'os';
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

let nodePtyCache: NodePtyModule | null = null;

// Load node-pty, caching only successful loads. If the binary is missing or
// fails to load, we return null — but we DON'T cache that null, so the next
// terminal spawn retries. This matters when /claws-update compiles the native
// binary mid-session: new terminal spawns pick it up without needing a full
// VS Code reload. (A fresh extension activation still re-evaluates from
// scratch; this only affects the case where the extension has already loaded
// and the binary appears on disk afterward.)
function loadNodePty(): NodePtyModule | null {
  if (nodePtyCache) return nodePtyCache;
  try {
    nodePtyCache = require('node-pty') as NodePtyModule;
    return nodePtyCache;
  } catch {
    return null;
  }
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

  constructor(private readonly opts: ClawsPtyOptions) {}

  get pid(): number | null {
    return this.ptyProc?.pid ?? this.childProc?.pid ?? null;
  }

  get mode(): 'pty' | 'pipe' | 'none' {
    if (this.ptyProc) return 'pty';
    if (this.childProc) return 'pipe';
    return 'none';
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.isOpen = true;
    const shell = this.opts.shellPath || defaultShell();
    const args = this.opts.shellArgs ?? defaultShellArgs(shell);
    const cwd = this.opts.cwd || os.homedir();
    const env = { ...process.env, ...(this.opts.env || {}), TERM: 'xterm-256color' };
    const cols = initialDimensions?.columns ?? 80;
    const rows = initialDimensions?.rows ?? 24;

    const nodePty = loadNodePty();
    if (nodePty) {
      try {
        this.ptyProc = nodePty.spawn(shell, args, { cols, rows, cwd, env, name: 'xterm-256color' });
        this.ptyProc.onData((data) => this.handleOutput(data));
        this.ptyProc.onExit(({ exitCode }) => this.handleExit(exitCode));
        this.opts.logger(`[claws-pty ${this.opts.terminalId}] node-pty spawned ${shell} pid=${this.ptyProc.pid}`);
        return;
      } catch (err) {
        this.opts.logger(`[claws-pty ${this.opts.terminalId}] node-pty failed: ${(err as Error).message}. Falling back to pipes.`);
        this.ptyProc = null;
      }
    }

    try {
      this.childProc = spawn(shell, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.childProc.stdout.on('data', (d: Buffer) => this.handleOutput(d.toString('utf8')));
      this.childProc.stderr.on('data', (d: Buffer) => this.handleOutput(d.toString('utf8')));
      this.childProc.on('exit', (code) => this.handleExit(code ?? 0));
      this.opts.logger(`[claws-pty ${this.opts.terminalId}] child_process fallback ${shell} pid=${this.childProc.pid}`);
      this.writeEmitter.fire('\x1b[33m[claws] running in pipe-mode (node-pty unavailable); TUIs may render poorly\x1b[0m\r\n');
    } catch (err) {
      this.opts.logger(`[claws-pty ${this.opts.terminalId}] spawn failed: ${(err as Error).message}`);
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
    let payload = text;
    if (bracketedPaste) payload = `\x1b[200~${payload}\x1b[201~`;
    if (withNewline) payload += '\r';
    if (this.ptyProc) {
      this.ptyProc.write(payload);
    } else if (this.childProc?.stdin.writable) {
      this.childProc.stdin.write(payload);
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

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

function defaultShellArgs(shell: string): string[] {
  if (process.platform === 'win32') return [];
  const base = shell.split('/').pop() || shell;
  if (base === 'zsh' || base === 'bash' || base === 'fish' || base === 'sh') {
    return ['-i', '-l'];
  }
  return [];
}
