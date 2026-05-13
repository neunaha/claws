// extension/src/backends/vscode/vscode-backend.ts
// Thin adapter that wraps TerminalManager + CaptureStore behind the
// TerminalBackend interface. Owns the execWaiters WeakMap (moved from
// ServerOptions in Commit 3). All VS Code API calls are confined to this file.

import * as vscode from 'vscode';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { CaptureStore } from '../../capture-store';
import { TerminalManager } from '../../terminal-manager';
import { stripAnsi } from '../../ansi-strip';
import { HistoryEvent } from '../../protocol';
import { VehicleStateName, TerminalCloseOrigin } from '../../event-schemas';
import type {
  TerminalBackend,
  BackendCreateOptions,
  BackendTerminalInfo,
  BackendLogSlice,
  BackendSendOptions,
  TerminalCreatedEvent,
  TerminalClosedEvent,
  TerminalDataEvent,
  ForegroundProcessInfo,
} from '../../terminal-backend';

type StateChangeCallback = (id: string, from: VehicleStateName | null, to: VehicleStateName) => void;
type ContentChangeCallback = (id: string, pid: number | null, basename: string | null) => void;

const MAX_READLOG_BYTES = 512 * 1024;

export interface VsCodeBackendOptions {
  captureStore: CaptureStore;
  terminalManager: TerminalManager;
  logger: (msg: string) => void;
}

export class VsCodeBackend extends EventEmitter implements TerminalBackend {
  private readonly captureStore: CaptureStore;
  private readonly tm: TerminalManager;

  /** Moved from ServerOptions — exec command waiters keyed by vscode.Terminal. */
  readonly execWaiters = new WeakMap<vscode.Terminal, Array<(ev: HistoryEvent) => void>>();

  constructor(opts: VsCodeBackendOptions) {
    super();
    this.captureStore = opts.captureStore;
    this.tm = opts.terminalManager;
  }

  async start(): Promise<void> {
    // Wire TerminalManager close callback → emit 'terminal:closed' event.
    this.tm.setTerminalCloseCallback((id: string, _wrapped: boolean, origin: TerminalCloseOrigin) => {
      const ev: TerminalClosedEvent = {
        id,
        origin: origin as TerminalClosedEvent['origin'],
      };
      this.emit('terminal:closed', ev);
    });
    // start() resolves immediately — VS Code APIs are already ready at this point.
  }

  dispose(): void {
    this.tm.dispose();
    this.removeAllListeners();
  }

  // ── Optional: VS Code-specific state/content callbacks (not on interface) ──

  /** Delegates to TerminalManager. Called by ClawsServer to wire pub/sub vehicle events. */
  setStateChangeCallback(cb: StateChangeCallback): void {
    this.tm.setStateChangeCallback(cb);
  }

  /** Delegates to TerminalManager. Called by ClawsServer to wire content change events. */
  setContentChangeCallback(cb: ContentChangeCallback): void {
    this.tm.setContentChangeCallback(cb);
  }

  /** Snapshot of currently-tracked terminal IDs (delegates to TerminalManager). */
  liveTerminalIds(): Set<string> {
    return this.tm.liveTerminalIds();
  }

  // ── TerminalBackend interface ──────────────────────────────────────────────

  async createTerminal(opts: BackendCreateOptions): Promise<{ id: string; logPath: string | null }> {
    if (opts.wrapped) {
      const { id } = this.tm.createWrapped({
        name: opts.name,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        env: opts.env,
      });
      const ev: TerminalCreatedEvent = { id, name: opts.name ?? `Claws ${id}`, wrapped: true, logPath: null };
      this.emit('terminal:created', ev);
      return { id, logPath: null };
    }
    const { id } = this.tm.createStandard({
      name: opts.name,
      cwd: opts.cwd,
      shellPath: opts.shellPath,
      env: opts.env,
    });
    const ev: TerminalCreatedEvent = { id, name: opts.name ?? `Claws ${id}`, wrapped: false, logPath: null };
    this.emit('terminal:created', ev);
    return { id, logPath: null };
  }

  async listTerminals(): Promise<BackendTerminalInfo[]> {
    const descriptors = await this.tm.describeAll();
    return descriptors.map((d) => ({
      id: d.id,
      name: d.name,
      shellPid: d.ptyPid ?? d.pid ?? null,
      wrapped: d.wrapped,
      logPath: d.logPath ?? null,
      status: (d.status === 'adopted' ? 'alive' : d.status === 'unknown' ? 'unknown' : 'closed') as BackendTerminalInfo['status'],
      vehicleState: d.vehicleState,
      pid: d.pid ?? null,
      hasShellIntegration: d.hasShellIntegration,
      ptyMode: d.ptyMode,
    }));
  }

