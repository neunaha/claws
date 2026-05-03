import * as fs from 'fs';
import * as path from 'path';

// ─── Lifecycle state model (v0.7.10 — 10-phase, schema v3) ──────────────────
// Pure CRUD on LifecycleState. Transition rules + gate validators live in
// lifecycle-rules.ts. Auto-advance logic lives in lifecycle-engine.ts.
//
// Rationale: separating state, rules, and engine lets each be tested
// independently. The store owns persistence; rules are pure functions; the
// engine subscribes to events and orchestrates state changes.

export type Phase =
  | 'SESSION-BOOT'
  | 'PLAN' | 'SPAWN' | 'DEPLOY' | 'OBSERVE'
  | 'RECOVER' | 'HARVEST' | 'CLEANUP' | 'REFLECT'
  | 'SESSION-END' | 'FAILED';

export type WorkerMode = 'single' | 'fleet' | 'army';
export type WorkerStatus = 'spawned' | 'completed' | 'failed' | 'timeout' | 'closed' | 'terminated';

export interface SpawnedWorker {
  id: string;                  // terminal_id
  correlation_id: string;      // orchestrator-supplied UUID — race-free monitor key (D)
  name: string;
  spawned_at: string;          // ISO
  status: WorkerStatus;
  completed_at?: string;       // ISO; set when status leaves 'spawned'
}

export interface MonitorRecord {
  terminal_id: string;
  correlation_id: string;      // matches SpawnedWorker.correlation_id
  command: string;             // verbatim Bash(...) command the orchestrator was instructed to arm
  armed_at: string;            // ISO — set by server-side spawn handler atomically with spawn (F)
}

export interface LifecycleState {
  v: 3;                        // schema bump for D+F architecture
  phase: Phase;
  phases_completed: Phase[];
  plan: string;
  worker_mode: WorkerMode;
  expected_workers: number;
  spawned_workers: SpawnedWorker[];
  monitors: MonitorRecord[];
  // Backward-compat mirror — v1/v2 consumers expect `workers` field for "is this terminal closed?"
  workers: Array<{ id: string; closed: boolean }>;
  mission_n: number;
  session_started_at: string;
  mission_started_at: string;
  reflect?: string;
}

const LEGAL_PHASES = new Set<Phase>([
  'SESSION-BOOT', 'PLAN', 'SPAWN', 'DEPLOY', 'OBSERVE',
  'RECOVER', 'HARVEST', 'CLEANUP', 'REFLECT', 'SESSION-END', 'FAILED',
]);

const VALID_WORKER_MODES = new Set<WorkerMode>(['single', 'fleet', 'army']);

export class LifecycleStore {
  private state: LifecycleState | null = null;
  private readonly statePath: string;
  private readonly sessionStartedAt: string;

  constructor(workspaceRoot: string) {
    this.statePath = path.join(workspaceRoot, '.claws', 'lifecycle-state.json');
    this.sessionStartedAt = new Date().toISOString();
    this.loadFromDisk();
  }

  /** True when in a mission cycle (PLAN..CLEANUP). False at SESSION-BOOT, REFLECT, SESSION-END, or null. */
  hasPlan(): boolean {
    if (!this.state) return false;
    const p = this.state.phase;
    return p !== 'SESSION-BOOT' && p !== 'REFLECT' && p !== 'SESSION-END';
  }

  /** Returns current state, or null if no SESSION-BOOT yet. */
  snapshot(): LifecycleState | null { return this.state; }

  /**
   * Initialize at SESSION-BOOT. Idempotent: subsequent calls return existing state.
   * Auto-fired by server constructor; can also be called explicitly by session-start hook.
   */
  bootSession(): LifecycleState {
    if (this.state !== null) return this.state;
    this.state = {
      v: 3,
      phase: 'SESSION-BOOT',
      phases_completed: ['SESSION-BOOT'],
      plan: '',
      worker_mode: 'single',          // placeholder — overwritten by plan()
      expected_workers: 0,
      spawned_workers: [],
      monitors: [],
      workers: [],
      mission_n: 0,
      session_started_at: this.sessionStartedAt,
      mission_started_at: '',
    };
    this.flushToDisk();
    return this.state;
  }

