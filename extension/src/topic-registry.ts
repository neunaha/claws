import { z } from 'zod';
import { matchTopic } from './topic-utils';
import {
  WorkerBootV1, WorkerPhaseV1, WorkerEventV1, WorkerHeartbeatV1, WorkerCompleteV1,
  CmdApproveV1, CmdRejectV1, CmdAbortV1, CmdPauseV1, CmdResumeV1,
  CmdSetPhaseV1, CmdSpawnV1, CmdInjectTextV1,
  SystemPeerJoinedV1, SystemPeerLeftV1, SystemPeerStaleV1,
  SystemGateFiredV1, SystemBudgetWarningV1, SystemMalformedReceivedV1,
  VehicleStateV1, VehicleContentV1, CommandStartV1, CommandEndV1,
  CmdAckV1,
} from './event-schemas';

export { matchTopic };

export const TOPIC_REGISTRY: ReadonlyArray<{ pattern: string; schema: z.ZodTypeAny }> = [
  { pattern: 'worker.*.boot',              schema: WorkerBootV1 },
  { pattern: 'worker.*.phase',             schema: WorkerPhaseV1 },
  { pattern: 'worker.*.event',             schema: WorkerEventV1 },
  { pattern: 'worker.*.heartbeat',         schema: WorkerHeartbeatV1 },
  { pattern: 'worker.*.complete',          schema: WorkerCompleteV1 },
  { pattern: 'cmd.*.approve',              schema: CmdApproveV1 },
  { pattern: 'cmd.*.reject',               schema: CmdRejectV1 },
  { pattern: 'cmd.*.abort',                schema: CmdAbortV1 },
  { pattern: 'cmd.*.pause',                schema: CmdPauseV1 },
  { pattern: 'cmd.*.resume',               schema: CmdResumeV1 },
  { pattern: 'cmd.*.set_phase',            schema: CmdSetPhaseV1 },
  { pattern: 'cmd.*.spawn',                schema: CmdSpawnV1 },
  { pattern: 'cmd.*.inject_text',          schema: CmdInjectTextV1 },
  { pattern: 'system.peer.joined',         schema: SystemPeerJoinedV1 },
  { pattern: 'system.peer.left',           schema: SystemPeerLeftV1 },
  { pattern: 'system.peer.stale',          schema: SystemPeerStaleV1 },
  { pattern: 'system.gate.fired',          schema: SystemGateFiredV1 },
  { pattern: 'system.budget.warning',      schema: SystemBudgetWarningV1 },
  { pattern: 'system.malformed.received',  schema: SystemMalformedReceivedV1 },
  { pattern: 'vehicle.*.state',            schema: VehicleStateV1 },
  { pattern: 'vehicle.*.created',          schema: VehicleStateV1 },
  { pattern: 'vehicle.*.closed',           schema: VehicleStateV1 },
  { pattern: 'vehicle.*.content',          schema: VehicleContentV1 },
  { pattern: 'command.*.start',            schema: CommandStartV1 },
  { pattern: 'command.*.end',              schema: CommandEndV1 },
  { pattern: 'command.*.timeout',          schema: CommandEndV1 },
  { pattern: 'error.*.crash',              schema: z.object({
    terminalId: z.string().min(1),
    exitCode:   z.number().int().nullable(),
    ts:         z.string().datetime(),
  }) },
  { pattern: 'wave.**',                    schema: z.record(z.unknown()) },
  { pattern: 'cmd.*.ack',                  schema: CmdAckV1 },
];

/**
 * Returns the Zod data schema for the given topic, or null if no schema
 * is registered for the topic pattern.
 */
export function schemaForTopic(topic: string): z.ZodTypeAny | null {
  for (const entry of TOPIC_REGISTRY) {
    if (matchTopic(topic, entry.pattern)) return entry.schema;
  }
  return null;
}
