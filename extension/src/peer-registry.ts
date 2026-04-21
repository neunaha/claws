// claws/2 peer registry primitives.
//
// The registry holds one `PeerConnection` per active socket that has
// completed the `hello` handshake. It is owned by the `ClawsServer` and
// cleared on `stop()`. Helper `matchTopic` implements the wildcard rules
// that `publish` / `subscribe` handlers rely on.

import * as net from 'net';

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
  /** Allocated peerId, format `p_` + 6 lowercase hex chars. */
  peerId: string;
  /** Role as declared in the `hello` frame. */
  role: ClawsRole;
  /** Human-friendly name from the `hello` frame (used in logs / UI). */
  peerName: string;
  /** Optional terminal id the peer is bound to (workers attached to a pty). */
  terminalId?: string;
  /** Capability strings the peer advertised. May be empty. */
  capabilities: string[];
  /** Live socket — used exclusively by the server for push frames. */
  socket: net.Socket;
  /** subscriptionId → topicPattern. Patterns may contain `*` / `**`. */
  subscriptions: Map<string, string>;
  /** Monotonic timestamp updated on every command from this peer. */
  lastSeen: number;
  /** Timestamp when the `hello` was accepted. */
  connectedAt: number;
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
 * Match a concrete dot-delimited topic against a subscription pattern.
 *
 * Rules (segments separated by `.`):
 *   - `*`  matches exactly one segment
 *   - `**` matches one or more segments (greedy; at least one segment)
 *   - any other segment must match literally
 *
 * Examples:
 *   matchTopic('task.started.p1', 'task.*.p1')   === true
 *   matchTopic('task.started.p1', 'task.**')     === true
 *   matchTopic('task.started',    'task.**')     === true
 *   matchTopic('task',            'task.**')     === false
 *   matchTopic('worker.online',   'worker.*')    === true
 *   matchTopic('worker.online.p1','worker.*')    === false
 */
export function matchTopic(topic: string, pattern: string): boolean {
  const t = topic.split('.');
  const p = pattern.split('.');
  return matchSegments(t, 0, p, 0);
}

function matchSegments(t: string[], ti: number, p: string[], pi: number): boolean {
  while (pi < p.length) {
    const seg = p[pi];
    if (seg === '**') {
      // `**` requires at least one remaining topic segment, then consumes
      // one or more. If this is the last pattern segment, any non-empty
      // remainder matches; otherwise we have to try every split point.
      if (pi === p.length - 1) {
        return ti < t.length;
      }
      for (let k = ti + 1; k <= t.length; k++) {
        if (matchSegments(t, k, p, pi + 1)) return true;
      }
      return false;
    }
    if (ti >= t.length) return false;
    if (seg !== '*' && seg !== t[ti]) return false;
    ti++;
    pi++;
  }
  return ti === t.length;
}
