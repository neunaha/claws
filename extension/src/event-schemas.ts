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
  // Monotonic per-stream sequence number stamped by the server (optional for
  // backward compat with pre-γ producers that do not set this field).
  sequence:       z.number().int().nonnegative().optional(),
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

// ── Vehicle state schemas (server-emitted, not published by clients) ──────

export const VEHICLE_STATES = [
  'PROVISIONING', 'BOOTING', 'READY', 'BUSY', 'IDLE', 'CLOSING', 'CLOSED',
] as const;
export const VehicleStateEnum = z.enum(VEHICLE_STATES);
export type VehicleStateName = z.infer<typeof VehicleStateEnum>;

export const VehicleStateV1 = z.object({
  terminalId: z.string().min(1),
  from:       VehicleStateEnum.nullable(),
  to:         VehicleStateEnum,
  ts:         z.string().datetime(),
});
export type VehicleState = z.infer<typeof VehicleStateV1>;

// ── Vehicle content schemas (L5 content detection) ────────────────────────

export const CONTENT_TYPES = [
  'shell', 'claude', 'python', 'node', 'vim', 'htop', 'unknown',
] as const;
export const ContentTypeEnum = z.enum(CONTENT_TYPES);
export type ContentType = z.infer<typeof ContentTypeEnum>;

export const VehicleContentV1 = z.object({
  terminalId:    z.string().min(1),
  contentType:   ContentTypeEnum,
  foregroundPid: z.number().int().nonnegative().nullable(),
  basename:      z.string().nullable().optional(),
  detectedAt:    z.string().datetime(),
  confidence:    z.enum(['high', 'low', 'unknown']).optional(),
});
export type VehicleContent = z.infer<typeof VehicleContentV1>;

// ── Command lifecycle schemas (L6 event taxonomy) ─────────────────────────

export const CommandStartV1 = z.object({
  terminalId: z.string().min(1),
  command:    z.string().min(1),
  startedAt:  z.string().datetime(),
});
export type CommandStart = z.infer<typeof CommandStartV1>;

export const CommandEndV1 = z.object({
  terminalId: z.string().min(1),
  command:    z.string().min(1),
  exitCode:   z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  degraded:   z.boolean().optional(),
  endedAt:    z.string().datetime(),
});
export type CommandEnd = z.infer<typeof CommandEndV1>;

// ── Wave army event schemas ────────────────────────────────────────────────

export const SUB_WORKER_ROLES = ['lead', 'tester', 'reviewer', 'auditor', 'bench', 'doc'] as const;
export const SubWorkerRoleEnum = z.enum(SUB_WORKER_ROLES);

export const WaveLeadBootV1 = z.object({
  waveId:     z.string().min(1),
  peerName:   z.string().min(1),
  layers:     z.array(z.string()),
  manifest:   z.array(SubWorkerRoleEnum),
  started_at: z.string().datetime(),
});
export type WaveLeadBoot = z.infer<typeof WaveLeadBootV1>;

export const WaveLeadCompleteV1 = z.object({
  waveId:           z.string().min(1),
  status:           z.enum(['ok', 'failed', 'partial']),
  commits:          z.array(z.string()),
  regression_clean: z.boolean(),
  duration_sec:     z.number().nonnegative().optional(),
});
export type WaveLeadComplete = z.infer<typeof WaveLeadCompleteV1>;

export const WaveTesterRedCompleteV1 = z.object({
  waveId:        z.string().min(1),
  test_file:     z.string().min(1),
  failing_tests: z.number().nonnegative(),
  ts:            z.string().datetime(),
});
export type WaveTesterRedComplete = z.infer<typeof WaveTesterRedCompleteV1>;

export const WaveReviewFindingV1 = z.object({
  waveId:        z.string().min(1),
  severity:      z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  file:          z.string().min(1),
  line:          z.number().int().nonnegative().optional(),
  message:       z.string().min(1),
  suggested_fix: z.string().optional(),
});
export type WaveReviewFinding = z.infer<typeof WaveReviewFindingV1>;

