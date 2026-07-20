import { recordLoopStep } from './site-loop-store.js';
import type { SiteLoopConfig } from './site-loop-config.js';

export type SiteLoopPayload = Record<string, unknown>;

export type SiteLoopStep = {
  step_run_id: string;
  run_id: string;
  step_id: string;
  status: string;
  started_at: string;
  finished_at: string;
  input_refs: unknown[];
  output_refs: unknown[];
  evidence: unknown;
  result?: unknown;
  error?: SiteLoopPayload;
};

export type SiteLoopStepRecorder = (store: unknown, step: SiteLoopStep) => void;

export type SiteLoopSyntheticStepInput = {
  stepId: string;
  status?: string;
  inputRefs?: unknown[];
  outputRefs?: unknown[];
  evidence?: unknown;
};

export type SiteLoopSyntheticStepRecordInput = SiteLoopSyntheticStepInput & {
  store?: unknown;
  runId: string;
};

export type SiteLoopPhaseContext<TState extends SiteLoopPayload = SiteLoopPayload> = {
  siteRoot: string;
  siteLoopConfig: SiteLoopConfig;
  store?: unknown;
  runId: string;
  options: SiteLoopPayload;
  dryRun: boolean;
  drain: boolean;
  limit: number;
  threshold?: number;
  steps: SiteLoopStep[];
  state: TState;
};

export type SiteLoopPhaseAdapter<TState extends SiteLoopPayload = SiteLoopPayload> = {
  id: string;
  synthetic?: boolean;
  shouldRun?: (context: SiteLoopPhaseContext<TState>) => boolean;
  skipStep?: (context: SiteLoopPhaseContext<TState>) => SiteLoopSyntheticStepInput | null;
  inputRefs: (context: SiteLoopPhaseContext<TState>) => unknown[];
  execute: (context: SiteLoopPhaseContext<TState>) => Promise<unknown> | unknown;
  outputRefs: (result: unknown, context: SiteLoopPhaseContext<TState>) => unknown[];
  evidence: (result: unknown, context: SiteLoopPhaseContext<TState>) => unknown;
  status?: (result: unknown, context: SiteLoopPhaseContext<TState>) => string;
};

export const DEFAULT_SITE_LOOP_PHASE_PLAN = [
  'source_sync',
  'scheduled_sop_triggers',
  'inbox_bridge',
  'task_materialization',
  'task_executability_reconciliation',
  'resident_directive_emission',
  'ticket_task_reconciliation',
  'pre_backlog_outcome_reconciliation',
  'reported_resident_task_state_reconciliation',
  'resident_backlog_recovery_emission',
  'resident_supervisor',
  'resident_directive_dispatch',
  'receipt_reconciliation',
  'agent_outcome_reconciliation',
  'stale_escalation_reconciliation',
  'operating_alert_reconciliation',
] as const;

export async function runSiteLoopStep({ store, runId, stepId, inputRefs = [], execute, outputRefs, evidence, onFailedStep = null }) {
  const startedAt = new Date().toISOString();
  try {
    const result = await execute();
    const finishedAt = new Date().toISOString();
    const step = {
      step_run_id: `${runId}:${stepId}`,
      run_id: runId,
      step_id: stepId,
      status: result?.status === 'error' ? 'failed' : 'ok',
      started_at: startedAt,
      finished_at: finishedAt,
      input_refs: inputRefs,
      output_refs: outputRefs(result),
      evidence: evidence(result),
      result,
    };
    if (store) recordLoopStep(store, step);
    if (step.status === 'failed') throw new Error(result.error ?? `${stepId}_failed`);
    return step;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const step = {
      step_run_id: `${runId}:${stepId}`,
      run_id: runId,
      step_id: stepId,
      status: 'failed',
      started_at: startedAt,
      finished_at: finishedAt,
      input_refs: inputRefs,
      output_refs: [],
      evidence: null,
      error: errorToPayload(error),
      result: null,
    };
    if (store) recordLoopStep(store, step);
    if (typeof onFailedStep === 'function') onFailedStep(step);
    throw error;
  }
}

function errorToPayload(error: unknown): SiteLoopPayload {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...Object.fromEntries(Object.entries(error).filter(([, value]) => value !== undefined)),
    };
  }
  return { message: String(error) };
}

export async function runSiteLoopPhaseAdapter({ adapter, context, store, runId, onFailedStep = null }) {
  if (adapter.shouldRun && !adapter.shouldRun(context)) {
    const skipped = adapter.skipStep?.(context);
    return skipped ? recordSiteLoopSyntheticStep({ store, runId, ...skipped }) : null;
  }
  if (adapter.synthetic) {
    const result = await adapter.execute(context);
    return recordSiteLoopSyntheticStep({
      store,
      runId,
      stepId: adapter.id,
      status: adapter.status?.(result, context) ?? 'ok',
      inputRefs: adapter.inputRefs(context),
      outputRefs: adapter.outputRefs(result, context),
      evidence: adapter.evidence(result, context),
    });
  }
  return runSiteLoopStep({
    store,
    runId,
    onFailedStep,
    stepId: adapter.id,
    inputRefs: adapter.inputRefs(context),
    execute: () => adapter.execute(context),
    outputRefs: (result) => adapter.outputRefs(result, context),
    evidence: (result) => adapter.evidence(result, context),
  });
}

export async function runSiteLoopPhasePlan({ adapters, context, store, runId, onFailedStep = null }) {
  const steps: SiteLoopStep[] = [];
  const byId: Record<string, SiteLoopStep> = {};
  for (const adapter of adapters) {
    context.store = store;
    context.runId = runId;
    const step = await runSiteLoopPhaseAdapter({ adapter, context, store, runId, onFailedStep });
    if (!step) continue;
    context.steps.push(step);
    steps.push(step);
    byId[step.step_id] = step;
  }
  return { steps, byId };
}

export function recordSiteLoopSyntheticStep({ store, runId, stepId, status = 'ok', inputRefs = [], outputRefs = [], evidence = null }: SiteLoopSyntheticStepRecordInput) {
  const now = new Date().toISOString();
  const step = {
    step_run_id: `${runId}:${stepId}`,
    run_id: runId,
    step_id: stepId,
    status,
    started_at: now,
    finished_at: now,
    input_refs: inputRefs,
    output_refs: outputRefs,
    evidence,
  };
  if (store) recordLoopStep(store, step);
  return step;
}