  async sendText(id: string, text: string, opts?: BackendSendOptions): Promise<void> {
    const rec = this.tm.recordById(id);
    if (!rec) return;
    const newline = opts?.newline !== false;
    const paste = opts?.paste === true;
    if (rec.pty) {
      rec.pty.writeInjected(text, newline, paste);
    } else {
      rec.terminal.sendText(text, newline);
    }
  }

  async closeTerminal(id: string, _origin?: TerminalClosedEvent['origin']): Promise<void> {
    const origin = (_origin ?? 'orchestrator') as TerminalCloseOrigin;
    const rec = this.tm.recordById(id);
    if (rec?.pty) {
      const fgPid = rec.pty.getForegroundProcess().pid ?? rec.pty.pid;
      if (fgPid != null) {
        try { process.kill(fgPid, 'SIGTERM'); } catch { /* already gone */ }
        const killTimer = setTimeout(() => {
          try {
            process.kill(fgPid, 0);
            process.kill(fgPid, 'SIGKILL');
          } catch { /* already gone */ }
        }, 5000);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }
    }
    this.tm.close(id, origin);
  }

  async readLog(id: string, offset: number | undefined, limit: number, strip: boolean): Promise<BackendLogSlice> {
    const rec = this.tm.recordById(id);
    if (!rec) throw new Error(`VsCodeBackend: unknown terminal id ${id}`);
    const effectiveLimit = Math.min(limit, MAX_READLOG_BYTES);

    if (rec.wrapped && rec.pty) {
      const slice = this.captureStore.read(id, offset, effectiveLimit, strip);
      return {
        bytes: slice.bytes,
        offset: slice.offset,
        nextOffset: slice.nextOffset,
        totalSize: slice.totalSize,
        truncated: slice.truncated,
      };
    }

    if (rec.logPath && fs.existsSync(rec.logPath)) {
      const stat = fs.statSync(rec.logPath);
      const totalSize = stat.size;
      const start = offset !== undefined ? offset : Math.max(0, totalSize - effectiveLimit);
      const fd = fs.openSync(rec.logPath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(effectiveLimit, totalSize - start));
        fs.readSync(fd, buf, 0, buf.length, start);
        let text = buf.toString('utf8');
        if (strip) text = stripAnsi(text);
        return {
          bytes: text,
          offset: start,
          nextOffset: start + buf.length,
          totalSize,
          truncated: buf.length < effectiveLimit,
        };
      } finally {
        fs.closeSync(fd);
      }
    }

    throw new Error(`VsCodeBackend: terminal ${id} is not wrapped and has no logPath`);
  }

  async getForegroundProcess(id: string): Promise<ForegroundProcessInfo> {
    const rec = this.tm.recordById(id);
    if (!rec?.pty) return { pid: null, basename: null };
    return rec.pty.getForegroundProcess();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'terminal:created', listener: (ev: TerminalCreatedEvent) => void): this;
  on(event: 'terminal:closed',  listener: (ev: TerminalClosedEvent)  => void): this;
  on(event: 'terminal:data',    listener: (ev: TerminalDataEvent)    => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  async focusTerminal(id: string): Promise<void> {
    const t = this.tm.terminalById(id);
    if (t) t.show(true);
  }

  async execCommand(id: string, command: string, timeoutMs: number): Promise<{ output: string; exitCode: number | null }> {
    const rec = this.tm.recordById(id);
    if (!rec) throw new Error(`VsCodeBackend: unknown terminal id ${id}`);

    if (!rec.terminal.shellIntegration) {
      // Fallback: send the command, no output capture.
      if (rec.pty) {
        rec.pty.writeInjected(command, true, false);
      } else {
        rec.terminal.sendText(command, true);
      }
      return { output: '', exitCode: null };
    }

    const event = await new Promise<HistoryEvent>((resolve, reject) => {
      const list = this.execWaiters.get(rec.terminal) ?? [];
      const resolver = (ev: HistoryEvent) => { clearTimeout(timer); resolve(ev); };
      const timer = setTimeout(() => {
        const i = list.indexOf(resolver);
        if (i >= 0) list.splice(i, 1);
        reject(new Error(`exec timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      list.push(resolver);
      this.execWaiters.set(rec.terminal, list);
      try {
        rec.terminal.shellIntegration!.executeCommand(command);
      } catch (err) {
        clearTimeout(timer);
        const i = list.indexOf(resolver);
        if (i >= 0) list.splice(i, 1);
        reject(err);
      }
    });

    return {
      output: '',
      exitCode: (event as unknown as { exitCode?: number }).exitCode ?? null,
    };
  }
}
