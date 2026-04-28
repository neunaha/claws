import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────────

export const PHASES = [
  'PLAN', 'SPAWN', 'DEPLOY', 'OBSERVE', 'RECOVER',
  'HARVEST', 'CLEANUP', 'REFLECT', 'FAILED',
] as const;
export const PhaseEnum = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseEnum>;

export const EVENT_KINDS = [
  'BLOCKED', 'REQUEST', 'HARVEST', 'ERROR', 'DECISION', 'PROGRESS', 'LOG',
] as const;
export const EventKindEnum = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindEnum>;

export const CLAWS_ROLES = ['orchestrator', 'worker', 'observer'] as const;
export const ClawsRoleEnum = z.enum(CLAWS_ROLES);
export type ClawsRole = z.infer<typeof ClawsRoleEnum>;

export const RESULT_KINDS = ['ok', 'failed', 'cancelled'] as const;
export const ResultEnum = z.enum(RESULT_KINDS);
export type ResultKind = z.infer<typeof ResultEnum>;

export const SEVERITY_LEVELS = ['info', 'warn', 'error', 'fatal'] as const;
export const SeverityEnum = z.enum(SEVERITY_LEVELS);
export type SeverityLevel = z.infer<typeof SeverityEnum>;

// ── Universal envelope ─────────────────────────────────────────────────────

