// ─── Lifecycle rules — pure functions (v0.7.10) ─────────────────────────────
// Validators + gate predicates + auto-advance decisions. All pure: input
// LifecycleState → output decision. No I/O, no mutation, no time dependency
// (callers pass their own clock if needed).
//
// This separation lets the engine reason about transitions without touching
// disk and lets tests cover every gate independently.

import type { LifecycleState, Phase, SpawnedWorker, WorkerStatus } from './lifecycle-store';

// 10-phase transition graph. SESSION-BOOT and SESSION-END bookend the session;
// PLAN..REFLECT is the mission cycle, repeatable within a session.
export const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  'SESSION-BOOT': ['PLAN', 'FAILED'],
  PLAN:    ['SPAWN', 'FAILED'],
  SPAWN:   ['DEPLOY', 'RECOVER', 'FAILED'],
  DEPLOY:  ['OBSERVE', 'RECOVER', 'FAILED'],
  OBSERVE: ['HARVEST', 'RECOVER', 'FAILED'],
  RECOVER: ['DEPLOY', 'OBSERVE', 'FAILED'],
  HARVEST: ['CLEANUP', 'FAILED'],
  CLEANUP: ['REFLECT', 'FAILED'],
  REFLECT: ['PLAN', 'SESSION-END'],
  'SESSION-END': [],
  FAILED:  ['CLEANUP', 'SESSION-END'],
};

const TERMINAL_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set(['completed', 'failed', 'timeout', 'closed', 'terminated']);

/** Pure: is the requested transition legal from the current phase? */
export function canTransition(from: Phase, to: Phase): boolean {
  if (from === to) return true;            // idempotent no-op always allowed
  return TRANSITIONS[from].includes(to);
}

/**
 * Why a transition is illegal — for actionable error messages. Returns null if legal.
 * Callers should use canTransition() first; this is for failure-path messaging.
 */
export function explainIllegalTransition(from: Phase, to: Phase): string | null {
  if (canTransition(from, to)) return null;
  const allowed = TRANSITIONS[from];
  if (allowed.length === 0) {
    return `phase ${from} is terminal — no transitions allowed`;
  }
  return `cannot go from ${from} to ${to}; allowed: ${allowed.join(', ')}`;
}

/**
 * Spawn-class tools (claws_create / claws_worker / claws_fleet / claws_dispatch_subworker)
 * are only allowed during SPAWN phase, with declared worker_mode + capacity remaining.
 */
export function canSpawn(state: LifecycleState | null): { ok: true } | { ok: false; reason: string } {
  if (!state) return { ok: false, reason: 'no lifecycle state — call lifecycle.plan first' };
  if (state.phase !== 'SPAWN') {
    return { ok: false, reason: `spawn allowed only in SPAWN phase, currently ${state.phase}` };
  }
  if (state.spawned_workers.length >= state.expected_workers) {
    return { ok: false, reason: `expected_workers=${state.expected_workers} already spawned` };
  }
  return { ok: true };
}

/** CLEANUP gate: every spawned worker must have reached terminal status. */
export function canCleanup(state: LifecycleState | null): { ok: true } | { ok: false; reason: string } {
  if (!state) return { ok: false, reason: 'no lifecycle state' };
  const incomplete = state.spawned_workers.filter(w => !TERMINAL_WORKER_STATUSES.has(w.status));
  if (incomplete.length > 0) {
    return { ok: false, reason: `${incomplete.length} worker(s) not at terminal status: ` + incomplete.map(w => `${w.id}(${w.status})`).join(', ') };
  }
  return { ok: true };
}

/** REFLECT gate: every spawned terminal must be closed. */
export function canReflect(state: LifecycleState | null): { ok: true } | { ok: false; reason: string } {
  if (!state) return { ok: false, reason: 'no lifecycle state' };
  const stillOpen = state.spawned_workers.filter(w => w.status !== 'closed');
  if (stillOpen.length > 0) {
    return { ok: false, reason: `${stillOpen.length} terminal(s) still open: ` + stillOpen.map(w => w.id).join(', ') };
  }
  return { ok: true };
}

