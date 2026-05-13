import * as vscode from 'vscode';
import { CaptureStore } from './capture-store';
import { ClawsPty } from './backends/vscode/claws-pty';
import { TerminalDescriptor } from './protocol';
import { VehicleStateName, TerminalCloseOrigin } from './event-schemas';

type StateChangeCallback = (id: string, from: VehicleStateName | null, to: VehicleStateName) => void;
type ContentChangeCallback = (id: string, pid: number | null, basename: string | null) => void;
type TerminalCloseCallback = (id: string, wrapped: boolean, origin: TerminalCloseOrigin) => void;

const VALID_TRANSITIONS: Readonly<Record<VehicleStateName, readonly VehicleStateName[]>> = {
  PROVISIONING: ['BOOTING', 'CLOSING'],
  BOOTING:      ['READY', 'CLOSING'],
  READY:        ['BUSY', 'IDLE', 'CLOSING'],
  BUSY:         ['IDLE', 'CLOSING'],
  IDLE:         ['BUSY', 'CLOSING'],
  CLOSING:      ['CLOSED'],
  CLOSED:       [],
};

const CONTENT_DETECTION_INTERVAL_MS = 2000;

interface TerminalRecord {
  id: string;
  terminal: vscode.Terminal;
  pty: ClawsPty | null;
  wrapped: boolean;
  logPath: string | null;
  name: string;
  vehicleState: VehicleStateName;
  contentDetectionTimer: NodeJS.Timeout | null;
  lastForegroundBasename: string | null | undefined;
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

// If VS Code never calls our Pseudoterminal.open() hook within this window
// after a programmatic createWrapped, we treat the ClawsPty as orphaned and
// dispose it. Covers the pathological case where the extension host crashes
// or VS Code silently drops the terminal spec.
const UNOPENED_PTY_TIMEOUT_MS = 60_000;
// Interval at which we scan for stale un-opened PTYs. 10s is frequent enough
// that cleanup feels responsive but infrequent enough that it's invisible
// in perf traces.
const UNOPENED_PTY_SCAN_INTERVAL_MS = 10_000;

export class TerminalManager {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly byTerminal = new Map<vscode.Terminal, string>();
  private nextId = 1;
  private unopenedScanTimer: NodeJS.Timeout | null = null;
  private onStateChange: StateChangeCallback | null = null;
  private onContentChange: ContentChangeCallback | null = null;
  private onTerminalClose: TerminalCloseCallback | null = null;

  constructor(
    private readonly captureStore: CaptureStore,
    private readonly logger: (msg: string) => void,
  ) {
    this.startUnopenedScan();
  }

  /** Wire the vehicle state change callback. Called by ClawsServer after construction. */
  setStateChangeCallback(cb: StateChangeCallback): void {
    this.onStateChange = cb;
  }

  /** Wire the content change callback. Called by ClawsServer after construction. */
  setContentChangeCallback(cb: ContentChangeCallback): void {
    this.onContentChange = cb;
  }

  /** Wire the terminal close callback. Fires for every Claws-tracked terminal on close. */
  setTerminalCloseCallback(cb: TerminalCloseCallback): void {
    this.onTerminalClose = cb;
  }

  private transitionState(rec: TerminalRecord, to: VehicleStateName): void {
    const from = rec.vehicleState;
    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      this.logger(`[terminal-manager] invalid state transition ${from} → ${to} for terminal ${rec.id}`);
      return;
    }
    rec.vehicleState = to;
    this.onStateChange?.(rec.id, from, to);
  }

  private emitInitialState(rec: TerminalRecord): void {
    this.onStateChange?.(rec.id, null, rec.vehicleState);
  }

