import * as fs from 'fs';
import * as path from 'path';

export type Phase =
  | 'PLAN' | 'SPAWN' | 'DEPLOY' | 'OBSERVE'
  | 'RECOVER' | 'HARVEST' | 'CLEANUP' | 'REFLECT' | 'FAILED';

export interface LifecycleState {
  v: 1;
  phase: Phase;
  phases_completed: Phase[];
  plan: string;
  workers: Array<{ id: string; closed: boolean }>;
  started_at: string;
  reflect?: string;
}

const LEGAL_PHASES = new Set<Phase>([
  'PLAN', 'SPAWN', 'DEPLOY', 'OBSERVE', 'RECOVER', 'HARVEST', 'CLEANUP', 'REFLECT', 'FAILED',
]);

const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  PLAN:    ['SPAWN'],
  SPAWN:   ['DEPLOY', 'RECOVER', 'FAILED'],
  DEPLOY:  ['OBSERVE', 'RECOVER', 'FAILED'],
  OBSERVE: ['HARVEST', 'RECOVER', 'FAILED'],
  RECOVER: ['DEPLOY', 'OBSERVE', 'FAILED'],
  HARVEST: ['CLEANUP', 'FAILED'],
  CLEANUP: ['REFLECT', 'FAILED'],
  REFLECT: [],
  FAILED:  [],
};

export class LifecycleStore {
  private state: LifecycleState | null = null;
  private readonly statePath: string;

  constructor(workspaceRoot: string) {
    this.statePath = path.join(workspaceRoot, '.claws', 'lifecycle-state.json');
    this.loadFromDisk();
  }

  /** True when a PLAN has been logged (gate passes). */
  hasPlan(): boolean { return this.state !== null; }

  /** Returns current state, or null if no PLAN exists. */
  snapshot(): LifecycleState | null { return this.state; }

  /**
   * Create initial lifecycle state at PLAN phase.
   * Idempotent: if state already exists, returns it unchanged.
   */
  plan(planText: string): LifecycleState {
    if (!planText.trim()) throw new Error('lifecycle:plan-empty');
    if (this.state !== null) return this.state;
    this.state = {
      v: 1,
      phase: 'PLAN',
      phases_completed: ['PLAN'],
      plan: planText.trim(),
      workers: [],
      started_at: new Date().toISOString(),
    };
    this.flushToDisk();
    return this.state;
  }

  /**
   * Advance state machine by one step.
   * Idempotent: advance to the current phase returns ok.
   * Illegal transitions throw with 'lifecycle:invalid-transition' prefix.
   */
  advance(toPhase: Phase, _reason?: string): LifecycleState {
    if (!this.state) throw new Error('lifecycle:plan-required');
    if (this.state.phase === toPhase) return this.state;
    const allowed = TRANSITIONS[this.state.phase];
    if (!allowed.includes(toPhase)) {
      throw new Error(
        `lifecycle:invalid-transition — cannot go from ${this.state.phase} to ${toPhase}. ` +
        `Allowed: ${allowed.join(', ') || 'none (terminal state)'}`,
      );
    }
    const phases_completed = this.state.phases_completed.includes(toPhase)
      ? this.state.phases_completed
      : [...this.state.phases_completed, toPhase];
    this.state = { ...this.state, phase: toPhase, phases_completed };
    this.flushToDisk();
    return this.state;
  }

  /**
   * Terminal transition to REFLECT with persisted reflection text.
   * Convenience over advance(REFLECT) that also stores the reflect string.
   */
  reflect(reflectText: string): LifecycleState {
    if (!reflectText.trim()) throw new Error('lifecycle:reflect-empty');
    this.advance('REFLECT');
    this.state = { ...this.state!, reflect: reflectText.trim() };
    this.flushToDisk();
    return this.state;
  }

  loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as unknown;
      if (this.isValid(raw)) this.state = raw;
    } catch { /* invalid file — start fresh */ }
  }

  flushToDisk(): void {
    if (!this.state) return;
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.statePath);
  }

  private isValid(raw: unknown): raw is LifecycleState {
    if (!raw || typeof raw !== 'object') return false;
    const s = raw as Record<string, unknown>;
    return (
      LEGAL_PHASES.has(s['phase'] as Phase) &&
      typeof s['plan'] === 'string' && s['plan'].trim().length > 0 &&
      Array.isArray(s['phases_completed'])
    );
  }
}