export const EnvelopeV1 = z.object({
  v:              z.literal(1),
  id:             z.string().uuid(),
  correlation_id: z.string().uuid().nullable().optional(),
  parent_id:      z.string().nullable().optional(),
  from_peer:      z.string().min(1),
  from_name:      z.string().min(1),
  terminal_id:    z.string().nullable().optional(),
  ts_published:   z.string().datetime(),
  ts_server:      z.string().datetime().optional(),
  schema:         z.string().min(1),
  data:           z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeV1>;

// ── Worker event schemas ───────────────────────────────────────────────────

export const WorkerBootV1 = z.object({
  model:           z.string().min(1),
  role:            ClawsRoleEnum,
  parent_peer_id:  z.string().nullable(),
  mission_summary: z.string().min(1),
  capabilities:    z.array(z.string()),
  cwd:             z.string().min(1),
  terminal_id:     z.string(),
});
export type WorkerBoot = z.infer<typeof WorkerBootV1>;

export const WorkerPhaseV1 = z.object({
  phase:             PhaseEnum,
  prev:              PhaseEnum.nullable(),
  transition_reason: z.string().min(1),
  phases_completed:  z.array(PhaseEnum),
  metadata:          z.record(z.unknown()).optional(),
});
export type WorkerPhase = z.infer<typeof WorkerPhaseV1>;

export const ArtifactSchema = z.object({
  path:       z.string().min(1),
  type:       z.string().min(1),
  size_bytes: z.number().nonnegative().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const WorkerEventV1 = z.object({
  kind:       EventKindEnum,
  severity:   SeverityEnum,
  message:    z.string().min(1),
  request_id: z.string().uuid().optional(),
  data:       z.record(z.unknown()).optional(),
});
export type WorkerEvent = z.infer<typeof WorkerEventV1>;

export const WorkerHeartbeatV1 = z.object({
  current_phase:      PhaseEnum,
  time_in_phase_ms:   z.number().nonnegative(),
  tokens_used:        z.number().nonnegative(),
  cost_usd:           z.number().nonnegative(),
  last_event_id:      z.string().uuid().nullable(),
  active_sub_workers: z.array(z.string()),
});
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatV1>;

export const WorkerCompleteV1 = z.object({
  result:           ResultEnum,
  summary:          z.string().min(1),
  artifacts:        z.array(ArtifactSchema),
  phases_completed: z.array(PhaseEnum),
  total_tokens:     z.number().nonnegative(),
  total_cost_usd:   z.number().nonnegative(),
  duration_ms:      z.number().nonnegative(),
});
export type WorkerComplete = z.infer<typeof WorkerCompleteV1>;

// ── Command schemas ────────────────────────────────────────────────────────

export const CmdApproveV1 = z.object({
  correlation_id: z.string().uuid(),
  payload:        z.record(z.unknown()).optional(),
});
export type CmdApprove = z.infer<typeof CmdApproveV1>;

export const CmdRejectV1 = z.object({
  correlation_id: z.string().uuid(),
  reason:         z.string().min(1),
});
export type CmdReject = z.infer<typeof CmdRejectV1>;

export const CmdAbortV1 = z.object({
  reason: z.string().min(1),
});
export type CmdAbort = z.infer<typeof CmdAbortV1>;

export const CmdPauseV1 = z.object({});
export type CmdPause = z.infer<typeof CmdPauseV1>;

export const CmdResumeV1 = z.object({});
export type CmdResume = z.infer<typeof CmdResumeV1>;

export const CmdSetPhaseV1 = z.object({
  phase:  PhaseEnum,
  reason: z.string().min(1),
});
export type CmdSetPhase = z.infer<typeof CmdSetPhaseV1>;

export const CmdSpawnV1 = z.object({
  name:    z.string().min(1),
  mission: z.string().min(1),
  model:   z.string().optional(),
});
export type CmdSpawn = z.infer<typeof CmdSpawnV1>;

export const CmdInjectTextV1 = z.object({
  text:  z.string(),
  paste: z.boolean().optional(),
});
export type CmdInjectText = z.infer<typeof CmdInjectTextV1>;

// ── System event schemas (server-emitted, not published by clients) ────────

export const SystemPeerJoinedV1 = z.object({
  peerId:   z.string().min(1),
  role:     ClawsRoleEnum,
  peerName: z.string().min(1),
  ts:       z.string().datetime(),
});
export type SystemPeerJoined = z.infer<typeof SystemPeerJoinedV1>;

export const SystemPeerLeftV1 = z.object({
  peerId: z.string().min(1),
  role:   ClawsRoleEnum,
  reason: z.enum(['clean', 'crash', 'timeout']),
});
export type SystemPeerLeft = z.infer<typeof SystemPeerLeftV1>;

export const SystemPeerStaleV1 = z.object({
  peerId:            z.string().min(1),
  last_seen:         z.number().nonnegative(),
  missed_heartbeats: z.number().nonnegative(),
});
export type SystemPeerStale = z.infer<typeof SystemPeerStaleV1>;

export const SystemGateFiredV1 = z.object({
  tool:   z.string().min(1),
  reason: z.string().min(1),
  peerId: z.string().min(1),
});
export type SystemGateFired = z.infer<typeof SystemGateFiredV1>;

export const SystemBudgetWarningV1 = z.object({
  current_usd:   z.number().nonnegative(),
  threshold_usd: z.number().nonnegative(),
});
export type SystemBudgetWarning = z.infer<typeof SystemBudgetWarningV1>;

export const SystemMalformedReceivedV1 = z.object({
  from:  z.string().min(1),
  topic: z.string().min(1),
  error: z.unknown(),
});
export type SystemMalformedReceived = z.infer<typeof SystemMalformedReceivedV1>;

// ── Schema name → Zod schema map (for server validation and SDK use) ───────

export const SCHEMA_BY_NAME: Record<string, z.ZodTypeAny> = {
  'worker-boot-v1':                WorkerBootV1,
  'worker-phase-v1':               WorkerPhaseV1,
  'worker-event-v1':               WorkerEventV1,
  'worker-heartbeat-v1':           WorkerHeartbeatV1,
  'worker-complete-v1':            WorkerCompleteV1,
  'cmd-approve-v1':                CmdApproveV1,
  'cmd-reject-v1':                 CmdRejectV1,
  'cmd-abort-v1':                  CmdAbortV1,
  'cmd-pause-v1':                  CmdPauseV1,
  'cmd-resume-v1':                 CmdResumeV1,
  'cmd-set-phase-v1':              CmdSetPhaseV1,
  'cmd-spawn-v1':                  CmdSpawnV1,
  'cmd-inject-text-v1':            CmdInjectTextV1,
  'system-peer-joined-v1':         SystemPeerJoinedV1,
  'system-peer-left-v1':           SystemPeerLeftV1,
  'system-peer-stale-v1':          SystemPeerStaleV1,
  'system-gate-fired-v1':          SystemGateFiredV1,
  'system-budget-warning-v1':      SystemBudgetWarningV1,
  'system-malformed-received-v1':  SystemMalformedReceivedV1,
};