export const WaveAuditFindingV1 = z.object({
  waveId:         z.string().min(1),
  severity:       z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  category:       z.enum(['race_condition', 'schema', 'error_handling', 'regression', 'security']),
  file:           z.string().min(1),
  finding:        z.string().min(1),
  recommendation: z.string().optional(),
});
export type WaveAuditFinding = z.infer<typeof WaveAuditFindingV1>;

export const WaveBenchMetricV1 = z.object({
  waveId:   z.string().min(1),
  name:     z.string().min(1),
  value:    z.number(),
  unit:     z.string().min(1),
  baseline: z.number().optional(),
});
export type WaveBenchMetric = z.infer<typeof WaveBenchMetricV1>;

export const WaveDocCompleteV1 = z.object({
  waveId:        z.string().min(1),
  files_updated: z.array(z.string()),
  ts:            z.string().datetime(),
});
export type WaveDocComplete = z.infer<typeof WaveDocCompleteV1>;

// ── Structured control schemas (L10 deliver-cmd / cmd.ack) ───────────────────

export const CmdDeliverV1 = z.object({
  targetPeerId:   z.string().min(1),
  cmdTopic:       z.string().min(1),
  payload:        EnvelopeV1,
  idempotencyKey: z.string().uuid(),
  seq:            z.number().int().nonnegative(),
});
export type CmdDeliver = z.infer<typeof CmdDeliverV1>;

export const CmdAckV1 = z.object({
  seq:            z.number().int().nonnegative(),
  status:         z.enum(['executed', 'rejected', 'duplicate']),
  correlation_id: z.string().uuid().optional(),
});
export type CmdAck = z.infer<typeof CmdAckV1>;

// ── Typed RPC schemas (L16) ───────────────────────────────────────────────

export const RpcRequestV1 = z.object({
  requestId:    z.string().uuid(),
  method:       z.string().min(1),
  params:       z.record(z.unknown()).optional(),
  callerPeerId: z.string().min(1),
});
export type RpcRequest = z.infer<typeof RpcRequestV1>;

export const RpcResponseV1 = z.object({
  requestId: z.string().uuid(),
  ok:        z.boolean(),
  result:    z.unknown().optional(),
  error:     z.string().optional(),
});
export type RpcResponse = z.infer<typeof RpcResponseV1>;

// ── Pipeline schemas (L11 composition) ────────────────────────────────────

export const PIPELINE_STEP_STATES = ['active', 'degraded', 'closed'] as const;
export const PipelineStepStateEnum = z.enum(PIPELINE_STEP_STATES);
export type PipelineStepStateName = z.infer<typeof PipelineStepStateEnum>;

export const PipelineStepV1 = z.object({
  pipelineId: z.string().min(1),
  stepId:     z.string().min(1),
  role:       z.enum(['source', 'sink']),
  terminalId: z.string().min(1),
  state:      PipelineStepStateEnum,
  ts:         z.string().datetime(),
});
export type PipelineStep = z.infer<typeof PipelineStepV1>;

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
  'vehicle-state-v1':              VehicleStateV1,
  'vehicle-content-v1':            VehicleContentV1,
  'command-start-v1':              CommandStartV1,
  'command-end-v1':                CommandEndV1,
  'wave-lead-boot-v1':             WaveLeadBootV1,
  'wave-lead-complete-v1':         WaveLeadCompleteV1,
  'wave-tester-red-complete-v1':   WaveTesterRedCompleteV1,
  'wave-review-finding-v1':        WaveReviewFindingV1,
  'wave-audit-finding-v1':         WaveAuditFindingV1,
  'wave-bench-metric-v1':          WaveBenchMetricV1,
  'wave-doc-complete-v1':          WaveDocCompleteV1,
  'cmd-deliver-v1':                CmdDeliverV1,
  'cmd-ack-v1':                    CmdAckV1,
  'pipeline-step-v1':              PipelineStepV1,
  'rpc-request-v1':                RpcRequestV1,
  'rpc-response-v1':               RpcResponseV1,
};
