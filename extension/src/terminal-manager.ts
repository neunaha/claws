import * as vscode from 'vscode';
import { CaptureStore } from './capture-store';
import { ClawsPty } from './claws-pty';
import { TerminalDescriptor } from './protocol';

interface TerminalRecord {
  id: string;
  terminal: vscode.Terminal;
  pty: ClawsPty | null;
  wrapped: boolean;
  logPath: string | null;
  name: string;
}

export interface CreateOptions {
  name?: string;
  cwd?: string;
  wrapped?: boolean;
  shellPath?: string;
  env?: Record<string, string>;
  show?: boolean;
  preserveFocus?: boolean;
}

export class TerminalManager {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly byTerminal = new WeakMap<vscode.Terminal, string>();
  private nextId = 1;

  constructor(
    private readonly captureStore: CaptureStore,
    private readonly logger: (msg: string) => void,
  ) {}

  adoptExisting(terminals: readonly vscode.Terminal[]): void {
    for (const t of terminals) this.idFor(t);
  }

  idFor(terminal: vscode.Terminal): string {
    const existing = this.byTerminal.get(terminal);
    if (existing) return existing;
    const id = String(this.nextId++);
    this.byTerminal.set(terminal, id);
    this.records.set(id, {
      id,
      terminal,
      pty: null,
      wrapped: false,
      logPath: null,
      name: terminal.name,
    });
    return id;
  }

  terminalById(id: string | number): vscode.Terminal | null {
    return this.records.get(String(id))?.terminal ?? null;
  }

  recordById(id: string | number): TerminalRecord | null {
    return this.records.get(String(id)) ?? null;
  }

  async describe(terminal: vscode.Terminal): Promise<TerminalDescriptor> {
    const id = this.idFor(terminal);
    const rec = this.records.get(id);
    let pid: number | null = null;
    try {
      const p = await terminal.processId;
      pid = p ?? null;
    } catch {
      pid = null;
    }
    return {
      id,
      name: terminal.name,
      pid,
      hasShellIntegration: !!terminal.shellIntegration,
      active: vscode.window.activeTerminal === terminal,
      logPath: rec?.logPath ?? null,
      wrapped: rec?.wrapped ?? false,
    };
  }

  async describeAll(): Promise<TerminalDescriptor[]> {
    const out: TerminalDescriptor[] = [];
    for (const t of vscode.window.terminals) {
      out.push(await this.describe(t));
    }
    return out;
  }

  createWrapped(options: CreateOptions): { id: string; terminal: vscode.Terminal; pty: ClawsPty } {
    const id = String(this.nextId++);
    const pty = new ClawsPty({
      terminalId: id,
      shellPath: options.shellPath,
      cwd: options.cwd,
      env: options.env,
      captureStore: this.captureStore,
      logger: this.logger,
    });
    const terminal = vscode.window.createTerminal({
      name: options.name || `Claws ${id}`,
      pty,
    });
    this.byTerminal.set(terminal, id);
    this.records.set(id, {
      id,
      terminal,
      pty,
      wrapped: true,
      logPath: null,
      name: terminal.name,
    });
    if (options.show !== false) terminal.show(options.preserveFocus !== false);
    return { id, terminal, pty };
  }

  createStandard(options: CreateOptions): { id: string; terminal: vscode.Terminal } {
    const id = String(this.nextId++);
    const terminal = vscode.window.createTerminal({
      name: options.name || `Claws ${id}`,
      cwd: options.cwd,
      shellPath: options.shellPath,
      env: options.env,
    });
    this.byTerminal.set(terminal, id);
    this.records.set(id, {
      id,
      terminal,
      pty: null,
      wrapped: false,
      logPath: null,
      name: terminal.name,
    });
    if (options.show !== false) terminal.show(options.preserveFocus !== false);
    return { id, terminal };
  }

  close(id: string | number): boolean {
    const key = String(id);
    const rec = this.records.get(key);
    if (!rec) return false;
    try { rec.terminal.dispose(); } catch { /* ignore */ }
    this.records.delete(key);
    this.captureStore.clear(key);
    return true;
  }

  onTerminalClosed(terminal: vscode.Terminal): void {
    const id = this.byTerminal.get(terminal);
    if (!id) return;
    const rec = this.records.get(id);
    if (rec?.pty) rec.pty.close();
    this.records.delete(id);
    this.captureStore.clear(id);
  }

  reserveNextId(): string {
    return String(this.nextId++);
  }

  linkProfileTerminal(id: string, terminal: vscode.Terminal, pty: ClawsPty): void {
    this.byTerminal.set(terminal, id);
    this.records.set(id, {
      id,
      terminal,
      pty,
      wrapped: true,
      logPath: null,
      name: terminal.name,
    });
  }
}
