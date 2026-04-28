// gen-types.mjs — Generate schemas/types/event-protocol.d.ts.
// Called by index.mjs. Default export is the generator function.
// Produces ambient TypeScript declarations for external consumers.

import { writeFileSync } from 'fs';
import { join } from 'path';

// The type definitions below are templated from the Zod schemas in
// extension/src/event-schemas.ts. Keep in sync when schemas change.
const DTS_CONTENT = `\
// @generated — do not edit. Run: npm run schemas (from extension/)
// Source: extension/src/event-schemas.ts

export type Phase =
  | 'PLAN' | 'SPAWN' | 'DEPLOY' | 'OBSERVE' | 'RECOVER'
  | 'HARVEST' | 'CLEANUP' | 'REFLECT' | 'FAILED';

export type EventKind =
  | 'BLOCKED' | 'REQUEST' | 'HARVEST' | 'ERROR'
  | 'DECISION' | 'PROGRESS' | 'LOG';

export type ClawsRole = 'orchestrator' | 'worker' | 'observer';
export type ResultKind = 'ok' | 'failed' | 'cancelled';
export type SeverityLevel = 'info' | 'warn' | 'error' | 'fatal';

export interface Envelope {
  v: 1;
  id: string;
  correlation_id?: string | null;
  parent_id?: string | null;
  from_peer: string;
  from_name: string;
  terminal_id?: string | null;
  ts_published: string;
  ts_server?: string;
  sequence?: number;
  schema: string;
  data: unknown;
}

export interface Artifact {
  path: string;
  type: string;
  size_bytes?: number;
}

// ── Worker schemas ────────────────────────────────────────────────────────────

export interface WorkerBoot {
  model: string;
  role: ClawsRole;
  parent_peer_id: string | null;
  mission_summary: string;
  capabilities: string[];
  cwd: string;
  terminal_id: string;
}

export interface WorkerPhase {
  phase: Phase;
  prev: Phase | null;
  transition_reason: string;
  phases_completed: Phase[];
  metadata?: Record<string, unknown>;
}

export interface WorkerEvent {
  kind: EventKind;
  severity: SeverityLevel;
  message: string;
  request_id?: string;
  data?: Record<string, unknown>;
}

export interface WorkerHeartbeat {
  current_phase: Phase;
  time_in_phase_ms: number;
  tokens_used: number;
  cost_usd: number;
  last_event_id: string | null;
  active_sub_workers: string[];
}

export interface WorkerComplete {
  result: ResultKind;
  summary: string;
  artifacts: Artifact[];
  phases_completed: Phase[];
  total_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
}

// ── Command schemas ───────────────────────────────────────────────────────────

export interface CmdApprove {
  correlation_id: string;
  payload?: Record<string, unknown>;
}

export interface CmdReject {
  correlation_id: string;
  reason: string;
}

export interface CmdAbort {
  reason: string;
}

export interface CmdPause {}
export interface CmdResume {}

export interface CmdSetPhase {
  phase: Phase;
  reason: string;
}

export interface CmdSpawn {
  name: string;
  mission: string;
  model?: string;
}

export interface CmdInjectText {
  text: string;
  paste?: boolean;
}

// ── System schemas ────────────────────────────────────────────────────────────

export interface SystemPeerJoined {
  peerId: string;
  role: ClawsRole;
  peerName: string;
  ts: string;
}

export interface SystemPeerLeft {
  peerId: string;
  role: ClawsRole;
  reason: 'clean' | 'crash' | 'timeout';
}

export interface SystemPeerStale {
  peerId: string;
  last_seen: number;
  missed_heartbeats: number;
}

export interface SystemGateFired {
  tool: string;
  reason: string;
  peerId: string;
}

export interface SystemBudgetWarning {
  current_usd: number;
  threshold_usd: number;
}

export interface SystemMalformedReceived {
  from: string;
  topic: string;
  error: unknown;
}
`;

export default async function genTypes(_bundlePath, repoRoot) {
  const outPath = join(repoRoot, 'schemas', 'types', 'event-protocol.d.ts');
  writeFileSync(outPath, DTS_CONTENT, 'utf8');
  console.log('[codegen/gen-types] wrote schemas/types/event-protocol.d.ts');
}