  /**
   * Start mission cycle at PLAN phase. workerMode + expectedWorkers REQUIRED.
   * Re-entry from REFLECT starts cycle N+1; otherwise idempotent within active cycle.
   */
  plan(planText: string, workerMode: WorkerMode, expectedWorkers: number): LifecycleState {
    if (!planText.trim()) throw new Error('lifecycle:plan-empty');
    if (!VALID_WORKER_MODES.has(workerMode)) {
      throw new Error(`lifecycle:invalid-worker-mode — must be single|fleet|army, got: ${workerMode}`);
    }
    if (!Number.isInteger(expectedWorkers) || expectedWorkers < 1) {
      throw new Error('lifecycle:invalid-expected-workers — must be positive integer');
    }
    if (this.state === null) this.bootSession();
    const inActiveMission = this.state!.phase !== 'SESSION-BOOT'
      && this.state!.phase !== 'REFLECT'
      && this.state!.phase !== 'SESSION-END';
    if (inActiveMission) {
      // Idempotent within active mission — return existing state unchanged
      return this.state!;
    }
    const nextMissionN = this.state!.phase === 'REFLECT' ? this.state!.mission_n + 1 : 1;
    this.state = {
      ...this.state!,
      v: 3,
      phase: 'PLAN',
      phases_completed: this.state!.phases_completed.includes('PLAN')
        ? this.state!.phases_completed
        : [...this.state!.phases_completed, 'PLAN'],
      plan: planText.trim(),
      worker_mode: workerMode,
      expected_workers: expectedWorkers,
      spawned_workers: [],
      monitors: [],
      workers: [],
      mission_n: nextMissionN,
      mission_started_at: new Date().toISOString(),
      reflect: undefined,
    };
    this.flushToDisk();
    return this.state;
  }

  /**
   * Convenience: alias for setPhase(). Provided for backward-compat with v1/v2
   * callers. New code should use setPhase + caller-side validation via lifecycle-rules.
   */
  advance(toPhase: Phase, _reason?: string): LifecycleState {
    return this.setPhase(toPhase);
  }

  /**
   * Set phase directly. NO transition validation here — that's the engine's job
   * (which calls canTransition() from lifecycle-rules.ts before calling this).
   * Use this only when you've already validated the transition.
   */
  setPhase(toPhase: Phase): LifecycleState {
    if (!this.state) throw new Error('lifecycle:no-state');
    if (this.state.phase === toPhase) return this.state;
    const phases_completed = this.state.phases_completed.includes(toPhase)
      ? this.state.phases_completed
      : [...this.state.phases_completed, toPhase];
    this.state = { ...this.state, phase: toPhase, phases_completed };
    this.flushToDisk();
    return this.state;
  }

  /**
   * Register a newly-spawned worker. Called atomically by server-side spawn-class
   * tool handler (claws_create / claws_worker / claws_fleet / claws_dispatch_subworker).
   * correlation_id is the orchestrator-supplied UUID (D) used to match worker.* events.
   */
  registerSpawn(terminalId: string, correlationId: string, name: string): SpawnedWorker {
    if (!this.state) throw new Error('lifecycle:no-state');
    if (!correlationId || !correlationId.trim()) {
      throw new Error('lifecycle:correlation-id-required — orchestrator must supply correlation_id for race-free monitor');
    }
    // Idempotent: same id+corrId → return existing
    const existing = this.state.spawned_workers.find(w => w.id === terminalId);
    if (existing) {
      if (existing.correlation_id !== correlationId) {
        throw new Error(`lifecycle:correlation-id-conflict — terminal ${terminalId} already registered with different corrId`);
      }
      return existing;
    }
    const rec: SpawnedWorker = {
      id: terminalId,
      correlation_id: correlationId,
      name,
      spawned_at: new Date().toISOString(),
      status: 'spawned',
    };
    this.state = {
      ...this.state,
      spawned_workers: [...this.state.spawned_workers, rec],
      workers: [...this.state.workers, { id: terminalId, closed: false }],
    };
    this.flushToDisk();
    return rec;
  }

