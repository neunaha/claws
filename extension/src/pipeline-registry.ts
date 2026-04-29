export type PipelineStepRole = 'source' | 'sink';
export type PipelineStepState = 'active' | 'degraded' | 'closed';
export type PipelineState = 'active' | 'closed';

export interface PipelineStep {
  stepId: string;
  role: PipelineStepRole;
  terminalId: string;
  state: PipelineStepState;
}

export interface PipelineRecord {
  pipelineId: string;
  name: string;
  steps: PipelineStep[];
  state: PipelineState;
  createdAt: string;
  closedAt?: string;
}

export class PipelineRegistry {
  private readonly pipelines = new Map<string, PipelineRecord>();
  private pipelineSeq = 0;

  create(
    name: string,
    steps: ReadonlyArray<{ role: PipelineStepRole; terminalId: string }>,
  ): PipelineRecord {
    const pipelineId = `pipe_${String(++this.pipelineSeq).padStart(4, '0')}`;
    const record: PipelineRecord = {
      pipelineId,
      name,
      steps: steps.map((s, i) => ({
        stepId:     `${pipelineId}_step_${i}`,
        role:       s.role,
        terminalId: s.terminalId,
        state:      'active',
      })),
      state:     'active',
      createdAt: new Date().toISOString(),
    };
    this.pipelines.set(pipelineId, { ...record, steps: record.steps.map((s) => ({ ...s })) });
    return record;
  }

  get(pipelineId: string): PipelineRecord | undefined {
    return this.pipelines.get(pipelineId);
  }

  list(): PipelineRecord[] {
    return Array.from(this.pipelines.values());
  }

  close(pipelineId: string): PipelineRecord | null {
    const p = this.pipelines.get(pipelineId);
    if (!p) return null;
    const closed: PipelineRecord = {
      ...p,
      state:    'closed',
      steps:    p.steps.map((s) => ({ ...s, state: 'closed' as PipelineStepState })),
      closedAt: new Date().toISOString(),
    };
    this.pipelines.set(pipelineId, closed);
    return closed;
  }

  /** Returns all active pipelines that have sourceTerminalId as their source step. */
  findBySource(sourceTerminalId: string): PipelineRecord[] {
    const result: PipelineRecord[] = [];
    for (const p of this.pipelines.values()) {
      if (p.state === 'active' && p.steps.some((s) => s.role === 'source' && s.terminalId === sourceTerminalId)) {
        result.push(p);
      }
    }
    return result;
  }

  clear(): void {
    this.pipelines.clear();
    this.pipelineSeq = 0;
  }
}
