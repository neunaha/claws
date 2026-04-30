import { SubWorkerRole } from './protocol';

export interface WaveSubWorkerEntry {
  role: SubWorkerRole;
  /** peerId of the sub-worker terminal, if registered via hello with waveId. */
  peerId?: string;
  /** Epoch ms of last observed heartbeat from this sub-worker. */
  lastHeartbeatMs: number;
  /** Whether this sub-worker has published its *.complete event. */
  complete: boolean;
  /** NodeJS timer handle for the violation detector. */
  violationTimer?: ReturnType<typeof setTimeout>;
}

export interface WaveRecord {
  waveId: string;
  /** Human-readable layers or goals this wave covers. */
  layers: string[];
  /** Expected sub-worker roles, tracking entry keyed by role. */
  subWorkers: Map<SubWorkerRole, WaveSubWorkerEntry>;
  /** peerId of the LEAD peer that created this wave. */
  leadPeerId: string;
  createdAt: number;
  completedAt?: number;
  summary?: string;
  commits?: string[];
  regressionClean?: boolean;
  complete: boolean;
}

/**
 * Callback invoked by WaveRegistry when a sub-worker has been silent
 * longer than VIOLATION_THRESHOLD_MS. The emitter should publish a
 * wave.<waveId>.violation event on the bus.
 */
export type ViolationCallback = (waveId: string, role: SubWorkerRole, silentMs: number) => void;

const VIOLATION_THRESHOLD_MS = 25_000;

export class WaveRegistry {
  private readonly waves = new Map<string, WaveRecord>();
  private readonly onViolation: ViolationCallback;

  constructor(onViolation: ViolationCallback) {
    this.onViolation = onViolation;
  }

  /** Create a new wave. Idempotent — returns existing wave if waveId already registered. */
  createWave(
    waveId: string,
    layers: string[],
    manifest: SubWorkerRole[],
    leadPeerId: string,
  ): WaveRecord {
    const existing = this.waves.get(waveId);
    if (existing) return existing;

    const subWorkers = new Map<SubWorkerRole, WaveSubWorkerEntry>();
    const now = Date.now();
    for (const role of manifest) {
      const entry: WaveSubWorkerEntry = { role, lastHeartbeatMs: now, complete: false };
      const timer = setTimeout(() => {
        this._checkViolation(waveId, role);
      }, VIOLATION_THRESHOLD_MS);
      entry.violationTimer = timer;
      subWorkers.set(role, entry);
    }

    const record: WaveRecord = {
      waveId,
      layers,
      subWorkers,
      leadPeerId,
      createdAt: now,
      complete: false,
    };
    this.waves.set(waveId, record);
    return record;
  }

  /** Record a heartbeat from a sub-worker, resetting its violation timer. */
  recordHeartbeat(waveId: string, role: SubWorkerRole, peerId?: string): void {
    const wave = this.waves.get(waveId);
    if (!wave) return;
    const entry = wave.subWorkers.get(role);
    if (!entry) return;

    entry.lastHeartbeatMs = Date.now();
    if (peerId) entry.peerId = peerId;

    if (entry.violationTimer !== undefined) clearTimeout(entry.violationTimer);
    if (!entry.complete && !wave.complete) {
      entry.violationTimer = setTimeout(() => {
        this._checkViolation(waveId, role);
      }, VIOLATION_THRESHOLD_MS);
    }
  }

  /** Mark a sub-worker as complete and cancel its violation timer. */
  markSubWorkerComplete(waveId: string, role: SubWorkerRole): void {
    const wave = this.waves.get(waveId);
    if (!wave) return;
    const entry = wave.subWorkers.get(role);
    if (!entry) return;

    entry.complete = true;
    if (entry.violationTimer !== undefined) {
      clearTimeout(entry.violationTimer);
      entry.violationTimer = undefined;
    }
  }

  /**
   * Mark the wave as complete. Clears all sub-worker violation timers.
   * Only the LEAD should call this.
   */
  completeWave(
    waveId: string,
    summary: string,
    commits?: string[],
    regressionClean?: boolean,
  ): WaveRecord | null {
    const wave = this.waves.get(waveId);
    if (!wave || wave.complete) return null;

    for (const entry of wave.subWorkers.values()) {
      if (entry.violationTimer !== undefined) {
        clearTimeout(entry.violationTimer);
        entry.violationTimer = undefined;
      }
    }
    wave.complete = true;
    wave.completedAt = Date.now();
    wave.summary = summary;
    wave.commits = commits;
    wave.regressionClean = regressionClean;
    return wave;
  }

  /** Get a snapshot of a wave. Returns null if wave does not exist. */
  getWave(waveId: string): WaveRecord | null {
    return this.waves.get(waveId) ?? null;
  }

  /** List all waves (shallow copy of records). */
  listWaves(): WaveRecord[] {
    return [...this.waves.values()];
  }

  /** Handle peer disconnect — clear violation timers for any sub-worker registered under that peerId. */
  handlePeerDisconnect(peerId: string): void {
    for (const wave of this.waves.values()) {
      if (wave.complete) continue;
      for (const entry of wave.subWorkers.values()) {
        if (entry.peerId === peerId && !entry.complete) {
          if (entry.violationTimer !== undefined) clearTimeout(entry.violationTimer);
          entry.violationTimer = undefined;
        }
      }
    }
  }

  /** Dispose — clear all timers. */
  dispose(): void {
    for (const wave of this.waves.values()) {
      for (const entry of wave.subWorkers.values()) {
        if (entry.violationTimer !== undefined) clearTimeout(entry.violationTimer);
      }
    }
    this.waves.clear();
  }

  private _checkViolation(waveId: string, role: SubWorkerRole): void {
    const wave = this.waves.get(waveId);
    if (!wave || wave.complete) return;
    const entry = wave.subWorkers.get(role);
    if (!entry || entry.complete) return;

    const silentMs = Date.now() - entry.lastHeartbeatMs;
    if (silentMs >= VIOLATION_THRESHOLD_MS) {
      this.onViolation(waveId, role, silentMs);
      // Reschedule for next window so violations keep firing until resolved.
      entry.violationTimer = setTimeout(() => {
        this._checkViolation(waveId, role);
      }, VIOLATION_THRESHOLD_MS);
    }
  }
}
