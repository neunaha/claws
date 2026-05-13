// extension/test/fixtures/mock-backend.ts
// MockBackend implements TerminalBackend for test isolation.
// In-memory state only — no VS Code, no node-pty, no file I/O.

import { EventEmitter } from 'events';
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
} from '../../src/terminal-backend';

interface MockTerminalState {
  id: string;
  name: string;
  wrapped: boolean;
  logPath: string | null;
  status: 'alive' | 'closed';
  logBuffer: string;
  sentTexts: string[];
}

export class MockBackend extends EventEmitter implements TerminalBackend {
  private terminals = new Map<string, MockTerminalState>();
  private nextId = 1;

  started = false;
  disposed = false;

  async start(): Promise<void> {
    this.started = true;
  }

  dispose(): void {
    this.disposed = true;
    this.terminals.clear();
  }

  async createTerminal(opts: BackendCreateOptions): Promise<{ id: string; logPath: string | null }> {
    const id = String(this.nextId++);
    const name = opts.name ?? `terminal-${id}`;
    const wrapped = opts.wrapped ?? false;
    const logPath = wrapped ? `/tmp/mock-log-${id}.log` : null;
    const state: MockTerminalState = { id, name, wrapped, logPath, status: 'alive', logBuffer: '', sentTexts: [] };
    this.terminals.set(id, state);
    const ev: TerminalCreatedEvent = { id, name, wrapped, logPath };
    this.emit('terminal:created', ev);
    return { id, logPath };
  }

  async listTerminals(): Promise<BackendTerminalInfo[]> {
    const results: BackendTerminalInfo[] = [];
    for (const t of this.terminals.values()) {
      results.push({
        id: t.id,
        name: t.name,
        shellPid: null,
        wrapped: t.wrapped,
        logPath: t.logPath,
        status: t.status,
      });
    }
    return results;
  }

  async sendText(id: string, text: string, _opts?: BackendSendOptions): Promise<void> {
    const t = this.terminals.get(id);
    if (!t || t.status !== 'alive') return;
    t.sentTexts.push(text);
    if (t.wrapped) {
      t.logBuffer += text;
      const ev: TerminalDataEvent = { id, data: text };
      this.emit('terminal:data', ev);
    }
  }

  async closeTerminal(id: string, origin: TerminalClosedEvent['origin'] = 'orchestrator'): Promise<void> {
    const t = this.terminals.get(id);
    if (!t || t.status === 'closed') return;
    t.status = 'closed';
    const ev: TerminalClosedEvent = { id, origin };
    this.emit('terminal:closed', ev);
  }

  async readLog(id: string, offset: number | undefined, limit: number, _strip: boolean): Promise<BackendLogSlice> {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`MockBackend: terminal ${id} not found`);
    if (!t.wrapped) throw new Error(`MockBackend: terminal ${id} is not wrapped`);
    const buf = t.logBuffer;
    const totalSize = buf.length;
    const start = offset !== undefined ? offset : Math.max(0, totalSize - limit);
    const slice = buf.slice(start, start + limit);
    const nextOffset = start + slice.length;
    return {
      bytes: slice,
      offset: start,
      nextOffset,
      totalSize,
      truncated: slice.length < totalSize - start,
    };
  }

  async getForegroundProcess(_id: string): Promise<ForegroundProcessInfo> {
    return { pid: null, basename: null };
  }

  on(event: 'terminal:created', listener: (ev: TerminalCreatedEvent) => void): this;
  on(event: 'terminal:closed',  listener: (ev: TerminalClosedEvent)  => void): this;
  on(event: 'terminal:data',    listener: (ev: TerminalDataEvent)    => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  async focusTerminal(_id: string): Promise<void> {
    // no-op in tests
  }

  // ── Test helpers ──────────────────────────────────────────────────────

  /** Inject log bytes into a wrapped terminal (simulates pty output). */
  injectData(id: string, data: string): void {
    const t = this.terminals.get(id);
    if (!t || !t.wrapped) return;
    t.logBuffer += data;
    const ev: TerminalDataEvent = { id, data };
    this.emit('terminal:data', ev);
  }

  /** Return all texts sent to a terminal (for assertion). */
  getSentTexts(id: string): string[] {
    return this.terminals.get(id)?.sentTexts ?? [];
  }

  /** Return the raw terminal state (for assertion). */
  getTerminalState(id: string): MockTerminalState | undefined {
    return this.terminals.get(id);
  }
}
