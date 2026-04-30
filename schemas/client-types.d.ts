// @generated — do not edit. Run: node scripts/gen-client-types.mjs
// Source: extension/src/event-schemas.ts — SCHEMA_BY_NAME

export interface WorkerBootV1 {
  model: string;
  role: "orchestrator" | "worker" | "observer";
  parent_peer_id: string | null;
  mission_summary: string;
  capabilities: Array<string>;
  cwd: string;
  terminal_id: string;
}

export interface WorkerPhaseV1 {
  phase: "PLAN" | "SPAWN" | "DEPLOY" | "OBSERVE" | "RECOVER" | "HARVEST" | "CLEANUP" | "REFLECT" | "FAILED";
  prev: "PLAN" | "SPAWN" | "DEPLOY" | "OBSERVE" | "RECOVER" | "HARVEST" | "CLEANUP" | "REFLECT" | "FAILED" | null;
  transition_reason: string;
  phases_completed: Array<"PLAN" | "SPAWN" | "DEPLOY" | "OBSERVE" | "RECOVER" | "HARVEST" | "CLEANUP" | "REFLECT" | "FAILED">;
  metadata?: Record<string, unknown>;
}

export interface WorkerEventV1 {
  kind: "BLOCKED" | "REQUEST" | "HARVEST" | "ERROR" | "DECISION" | "PROGRESS" | "LOG";
  severity: "info" | "warn" | "error" | "fatal";
  message: string;
  request_id?: string;
  data?: Record<string, unknown>;
}

export interface WorkerHeartbeatV1 {
  current_phase: "PLAN" | "SPAWN" | "DEPLOY" | "OBSERVE" | "RECOVER" | "HARVEST" | "CLEANUP" | "REFLECT" | "FAILED";
  time_in_phase_ms: number;
  tokens_used: number;
  cost_usd: number;
  last_event_id: string | null;
  active_sub_workers: Array<string>;
}

export interface WorkerCompleteV1 {
  result: "ok" | "failed" | "cancelled";
  summary: string;
  artifacts: Array<{
    path: string;
    type: string;
    size_bytes?: number;
  }>;
  phases_completed: Array<"PLAN" | "SPAWN" | "DEPLOY" | "OBSERVE" | "RECOVER" | "HARVEST" | "CLEANUP" | "REFLECT" | "FAILED">;
  total_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
}

export interface CmdApproveV1 {
  correlation_id: string;
  payload?: Record<string, unknown>;
}

export interface CmdRejectV1 {
  correlation_id: string;
  reason: string;
}

export interface CmdAbortV1 {
  reason: string;
}

export interface CmdPauseV1 {

}

export interface CmdResumeV1 {

}

export interface CmdSetPhaseV1 {
  phase: "PLAN" | "SPAWN" | "DEPLOY" | "OBSERVE" | "RECOVER" | "HARVEST" | "CLEANUP" | "REFLECT" | "FAILED";
  reason: string;
}

export interface CmdSpawnV1 {
  name: string;
  mission: string;
  model?: string;
}

export interface CmdInjectTextV1 {
  text: string;
  paste?: boolean;
}

export interface SystemPeerJoinedV1 {
  peerId: string;
  role: "orchestrator" | "worker" | "observer";
  peerName: string;
  ts: string;
}

export interface SystemPeerLeftV1 {
  peerId: string;
  role: "orchestrator" | "worker" | "observer";
  reason: "clean" | "crash" | "timeout";
}

export interface SystemPeerStaleV1 {
  peerId: string;
  last_seen: number;
  missed_heartbeats: number;
}

export interface SystemGateFiredV1 {
  tool: string;
  reason: string;
  peerId: string;
}

export interface SystemBudgetWarningV1 {
  current_usd: number;
  threshold_usd: number;
}

export interface SystemMalformedReceivedV1 {
  from: string;
  topic: string;
  error: unknown;
}

export interface VehicleStateV1 {
  terminalId: string;
  from: "PROVISIONING" | "BOOTING" | "READY" | "BUSY" | "IDLE" | "CLOSING" | "CLOSED" | null;
  to: "PROVISIONING" | "BOOTING" | "READY" | "BUSY" | "IDLE" | "CLOSING" | "CLOSED";
  ts: string;
}

export interface VehicleContentV1 {
  terminalId: string;
  contentType: "shell" | "claude" | "python" | "node" | "vim" | "htop" | "unknown";
  foregroundPid: number | null;
  basename?: string | null;
  detectedAt: string;
  confidence?: "high" | "low" | "unknown";
}

export interface CommandStartV1 {
  terminalId: string;
  command: string;
  startedAt: string;
}

export interface CommandEndV1 {
  terminalId: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  degraded?: boolean;
  endedAt: string;
}

export interface WaveLeadBootV1 {
  waveId: string;
  peerName: string;
  layers: Array<string>;
  manifest: Array<"lead" | "tester" | "reviewer" | "auditor" | "bench" | "doc">;
  started_at: string;
}

export interface WaveLeadCompleteV1 {
  waveId: string;
  status: "ok" | "failed" | "partial";
  commits: Array<string>;
  regression_clean: boolean;
  duration_sec?: number;
}

export interface WaveTesterRedCompleteV1 {
  waveId: string;
  test_file: string;
  failing_tests: number;
  ts: string;
}

export interface WaveReviewFindingV1 {
  waveId: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  file: string;
  line?: number;
  message: string;
  suggested_fix?: string;
}

export interface WaveAuditFindingV1 {
  waveId: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  category: "race_condition" | "schema" | "error_handling" | "regression" | "security";
  file: string;
  finding: string;
  recommendation?: string;
}

export interface WaveBenchMetricV1 {
  waveId: string;
  name: string;
  value: number;
  unit: string;
  baseline?: number;
}

export interface WaveDocCompleteV1 {
  waveId: string;
  files_updated: Array<string>;
  ts: string;
}

export interface CmdDeliverV1 {
  targetPeerId: string;
  cmdTopic: string;
  payload: {
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
  };
  idempotencyKey: string;
  seq: number;
}

export interface CmdAckV1 {
  seq: number;
  status: "executed" | "rejected" | "duplicate";
  correlation_id?: string;
}

export interface PipelineStepV1 {
  pipelineId: string;
  stepId: string;
  role: "source" | "sink";
  terminalId: string;
  state: "active" | "degraded" | "closed";
  ts: string;
}

export interface RpcRequestV1 {
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
  callerPeerId: string;
}

export interface RpcResponseV1 {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
