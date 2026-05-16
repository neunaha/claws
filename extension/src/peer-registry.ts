// claws/2 peer registry primitives.
//
// The registry holds one `PeerConnection` per active socket that has
// completed the `hello` handshake. It is owned by the `ClawsServer` and
// cleared on `stop()`. matchTopic is defined in topic-utils.ts and
// re-exported here for backward compatibility with existing callers.

import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
export { matchTopic } from './topic-utils';

/**
 * Role declared by a peer during the `hello` handshake. The role gates
 * which commands a peer may issue (e.g. only an orchestrator may dispatch
 * tasks). Exactly one `orchestrator` is permitted per server instance.
 */
export type ClawsRole = 'orchestrator' | 'worker' | 'observer';

/**
 * Live record of a peer that has completed `hello`. Keyed in the server's
 * `peers` map by `peerId`. The `socket` reference is the raw net.Socket
 * held open for server-push writes; on disconnect the server must remove
 * the record from the registry and the subscription index.
 */
export interface PeerConnection {
  /** Allocated peerId, format `p_` + 6 lowercase hex chars OR `fp_` + 12 hex for fingerprinted peers. */
  peerId: string;
  /** Role as declared in the `hello` frame. */
  role: ClawsRole;
  /** Human-friendly name from the `hello` frame (used in logs / UI). */
  peerName: string;
  /** Optional terminal id the peer is bound to (workers attached to a pty). */
  terminalId?: string;
  /** Capability strings the peer advertised. May be empty. */
  capabilities: string[];
  /** Wave ID this peer belongs to (set when hello includes waveId). */
  waveId?: string;
  /** Sub-worker role within the wave (set when hello includes subWorkerRole). */
  subWorkerRole?: string;
  /** Live socket — used exclusively by the server for push frames. */
  socket: net.Socket;
  /** subscriptionId → topicPattern. Patterns may contain `*` / `**`. */
  subscriptions: Map<string, string>;
  /** Monotonic timestamp updated on every command from this peer. */
  lastSeen: number;
  /** Timestamp when the `hello` was accepted. */
  connectedAt: number;
  /**
   * Stable 12-hex fingerprint derived from sha256(peerName+role+instanceNonce).
   * Present only when the peer supplied `instanceNonce` in their hello frame.
   * Used to restore subscriptions and tasks on reconnect.
   */
  fingerprint?: string;
  /** AC-1: lifecycle correlation id supplied by the peer at hello time (from CLAWS_TERMINAL_CORR_ID env).
   *  Used for event-driven boot detection and audit-trail correlation. */
  correlationId?: string;
}

/**
 * Tombstone stored when a fingerprinted peer disconnects. Allows the server
 * to restore subscriptions and re-bind orphaned tasks on reconnect.
 */
export interface DisconnectedPeer {
  peerId: string;
  fingerprint: string;
  role: ClawsRole;
  peerName: string;
  capabilities: string[];
  /** subscriptionId → topicPattern snapshot from the moment of disconnect. */
  subscriptions: Map<string, string>;
  disconnectedAt: number;
}

/**
 * Allocate a wire-format peerId for the Nth peer registered in a server's
 * lifetime. Called by `ClawsServer` with a monotonically increasing `seq`.
 * Format is stable: `p_` followed by `seq.toString(16)` zero-padded to 6
 * hex chars — unique up to 16,777,215 peers per server run, which far
 * exceeds any realistic fleet.
 */
export function allocPeerId(seq: number): string {
  return 'p_' + seq.toString(16).padStart(6, '0');
}

/**
 * Derive a stable 12-hex peerId component from the peer's identity tuple.
 * The result is the first 12 hex chars (6 bytes) of sha256(peerName+role+nonce).
 * Callers prefix with `fp_` to produce the wire peerId: `fp_<fingerprint>`.
 */
export function fingerprintPeer(peerName: string, role: string, nonce: string): string {
  return crypto
    .createHash('sha256')
    .update(peerName + '\x00' + role + '\x00' + nonce)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Bug-6 Layer 2 — tracks which Monitor peers have declared a monitorCorrelationId
 * at hello time. armedCorrelations links corrId → peerId; peerToCorr is the
 * reverse index used to clean up claims on peer disconnect.
 *
 * All four methods are O(1). The registry is never cleared between sessions
 * because it lives for the duration of the server instance.
 */
export class PeerRegistry {
  private readonly armedCorrelations = new Map<string, string>(); // corrId → peerId
  private readonly peerToCorr = new Map<string, string>();        // peerId → corrId
  private readonly pendingArms = new Set<string>();               // corrIds: intent registered, execution not yet completed
  private traceLogPath: string | null = null;

  /** Set the path for the peer-registry trace log (called once at server start). */
  setTraceLogPath(p: string): void { this.traceLogPath = p; }

  /** Append a structured trace line to .claws/peer-registry-trace.log. */
  private trace(event: string, peerId: string, extra?: Record<string, unknown>): void {
    if (!this.traceLogPath) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), event, peerId, ...extra }) + '\n';
      fs.appendFileSync(this.traceLogPath, line);
    } catch { /* non-fatal */ }
  }

  /** Notify registry that a peer was registered (called from ClawsServer hello handler). */
  notifyRegister(peerId: string, role: string, extra?: { fingerprint?: string; monitorCorrelationId?: string }): void {
    this.trace('register', peerId, { role, ...extra });
  }

  /** Notify registry that a peer was unregistered (called from ClawsServer handleDisconnect). */
  notifyUnregister(peerId: string, reason: string): void {
    this.trace('unregister', peerId, { reason });
  }

  /** Record that peerId is the Monitor process for correlationId. One peer → one claim. */
  recordMonitorClaim(peerId: string, correlationId: string): void {
    this.removeMonitorClaim(peerId);
    this.armedCorrelations.set(correlationId, peerId);
    this.peerToCorr.set(peerId, correlationId);
    this.pendingArms.delete(correlationId);   // graduation from intent to execution
  }

  /** Returns true if any live peer has declared a claim for this correlationId. */
  isCorrIdArmed(correlationId: string): boolean {
    return this.armedCorrelations.has(correlationId);
  }

  /** Remove any claim held by peerId (called on peer disconnect). Does NOT touch pendingArms. */
  removeMonitorClaim(peerId: string): void {
    const corrId = this.peerToCorr.get(peerId);
    if (corrId !== undefined) {
      this.armedCorrelations.delete(corrId);
      this.peerToCorr.delete(peerId);
    }
  }

  /** Return the peerId that claimed corrId, or undefined if unclaimed. */
  getArmedPeerForCorrId(correlationId: string): string | undefined {
    return this.armedCorrelations.get(correlationId);
  }

  /** Register intent to arm a monitor for corrId. Set server-side at spawn time. */
  registerArmIntent(correlationId: string): void {
    this.pendingArms.add(correlationId);
  }

  /** Remove intent without graduation (used only for cleanup / testing). */
  removeArmIntent(correlationId: string): void {
    this.pendingArms.delete(correlationId);
  }

  /** Returns true if intent was registered but execution (hello-claim) has not completed. */
  isCorrIdPending(correlationId: string): boolean {
    return this.pendingArms.has(correlationId);
  }
}
