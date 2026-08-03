#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import {
  SiteFabricClient,
  isRecord,
  type JsonRecord,
  type SiteFabricToolCallOptions,
} from '@narada-core/mcp-runtime-client';

const AGENT_RESULT_KEY = 'sop_handoff_result';
const WORKER_TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
const WORKER_IN_FLIGHT_PREFIX = 'worker_in_flight:';

export interface SopHandoffFabricCaller {
  call(
    surfaceId: string,
    toolName: string,
    args?: JsonRecord,
    options?: SiteFabricToolCallOptions,
  ): Promise<JsonRecord>;
}

function retryableWorkerError(error: unknown): string {
  const detail = boundedError(error);
  const value = `worker_retryable:${detail}`;
  return value.length <= 4_096 ? value : value.slice(0, 4_096);
}

function workerIdempotencyKey(handoff: ClaimedHandoff): string {
  if (handoff.last_error?.startsWith(WORKER_IN_FLIGHT_PREFIX)) {
    const inFlightKey = handoff.last_error.slice(WORKER_IN_FLIGHT_PREFIX.length).trim();
    if (inFlightKey) return inFlightKey;
  }
  if (handoff.last_error?.startsWith('worker_retryable:') && handoff.attempt_count > 1) {
    return `${handoff.occurrence_key}:attempt:${handoff.attempt_count}`;
  }
  return handoff.occurrence_key;
}

export interface SopAgentHandoffConsumerOptions {
  siteRoot: string;
  invocationPlanRef: string;
  requiredMcpTools?: string[];
  consumerId?: string;
  principal?: string;
  sopSurfaceId?: string;
  workerSurfaceId?: string;
  maxHandoffs?: number;
  leaseMs?: number;
  maxRunMs?: number;
  requestTimeoutMs?: number;
  loaderEntrypoint?: string;
}

export interface SopAgentHandoffConsumerReport extends JsonRecord {
  schema: 'narada.sop.agent_handoff_consumer_pass.v1';
  status: 'completed' | 'completed_with_errors';
  handoffs_claimed: number;
  handoffs_completed: number;
  handoffs_failed: number;
  handoffs_deferred: number;
  worker_runs_started: number;
  worker_runs_replayed: number;
  worker_runs_blocked: number;
  worker_runs_reaped: number;
  errors: JsonRecord[];
}

