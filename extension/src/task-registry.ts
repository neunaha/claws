/**
 * Task registry types for the claws/2 Agentic SDLC protocol.
 * Tasks are in-memory only — cleared when the extension reloads.
 */

/**
 * Lifecycle status of a task. Terminal states are 'succeeded', 'failed',
 * and 'skipped' — a task in any of these cannot be mutated by further
 * update/complete calls (complete is idempotent on the terminal state).
 */
export type TaskStatus = 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'skipped';

/**
 * In-memory record of a single task tracked by the server. Created by
 * `task.assign` and mutated by `task.update` / `task.complete` / `task.cancel`.
 * Exposed verbatim (shallow-copied) in `task.list` responses.
 */
export interface TaskRecord {
  /** Unique task id, format "t_NNN" (zero-padded to 3 digits). */
  taskId: string;
  /** Short human-readable description of the task. */
  title: string;
  /** The prompt or instruction to deliver to the assignee. */
  prompt: string;
  /** peerId of the worker assigned this task. */
  assignee: string;
  /** peerId of the orchestrator that created the task. */
  assignedBy: string;
  status: TaskStatus;
  progressPct?: number;
  note?: string;
  result?: unknown;
  artifacts?: Array<{ type: string; path: string }>;
  assignedAt: number;
  updatedAt: number;
  completedAt?: number;
  timeoutMs?: number;
  /** Set to true when task.cancel has been called; worker should observe and complete with skipped. */
  cancelRequested?: boolean;
  cancelReason?: string;
}

/**
 * Allocates a task id from a monotonic sequence. The wire format is a
 * stable "t_" prefix followed by the sequence number zero-padded to 3
 * digits (e.g. "t_001", "t_042"). Callers must pre-increment their own
 * counter and pass the new value in — this function is pure.
 */
export function allocTaskId(seq: number): string {
  return `t_${String(seq).padStart(3, '0')}`;
}