/** SESSION-END gate: phase must be REFLECT or FAILED + zero open terminals. */
export function canEndSession(state: LifecycleState | null): { ok: true } | { ok: false; reason: string } {
  if (!state) return { ok: false, reason: 'no lifecycle state' };
  if (state.phase !== 'REFLECT' && state.phase !== 'FAILED') {
    return { ok: false, reason: `session-end requires phase REFLECT or FAILED, got ${state.phase}` };
  }
  const stillOpen = state.spawned_workers.filter(w => w.status !== 'closed');
  if (stillOpen.length > 0) {
    return { ok: false, reason: `${stillOpen.length} terminal(s) still open` };
  }
  return { ok: true };
}

/** True iff every spawned worker has a registered monitor. */
export function allWorkersHaveMonitors(state: LifecycleState | null): boolean {
  if (!state) return false;
  const monitoredIds = new Set(state.monitors.map(m => m.terminal_id));
  return state.spawned_workers.every(w => monitoredIds.has(w.id));
}

/** Terminal IDs of spawned workers without monitors — for diagnostics. */
export function workersWithoutMonitors(state: LifecycleState | null): string[] {
  if (!state) return [];
  const monitoredIds = new Set(state.monitors.map(m => m.terminal_id));
  return state.spawned_workers.filter(w => !monitoredIds.has(w.id)).map(w => w.id);
}

/**
 * Auto-advance decision. Given current state, returns the phase the engine SHOULD
 * transition to next, or null if no auto-advance applies. Pure function — engine
 * decides whether to act on the recommendation.
 *
 * Rules (mode-specific):
 * - SPAWN → DEPLOY when all expected_workers spawned + all have monitors
 * - DEPLOY → OBSERVE when at least one worker has progressed (status !== spawned)
 * - OBSERVE → HARVEST when all workers reach terminal status
 *   - single: 1 terminal-status worker
 *   - fleet:  all expected_workers at terminal status
 *   - army:   driven by claws_wave_complete (engine doesn't auto-advance OBSERVE→HARVEST for army)
 * - CLEANUP → REFLECT (auto when all closed; gate enforces)
 */
export function nextAutoPhase(state: LifecycleState | null): Phase | null {
  if (!state) return null;
  switch (state.phase) {
    case 'SPAWN':
      if (state.spawned_workers.length === state.expected_workers && allWorkersHaveMonitors(state)) {
        return 'DEPLOY';
      }
      return null;
    case 'DEPLOY':
      if (state.spawned_workers.some(w => w.status !== 'spawned')) {
        return 'OBSERVE';
      }
      return null;
    case 'OBSERVE': {
      if (state.worker_mode === 'army') return null;          // army uses claws_wave_complete
      const terminalStatuses = state.spawned_workers.filter(w => TERMINAL_WORKER_STATUSES.has(w.status));
      if (state.worker_mode === 'single' && terminalStatuses.length >= 1) return 'HARVEST';
      if (state.worker_mode === 'fleet'  && terminalStatuses.length >= state.expected_workers) return 'HARVEST';
      return null;
    }
    case 'HARVEST':
      // BUG-A fix: HARVEST→CLEANUP auto when all workers reached terminal status.
      // (canCleanup gate enforces it; engine just needed the explicit transition.)
      if (canCleanup(state).ok) return 'CLEANUP';
      return null;
    case 'CLEANUP':
      if (canReflect(state).ok) return 'REFLECT';
      return null;
    default:
      return null;
  }
}

/** Helper for tests: terminal worker statuses set. */
export function isTerminalStatus(status: WorkerStatus): boolean {
  return TERMINAL_WORKER_STATUSES.has(status);
}

/** Helper for tests: count workers by status. */
export function workerStatusCounts(state: LifecycleState | null): Record<WorkerStatus, number> {
  const counts: Record<WorkerStatus, number> = { spawned: 0, completed: 0, failed: 0, timeout: 0, closed: 0, terminated: 0 };
  if (!state) return counts;
  for (const w of state.spawned_workers) counts[w.status]++;
  return counts;
}

// Re-export for ergonomic imports
export type { SpawnedWorker };