export async function runSopAgentHandoffConsumerPass(
  input: SopAgentHandoffConsumerOptions,
  providedFabric?: SopHandoffFabricCaller,
): Promise<SopAgentHandoffConsumerReport> {
  const options = normalizeAgentOptions(input);
  const ownedFabric = providedFabric ? null : await SiteFabricClient.open({
    siteRoot: options.siteRoot,
    loaderEntrypoint: options.loaderEntrypoint,
    allowedSurfaceIds: [options.sopSurfaceId, options.workerSurfaceId],
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const fabric = providedFabric ?? ownedFabric!;
  const report: SopAgentHandoffConsumerReport = {
    schema: 'narada.sop.agent_handoff_consumer_pass.v1',
    status: 'completed',
    handoffs_claimed: 0,
    handoffs_completed: 0,
    handoffs_failed: 0,
    handoffs_deferred: 0,
    worker_runs_started: 0,
    worker_runs_replayed: 0,
    worker_runs_blocked: 0,
    worker_runs_reaped: 0,
    errors: [],
  };

  try {
    for (let index = 0; index < options.maxHandoffs; index += 1) {
      try {
        const workerAdmission = await reconcileWorkerConcurrency(fabric, options);
        report.worker_runs_reaped += workerAdmission.reaped;
        if (workerAdmission.blocked) {
          report.worker_runs_blocked += 1;
          report.handoffs_deferred += 1;
          break;
        }
      } catch (error) {
        report.errors.push(errorRecord('worker_admission', error));
        break;
      }
      const claimed = await fabric.call(options.sopSurfaceId, 'sop_handoff_claim', {
        consumer_id: options.consumerId,
        executor: 'agent',
        lease_ms: handoffLeaseMs(options),
      });
      if (claimed.status === 'empty' || claimed.handoff === null || claimed.handoff === undefined) break;
      const handoff = parseClaimedHandoff(requireRecord(claimed.handoff, 'sop_handoff_claim_invalid'), 'agent');
      report.handoffs_claimed += 1;
      let settled = false;
      try {
        const worker = await fabric.call(
          options.workerSurfaceId,
          'worker_run',
          buildAgentWorkerRequest(handoff, options),
          {
            timeoutMs: Math.min(
              300_000,
              Math.max(options.requestTimeoutMs, Math.min(180_000, options.maxRunMs) + 5_000),
            ),
          },
        );
        const workerRun = parseWorkerRun(worker);
        if (workerRun.idempotency_replayed) report.worker_runs_replayed += 1;
        else report.worker_runs_started += 1;

        if (workerRun.status === 'running') {
          // The finite consumer intentionally exits without owning a resident cursor.
          // Release the SOP lease while preserving the exact worker operation key;
          // a later pass can replay that operation without launching a duplicate.
          await releaseHandoff(
            fabric,
            options.sopSurfaceId,
            handoff,
            options.consumerId,
            `${WORKER_IN_FLIGHT_PREFIX}${workerRun.idempotency_key ?? workerIdempotencyKey(handoff)}`,
          );
          settled = true;
          report.handoffs_deferred += 1;
          break;
        }

        if (workerRun.status === 'completed' || workerRun.status === 'completed_with_errors') {
          let result: JsonRecord;
          try {
            result = parseAgentStructuredResult(workerRun.raw);
            validateAgentResult(result, handoff.result_schema);
          } catch (contractError) {
            await advanceHandoff(fabric, options.sopSurfaceId, handoff, {
              consumerId: options.consumerId,
              completionKey: `worker:${workerRun.run_id}`,
              principal: options.principal,
              outcome: 'failed',
              result: {
                schema: 'narada.sop.agent_handoff_failure.v1',
                worker_run_id: workerRun.run_id,
                worker_status: workerRun.status,
                failure_kind: 'result_contract_invalid',
              },
              errorMessage: boundedError(contractError),
            });
            settled = true;
            report.handoffs_failed += 1;
            continue;
          }
          await advanceHandoff(fabric, options.sopSurfaceId, handoff, {
            consumerId: options.consumerId,
            completionKey: `worker:${workerRun.run_id}`,
            principal: options.principal,
            outcome: 'completed',
            result,
          });
          settled = true;
          report.handoffs_completed += 1;
          continue;
        }

        await releaseHandoff(
          fabric,
          options.sopSurfaceId,
          handoff,
          options.consumerId,
          retryableWorkerError(workerRun.raw.error ?? `worker_run_${workerRun.status}`),
        );
        settled = true;
        report.handoffs_deferred += 1;
        break;
      } catch (error) {
        report.errors.push(errorRecord('agent_handoff', error, handoff.handoff_id));
        if (!settled) {
          try {
            await releaseHandoff(fabric, options.sopSurfaceId, handoff, options.consumerId, retryableWorkerError(error));
          } catch (releaseError) {
            report.errors.push(errorRecord('agent_handoff_release', releaseError, handoff.handoff_id));
          }
        }
        // A released oldest handoff would be selected again immediately in the
        // same finite pass. Leave retry to the next invocation.
        break;
      }
    }
  } finally {
    if (ownedFabric) {
      try {
        await ownedFabric.close();
      } catch (error) {
        report.errors.push(errorRecord('site_fabric_close', error));
      }
    }
  }
  report.status = report.errors.length === 0 ? 'completed' : 'completed_with_errors';
  return report;
}

async function reconcileWorkerConcurrency(
  fabric: SopHandoffFabricCaller,
  options: NormalizedAgentOptions,
): Promise<{ blocked: boolean; reaped: number }> {
  const listed = await fabric.call(options.workerSurfaceId, 'worker_runs_list', {
    site_root: options.siteRoot,
    limit: 100,
    include_running: true,
    include_completed: false,
    include_summary: false,
    verbose: false,
  });
  if (listed.schema !== 'narada.worker.runs_list.v1') throw new Error('worker_runs_list_schema_invalid');
  const runs = Array.isArray(listed.runs) ? listed.runs.filter(isRecord) : [];
  let reaped = 0;
  for (const run of runs) {
    if (run.status !== 'running') continue;
    const liveness = isRecord(run.status_liveness) ? run.status_liveness : {};
    const staleForMs = typeof liveness.stale_for_ms === 'number' ? liveness.stale_for_ms : null;
    const staleAfterMs = typeof liveness.stale_after_ms === 'number' ? liveness.stale_after_ms : null;
    const staleConfirmed = liveness.state === 'stale'
      && staleForMs !== null
      && staleAfterMs !== null
      && staleForMs >= staleAfterMs;
    if (!staleConfirmed) return { blocked: true, reaped };
    await fabric.call(options.workerSurfaceId, 'worker_run_reap', {
      run_id: requiredString(run.run_id, 'worker_run_id_missing'),
      reason: 'SOP agent handoff consumer recovered a stale cross-process worker run before admitting another run.',
      site_root: options.siteRoot,
    });
    reaped += 1;
  }
  return { blocked: false, reaped };
}

export interface SopOperatorHandoffCompletionOptions {
  siteRoot: string;
  handoffId: string;
  principal: string;
  outcome: 'completed' | 'failed';
  result: JsonRecord;
  completionKey?: string;
  resultRef?: JsonRecord | null;
  errorMessage?: string | null;
  consumerId?: string;
  sopSurfaceId?: string;
  leaseMs?: number;
  requestTimeoutMs?: number;
  loaderEntrypoint?: string;
}

export async function completeSopOperatorHandoff(
  input: SopOperatorHandoffCompletionOptions,
  providedFabric?: SopHandoffFabricCaller,
): Promise<JsonRecord> {
  const options = normalizeOperatorOptions(input);
  const ownedFabric = providedFabric ? null : await SiteFabricClient.open({
    siteRoot: options.siteRoot,
    loaderEntrypoint: options.loaderEntrypoint,
    allowedSurfaceIds: [options.sopSurfaceId],
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const fabric = providedFabric ?? ownedFabric!;
  try {
    const shown = await fabric.call(options.sopSurfaceId, 'sop_handoff_show', { handoff_id: options.handoffId });
    const current = parseVisibleHandoff(shown, 'operator');
    if (current.status === 'completed' || current.status === 'failed') {
      assertOperatorReplay(current, options);
      return {
        schema: 'narada.sop.operator_handoff_completion.v1',
        status: 'completed',
        completion_replayed: true,
        handoff: current.raw,
      };
    }
    const claimed = await fabric.call(options.sopSurfaceId, 'sop_handoff_claim', {
      consumer_id: options.consumerId,
      handoff_id: options.handoffId,
      executor: 'operator',
      lease_ms: options.leaseMs,
    });
    if (claimed.status !== 'claimed' || claimed.handoff === null || claimed.handoff === undefined) {
      throw new Error(`sop_operator_handoff_unavailable:${options.handoffId}`);
    }
    const handoff = parseClaimedHandoff(requireRecord(claimed.handoff, 'sop_handoff_claim_invalid'), 'operator');
    const advanced = await advanceHandoff(fabric, options.sopSurfaceId, handoff, {
      consumerId: options.consumerId,
      completionKey: options.completionKey,
      principal: options.principal,
      outcome: options.outcome,
      result: options.result,
      resultRef: options.resultRef,
      errorMessage: options.errorMessage,
    });
    return {
      schema: 'narada.sop.operator_handoff_completion.v1',
      status: 'completed',
      completion_replayed: Boolean(advanced.completion_replayed),
      handoff: advanced.handoff ?? null,
      sop_run: advanced,
    };
  } finally {
    if (ownedFabric) await ownedFabric.close();
  }
}

type ClaimedHandoff = {
  handoff_id: string;
  run_id: string;
  step_id: string;
  occurrence_key: string;
  sop_id: string;
  sop_version: number;
  executor: 'agent' | 'operator';
  title: string;
  instructions: string;
  input: unknown;
  input_ref: JsonRecord | null;
  result_schema: JsonRecord | null;
  lease_token: string;
  attempt_count: number;
  last_error: string | null;
};

type VisibleHandoff = Omit<ClaimedHandoff, 'lease_token'> & {
  status: string;
  completion_key: string | null;
  principal: string | null;
  result: JsonRecord;
  result_ref: JsonRecord | null;
  error_message: string | null;
  attempt_count: number;
  last_error: string | null;
  raw: JsonRecord;
};

type NormalizedAgentOptions = Required<Omit<SopAgentHandoffConsumerOptions, 'loaderEntrypoint'>> & {
  loaderEntrypoint?: string;
};

function normalizeAgentOptions(input: SopAgentHandoffConsumerOptions): NormalizedAgentOptions {
  const requiredMcpTools = [...new Set((input.requiredMcpTools ?? []).map((value) => requiredString(value, 'required_mcp_tool_invalid')))];
  return {
    siteRoot: requiredString(input.siteRoot, 'siteRoot_required'),
    invocationPlanRef: requiredString(input.invocationPlanRef, 'invocationPlanRef_required'),
    requiredMcpTools,
    consumerId: optionalString(input.consumerId) ?? 'sop-agent-handoff-consumer-v1',
    principal: optionalString(input.principal) ?? 'sop-agent-handoff-consumer-v1',
    sopSurfaceId: optionalString(input.sopSurfaceId) ?? 'sop',
    workerSurfaceId: optionalString(input.workerSurfaceId) ?? 'worker-delegation',
    maxHandoffs: boundedInteger(input.maxHandoffs, 10, 1, 100, 'maxHandoffs'),
    leaseMs: boundedInteger(input.leaseMs, 60_000, 1_000, 300_000, 'leaseMs'),
    maxRunMs: boundedInteger(input.maxRunMs, 300_000, 1_000, 1_800_000, 'maxRunMs'),
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, 30_000, 1_000, 300_000, 'requestTimeoutMs'),
    ...(input.loaderEntrypoint ? { loaderEntrypoint: input.loaderEntrypoint } : {}),
  };
}

function handoffLeaseMs(options: NormalizedAgentOptions): number {
  const boundedWorkerCallMs = Math.min(180_000, options.maxRunMs) + options.requestTimeoutMs + 5_000;
  return Math.min(300_000, Math.max(options.leaseMs, boundedWorkerCallMs));
}

type NormalizedOperatorOptions = Required<Omit<SopOperatorHandoffCompletionOptions, 'loaderEntrypoint' | 'resultRef' | 'errorMessage'>> & {
  resultRef: JsonRecord | null;
  errorMessage: string | null;
  loaderEntrypoint?: string;
};

function normalizeOperatorOptions(input: SopOperatorHandoffCompletionOptions): NormalizedOperatorOptions {
  const handoffId = requiredString(input.handoffId, 'handoffId_required');
  const principal = requiredString(input.principal, 'principal_required');
  if (input.outcome !== 'completed' && input.outcome !== 'failed') throw new Error('outcome_invalid');
  const errorMessage = optionalString(input.errorMessage);
  if (input.outcome === 'failed' && !errorMessage) throw new Error('failed_outcome_requires_errorMessage');
  return {
    siteRoot: requiredString(input.siteRoot, 'siteRoot_required'),
    handoffId,
    principal,
    outcome: input.outcome,
    result: requireRecord(input.result, 'result_object_required'),
    completionKey: optionalString(input.completionKey) ?? `operator:${handoffId}`,
    resultRef: input.resultRef === undefined || input.resultRef === null ? null : requireRecord(input.resultRef, 'resultRef_invalid'),
    errorMessage,
    consumerId: optionalString(input.consumerId) ?? `sop-operator:${principal}`,
    sopSurfaceId: optionalString(input.sopSurfaceId) ?? 'sop',
    leaseMs: boundedInteger(input.leaseMs, 60_000, 1_000, 300_000, 'leaseMs'),
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, 30_000, 1_000, 300_000, 'requestTimeoutMs'),
    ...(input.loaderEntrypoint ? { loaderEntrypoint: input.loaderEntrypoint } : {}),
  };
}

function buildAgentWorkerRequest(handoff: ClaimedHandoff, options: NormalizedAgentOptions): JsonRecord {
  const resultSchema = handoff.result_schema ?? { type: 'object' };
  return {
    idempotency_key: workerIdempotencyKey(handoff),
    intent: {
      mode: 'audit_only',
      instruction: [
        'Execute judgment for one durable SOP agent handoff.',
        'This child execution has read-only authority. Do not mutate domain state, files, tasks, tickets, drafts, mail, or the SOP run.',
        `SOP: ${handoff.sop_id} v${handoff.sop_version}`,
        `Run: ${handoff.run_id}`,
        `Step: ${handoff.step_id}`,
        `Title: ${handoff.title}`,
        '',
        'Instructions:',
        handoff.instructions,
        '',
        `Input: ${JSON.stringify(handoff.input)}`,
        `Input reference: ${JSON.stringify(handoff.input_ref)}`,
        '',
        `Return the exact step result only at structured_outputs.${AGENT_RESULT_KEY}.`,
        'A prose summary is not a substitute for that structured output.',
        `Required result schema: ${JSON.stringify(resultSchema)}`,
      ].join('\n'),
      output_contract: {
        schema: 'narada.sop.agent_handoff_output.v1',
        strict: true,
        structured_output_key: AGENT_RESULT_KEY,
        structured_output_schema: resultSchema,
      },
    },
    constraints: {
      cwd: options.siteRoot,
      site_root: options.siteRoot,
      invocation_plan_ref: options.invocationPlanRef,
      authority: 'read',
      resumable: false,
      wait_for_completion: true,
      wait_timeout_ms: Math.min(180_000, options.maxRunMs),
      max_run_ms: options.maxRunMs,
      required_mcp_tools: options.requiredMcpTools,
      overrides: {
        runtime: 'narada-agent-runtime-server',
        sandbox: 'read-only',
      },
    },
  };
}

function parseClaimedHandoff(value: JsonRecord, executor: 'agent' | 'operator'): ClaimedHandoff {
  const visible = parseVisibleHandoff(value, executor);
  if (visible.status !== 'leased') throw new Error(`sop_handoff_not_leased:${visible.status}`);
  return { ...visible, lease_token: requiredString(value.lease_token, 'sop_handoff_lease_token_missing') };
}

function parseVisibleHandoff(value: JsonRecord, executor: 'agent' | 'operator'): VisibleHandoff {
  if (value.schema !== 'narada.sop.handoff.v1') throw new Error('sop_handoff_schema_invalid');
  if (value.executor !== executor) throw new Error(`sop_handoff_executor_invalid:${String(value.executor)}`);
  const version = Number(value.sop_version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('sop_handoff_version_invalid');
  return {
    handoff_id: requiredString(value.handoff_id, 'sop_handoff_id_missing'),
    run_id: requiredString(value.run_id, 'sop_handoff_run_id_missing'),
    step_id: requiredString(value.step_id, 'sop_handoff_step_id_missing'),
    occurrence_key: requiredString(value.occurrence_key, 'sop_handoff_occurrence_key_missing'),
    sop_id: requiredString(value.sop_id, 'sop_handoff_sop_id_missing'),
    sop_version: version,
    executor,
    title: requiredString(value.title, 'sop_handoff_title_missing'),
    instructions: requiredString(value.instructions, 'sop_handoff_instructions_missing'),
    input: value.input,
    input_ref: value.input_ref === undefined || value.input_ref === null ? null : requireRecord(value.input_ref, 'sop_handoff_input_ref_invalid'),
    result_schema: value.result_schema === undefined || value.result_schema === null ? null : requireRecord(value.result_schema, 'sop_handoff_result_schema_invalid'),
    status: requiredString(value.status, 'sop_handoff_status_missing'),
    completion_key: optionalString(value.completion_key),
    principal: optionalString(value.principal),
    result: value.result === undefined ? {} : requireRecord(value.result, 'sop_handoff_result_invalid'),
    result_ref: value.result_ref === undefined || value.result_ref === null ? null : requireRecord(value.result_ref, 'sop_handoff_result_ref_invalid'),
    error_message: optionalString(value.error_message),
    attempt_count: Number.isSafeInteger(Number(value.attempt_count)) ? Number(value.attempt_count) : 0,
    last_error: optionalString(value.last_error),
    raw: value,
  };
}

function parseWorkerRun(value: JsonRecord): {
  raw: JsonRecord;
  run_id: string;
  status: string;
  idempotency_replayed: boolean;
  idempotency_key: string | null;
} {
  if (value.schema !== 'narada.worker.run.v1') throw new Error('worker_run_schema_invalid');
  const status = requiredString(value.status, 'worker_run_status_missing');
  if (status !== 'running' && !WORKER_TERMINAL_STATUSES.has(status)) throw new Error(`worker_run_status_invalid:${status}`);
  return {
    raw: value,
    run_id: requiredString(value.run_id, 'worker_run_id_missing'),
    status,
    idempotency_replayed: value.idempotency_replayed === true,
    idempotency_key: optionalString(value.idempotency_key),
  };
}

function parseAgentStructuredResult(worker: JsonRecord): JsonRecord {
  const structured = requireRecord(worker.structured_outputs, 'worker_structured_outputs_missing');
  return requireRecord(structured[AGENT_RESULT_KEY], 'worker_sop_handoff_result_missing');
}

function validateAgentResult(result: JsonRecord, schema: JsonRecord | null): void {
  if (!schema) return;
  const validator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validator(result)) {
    throw new Error(`worker_sop_handoff_result_schema_mismatch:${JSON.stringify(validator.errors ?? [])}`);
  }
}

async function advanceHandoff(
  fabric: SopHandoffFabricCaller,
  sopSurfaceId: string,
  handoff: ClaimedHandoff,
  completion: {
    consumerId: string;
    completionKey: string;
    principal: string;
    outcome: 'completed' | 'failed';
    result: JsonRecord;
    resultRef?: JsonRecord | null;
    errorMessage?: string | null;
  },
): Promise<JsonRecord> {
  return await fabric.call(sopSurfaceId, 'sop_run_advance', {
    handoff_id: handoff.handoff_id,
    run_id: handoff.run_id,
    step_id: handoff.step_id,
    consumer_id: completion.consumerId,
    lease_token: handoff.lease_token,
    completion_key: completion.completionKey,
    outcome: completion.outcome,
    principal: completion.principal,
    result: completion.result,
    ...(completion.resultRef ? { result_ref: completion.resultRef } : {}),
    ...(completion.outcome === 'failed' ? { error_message: requiredString(completion.errorMessage, 'failure_error_message_required') } : {}),
  });
}

async function releaseHandoff(
  fabric: SopHandoffFabricCaller,
  sopSurfaceId: string,
  handoff: ClaimedHandoff,
  consumerId: string,
  errorMessage: string,
): Promise<void> {
  await fabric.call(sopSurfaceId, 'sop_handoff_release', {
    handoff_id: handoff.handoff_id,
    consumer_id: consumerId,
    lease_token: handoff.lease_token,
    error_message: errorMessage,
  });
}

function assertOperatorReplay(current: VisibleHandoff, options: NormalizedOperatorOptions): void {
  const matches = current.completion_key === options.completionKey
    && current.status === options.outcome
    && current.principal === options.principal
    && canonicalJson(current.result) === canonicalJson(options.result)
    && canonicalJson(current.result_ref) === canonicalJson(options.resultRef)
    && current.error_message === options.errorMessage;
  if (!matches) throw new Error(`sop_operator_handoff_completion_conflict:${current.handoff_id}`);
}

function requireRecord(value: unknown, code: string): JsonRecord {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function requiredString(value: unknown, code: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(code);
  return normalized;
}

function optionalString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${name}_invalid`);
  return resolved;
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 2_048 ? text : text.slice(0, 2_048);
}

function errorRecord(stage: string, error: unknown, handoffId?: string): JsonRecord {
  return { stage, ...(handoffId ? { handoff_id: handoffId } : {}), error: boundedError(error) };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function parseJsonObject(value: string, code: string): JsonRecord {
  try {
    return requireRecord(JSON.parse(value), code);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

function parseCli(argv: string[]): { mode: 'agent-pass'; options: SopAgentHandoffConsumerOptions } | { mode: 'operator-complete'; options: SopOperatorHandoffCompletionOptions } {
  const mode = argv[0];
  if (mode !== 'agent-pass' && mode !== 'operator-complete') throw new Error('mode_required:agent-pass|operator-complete');
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!flag.startsWith('--')) throw new Error(`unexpected_argument:${flag}`);
    if (!value || value.startsWith('--')) throw new Error(`missing_argument_value:${flag}`);
    if (flag === '--required-mcp-tool') repeated.set(flag, [...(repeated.get(flag) ?? []), value]);
    else {
      if (values.has(flag)) throw new Error(`duplicate_argument:${flag}`);
      values.set(flag, value);
    }
    index += 1;
  }
  const common = {
    siteRoot: requiredString(values.get('--site-root'), 'site_root_required'),
    ...(values.has('--sop-surface-id') ? { sopSurfaceId: values.get('--sop-surface-id') } : {}),
    ...(values.has('--lease-ms') ? { leaseMs: Number(values.get('--lease-ms')) } : {}),
    ...(values.has('--request-timeout-ms') ? { requestTimeoutMs: Number(values.get('--request-timeout-ms')) } : {}),
    ...(values.has('--loader-entrypoint') ? { loaderEntrypoint: values.get('--loader-entrypoint') } : {}),
  };
  if (mode === 'agent-pass') {
    const known = new Set(['--site-root', '--invocation-plan-ref', '--consumer-id', '--principal', '--sop-surface-id', '--worker-surface-id', '--max-handoffs', '--lease-ms', '--max-run-ms', '--request-timeout-ms', '--loader-entrypoint']);
    for (const flag of values.keys()) if (!known.has(flag)) throw new Error(`unknown_argument:${flag}`);
    return {
      mode,
      options: {
        ...common,
        invocationPlanRef: requiredString(values.get('--invocation-plan-ref'), 'invocation_plan_ref_required'),
        requiredMcpTools: repeated.get('--required-mcp-tool') ?? [],
        ...(values.has('--consumer-id') ? { consumerId: values.get('--consumer-id') } : {}),
        ...(values.has('--principal') ? { principal: values.get('--principal') } : {}),
        ...(values.has('--worker-surface-id') ? { workerSurfaceId: values.get('--worker-surface-id') } : {}),
        ...(values.has('--max-handoffs') ? { maxHandoffs: Number(values.get('--max-handoffs')) } : {}),
        ...(values.has('--max-run-ms') ? { maxRunMs: Number(values.get('--max-run-ms')) } : {}),
      },
    };
  }
  if (repeated.size > 0) throw new Error('unknown_argument:--required-mcp-tool');
  const known = new Set(['--site-root', '--handoff-id', '--principal', '--outcome', '--result-json', '--completion-key', '--result-ref-json', '--error-message', '--consumer-id', '--sop-surface-id', '--lease-ms', '--request-timeout-ms', '--loader-entrypoint']);
  for (const flag of values.keys()) if (!known.has(flag)) throw new Error(`unknown_argument:${flag}`);
  const outcome = requiredString(values.get('--outcome'), 'outcome_required');
  if (outcome !== 'completed' && outcome !== 'failed') throw new Error('outcome_invalid');
  return {
    mode,
    options: {
      ...common,
      handoffId: requiredString(values.get('--handoff-id'), 'handoff_id_required'),
      principal: requiredString(values.get('--principal'), 'principal_required'),
      outcome,
      result: parseJsonObject(requiredString(values.get('--result-json'), 'result_json_required'), 'result_json_invalid'),
      ...(values.has('--completion-key') ? { completionKey: values.get('--completion-key') } : {}),
      ...(values.has('--result-ref-json') ? { resultRef: parseJsonObject(values.get('--result-ref-json')!, 'result_ref_json_invalid') } : {}),
      ...(values.has('--error-message') ? { errorMessage: values.get('--error-message') } : {}),
      ...(values.has('--consumer-id') ? { consumerId: values.get('--consumer-id') } : {}),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = parseCli(process.argv.slice(2));
    const result = command.mode === 'agent-pass'
      ? await runSopAgentHandoffConsumerPass(command.options)
      : await completeSopOperatorHandoff(command.options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'completed') process.exitCode = 1;
  } catch (error) {
    const failure = {
      schema: 'narada.sop.handoff_consumer_cli.v1',
      status: 'error',
      error: boundedError(error),
      diagnostic_id: createHash('sha256').update(boundedError(error)).digest('hex').slice(0, 16),
    };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}
