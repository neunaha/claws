// ─── LifecycleEngine — auto-advance state machine driven by bus events ────────
// Subscribes (in-process, via direct ClawsServer hookup) to worker state
// changes. On each event, calls nextAutoPhase(state) from lifecycle-rules.
// If a transition is recommended AND legal AND gate-checked, calls
// lifecycleStore.setPhase(next) and emits 'lifecycle.phase-changed' on the
// bus for orchestrator visibility.
//
// Design intent: eliminates orchestrator camping in SPAWN. Phases self-progress
// as work happens: SPAWN→DEPLOY when all expected workers spawned + monitored,
// DEPLOY→OBSERVE when first worker progresses, OBSERVE→HARVEST when done
// (mode-aware), CLEANUP→REFLECT when all terminals closed.

import type { LifecycleStore } from './lifecycle-store';
import { canTransition, canReflect, nextAutoPhase } from './lifecycle-rules';

export interface LifecycleEngineDeps {
  store: LifecycleStore;
  emitEvent: (topic: string, payload: unknown) => Promise<void> | void;
  logger?: (msg: string) => void;
}

export class LifecycleEngine {
  constructor(private readonly deps: LifecycleEngineDeps) {}

  /**
   * Call after any worker state change (spawn, monitor armed, status update).
   * Loops until no further auto-advance is recommended — handles cascades
   * (e.g. SPAWN→DEPLOY may immediately enable DEPLOY→OBSERVE in edge cases).
   */
  onWorkerEvent(reason: string): void {
    let safety = 10;
    while (safety-- > 0) {
      const state = this.deps.store.snapshot();
      if (!state) return;
      const next = nextAutoPhase(state);
      if (next === null || next === state.phase) return;
      if (!canTransition(state.phase, next)) {
        this.deps.logger?.(
          `[lifecycle-engine] BLOCKED: nextAutoPhase ${state.phase}→${next} but canTransition=false`,
        );
        return;
      }
      if (next === 'REFLECT' && !canReflect(state).ok) {
        this.deps.logger?.(`[lifecycle-engine] BLOCKED: REFLECT gate not met`);
        return;
      }
      const prev = state.phase;
      this.deps.store.setPhase(next);
      this.deps.logger?.(
        `[lifecycle-engine] auto-advanced ${prev}→${next} (reason: ${reason})`,
      );
      void this.deps.emitEvent('lifecycle.phase-changed', {
        from: prev,
        to: next,
        reason,
        ts: new Date().toISOString(),
      });
    }
  }
}