  private startContentDetection(rec: TerminalRecord): void {
    if (rec.contentDetectionTimer || !rec.pty) return;
    const poll = () => {
      if (!rec.pty) return;
      const { pid, basename } = rec.pty.getForegroundProcess();
      if (basename !== rec.lastForegroundBasename) {
        rec.lastForegroundBasename = basename;
        this.onContentChange?.(rec.id, pid, basename);
      }
    };
    // Fire immediately after a short delay to capture the initial shell state.
    setTimeout(poll, 1500);
    const timer = setInterval(poll, CONTENT_DETECTION_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    rec.contentDetectionTimer = timer;
  }

  private stopContentDetection(rec: TerminalRecord): void {
    if (rec.contentDetectionTimer) {
      clearInterval(rec.contentDetectionTimer);
      rec.contentDetectionTimer = null;
    }
  }

  adoptExisting(terminals: readonly vscode.Terminal[]): void {
    for (const t of terminals) this.idFor(t);
  }

  get terminalCount(): number { return this.records.size; }

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
      vehicleState: 'PROVISIONING',
      contentDetectionTimer: null,
      lastForegroundBasename: undefined,
    });
    return id;
  }

  terminalById(id: string | number): vscode.Terminal | null {
    return this.records.get(String(id))?.terminal ?? null;
  }

  recordById(id: string | number): TerminalRecord | null {
    return this.records.get(String(id)) ?? null;
  }

  /**
   * LH-9: Snapshot of currently-tracked terminal IDs. Used for boot
   * reconciliation against lifecycle-state.json — any spawned_worker not
   * in this set has died while we were down and should be marked closed.
   */
  liveTerminalIds(): Set<string> {
    return new Set(this.records.keys());
  }

  /**
   * Describe a terminal WITHOUT mutating state. If the terminal has never
   * been adopted by the manager (no entry in byTerminal), we return a
   * minimal descriptor with `status: 'unknown'` and no stable id. Adoption
   * happens elsewhere — typically in the `onDidOpenTerminal` event handler.
   */
  async describe(terminal: vscode.Terminal): Promise<TerminalDescriptor> {
    const existingId = this.byTerminal.get(terminal);
    let pid: number | null = null;
    try {
      const p = await terminal.processId;
      pid = p ?? null;
    } catch {
      pid = null;
    }
    if (!existingId) {
      return {
        id: '',
        name: terminal.name,
        pid,
        ptyPid: null,
        hasShellIntegration: !!terminal.shellIntegration,
        active: vscode.window.activeTerminal === terminal,
        logPath: null,
        wrapped: false,
        status: 'unknown',
      };
    }
    const rec = this.records.get(existingId);
    // R7: surface the real shell pid from our ClawsPty (ptyProc.pid or childProc.pid).
    // VS Code's `terminal.processId` is null for Pseudoterminal-based terminals.
    const ptyPid = rec?.pty?.pid ?? null;
    const ptyMode = rec?.pty?.mode;
    return {
      id: existingId,
      name: terminal.name,
      pid,
      ptyPid,
      ptyMode,
      hasShellIntegration: !!terminal.shellIntegration,
      active: vscode.window.activeTerminal === terminal,
      logPath: rec?.logPath ?? null,
      wrapped: rec?.wrapped ?? false,
      status: 'adopted',
      vehicleState: rec?.vehicleState,
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
    const rec: TerminalRecord = {
      id,
      terminal: null as unknown as vscode.Terminal, // set below after createTerminal
      pty: null,
      wrapped: true,
      logPath: null,
      name: options.name || `Claws ${id}`,
      vehicleState: 'PROVISIONING',
      contentDetectionTimer: null,
      lastForegroundBasename: undefined,
    };
    this.records.set(id, rec);

    // Emit PROVISIONING immediately, then transition to BOOTING synchronously.
    this.emitInitialState(rec);
    this.transitionState(rec, 'BOOTING');

    const pty = new ClawsPty({
      terminalId: id,
      shellPath: options.shellPath,
      cwd: options.cwd,
      env: options.env,
      captureStore: this.captureStore,
      logger: this.logger,
      // When VS Code calls open() on the Pseudoterminal, flip to READY and
      // start polling for foreground process changes.
      onOpenHook: () => {
        this.transitionState(rec, 'READY');
        this.startContentDetection(rec);
      },
    });
    rec.pty = pty;

    const terminal = vscode.window.createTerminal({
      name: options.name || `Claws ${id}`,
      pty,
    });
    rec.terminal = terminal;
    this.byTerminal.set(terminal, id);

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
      vehicleState: 'PROVISIONING',
      contentDetectionTimer: null,
      lastForegroundBasename: undefined,
    });
    if (options.show !== false) terminal.show(options.preserveFocus !== false);
    return { id, terminal };
  }

  close(id: string | number, origin: TerminalCloseOrigin = 'orchestrator'): boolean {
    const key = String(id);
    const rec = this.records.get(key);
    if (!rec) return false;
    this.stopContentDetection(rec);
    this.transitionState(rec, 'CLOSING');
    this.transitionState(rec, 'CLOSED');
    // Invoke callback synchronously BEFORE dispose+map mutation. VS Code fires
    // onDidCloseTerminal asynchronously, so by the time onTerminalClosed runs,
    // byTerminal.delete has already cleared the entry and the function bails at
    // its early-return guard — the callback was never reached. This direct call
    // ensures system.terminal.closed always emits for programmatic closes.
    // See .local/audits/lifecycle-silent-mutation-trace.md.
    this.onTerminalClose?.(key, rec.wrapped, origin);
    try { rec.terminal.dispose(); } catch { /* ignore */ }
    this.byTerminal.delete(rec.terminal);
    this.records.delete(key);
    this.captureStore.clear(key);
    return true;
  }

  onTerminalClosed(terminal: vscode.Terminal): void {
    const id = this.byTerminal.get(terminal);
    if (!id) return;
    this.byTerminal.delete(terminal);
    const rec = this.records.get(id);
    if (rec) {
      this.stopContentDetection(rec);
      this.transitionState(rec, 'CLOSING');
      this.transitionState(rec, 'CLOSED');
      this.onTerminalClose?.(id, rec.wrapped, 'user');
    }
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
      vehicleState: 'PROVISIONING',
      contentDetectionTimer: null,
      lastForegroundBasename: undefined,
    });
  }

  /**
   * Tear down internal timers and dispose any tracked ClawsPty instances.
   * Call this during extension deactivation.
   */
  dispose(): void {
    for (const rec of this.records.values()) {
      this.stopContentDetection(rec);
    }
    if (this.unopenedScanTimer) {
      clearInterval(this.unopenedScanTimer);
      this.unopenedScanTimer = null;
    }
  }

  private startUnopenedScan(): void {
    // setInterval is `unref`ed so it never holds the event loop open on its
    // own — matters for unit-test processes that shouldn't hang on exit.
    const timer = setInterval(() => this.scanUnopenedPtys(), UNOPENED_PTY_SCAN_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.unopenedScanTimer = timer;
  }

  private scanUnopenedPtys(): void {
    for (const [id, rec] of this.records) {
      if (!rec.pty) continue;
      if (rec.pty.hasOpened()) continue;
      if (rec.pty.ageMs() < UNOPENED_PTY_TIMEOUT_MS) continue;
      this.logger(
        `[terminal-manager] pty id=${id} never opened after ${rec.pty.ageMs()}ms — disposing orphan`,
      );
      this.stopContentDetection(rec);
      try { rec.pty.close(); } catch { /* ignore */ }
      try { rec.terminal.dispose(); } catch { /* ignore */ }
      this.byTerminal.delete(rec.terminal);
      this.records.delete(id);
      this.captureStore.clear(id);
    }
  }
}
