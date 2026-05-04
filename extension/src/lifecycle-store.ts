import * as fs from 'fs';
import * as path from 'path';
import type { FailureCause } from './event-schemas';
export type { FailureCause };

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
  // ── LH-9 TTL fields (additive, optional for v3 backward-compat) ──────────
  // idle_ms: window of inactivity before idle_timeout close. Reset by PTY
  // activity (log-file mtime sampling) and explicit extendTtl().
  // max_ms:  hard ceiling since spawn — never reset by activity.
  // Both default to LifecycleStore.DEFAULT_IDLE_MS / DEFAULT_MAX_MS.
  idle_ms?: number;
  max_ms?: number;
  // last_activity_at: ISO timestamp of last observed PTY mtime / explicit
  // extend. Initialized to spawned_at on registerSpawn. Watchdog computes:
  //   idle_expired = now - last_activity_at > idle_ms
  //   max_expired  = now - spawned_at      > max_ms
  last_activity_at?: string;
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
  // Set on FAILED transition; preserved across FAILED→PLAN recovery so the
  // orchestrator can read it and apply corrective direction to the new mission.
  failure_cause: FailureCause | null;
}

const LEGAL_PHASES = new Set<Phase>([
  'SESSION-BOOT', 'PLAN', 'SPAWN', 'DEPLOY', 'OBSERVE',
  'RECOVER', 'HARVEST', 'CLEANUP', 'REFLECT', 'SESSION-END', 'FAILED',
]);

const VALID_WORKER_MODES = new Set<WorkerMode>(['single', 'fleet', 'army']);

