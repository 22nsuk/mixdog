export type DelegationObservationRow = {
  id: string;
  tag: string;
  agent: string;
  provider: string;
  model: string;
  operation: 'spawn' | 'send' | null;
  startedAt: string;
  mode: 'none' | 'focused' | 'balanced' | 'swarm' | null;
  phase: 'queued' | 'preparing' | 'running' | 'finished' | null;
  outcome: 'completed' | 'failed' | 'cancelled' | 'partial' | null;
  queueWaitMs: number | null;
  preparationMs: number | null;
  executionMs: number | null;
  elapsedMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number | null;
};
export function delegationObservations(
  jobs: unknown,
  sessionId: unknown
): {
  available: boolean;
  rows: DelegationObservationRow[];
  unmeasured: number;
};
