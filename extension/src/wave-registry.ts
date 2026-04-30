import { SubWorkerRole } from './protocol';

export interface WaveSubWorkerEntry {
  role: SubWorkerRole;
  /** peerId of the sub-worker peer, set on hello with waveId+subWorkerRole. */
  peerId?: string;
  /** Epoch ms of last observed heartbeat from this sub-worker. */
  lastHeartbeatMs: number;
  /** Whether this sub-worker has published its *.complete event. */
  complete: boolean;
  /** NodeJS timer handle for the violation detector. */
  violationTimer?: ReturnType<typeof setTimeout>;
  /** Terminal ID created by this sub-worker (set by server create handler). */
  terminalId?: string;
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
  /** Optional parent wave ID when this wave was spawned by another wave's LEAD. */
  parentWave?: string;
  /** Terminal IDs spawned by sub-worker peers affiliated with this wave. */
  subWorkerTerminals: string[];
  /** Epoch ms when auto-harvest ran (wave.complete triggered terminal closures). */
  harvestedAt?: number;
  /** Terminal IDs that were still open at harvest time and were force-closed. */
  orphanedTerminals: string[];
  /** Lead-silence violation timer. Fires when LEAD is silent AND has active sub-worker terminals. */
  leadViolationTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Callback invoked by WaveRegistry when a sub-worker has been silent
 * longer than VIOLATION_THRESHOLD_MS. The emitter should publish a
 * wave.<waveId>.violation event on the bus.
 */
export type ViolationCallback = (waveId: string, role: SubWorkerRole, silentMs: number) => void;

/**
 * Callback invoked when a LEAD has been silent for VIOLATION_THRESHOLD_MS
 * while the wave still has un-harvested sub-worker terminals.
 */
export type LeadViolationCallback = (waveId: string, subWorkerCount: number) => void;

const VIOLATION_THRESHOLD_MS = 25_000;

export class WaveRegistry {
  private readonly waves = new Map<string, WaveRecord>();
  private readonly onViolation: ViolationCallback;
  private readonly onLeadViolation?: LeadViolationCallback;

  constructor(onViolation: ViolationCallback, onLeadViolation?: LeadViolationCallback) {
    this.onViolation = onViolation;
    this.onLeadViolation = onLeadViolation;
  }

  /** Create a new wave. Idempotent — returns existing wave if waveId already registered. */
  createWave(
    waveId: string,
    layers: string[],
    manifest: SubWorkerRole[],
    leadPeerId: string,
    parentWave?: string,
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
      parentWave,
      subWorkerTerminals: [],
      orphanedTerminals: [],
    };

    if (this.onLeadViolation) {
      record.leadViolationTimer = this._scheduleLeadViolation(waveId);
    }

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

  /**
   * Record a heartbeat from the LEAD peer, resetting the lead-violation timer.
   * Called by the server whenever the LEAD peer issues any command.
   */
  recordLeadHeartbeat(waveId: string): void {
    const wave = this.waves.get(waveId);
    if (!wave || wave.complete) return;
    if (wave.leadViolationTimer !== undefined) clearTimeout(wave.leadViolationTimer);
    if (this.onLeadViolation) {
      wave.leadViolationTimer = this._scheduleLeadViolation(waveId);
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
   * Track a terminal ID spawned by a sub-worker peer affiliated with this wave.
   * Optionally associates the TID with a specific sub-worker role entry.
   * Silently ignored if wave doesn't exist or is already complete.
   */
  trackTerminal(waveId: string, terminalId: string, role?: SubWorkerRole): void {
    const wave = this.waves.get(waveId);
    if (!wave || wave.complete) return;
    if (!wave.subWorkerTerminals.includes(terminalId)) {
      wave.subWorkerTerminals.push(terminalId);
    }
    if (role) {
      const entry = wave.subWorkers.get(role);
      if (entry && !entry.terminalId) entry.terminalId = terminalId;
    }
  }

  /**
   * Harvest a wave: collect all un-closed sub-worker terminals, mark them as
   * orphaned, set harvestedAt. Returns the terminal ID list so the server can
   * call terminalManager.close() on each. Only valid once per wave.
   */
  harvestWave(waveId: string): string[] {
    const wave = this.waves.get(waveId);
    if (!wave || wave.harvestedAt) return [];
    wave.harvestedAt = Date.now();
    wave.orphanedTerminals = [...wave.subWorkerTerminals];
    return wave.orphanedTerminals;
  }

  /**
   * Mark the wave as complete. Clears all sub-worker violation timers and the
   * lead violation timer. Returns the wave record (including subWorkerTerminals
   * for harvest) or null if the wave was already complete.
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
    if (wave.leadViolationTimer !== undefined) {
      clearTimeout(wave.leadViolationTimer);
      wave.leadViolationTimer = undefined;
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
      if (wave.leadViolationTimer !== undefined) clearTimeout(wave.leadViolationTimer);
    }
    this.waves.clear();
  }

  private _scheduleLeadViolation(waveId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this._checkLeadViolation(waveId);
    }, VIOLATION_THRESHOLD_MS);
  }

  private _checkLeadViolation(waveId: string): void {
    const wave = this.waves.get(waveId);
    if (!wave || wave.complete || wave.harvestedAt) return;
    const activeCount = wave.subWorkerTerminals.length;
    if (activeCount > 0 && this.onLeadViolation) {
      this.onLeadViolation(waveId, activeCount);
      // Reschedule so violations keep firing until resolved.
      wave.leadViolationTimer = this._scheduleLeadViolation(waveId);
    }
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