// LH-9 TTL defaults — chosen against observed Claude Code TUI behavior.
// idle: 10 min covers all measured thinking-pauses with 2x margin (longest
//       observed pause was ~5 min during heavy planning).
// max:  4 h covers the longest legitimate workload (40-min audit fleet) with
//       6x margin. Anything longer should not be a Claude Code worker.
// Both are configurable per-spawn via registerSpawn opts.
export const DEFAULT_IDLE_MS = 600_000;       // 10 min
export const DEFAULT_MAX_MS = 14_400_000;     // 4 h

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
      failure_cause: null,
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
    const isRecoveringFromFailed = this.state!.phase === 'FAILED';
    const inActiveMission = this.state!.phase !== 'SESSION-BOOT'
      && this.state!.phase !== 'REFLECT'
      && this.state!.phase !== 'SESSION-END'
      && !isRecoveringFromFailed;   // FAILED is recoverable — allow re-plan
    if (inActiveMission) {
      // Idempotent within active mission — return existing state unchanged
      return this.state!;
    }
    const nextMissionN = (this.state!.phase === 'REFLECT' || isRecoveringFromFailed)
      ? this.state!.mission_n + 1
      : 1;
    // On FAILED recovery: preserve failure_cause so orchestrator can reference
    // it after re-plan. All worker/monitor arrays start fresh.
    const preservedFailureCause = isRecoveringFromFailed ? this.state!.failure_cause : null;
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
      failure_cause: preservedFailureCause,
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
   *
   * When transitioning to FAILED, pass opts.failure_cause to attach structured
   * context the orchestrator can read after recovery via plan().
   */
  setPhase(toPhase: Phase, opts?: { failure_cause?: FailureCause }): LifecycleState {
    if (!this.state) throw new Error('lifecycle:no-state');
    if (this.state.phase === toPhase) return this.state;
    const phases_completed = this.state.phases_completed.includes(toPhase)
      ? this.state.phases_completed
      : [...this.state.phases_completed, toPhase];
    const failure_cause = toPhase === 'FAILED' && opts?.failure_cause
      ? opts.failure_cause
      : this.state.failure_cause;
    this.state = { ...this.state, phase: toPhase, phases_completed, failure_cause };
    this.flushToDisk();
    return this.state;
  }

  /**
   * Register a newly-spawned worker. Called atomically by server-side spawn-class
   * tool handler (claws_create / claws_worker / claws_fleet / claws_dispatch_subworker).
   * correlation_id is the orchestrator-supplied UUID (D) used to match worker.* events.
   */
  registerSpawn(
    terminalId: string,
    correlationId: string,
    name: string,
    opts?: { idle_ms?: number; max_ms?: number },
  ): SpawnedWorker {
    if (!this.state) throw new Error('lifecycle:no-state');
    if (!correlationId || !correlationId.trim()) {
      throw new Error('lifecycle:correlation-id-required — orchestrator must supply correlation_id for race-free monitor');
    }
    const idx = this.state.spawned_workers.findIndex(w => w.id === terminalId);
    const existing = idx === -1 ? null : this.state.spawned_workers[idx];
    if (existing) {
      // Idempotent: same id+corrId on a still-spawned worker returns existing.
      if (existing.status === 'spawned' && existing.correlation_id === correlationId) {
        return existing;
      }
      // LH-9: An existing entry with a different corrId is a conflict ONLY if
      // the worker is still active. Closed/completed/failed/timeout slots
      // are historical — VS Code reload restarts the terminal id counter, so
      // a fresh spawn legitimately reuses a stale id. Block only on a live
      // collision (the prior worker is still running).
      if (existing.status === 'spawned' && existing.correlation_id !== correlationId) {
        throw new Error(`lifecycle:correlation-id-conflict — terminal ${terminalId} already registered with different corrId`);
      }
      // existing.status is non-spawned → fall through, overwrite below.
    }
    const spawnedAt = new Date().toISOString();
    const idleMs = opts?.idle_ms ?? DEFAULT_IDLE_MS;
    const maxMs = opts?.max_ms ?? DEFAULT_MAX_MS;
    const rec: SpawnedWorker = {
      id: terminalId,
      correlation_id: correlationId,
      name,
      spawned_at: spawnedAt,
      status: 'spawned',
      idle_ms: idleMs,
      max_ms: maxMs,
      last_activity_at: spawnedAt,
    };
    let nextSpawned: SpawnedWorker[];
    let nextWorkers: Array<{ id: string; closed: boolean }>;
    if (idx === -1) {
      nextSpawned = [...this.state.spawned_workers, rec];
      nextWorkers = [...this.state.workers, { id: terminalId, closed: false }];
    } else {
      nextSpawned = [...this.state.spawned_workers];
      nextSpawned[idx] = rec;
      const wIdx = this.state.workers.findIndex(w => w.id === terminalId);
      if (wIdx === -1) {
        nextWorkers = [...this.state.workers, { id: terminalId, closed: false }];
      } else {
        nextWorkers = [...this.state.workers];
        nextWorkers[wIdx] = { id: terminalId, closed: false };
      }
    }
    this.state = { ...this.state, spawned_workers: nextSpawned, workers: nextWorkers };
    this.flushToDisk();
    return rec;
  }

  /**
   * LH-9: Mark fresh activity for a worker. Resets the idle TTL window.
   * Called by the watchdog when PTY log-file mtime advances or when an
   * orchestrator MCP call touches the terminal. Cheap — only flushes to
   * disk when the change is meaningful (>5s since last persist).
   * Returns the new last_activity_at, or null if worker is unknown/closed.
   */
  markActivity(terminalId: string, atIso?: string): string | null {
    if (!this.state) return null;
    const idx = this.state.spawned_workers.findIndex(w => w.id === terminalId);
    if (idx === -1) return null;
    const cur = this.state.spawned_workers[idx];
    if (cur.status !== 'spawned') return null;
    const at = atIso ?? new Date().toISOString();
    // Throttle disk flushes to avoid IO storm — in-memory state always
    // reflects truth, but only persist when the gap is >5s. Watchdog reads
    // in-memory snapshot, so durability lag is fine here.
    const lastIso = cur.last_activity_at ?? cur.spawned_at;
    const lastMs = Date.parse(lastIso);
    const atMs = Date.parse(at);
    const newSpawned = [...this.state.spawned_workers];
    newSpawned[idx] = { ...cur, last_activity_at: at };
    this.state = { ...this.state, spawned_workers: newSpawned };
    if (atMs - lastMs >= 5000) {
      this.flushToDisk();
    }
    return at;
  }

  /**
   * LH-9: Atomically extend a worker's idle TTL by addMs. Used by orchestrator
   * for long-running missions that exceed default idle window. Returns the
   * new last_activity_at on success, or null if the worker is unknown or
   * already non-spawned (lost race with watchdog).
   */
  extendTtl(terminalId: string, addMs: number): string | null {
    if (!this.state) return null;
    if (!Number.isFinite(addMs) || addMs <= 0) return null;
    const idx = this.state.spawned_workers.findIndex(w => w.id === terminalId);
    if (idx === -1) return null;
    const cur = this.state.spawned_workers[idx];
    if (cur.status !== 'spawned') return null;
    // Push last_activity_at forward by addMs from now, equivalent to refreshing
    // and adding a one-shot grace window. Caller-supplied addMs is the grace.
    const newIso = new Date(Date.now() + addMs).toISOString();
    const newSpawned = [...this.state.spawned_workers];
    newSpawned[idx] = { ...cur, last_activity_at: newIso };
    this.state = { ...this.state, spawned_workers: newSpawned };
    this.flushToDisk();
    return newIso;
  }

  /**
   * LH-9: Boot reconciliation — given the live terminal IDs from
   * TerminalManager, mark every spawned_worker NOT in liveIds as closed.
   * Self-heals stale state from extension reload / VS Code crash. Returns
   * the list of IDs that were reconciled.
   */
  reconcileWithLiveTerminals(liveIds: ReadonlySet<string>): string[] {
    if (!this.state) return [];
    const reconciled: string[] = [];
    const newSpawned = this.state.spawned_workers.map(w => {
      if (w.status !== 'spawned' || liveIds.has(w.id)) return w;
      reconciled.push(w.id);
      return { ...w, status: 'closed' as WorkerStatus, completed_at: new Date().toISOString() };
    });
    if (reconciled.length === 0) return [];
    const reconciledSet = new Set(reconciled);
    const newWorkers = this.state.workers.map(w =>
      reconciledSet.has(w.id) ? { ...w, closed: true } : w
    );
    this.state = { ...this.state, spawned_workers: newSpawned, workers: newWorkers };
    this.flushToDisk();
    return reconciled;
  }

  /**
   * LH-9: Watchdog scan. Returns workers whose idle or max window has
   * elapsed. Read-only — caller is responsible for closing each via
   * terminalManager.close(id, reason). Status check is inline so a worker
   * already in-flight to closed (race) is not double-emitted.
   */
  findExpiredWorkers(nowMs: number = Date.now()): Array<{ id: string; reason: 'idle_timeout' | 'ttl_max' }> {
    if (!this.state) return [];
    const out: Array<{ id: string; reason: 'idle_timeout' | 'ttl_max' }> = [];
    for (const w of this.state.spawned_workers) {
      if (w.status !== 'spawned') continue;
      const spawnedMs = Date.parse(w.spawned_at);
      const maxMs = w.max_ms ?? DEFAULT_MAX_MS;
      if (Number.isFinite(spawnedMs) && nowMs - spawnedMs > maxMs) {
        out.push({ id: w.id, reason: 'ttl_max' });
        continue;
      }
      const idleMs = w.idle_ms ?? DEFAULT_IDLE_MS;
      const lastActivityIso = w.last_activity_at ?? w.spawned_at;
      const lastMs = Date.parse(lastActivityIso);
      if (Number.isFinite(lastMs) && nowMs - lastMs > idleMs) {
        out.push({ id: w.id, reason: 'idle_timeout' });
      }
    }
    return out;
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
        // Back-fill failure_cause for state files written before T9
        if (raw.failure_cause === undefined) {
          (raw as unknown as Record<string, unknown>)['failure_cause'] = null;
        }
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