  /**
   * Register a per-worker monitor. Called atomically by server-side spawn handler
   * RIGHT AFTER registerSpawn. The orchestrator pre-armed the watcher (D), so by
   * the time spawn returns, the monitor record is already in place (F).
   */
  registerMonitor(terminalId: string, correlationId: string, command: string): MonitorRecord {
    if (!this.state) throw new Error('lifecycle:no-state');
    const filtered = this.state.monitors.filter(m => m.terminal_id !== terminalId);
    const rec: MonitorRecord = {
      terminal_id: terminalId,
      correlation_id: correlationId,
      command,
      armed_at: new Date().toISOString(),
    };
    this.state = { ...this.state, monitors: [...filtered, rec] };
    this.flushToDisk();
    return rec;
  }

  /**
   * Update a worker's status. Called by detach watcher when worker reaches terminal state.
   */
  markWorkerStatus(terminalId: string, status: WorkerStatus): SpawnedWorker | null {
    if (!this.state) return null;
    const idx = this.state.spawned_workers.findIndex(w => w.id === terminalId);
    if (idx === -1) return null;
    const updated: SpawnedWorker = {
      ...this.state.spawned_workers[idx],
      status,
      ...(status !== 'spawned' ? { completed_at: new Date().toISOString() } : {}),
    };
    const newSpawned = [...this.state.spawned_workers];
    newSpawned[idx] = updated;
    const newWorkers = this.state.workers.map(w =>
      w.id === terminalId ? { ...w, closed: status === 'closed' } : w
    );
    this.state = { ...this.state, spawned_workers: newSpawned, workers: newWorkers };
    this.flushToDisk();
    return updated;
  }

  /**
   * Persist reflect text + transition to REFLECT. Must already have set phase to REFLECT
   * (or be transitioning from CLEANUP — the engine handles validation).
   */
  reflect(reflectText: string): LifecycleState {
    if (!reflectText.trim()) throw new Error('lifecycle:reflect-empty');
    if (!this.state) throw new Error('lifecycle:no-state');
    this.state = { ...this.state, phase: 'REFLECT', reflect: reflectText.trim() };
    if (!this.state.phases_completed.includes('REFLECT')) {
      this.state.phases_completed = [...this.state.phases_completed, 'REFLECT'];
    }
    this.flushToDisk();
    return this.state;
  }

  loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as unknown;
      if (this.isValidV3(raw)) {
        this.state = raw;
      }
      // v1/v2 not auto-migrated — schema is breaking. Old state files start fresh.
      // Documented in CHANGELOG: "v0.7.10 lifecycle schema v3 — old state files discarded".
    } catch { /* invalid file — start fresh */ }
  }

  flushToDisk(): void {
    if (!this.state) return;
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.statePath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.state, null, 2) + '\n');
      fs.fsyncSync(fd); // M-43: fsyncSync before renameSync (parity with M-29)
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.statePath);
  }

  private isValidV3(raw: unknown): raw is LifecycleState {
    if (!raw || typeof raw !== 'object') return false;
    const s = raw as Record<string, unknown>;
    return (
      s['v'] === 3 &&
      LEGAL_PHASES.has(s['phase'] as Phase) &&
      typeof s['plan'] === 'string' &&
      Array.isArray(s['phases_completed']) &&
      Array.isArray(s['spawned_workers']) &&
      Array.isArray(s['monitors']) &&
      typeof s['mission_n'] === 'number' &&
      VALID_WORKER_MODES.has(s['worker_mode'] as WorkerMode)
    );
  }
}
