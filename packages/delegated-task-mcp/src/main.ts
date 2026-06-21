#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { callWorkerTool, createWorkerPolicy, publicWorkerPolicy, type WorkerMcpState } from '@narada2/worker-delegation-mcp';

const SERVER_NAME = 'delegated-task-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const COMPLETE_STEP_STATES = new Set(['completed', 'skipped', 'noted']);
const FAILED_WORKER_STATUSES = new Set(['failed', 'cancelled', 'completed_with_errors']);
const WORKER_KINDS = new Set(['worker', 'review', 'repair', 'verify', 'research']);
const LOCAL_KINDS = new Set(['gate', 'join', 'note']);
const DEFAULT_WORKFLOW_KINDS = [...WORKER_KINDS, ...LOCAL_KINDS];

type JsonRecord = Record<string, unknown>;
type WorkerTool = (name: string, args: JsonRecord, state: WorkerMcpState) => Promise<JsonRecord>;
type TaskStatus = 'accepted_for_execution' | 'running' | 'completed' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked' | 'noted';
type State = {
  taskRoot: string;
  allowedRoots: string[];
  allowedWorkflowKinds: string[];
  allowedProfiles: string[] | null;
  resultCompaction: {
    maxWorkerRefs: number;
    maxListItems: number;
  };
  outputRoot: string;
  workerState: WorkerMcpState;
  workerTool: WorkerTool;
};
type Task = {
  schema: 'narada.delegated_task.task.v1';
  task_id: string;
  status: TaskStatus;
  objective: string;
  constraints: JsonRecord;
  workflow: JsonRecord;
  acceptance: JsonRecord;
  result_policy: JsonRecord;
  execution: JsonRecord;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  summary: string | null;
  result: JsonRecord;
};
type WorkflowStep = {
  id: string;
  kind: string;
  profile: string | null;
  instruction: string | null;
  depends_on: string[];
  if: string | null;
  acceptance_scope: string[];
  constraints: JsonRecord;
};
type StepState = {
  step_id: string;
  kind: string;
  status: StepStatus;
  attempts: number;
  run_ids: string[];
  current_run_id: string | null;
  worker_session_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  blocked_by: string[];
  error: string | null;
  summary: string | null;
};
type AdvanceOptions = { waitUntilTerminal?: boolean; timeoutMs?: number; pollMs?: number };

export function createServerState(options: JsonRecord = {}): State {
  const taskRoot = resolve(String(options.taskRoot ?? options.outputRoot ?? process.cwd()));
  const siteRoot = resolve(String(options.siteRoot ?? taskRoot));
  const stateEnv = { ...process.env };
  loadSiteSecrets(siteRoot, stateEnv);
  const siteExtraRoots = loadSiteExtraAllowedRoots(siteRoot);
  const roots = normalizeRoots([...siteExtraRoots, ...optionList(options.allowedRoot), ...optionList(options.allowedRoots)]);
  const allowedRoots = roots.length ? roots : [taskRoot];
  if (!allowedRoots.some((root) => taskRoot === root || inside(taskRoot, root))) {
    throw diag('delegated_task_root_outside_allowed_roots', 'delegated_task_root_outside_allowed_roots', { task_root: taskRoot, allowed_roots: allowedRoots });
  }
  const workerState: WorkerMcpState = {
    policy: createWorkerPolicy({ ...rec(options.workerPolicy), allowedRoots }),
    env: stateEnv,
    activeRunCount: 0,
  };
  const policy = rec(options.policy);
  const allowedWorkflowKinds = stringList(policy.allowed_workflow_kinds ?? options.allowedWorkflowKinds, DEFAULT_WORKFLOW_KINDS);
  const profiles = stringList(policy.allowed_profiles ?? options.allowedProfiles, []);
  const resultCompaction = {
    maxWorkerRefs: integer(policy.max_worker_refs, 50, 1, 1000),
    maxListItems: integer(policy.max_list_items, 200, 1, 5000),
  };
  return { taskRoot, allowedRoots, allowedWorkflowKinds, allowedProfiles: profiles.length ? profiles : null, resultCompaction, outputRoot: resolve(taskRoot, 'outputs'), workerState, workerTool: workerToolOption(options.workerTool) };
}

export function listTools() {
  return [
    tool('delegated_task_policy_inspect', 'Inspect delegated task orchestration policy and defaults.', {}, [], true, false, true),
    tool('delegated_task_validate', 'Validate delegated task input without creating or running a task.', { objective: { type: 'string' }, intent: intentSchema(), constraints: constraintsSchema(), workflow: workflowSchema(), acceptance: acceptanceSchema(), result_policy: resultPolicySchema(), execution: executionSchema() }, [], true, false, true),
    tool('delegated_task_run', 'Create and optionally start a durable delegated workflow task.', { objective: { type: 'string' }, intent: intentSchema(), constraints: constraintsSchema(), workflow: workflowSchema(), acceptance: acceptanceSchema(), result_policy: resultPolicySchema(), execution: executionSchema(), idempotency_key: { type: 'string' } }, [], false, false, false),
    tool('delegated_task_status', 'Return compact delegated task status.', { task_id: { type: 'string' }, refresh: { type: 'boolean', default: true } }, ['task_id'], true, false, true),
    tool('delegated_task_wait', 'Wait for a delegated task to advance toward terminal status.', { task_id: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 0, maximum: 600000, default: 30000 }, poll_ms: { type: 'integer', minimum: 50, maximum: 30000, default: 500 }, include_diagnostics: { type: 'boolean', default: false } }, ['task_id'], true, false, true),
    tool('delegated_tasks_list', 'List recent delegated tasks so callers can rediscover active work.', { limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 }, include_terminal: { type: 'boolean', default: true }, include_active: { type: 'boolean', default: true } }, [], true, false, true),
    tool('delegated_task_result', 'Return delegated task result handoff.', { task_id: { type: 'string' }, include_diagnostics: { type: 'boolean', default: false }, refresh: { type: 'boolean', default: true } }, ['task_id'], true, false, true),
    tool('delegated_task_summary', 'Return a compact human review summary for one delegated task.', { task_id: { type: 'string' }, refresh: { type: 'boolean', default: true } }, ['task_id'], true, false, true),
    tool('delegated_task_events', 'List delegated task events.', { task_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 } }, ['task_id'], true, false, true),
    tool('delegated_task_cancel', 'Cancel a nonterminal delegated task.', { task_id: { type: 'string' }, reason: { type: 'string' } }, ['task_id'], false, true, false),
  ];
}

export async function handleRequest(request: JsonRecord, state: State) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatch(String(request.method), rec(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const data = errorData(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: data.message, data } };
  }
}

export async function delegatedTaskRun(args: JsonRecord, state: State): Promise<JsonRecord> {
  const idempotencyKey = opt(args.idempotency_key);
  const taskId = idempotencyKey ? `task_${hash(idempotencyKey).slice(0, 16)}` : `task_${stamp()}_${randomUUID().slice(0, 8)}`;
  const paths = taskPaths(state, taskId);
  if (existsSync(paths.taskPath)) return runResult(await advanceTask(readTask(state, taskId), state), paths, false);
  const taskIntent = normalizeIntent(args);
  const execution = normalizeExecution(args.execution);
  const task: Task = {
    schema: 'narada.delegated_task.task.v1',
    task_id: taskId,
    status: 'accepted_for_execution',
    objective: taskIntent.objective,
    constraints: rec(args.constraints),
    workflow: normalizeWorkflow(args.workflow, state),
    acceptance: rec(args.acceptance),
    result_policy: normalizeResultPolicy(args.result_policy),
    execution,
    idempotency_key: idempotencyKey,
    created_at: now(),
    updated_at: now(),
    cancelled_at: null,
    summary: null,
    result: handoff(),
  };
  task.result = { ...task.result, step_states: initialStepStates(task.workflow), progress: progressSummary(task) };
  const validation = validateTaskShape({ ...args, workflow: task.workflow, execution, result_policy: task.result_policy }, state, false);
  if (validation.status === 'rejected') throw diag('delegated_task_validation_failed', 'delegated_task_validation_failed', { diagnostics: validation.diagnostics });
  writeTask(state, task);
  appendEvent(state, taskId, 'task_created', { intent: taskIntent, status: task.status });
  const advanced = execution.start === false ? task : await advanceTask(task, state, { waitUntilTerminal: execution.wait_for_completion === true, timeoutMs: execution.wait_for_completion === true ? integer(execution.timeout_ms, 30000, 0, 600000) : integer(execution.timeout_ms, 0, 0, 600000), pollMs: integer(execution.poll_ms, 500, 50, 30000) });
  return runResult(advanced, paths, true);
}

export async function delegatedTaskStatus(args: JsonRecord, state: State): Promise<JsonRecord> {
  const task = args.refresh === false ? readTask(state, taskId(args)) : await advanceTask(readTask(state, taskId(args)), state);
  return { schema: 'narada.delegated_task.status.v1', status: 'ok', task_id: task.task_id, task_status: task.status, objective: task.objective, step_counts: stepCounts(task.workflow), step_status_counts: stepStatusCounts(task), acceptance_verdict: rec(task.result).acceptance_verdict ?? 'pending', progress: rec(task.result).progress, created_at: task.created_at, updated_at: task.updated_at, cancelled_at: task.cancelled_at };
}

export function delegatedTaskValidate(args: JsonRecord, state: State): JsonRecord {
  return validateTaskShape(args, state, true);
}

export async function delegatedTaskWait(args: JsonRecord, state: State): Promise<JsonRecord> {
  const started = Date.now();
  const timeoutMs = integer(args.timeout_ms, 30000, 0, 600000);
  const pollMs = integer(args.poll_ms, 500, 50, 30000);
  const task = await advanceTask(readTask(state, taskId(args)), state, { waitUntilTerminal: true, timeoutMs, pollMs });
  const result = delegatedTaskResultView(task, state, args.include_diagnostics === true);
  const waitStatus = TERMINAL.has(task.status) ? 'finished' : 'timeout';
  const response: JsonRecord = { schema: 'narada.delegated_task.wait.v1', status: waitStatus, elapsed_ms: Date.now() - started, timeout_ms: timeoutMs, poll_ms: pollMs, task_id: task.task_id, task_status: task.status, progress: rec(task.result).progress, result };
  if (waitStatus === 'timeout') response.timeout_diagnostics = { active_steps: activeStepIds(task), message: 'delegated_task_wait timed out before task reached a terminal status' };
  return response;
}

export function delegatedTasksList(args: JsonRecord, state: State): JsonRecord {
  const limit = integer(args.limit, 20, 1, 200);
  const includeTerminal = args.include_terminal !== false;
  const includeActive = args.include_active !== false;
  const tasksDir = resolve(state.taskRoot, 'tasks');
  const tasks = existsSync(tasksDir) ? readdirSync(tasksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    try { return readTask(state, entry.name); } catch { return null; }
  }).filter((task): task is Task => task !== null) : [];
  const filtered = tasks.filter((task) => TERMINAL.has(task.status) ? includeTerminal : includeActive).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
  return { schema: 'narada.delegated_task.list.v1', status: 'ok', limit, count: filtered.length, tasks: filtered.map((task) => ({ task_id: task.task_id, task_status: task.status, objective: task.objective, updated_at: task.updated_at, progress: rec(task.result).progress, acceptance_verdict: rec(task.result).acceptance_verdict ?? 'pending' })) };
}

export function delegatedTaskPolicyInspect(state: State): JsonRecord {
  return {
    schema: 'narada.delegated_task.policy.v1',
    status: 'ok',
    task_root: state.taskRoot,
    allowed_roots: state.allowedRoots,
    allowed_workflow_kinds: state.allowedWorkflowKinds,
    allowed_profiles: state.allowedProfiles,
    execution_defaults: normalizeExecution({}),
    result_policy_defaults: normalizeResultPolicy({}),
    result_compaction: state.resultCompaction,
    policy_schema: 'narada.delegated_task.policy.v1',
    condition_language: [
      'always',
      'on_success',
      'on_failure',
      'review_failed',
      'acceptance:<verdict>',
      'step:<step_id>:<status>',
      'kind:<kind>:<status>',
      'result_has:<text>',
      'no_residual_risks',
      'all(<expr>,<expr>)',
      'any(<expr>,<expr>)',
      'not(<expr>)',
    ],
    worker_policy: publicWorkerPolicy(state.workerState.policy),
  };
}

export async function delegatedTaskResult(args: JsonRecord, state: State): Promise<JsonRecord> {
  const task = args.refresh === false ? readTask(state, taskId(args)) : await advanceTask(readTask(state, taskId(args)), state);
  return delegatedTaskResultView(task, state, args.include_diagnostics === true);
}

export async function delegatedTaskSummary(args: JsonRecord, state: State): Promise<JsonRecord> {
  const task = args.refresh === false ? readTask(state, taskId(args)) : await advanceTask(readTask(state, taskId(args)), state);
  return {
    schema: 'narada.delegated_task.summary.v1',
    status: 'ok',
    task_id: task.task_id,
    task_status: task.status,
    objective: task.objective,
    summary: task.summary,
    acceptance_verdict: rec(task.result).acceptance_verdict ?? 'pending',
    changed_files: stringList(rec(task.result).changed_files),
    real_changed_files: stringList(rec(task.result).real_changed_files),
    affected_refs: stringList(rec(task.result).affected_refs),
    verification_count: count(rec(task.result).verification),
    residual_risks: stringList(rec(task.result).residual_risks),
    observed_incoherencies: stringList(rec(task.result).observed_incoherencies),
    child_evidence: workerRefs(task).map((ref) => ({ step_id: ref.step_id, step_kind: ref.step_kind, run_id: ref.run_id, status: ref.status, summary: ref.summary })),
    progress: rec(task.result).progress,
    terminal_summary: terminalSummary(task.result),
  };
}

export function delegatedTaskEvents(args: JsonRecord, state: State): JsonRecord {
  const id = taskId(args);
  const task = readTask(state, id);
  const events = readEvents(state, id);
  const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const policyLimit = integer(task.result_policy.max_events, 100, 1, 1000);
  const limit = Math.min(integer(args.limit, Math.min(50, policyLimit), 1, 100), policyLimit);
  return { schema: 'narada.delegated_task.events.v1', status: 'ok', task_id: id, offset, limit, count: events.length, event_counts_by_kind: eventCountsByKind(events), event_summary_by_step: eventSummaryByStep(events), last_meaningful_event_by_active_step: lastMeaningfulEventByActiveStep(task, events), events: events.slice(offset, offset + limit), has_more: offset + limit < events.length, compacted: events.length > limit };
}

export function delegatedTaskCancel(args: JsonRecord, state: State): JsonRecord {
  const id = taskId(args);
  const task = readTask(state, id);
  if (TERMINAL.has(task.status)) throw diag('delegated_task_terminal_status', `delegated_task_terminal_status:${task.status}`, { task_id: id, status: task.status });
  task.status = 'cancelled';
  task.updated_at = now();
  task.cancelled_at = now();
  task.summary = opt(args.reason) ?? 'cancelled';
  task.result = { ...rec(task.result), acceptance_verdict: 'cancelled', summary: task.summary, residual_risks: uniqueStrings([...stringList(rec(task.result).residual_risks), 'task_cancelled_before_completion']), progress: progressSummary(task) };
  writeTask(state, task);
  const event = appendEvent(state, id, 'task_cancelled', { reason: task.summary });
  task.result = annotateCancelledWorkerRefs(task.result);
  writeTask(state, task);
  return { schema: 'narada.delegated_task.cancel.v1', status: 'cancelled', task_id: id, task_status: task.status, event };
}

async function dispatch(method: string, params: JsonRecord, state: State) {
  if (method === 'initialize') return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
  if (method === 'tools/list') return { tools: listTools() };
  if (method !== 'tools/call') throw diag('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  const name = String(params.name ?? '');
  const args = rec(params.arguments);
  const result = name === 'delegated_task_policy_inspect' ? delegatedTaskPolicyInspect(state)
    : name === 'delegated_task_validate' ? delegatedTaskValidate(args, state)
    : name === 'delegated_task_run' ? await delegatedTaskRun(args, state)
    : name === 'delegated_task_status' ? await delegatedTaskStatus(args, state)
      : name === 'delegated_task_wait' ? await delegatedTaskWait(args, state)
        : name === 'delegated_tasks_list' ? delegatedTasksList(args, state)
            : name === 'delegated_task_result' ? await delegatedTaskResult(args, state)
              : name === 'delegated_task_summary' ? await delegatedTaskSummary(args, state)
                : name === 'delegated_task_events' ? delegatedTaskEvents(args, state)
                  : name === 'delegated_task_cancel' ? delegatedTaskCancel(args, state)
                : null;
  if (!result) throw diag('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  return { content: [{ type: 'text', text: render(result) }], structuredContent: result };
}

async function advanceTask(task: Task, state: State, options: AdvanceOptions = {}): Promise<Task> {
  if (TERMINAL.has(task.status)) return task;
  const deadline = Date.now() + (options.timeoutMs ?? 0);
  const waitUntilTerminal = options.waitUntilTerminal === true;
  const pollMs = Math.max(50, options.pollMs ?? 500);
  let current = task;
  do {
    const before = JSON.stringify(rec(current.result).step_states ?? {});
    current = await advanceTaskOnce(current, state);
    const after = JSON.stringify(rec(current.result).step_states ?? {});
    if (!waitUntilTerminal || TERMINAL.has(current.status) || before === after) {
      if (!waitUntilTerminal || TERMINAL.has(current.status) || Date.now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  } while (waitUntilTerminal && Date.now() < deadline && !TERMINAL.has(current.status));
  return current;
}

async function advanceTaskOnce(task: Task, state: State): Promise<Task> {
  const stepStates = stepStateMap(task);
  await refreshRunningSteps(task, state, stepStates);
  let progressMade = false;
  const workflow = workflowSteps(task.workflow);
  const readyWorkerSteps: Array<{ step: WorkflowStep; stepState: StepState }> = [];
  for (const step of workflow) {
    const stepState = stepStates[step.id] ?? initialStepState(step);
    stepStates[step.id] = stepState;
    if (stepState.status !== 'pending') continue;
    const dependency = dependencyStatus(step, stepStates);
    if (dependency.blocked.length > 0) {
      markStep(stepState, 'blocked', `blocked_by:${dependency.blocked.join(',')}`);
      stepState.blocked_by = dependency.blocked;
      appendEvent(state, task.task_id, 'step_blocked', { step_id: step.id, blocked_by: dependency.blocked });
      progressMade = true;
      continue;
    }
    if (!dependency.ready) continue;
    const condition = evaluateCondition(step.if, task, stepStates);
    if (!condition.pass) {
      markStep(stepState, 'skipped', condition.reason);
      appendEvent(state, task.task_id, 'step_skipped', { step_id: step.id, reason: condition.reason });
      progressMade = true;
      continue;
    }
    if (LOCAL_KINDS.has(step.kind)) {
      completeLocalStep(task, state, step, stepState, stepStates);
      progressMade = true;
      continue;
    }
    if (WORKER_KINDS.has(step.kind)) {
      readyWorkerSteps.push({ step, stepState });
      const concurrencyLimit = executionPolicy(task).max_concurrency;
      if (readyWorkerSteps.length >= concurrencyLimit) break;
    }
  }
  if (readyWorkerSteps.length > 0) {
    await Promise.allSettled(readyWorkerSteps.map(async ({ step, stepState }) => {
      try {
        await launchWorkerStep(task, state, step, stepState);
      } catch (error) {
        if (stepState.status === 'pending') {
          markStep(stepState, 'failed', error instanceof Error ? error.message : String(error));
          appendEvent(state, task.task_id, 'step_failed', { step_id: stepState.step_id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }));
    progressMade = true;
  }
  if (progressMade) appendEvent(state, task.task_id, 'task_progress_advanced', { progress: progressSummary(task, stepStates) });
  finalizeTask(task, state, stepStates);
  writeTask(state, task);
  return task;
}

async function refreshRunningSteps(task: Task, state: State, stepStates: Record<string, StepState>): Promise<void> {
  let dataChanged = false;
  for (const stepState of Object.values(stepStates)) {
    if (stepState.status !== 'running' || !stepState.current_run_id) continue;
    let statusResult: JsonRecord;
    try {
      statusResult = await state.workerTool('worker_run_status', { run_id: stepState.current_run_id }, state.workerState);
    } catch (error) {
      stepState.error = error instanceof Error ? error.message : String(error);
      dataChanged = true;
      continue;
    }
    const workerRef = summarizeWorkerRef({ id: stepState.step_id, kind: stepState.kind, profile: null, instruction: null, depends_on: [], if: null, acceptance_scope: [], constraints: {} }, statusResult);
    upsertWorkerRef(task, workerRef, statusResult);
    const refreshedStatus = String(statusResult.status ?? 'unknown');
    if (refreshedStatus === 'completed') {
      markStep(stepState, 'completed', opt(statusResult.summary));
      stepState.worker_session_id = opt(statusResult.worker_session_id);
      appendEvent(state, task.task_id, 'step_completed', { step_id: stepState.step_id, run_id: stepState.current_run_id });
      dataChanged = true;
    } else if (FAILED_WORKER_STATUSES.has(refreshedStatus)) {
      const maxRetries = executionPolicy(task).max_retries;
      if (stepState.attempts <= maxRetries) {
        stepState.status = 'pending';
        stepState.error = `retry_after:${refreshedStatus}`;
        appendEvent(state, task.task_id, 'step_retry_scheduled', { step_id: stepState.step_id, run_id: stepState.current_run_id, attempts: stepState.attempts, max_retries: maxRetries });
      } else {
        markStep(stepState, 'failed', opt(statusResult.error) ?? `worker_status:${refreshedStatus}`);
        appendEvent(state, task.task_id, 'step_failed', { step_id: stepState.step_id, run_id: stepState.current_run_id, status: refreshedStatus });
      }
      dataChanged = true;
    }
  }
  if (dataChanged) {
    finalizeTask(task, state, stepStates);
    writeTask(state, task);
  }
}

async function launchWorkerStep(task: Task, state: State, step: WorkflowStep, stepState: StepState): Promise<void> {
  const workerResult = await state.workerTool('worker_run', buildWorkerArgs(task, step, state), state.workerState);
  stepState.status = String(workerResult.status) === 'completed' ? 'completed' : FAILED_WORKER_STATUSES.has(String(workerResult.status)) ? 'failed' : 'running';
  stepState.attempts += 1;
  stepState.started_at ??= now();
  stepState.finished_at = stepState.status === 'running' ? null : now();
  stepState.current_run_id = opt(workerResult.run_id);
  stepState.worker_session_id = opt(workerResult.worker_session_id);
  if (stepState.current_run_id) stepState.run_ids = uniqueStrings([...stepState.run_ids, stepState.current_run_id]);
  stepState.summary = opt(workerResult.summary);
  stepState.error = opt(workerResult.error);
  const workerRef = summarizeWorkerRef(step, workerResult);
  upsertWorkerRef(task, workerRef, workerResult);
  if (stepState.status === 'failed' && stepState.attempts <= executionPolicy(task).max_retries) {
    stepState.status = 'pending';
    stepState.finished_at = null;
    stepState.error = `retry_after:${workerResult.status}`;
    appendEvent(state, task.task_id, 'step_retry_scheduled', { step_id: stepState.step_id, run_id: stepState.current_run_id, attempts: stepState.attempts, max_retries: executionPolicy(task).max_retries });
    return;
  }
  appendEvent(state, task.task_id, stepState.status === 'completed' ? 'step_completed' : stepState.status === 'failed' ? 'step_failed' : 'step_worker_started', workerRef);
}

function completeLocalStep(task: Task, state: State, step: WorkflowStep, stepState: StepState, stepStates: Record<string, StepState>): void {
  if (step.kind === 'join') {
    const dependencyRefs = workerRefs(task).filter((ref) => step.depends_on.includes(String(ref.step_id ?? '')));
    const summary = `joined ${dependencyRefs.length} worker result${dependencyRefs.length === 1 ? '' : 's'}`;
    markStep(stepState, 'completed', summary);
    appendEvent(state, task.task_id, 'step_join_completed', { step_id: step.id, dependency_count: step.depends_on.length, worker_ref_count: dependencyRefs.length });
    return;
  }
  if (step.kind === 'gate') {
    const failedDependencies = step.depends_on.filter((id) => stepStates[id]?.status === 'failed' || stepStates[id]?.status === 'blocked');
    markStep(stepState, failedDependencies.length ? 'failed' : 'completed', failedDependencies.length ? `failed_dependencies:${failedDependencies.join(',')}` : 'gate_passed');
    appendEvent(state, task.task_id, 'step_gate_evaluated', { step_id: step.id, failed_dependencies: failedDependencies });
    return;
  }
  markStep(stepState, 'noted', step.instruction);
  appendEvent(state, task.task_id, 'step_recorded', { step_id: step.id, kind: step.kind });
}

function finalizeTask(task: Task, state: State, stepStates: Record<string, StepState>): void {
  task.result = { ...rec(task.result), step_states: stepStates };
  const consolidated = consolidateResult(task, state, stepStates);
  const acceptance = evaluateAcceptance(task, state, consolidated);
  const statuses = Object.values(stepStates).map((step) => step.status);
  const hasRunning = statuses.includes('running');
  const hasPending = statuses.includes('pending');
  const hasBlocked = statuses.includes('blocked');
  const hasFailed = statuses.includes('failed');
  const allDone = statuses.length > 0 && statuses.every((status) => COMPLETE_STEP_STATES.has(status));
  task.status = hasFailed || hasBlocked ? 'failed' : hasRunning || hasPending ? 'running' : acceptance.verdict === 'failed' ? 'failed' : allDone ? 'completed' : 'accepted_for_execution';
  const verdict = task.status === 'completed' && acceptance.verdict === 'passed' ? 'passed' : task.status === 'failed' ? 'failed' : 'pending';
  task.summary = summaryForTask(task, stepStates, { verdict });
  task.result = {
    ...consolidated,
    acceptance_status: verdict === 'pending' && acceptance.verdict === 'passed' ? 'pending_terminal_completion' : verdict,
    acceptance_verdict: verdict,
    acceptance_precheck_verdict: acceptance.verdict,
    acceptance_evidence: acceptance.checks,
    step_states: stepStates,
    progress: progressSummary(task, stepStates),
    summary: task.summary,
  };
  task.updated_at = now();
}

function consolidateResult(task: Task, _state: State, stepStates: Record<string, StepState>): JsonRecord {
  const refs = workerRefs(task);
  const outputs = refs.map((ref) => rec(ref.output));
  const parentChangedFiles = uniqueStrings(stringList(rec(task.result).parent_changed_files));
  const workerReportedChangedFiles = uniqueStrings([...outputs.flatMap((output) => stringList(output.changed_files)), ...outputs.flatMap((output) => records(output.changes).map((change) => String(change.path ?? '')).filter(Boolean))]);
  const observedFiles = uniqueStrings(outputs.flatMap((output) => records(output.deliverables).map((item) => String(item.path ?? '')).filter(Boolean)));
  const nestedWorkflows = uniqueRecords(outputs.flatMap(nestedWorkflowRecords));
  const nestedWorkflowChangedFiles = uniqueStrings(nestedWorkflows.flatMap((workflow) => stringList(workflow.changed_files)));
  const changedFiles = uniqueStrings([...parentChangedFiles, ...workerReportedChangedFiles, ...observedFiles, ...nestedWorkflowChangedFiles]);
  const changedFileRefs = classifyChangedFileRefs(task, changedFiles);
  const realChangedFiles = changedFileRefs.filter((ref) => ref.kind === 'real_file').map((ref) => String(ref.path));
  const affectedRefs = changedFileRefs.filter((ref) => ref.kind !== 'real_file').map((ref) => String(ref.path));
  const nestedWorkflowVerification = uniqueRecords(nestedWorkflows.flatMap((workflow) => records(workflow.verification_results).length ? records(workflow.verification_results) : records(workflow.verification)));
  const verification = uniqueRecords([...records(rec(task.result).verification), ...outputs.flatMap((output) => records(output.verification_results)), ...outputs.flatMap((output) => records(output.verification)), ...nestedWorkflowVerification]);
  const residualRisks = uniqueStrings([...stringList(rec(task.result).residual_risks), ...outputs.flatMap((output) => stringList(output.residual_risks)), ...(Object.values(stepStates).some((step) => step.status === 'running') ? ['worker_runs_still_in_progress'] : [])]);
  const observedIncoherencies = uniqueStrings([...stringList(rec(task.result).observed_incoherencies), ...outputs.flatMap((output) => stringList(output.observed_incoherencies))]);
  return { schema: 'narada.delegated_task.handoff.v1', changed_files: changedFiles, changed_file_refs: changedFileRefs, real_changed_files: realChangedFiles, affected_refs: affectedRefs, parent_changed_files: parentChangedFiles, worker_reported_changed_files: workerReportedChangedFiles, observed_files: observedFiles, nested_workflows: nestedWorkflows, nested_workflow_changed_files: nestedWorkflowChangedFiles, nested_workflow_verification: nestedWorkflowVerification, verification, residual_risks: residualRisks, observed_incoherencies: observedIncoherencies, worker_refs: refs, worker_ref_count: refs.length };
}

function evaluateAcceptance(task: Task, state: State, result: JsonRecord): { verdict: 'passed' | 'pending' | 'failed'; checks: JsonRecord[] } {
  const cwd = opt(task.constraints.cwd) ?? state.allowedRoots[0];
  const checks: JsonRecord[] = [];
  for (const item of acceptanceItems(task.acceptance.required_files)) {
    const target = String(item.path ?? item.target ?? item.value ?? '');
    const path = resolve(cwd, target);
    const readable = Boolean(target) && (inside(path, cwd) || path === cwd) && existsSync(path);
    let status = readable ? 'passed' : 'failed';
    if (readable && typeof item.contains === 'string') {
      status = readFileSync(path, 'utf8').includes(item.contains) ? 'passed' : 'failed';
    }
    checks.push({ kind: 'required_file', target, status, contains: item.contains ?? null });
  }
  const verificationText = JSON.stringify(result.verification ?? []);
  for (const item of acceptanceItems(task.acceptance.required_tests)) {
    const target = String(item.command ?? item.target ?? item.value ?? '');
    const requiredStatus = String(item.status ?? 'passed');
    const matching = records(result.verification).filter((record) => JSON.stringify(record).includes(target));
    checks.push({ kind: 'required_test', target, required_status: requiredStatus, status: matching.some((record) => String(record.status ?? '').includes(requiredStatus)) || verificationText.includes(target) ? 'passed' : 'pending' });
  }
  const resultText = JSON.stringify(result);
  for (const item of acceptanceItems(task.acceptance.required_tools)) {
    const target = String(item.name ?? item.target ?? item.value ?? '');
    checks.push({ kind: 'required_tool', target, status: resultText.includes(target) ? 'passed' : 'pending' });
  }
  for (const item of acceptanceItems(task.acceptance.forbidden_patterns)) {
    const target = String(item.pattern ?? item.target ?? item.value ?? '');
    checks.push({ kind: 'forbidden_pattern', target, status: resultText.includes(target) ? 'failed' : 'passed' });
  }
  const quorum = rec(task.acceptance.review_quorum);
  if (Object.keys(quorum).length > 0) {
    const signals = reviewSignalsFromResult(result, { resolveAfterRepair: true });
    const minPassed = integer(quorum.min_passed, 1, 0, 1000);
    const maxFailed = integer(quorum.max_failed, 0, 0, 1000);
    const noSignalsYet = signals.passed === 0 && signals.failed === 0 && signals.running === 0;
    checks.push({ kind: 'review_quorum', min_passed: minPassed, max_failed: maxFailed, passed: signals.passed, failed: signals.failed, status: noSignalsYet ? 'pending' : signals.passed >= minPassed && signals.failed <= maxFailed ? 'passed' : signals.running > 0 ? 'pending' : 'failed' });
  }
  if (task.acceptance.residual_risk_policy === 'none_allowed') {
    const risks = stringList(result.residual_risks);
    checks.push({ kind: 'residual_risk_policy', policy: 'none_allowed', risk_count: risks.length, status: risks.length === 0 ? 'passed' : 'failed' });
  }
  if (checks.some((check) => check.status === 'failed')) return { verdict: 'failed', checks };
  if (checks.some((check) => check.status === 'pending')) return { verdict: 'pending', checks };
  return { verdict: 'passed', checks };
}

function delegatedTaskResultView(task: Task, state: State, explicitDiagnostics: boolean): JsonRecord {
  const workflowSummary = stepCounts(task.workflow);
  const includeDiagnostics = explicitDiagnostics || task.result_policy.include_diagnostics_by_default === true;
  const resultView = resultForPolicy(task.result, task.result_policy, includeDiagnostics, state);
  const result: JsonRecord = { schema: 'narada.delegated_task.result.v1', status: 'ok', task_id: task.task_id, task_status: task.status, objective: task.objective, result: resultView, workflow_summary: { ...workflowSummary, step_count: workflowSummary.total }, acceptance_summary: acceptanceSummary(task.acceptance) };
  if (includeDiagnostics) result.diagnostics = { task_id: task.task_id, task_path: taskPaths(state, task.task_id).taskPath, events_path: taskPaths(state, task.task_id).eventsPath, constraints: task.constraints, workflow: task.workflow, result_policy: task.result_policy, execution: task.execution };
  return result;
}

function tool(name: string, description: string, properties: JsonRecord, requiredFields: string[], readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean) {
  return { name, description, inputSchema: { type: 'object', properties, required: requiredFields, additionalProperties: false }, annotations: { title: name, readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false }, outputSchema: { type: 'object', additionalProperties: true } };
}
function intentSchema(): JsonRecord { return { type: 'object', properties: { objective: { type: 'string' }, instructions: { type: 'string' }, behavior: { type: 'string' }, mode: { type: 'string' } }, additionalProperties: false }; }
function constraintsSchema(): JsonRecord { return { type: 'object', properties: { authority: { type: 'string', enum: ['read', 'write', 'command'] }, cwd: { type: 'string' }, profile: { type: 'string' }, cognition: { type: 'string', enum: ['low', 'medium', 'high'] }, model: { type: 'string' }, sandbox: { type: 'string' }, runtime: { type: 'string' }, skip_git_repo_check: { type: 'boolean' }, resumable: { type: 'boolean' }, wait_for_completion: { type: 'boolean' }, exit_interview: { type: 'boolean' }, max_concurrency: { type: 'integer', minimum: 1 }, max_retries: { type: 'integer', minimum: 0 }, repair_policy: repairPolicySchema(), required_mcp_tools: { type: 'array', items: { type: 'string' } }, preflight_paths: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, access: { type: 'string', enum: ['read', 'write', 'create'] }, label: { type: 'string' } }, required: ['path', 'access'], additionalProperties: false } }, overrides: constraintOverridesSchema() }, additionalProperties: false }; }
function constraintOverridesSchema(): JsonRecord { return { type: 'object', properties: { runtime: { type: 'string' }, sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] }, model: { type: 'string' }, reasoning_effort: { type: 'string' }, config: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } }, skip_git_repo_check: { type: 'boolean' } }, additionalProperties: false }; }
function workflowSchema(): JsonRecord { return { type: 'object', properties: { strategy: { type: 'string', enum: ['implement', 'implement_review', 'research_synthesize', 'implement_review_repair_verify'] }, steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' }, profile: { type: 'string' }, instruction: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } }, if: { type: 'string' }, acceptance_scope: { type: 'array', items: { type: 'string' } }, constraints: constraintsSchema() }, required: ['id', 'kind'], additionalProperties: false } } }, additionalProperties: false }; }
function repairPolicySchema(): JsonRecord { return { type: 'object', properties: { strategy: { type: 'string', enum: ['retry_same_step', 'named_repair_step'] }, repair_step_id: { type: 'string' }, require_review_after_repair: { type: 'boolean' } }, additionalProperties: false }; }
function acceptanceSchema(): JsonRecord { return { type: 'object', properties: { required_files: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string' }, contains: { type: 'string' } }, required: ['path'], additionalProperties: false }] } }, required_tests: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { command: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['passed', 'pending', 'failed'] } }, additionalProperties: false }] } }, required_tools: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string', enum: ['passed', 'pending', 'failed'] } }, required: ['name'], additionalProperties: false }] } }, forbidden_patterns: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { pattern: { type: 'string' }, scope: { type: 'string' } }, required: ['pattern'], additionalProperties: false }] } }, review_questions: { type: 'array', items: { type: 'string' } }, review_quorum: { type: 'object', properties: { min_passed: { type: 'integer', minimum: 0 }, max_failed: { type: 'integer', minimum: 0 } }, additionalProperties: false }, residual_risk_policy: { type: 'string', enum: ['allow', 'none_allowed'] } }, additionalProperties: false }; }
function resultPolicySchema(): JsonRecord { return { type: 'object', properties: { include_diagnostics_by_default: { type: 'boolean' }, expose_worker_refs: { type: 'boolean' }, compact_completed_worker_refs: { type: 'boolean' }, max_events: { type: 'integer', minimum: 1, maximum: 1000 }, max_worker_refs: { type: 'integer', minimum: 1, maximum: 1000 }, max_result_items: { type: 'integer', minimum: 1, maximum: 5000 } }, additionalProperties: false }; }
function executionSchema(): JsonRecord { return { type: 'object', properties: { start: { type: 'boolean', default: true }, wait_for_completion: { type: 'boolean', default: false }, timeout_ms: { type: 'integer', minimum: 0, maximum: 600000, default: 0 }, poll_ms: { type: 'integer', minimum: 50, maximum: 30000, default: 500 }, resumable: { type: 'boolean', default: true }, exit_interview: { type: 'boolean', default: false }, max_concurrency: { type: 'integer', minimum: 1, maximum: 32, default: 10 }, max_retries: { type: 'integer', minimum: 0, maximum: 10, default: 0 } }, additionalProperties: false }; }

function runResult(task: Task, paths: ReturnType<typeof taskPaths>, created: boolean): JsonRecord { return { schema: 'narada.delegated_task.run.v1', status: created ? 'accepted_for_execution' : 'existing', task_id: task.task_id, task_status: task.status, created, task_path: paths.taskPath, events_path: paths.eventsPath, summary: task.summary, progress: rec(task.result).progress, worker_refs: rec(task.result).worker_refs ?? [] }; }
function handoff(): JsonRecord { return { schema: 'narada.delegated_task.handoff.v1', acceptance_verdict: 'pending', changed_files: [], verification: [], residual_risks: [], observed_incoherencies: [], worker_refs: [], worker_ref_count: 0, summary: null }; }
function normalizeIntent(args: JsonRecord): { objective: string; instructions: string | null; behavior: string | null; mode: string | null } { const intent = rec(args.intent); return { objective: required(intent.objective ?? args.objective, 'delegated_task_requires_objective'), instructions: opt(intent.instructions), behavior: opt(intent.behavior), mode: opt(intent.mode) }; }
function validateTaskShape(args: JsonRecord, state: State, dryRun: boolean): JsonRecord {
  const diagnostics: JsonRecord[] = [];
  let workflow: JsonRecord = {};
  try { workflow = normalizeWorkflow(args.workflow, state); } catch (error) { diagnostics.push({ severity: 'error', code: 'workflow_policy_violation', message: error instanceof Error ? error.message : String(error), details: rec(rec(error).details) }); }
  const steps = workflowSteps(workflow);
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) diagnostics.push({ severity: 'error', code: 'duplicate_step_id', step_id: step.id });
    ids.add(step.id);
    if (!state.allowedWorkflowKinds.includes(step.kind)) diagnostics.push({ severity: 'error', code: 'workflow_kind_not_allowed', step_id: step.id, kind: step.kind, allowed: state.allowedWorkflowKinds });
    if (state.allowedProfiles && step.profile && !state.allowedProfiles.includes(step.profile)) diagnostics.push({ severity: 'error', code: 'profile_not_allowed', step_id: step.id, profile: step.profile, allowed: state.allowedProfiles });
    for (const dependency of step.depends_on) {
      if (!steps.some((candidate) => candidate.id === dependency)) diagnostics.push({ severity: 'error', code: 'unknown_dependency', step_id: step.id, dependency });
    }
    const condition = validateCondition(step.if);
    if (condition.status === 'invalid') diagnostics.push({ severity: 'error', code: 'invalid_condition', step_id: step.id, condition: step.if, message: condition.message, allowed: condition.allowed });
  }
  const cycles = detectCycles(steps);
  for (const cycle of cycles) diagnostics.push({ severity: 'error', code: 'workflow_cycle', cycle });
  diagnostics.push(...unknownKeyDiagnostics(rec(args.constraints), ['authority', 'cwd', 'profile', 'cognition', 'model', 'sandbox', 'runtime', 'skip_git_repo_check', 'resumable', 'wait_for_completion', 'exit_interview', 'max_concurrency', 'max_retries', 'repair_policy', 'required_mcp_tools', 'preflight_paths', 'overrides'], 'constraints'));
  diagnostics.push(...unknownKeyDiagnostics(rec(rec(args.constraints).overrides), ['runtime', 'sandbox', 'model', 'reasoning_effort', 'config', 'skip_git_repo_check'], 'constraint_overrides'));
  diagnostics.push(...unknownKeyDiagnostics(rec(args.result_policy), ['include_diagnostics_by_default', 'expose_worker_refs', 'compact_completed_worker_refs', 'max_events', 'max_worker_refs', 'max_result_items'], 'result_policy'));
  const acceptanceDiagnostics = validateAcceptanceContract(rec(args.acceptance));
  diagnostics.push(...acceptanceDiagnostics);
  const repairPolicy = rec(rec(args.constraints).repair_policy ?? rec(args.execution).repair_policy);
  if (Object.keys(repairPolicy).length > 0) {
    const strategy = repairPolicy.strategy;
    if (strategy !== 'retry_same_step' && strategy !== 'named_repair_step') diagnostics.push({ severity: 'error', code: 'repair_policy_strategy_invalid', strategy });
    if (strategy === 'named_repair_step' && !ids.has(String(repairPolicy.repair_step_id ?? ''))) diagnostics.push({ severity: 'error', code: 'repair_policy_repair_step_missing', repair_step_id: repairPolicy.repair_step_id });
  }
  return { schema: 'narada.delegated_task.validate.v1', status: diagnostics.some((item) => item.severity === 'error') ? 'rejected' : 'ok', dry_run: dryRun, diagnostics, workflow_preview: { step_count: steps.length, steps: steps.map((step) => ({ id: step.id, kind: step.kind, depends_on: step.depends_on, if: step.if })) }, policy: { allowed_workflow_kinds: state.allowedWorkflowKinds, allowed_profiles: state.allowedProfiles, allowed_roots: state.allowedRoots } };
}
function expandWorkflowPreset(workflow: JsonRecord): JsonRecord {
  if (Array.isArray(workflow.steps)) return workflow;
  const strategy = opt(workflow.strategy);
  if (!strategy) return workflow;
  const objectiveInstruction = opt(workflow.instruction) ?? 'Complete the delegated task.';
  const presets: Record<string, JsonRecord[]> = {
    implement: [{ id: 'implement', kind: 'worker', instruction: objectiveInstruction }],
    implement_review: [
      { id: 'implement', kind: 'worker', instruction: objectiveInstruction },
      { id: 'review', kind: 'review', depends_on: ['implement'], instruction: 'Review the implementation against acceptance.' },
    ],
    research_synthesize: [
      { id: 'research', kind: 'research', instruction: 'Research the task and gather evidence.' },
      { id: 'synthesize', kind: 'worker', depends_on: ['research'], instruction: 'Synthesize research into the requested result.' },
      { id: 'review', kind: 'review', depends_on: ['synthesize'], instruction: 'Review the synthesis.' },
    ],
    implement_review_repair_verify: [
      { id: 'implement', kind: 'worker', instruction: objectiveInstruction },
      { id: 'review', kind: 'review', depends_on: ['implement'], instruction: 'Review the implementation against acceptance.' },
      { id: 'repair', kind: 'repair', depends_on: ['review'], if: 'review_failed', instruction: 'Repair findings from review.' },
      { id: 'verify', kind: 'verify', depends_on: ['implement'], instruction: 'Verify final acceptance evidence.' },
    ],
  };
  return { ...workflow, steps: presets[strategy] ?? [] };
}
function normalizeWorkflow(value: unknown, state: State): JsonRecord {
  const workflow = rec(value);
  const expanded = expandWorkflowPreset(workflow);
  const steps = Array.isArray(expanded.steps) ? expanded.steps.map((step) => normalizeStep(step, state)) : [normalizeStep({ id: 'primary', kind: 'worker' }, state)];
  return { ...expanded, steps };
}
function normalizeStep(value: unknown, state?: State): WorkflowStep {
  const step = rec(value);
  const kind = opt(step.kind) ?? 'worker';
  if (state && !state.allowedWorkflowKinds.includes(kind)) throw diag('delegated_task_workflow_kind_not_allowed', 'delegated_task_workflow_kind_not_allowed', { kind, allowed_workflow_kinds: state.allowedWorkflowKinds });
  const profile = opt(step.profile);
  if (state?.allowedProfiles && profile && !state.allowedProfiles.includes(profile)) throw diag('delegated_task_profile_not_allowed', 'delegated_task_profile_not_allowed', { profile, allowed_profiles: state.allowedProfiles });
  return { ...step, id: opt(step.id) ?? `step_${hash(JSON.stringify(step)).slice(0, 8)}`, kind, profile, instruction: opt(step.instruction), depends_on: Array.isArray(step.depends_on) ? step.depends_on.map(String).filter(Boolean) : [], if: opt(step.if), acceptance_scope: Array.isArray(step.acceptance_scope) ? step.acceptance_scope.map(String).filter(Boolean) : [], constraints: rec(step.constraints) };
}
function normalizeExecution(value: unknown): JsonRecord { const input = rec(value); const waitForCompletion = input.wait_for_completion === true; return { start: input.start !== false, wait_for_completion: waitForCompletion, timeout_ms: integer(input.timeout_ms, waitForCompletion ? 30000 : 0, 0, 600000), poll_ms: integer(input.poll_ms, 500, 50, 30000), resumable: input.resumable !== false, exit_interview: input.exit_interview === true, max_concurrency: integer(input.max_concurrency, 10, 1, 32), max_retries: integer(input.max_retries, 0, 0, 10) }; }
function normalizeResultPolicy(value: unknown): JsonRecord { const input = rec(value); return { include_diagnostics_by_default: input.include_diagnostics_by_default === true, expose_worker_refs: input.expose_worker_refs !== false, compact_completed_worker_refs: input.compact_completed_worker_refs === true, max_events: integer(input.max_events, 100, 1, 1000), max_worker_refs: integer(input.max_worker_refs, 50, 1, 1000), max_result_items: integer(input.max_result_items, 200, 1, 5000) }; }
function initialStepStates(workflow: JsonRecord): Record<string, StepState> { return Object.fromEntries(workflowSteps(workflow).map((step) => [step.id, initialStepState(step)])); }
function initialStepState(step: WorkflowStep): StepState { return { step_id: step.id, kind: step.kind, status: 'pending', attempts: 0, run_ids: [], current_run_id: null, worker_session_id: null, started_at: null, finished_at: null, blocked_by: [], error: null, summary: null }; }
function workflowSteps(workflow: JsonRecord): WorkflowStep[] { return Array.isArray(workflow.steps) ? workflow.steps.map((step) => normalizeStep(step)) : []; }
function stepStateMap(task: Task): Record<string, StepState> { return { ...initialStepStates(task.workflow), ...rec(rec(task.result).step_states) as Record<string, StepState> }; }
function executionPolicy(task: Task): { max_concurrency: number; max_retries: number } { return { max_concurrency: integer(task.constraints.max_concurrency ?? task.execution.max_concurrency, 10, 1, 32), max_retries: integer(task.constraints.max_retries ?? task.execution.max_retries, 0, 0, 10) }; }
function dependencyStatus(step: WorkflowStep, states: Record<string, StepState>): { ready: boolean; blocked: string[] } {
  const unknown = step.depends_on.filter((id) => !states[id]);
  const missing = step.depends_on.filter((id) => states[id]?.status === 'pending' || states[id]?.status === 'running');
  const blocked = [...unknown, ...step.depends_on.filter((id) => states[id]?.status === 'failed' || states[id]?.status === 'blocked')];
  return { ready: missing.length === 0 && blocked.length === 0, blocked };
}
function evaluateCondition(condition: string | null, task: Task, states: Record<string, StepState>): { pass: boolean; reason: string } {
  if (!condition) return { pass: true, reason: 'no_condition' };
  const trimmed = condition.trim();
  if (trimmed === 'always') return { pass: true, reason: 'always' };
  if (trimmed === 'on_failure') return { pass: Object.values(states).some((state) => state.status === 'failed' || state.status === 'blocked'), reason: 'on_failure' };
  if (trimmed === 'on_success') return { pass: Object.values(states).every((state) => state.status !== 'failed' && state.status !== 'blocked'), reason: 'on_success' };
  if (trimmed === 'review_failed') return { pass: reviewSignals(task).failed > 0, reason: 'review_failed' };
  if (trimmed === 'no_residual_risks') return { pass: stringList(rec(task.result).residual_risks).length === 0, reason: 'no_residual_risks' };
  if (trimmed.startsWith('acceptance:')) {
    const verdict = rec(task.result).acceptance_verdict;
    const expected = trimmed.slice('acceptance:'.length);
    return { pass: verdict === expected, reason: `acceptance:${verdict ?? 'unknown'}` };
  }
  if (trimmed.startsWith('step:')) {
    const [, stepId, expected] = trimmed.split(':');
    return { pass: states[stepId]?.status === expected, reason: `step:${stepId}:${states[stepId]?.status ?? 'missing'}` };
  }
  if (trimmed.startsWith('kind:')) {
    const [, kind, expected] = trimmed.split(':');
    const matching = Object.values(states).filter((state) => state.kind === kind);
    return { pass: matching.length > 0 && matching.every((state) => state.status === expected), reason: `kind:${kind}:${expected}` };
  }
  if (trimmed.startsWith('result_has:')) {
    const needle = trimmed.slice('result_has:'.length);
    return { pass: JSON.stringify(task.result).includes(needle), reason: `result_has:${needle}` };
  }
  const call = parseConditionCall(trimmed);
  if (call?.name === 'all') {
    const results = call.args.map((arg) => evaluateCondition(arg, task, states));
    return { pass: results.every((result) => result.pass), reason: `all:${results.map((result) => result.reason).join('|')}` };
  }
  if (call?.name === 'any') {
    const results = call.args.map((arg) => evaluateCondition(arg, task, states));
    return { pass: results.some((result) => result.pass), reason: `any:${results.map((result) => result.reason).join('|')}` };
  }
  if (call?.name === 'not' && call.args.length === 1) {
    const result = evaluateCondition(call.args[0], task, states);
    return { pass: !result.pass, reason: `not:${result.reason}` };
  }
  return { pass: false, reason: `unsupported_condition:${condition}` };
}
function markStep(stepState: StepState, status: StepStatus, summary: string | null): void { stepState.status = status; stepState.finished_at = now(); stepState.summary = summary; stepState.error = status === 'failed' || status === 'blocked' ? summary : stepState.error; }
function parseConditionCall(condition: string): { name: string; args: string[] } | null {
  const match = /^([a-z_]+)\((.*)\)$/.exec(condition);
  if (!match) return null;
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of match[2]) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      if (current.trim()) args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) args.push(current.trim());
  return { name: match[1], args };
}
function validateCondition(condition: string | null): { status: 'ok' | 'invalid'; message?: string; allowed?: string[] } {
  const allowed = ['always', 'on_success', 'on_failure', 'review_failed', 'acceptance:<verdict>', 'step:<step_id>:<status>', 'kind:<kind>:<status>', 'result_has:<text>', 'no_residual_risks', 'all(<expr>,<expr>)', 'any(<expr>,<expr>)', 'not(<expr>)'];
  if (!condition) return { status: 'ok' };
  const trimmed = condition.trim();
  if (['always', 'on_success', 'on_failure', 'review_failed', 'no_residual_risks'].includes(trimmed)) return { status: 'ok' };
  if (/^acceptance:[a-z_]+$/.test(trimmed)) return { status: 'ok' };
  if (/^step:[^:]+:(pending|running|completed|failed|skipped|blocked|noted)$/.test(trimmed)) return { status: 'ok' };
  if (/^kind:[^:]+:(pending|running|completed|failed|skipped|blocked|noted)$/.test(trimmed)) return { status: 'ok' };
  if (/^result_has:.+$/.test(trimmed)) return { status: 'ok' };
  const call = parseConditionCall(trimmed);
  if (call) {
    if (!['all', 'any', 'not'].includes(call.name)) return { status: 'invalid', message: `unknown condition function: ${call.name}`, allowed };
    if ((call.name === 'all' || call.name === 'any') && call.args.length < 2) return { status: 'invalid', message: `${call.name} requires at least two arguments`, allowed };
    if (call.name === 'not' && call.args.length !== 1) return { status: 'invalid', message: 'not requires exactly one argument', allowed };
    const invalid = call.args.map(validateCondition).find((result) => result.status === 'invalid');
    return invalid ?? { status: 'ok' };
  }
  if (/^[a-z_]+\(/.test(trimmed)) return { status: 'invalid', message: 'malformed condition call or unbalanced parentheses', allowed };
  return { status: 'invalid', message: `unsupported condition: ${condition}`, allowed };
}
function detectCycles(steps: WorkflowStep[]): string[][] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (visiting.has(id)) {
      const index = stack.indexOf(id);
      cycles.push(index >= 0 ? stack.slice(index).concat(id) : [id, id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) if (byId.has(dependency)) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
  return cycles;
}
function validateAcceptanceContract(acceptance: JsonRecord): JsonRecord[] {
  const diagnostics: JsonRecord[] = [];
  diagnostics.push(...unknownKeyDiagnostics(acceptance, ['required_files', 'required_tests', 'required_tools', 'forbidden_patterns', 'review_questions', 'review_quorum', 'residual_risk_policy'], 'acceptance'));
  for (const item of acceptanceItems(acceptance.required_files)) {
    if (!String(item.path ?? item.target ?? item.value ?? '').trim()) diagnostics.push({ severity: 'error', code: 'acceptance_required_file_missing_path', item });
  }
  for (const item of acceptanceItems(acceptance.required_tests)) {
    if (!String(item.command ?? item.target ?? item.value ?? '').trim()) diagnostics.push({ severity: 'error', code: 'acceptance_required_test_missing_command', item });
  }
  for (const item of acceptanceItems(acceptance.required_tools)) {
    if (!String(item.name ?? item.target ?? item.value ?? '').trim()) diagnostics.push({ severity: 'error', code: 'acceptance_required_tool_missing_name', item });
  }
  const residualPolicy = acceptance.residual_risk_policy;
  if (residualPolicy !== undefined && residualPolicy !== 'allow' && residualPolicy !== 'none_allowed') diagnostics.push({ severity: 'error', code: 'acceptance_residual_risk_policy_invalid', residual_risk_policy: residualPolicy });
  const quorum = rec(acceptance.review_quorum);
  if (Object.keys(quorum).length > 0) {
    if (integer(quorum.min_passed, 0, 0, 1000) !== Number(quorum.min_passed ?? 0)) diagnostics.push({ severity: 'error', code: 'acceptance_review_quorum_min_passed_invalid', value: quorum.min_passed });
    if (integer(quorum.max_failed, 0, 0, 1000) !== Number(quorum.max_failed ?? 0)) diagnostics.push({ severity: 'error', code: 'acceptance_review_quorum_max_failed_invalid', value: quorum.max_failed });
  }
  return diagnostics;
}
function unknownKeyDiagnostics(value: JsonRecord, allowed: string[], scope: string): JsonRecord[] {
  if (Object.keys(value).length === 0) return [];
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).map((key) => ({ severity: 'error', code: `${scope}_unknown_key`, scope, key, allowed }));
}
function runningCount(states: Record<string, StepState>): number { return Object.values(states).filter((state) => state.status === 'running').length; }
function workerRefs(task: Task): JsonRecord[] { return records(rec(task.result).worker_refs); }
function upsertWorkerRef(task: Task, workerRef: JsonRecord, output: JsonRecord): void {
  const refs = workerRefs(task);
  const index = refs.findIndex((ref) => ref.run_id === workerRef.run_id && ref.step_id === workerRef.step_id);
  const next = { ...workerRef, output: summarizeWorkerOutput(output) };
  if (index >= 0) refs[index] = { ...refs[index], ...next }; else refs.push(next);
  task.result = { ...rec(task.result), worker_refs: refs, worker_ref_count: refs.length };
}
function summarizeWorkerRef(step: WorkflowStep, result: JsonRecord): JsonRecord { return { step_id: step.id, step_kind: step.kind, run_id: result.run_id, worker_session_id: result.worker_session_id ?? null, status: String(result.status ?? 'unknown'), confidence: result.confidence ?? null, summary: result.summary ?? '', run_dir: result.run_dir, result_ref: result.result_ref ?? null }; }
function summarizeWorkerOutput(output: JsonRecord): JsonRecord { return { summary: output.summary ?? '', deliverables: output.deliverables ?? [], changes: output.changes ?? [], changed_files: output.changed_files ?? [], nested_workflows: nestedWorkflowRecords(output), verification_results: output.verification_results ?? output.verification ?? [], residual_risks: output.residual_risks ?? [], observed_incoherencies: output.observed_incoherencies ?? [], review_verdict: output.review_verdict ?? null, acceptance_verdict: output.acceptance_verdict ?? null, verdict: output.verdict ?? null, error: output.error ?? null }; }
function nestedWorkflowRecords(output: JsonRecord): JsonRecord[] { return uniqueRecords([...recordList(output.nested_workflows), ...recordList(output.nested_workflow), ...recordList(output.nested_tasks), ...recordList(output.nested_task_results)]); }
function buildWorkerArgs(task: Task, step: WorkflowStep, state: State): JsonRecord {
  const constraints = { ...task.constraints, ...step.constraints };
  const cwd = opt(constraints.cwd) ?? state.allowedRoots[0];
  return { intent: { instruction: workerInstruction(task, step), mode: step.kind === 'review' || step.kind === 'verify' ? 'audit_only' : step.kind === 'research' ? 'audit_only' : undefined }, constraints: { ...constraints, cwd, resumable: task.execution.resumable !== false, exit_interview: task.execution.exit_interview === true } };
}
function workerInstruction(task: Task, step: WorkflowStep): string { return [`Delegated task objective: ${task.objective}`, step.instruction ? `Step instruction: ${step.instruction}` : null, `Step id: ${step.id}`, `Step kind: ${step.kind}`, `Acceptance: ${JSON.stringify(task.acceptance)}`, 'Return a concise result with changes, verification, residual risks, and observed incoherencies.'].filter((line): line is string => Boolean(line)).join('\n'); }
function progressSummary(task: Task, states = stepStateMap(task)): JsonRecord { return { total: Object.keys(states).length, ...stepStatusCounts(task, states), running_run_ids: Object.values(states).filter((step) => step.status === 'running').map((step) => step.current_run_id).filter(Boolean) }; }
function activeStepIds(task: Task): string[] { return Object.entries(stepStateMap(task)).filter(([, step]) => step.status === 'running').map(([stepId]) => stepId); }
function stepStatusCounts(task: Task, states?: Record<string, StepState>): JsonRecord { const counts: Record<string, number> = {}; for (const step of Object.values(states ?? stepStateMap(task))) counts[step.status] = (counts[step.status] ?? 0) + 1; return counts; }
function summaryForTask(task: Task, states: Record<string, StepState>, acceptance: { verdict: string }): string { const progress = progressSummary(task, states); return `delegated task ${task.status}; steps=${progress.total}; acceptance=${acceptance.verdict}`; }
function stepCounts(workflow: JsonRecord): JsonRecord { const by_kind: Record<string, number> = {}; const steps = workflowSteps(workflow); for (const step of steps) by_kind[step.kind] = (by_kind[step.kind] ?? 0) + 1; return { total: steps.length, by_kind }; }
function acceptanceSummary(acceptance: JsonRecord): JsonRecord { return { required_files: count(acceptance.required_files), required_tests: count(acceptance.required_tests), required_tools: count(acceptance.required_tools), forbidden_patterns: count(acceptance.forbidden_patterns) }; }
function count(value: unknown): number { return Array.isArray(value) ? value.length : 0; }
function acceptanceItems(value: unknown): JsonRecord[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => typeof item === 'string' ? { value: item } : rec(item)).filter((item) => Object.keys(item).length > 0);
}
function reviewSignals(task: Task): { passed: number; failed: number; running: number } {
  return reviewSignalsFromResult(task.result);
}
function reviewSignalsFromResult(result: JsonRecord, options: { resolveAfterRepair?: boolean } = {}): { passed: number; failed: number; running: number } {
  const allRefs = records(result.worker_refs);
  let latestCompletedRepair = -1;
  if (options.resolveAfterRepair) {
    for (let index = allRefs.length - 1; index >= 0; index -= 1) {
      const ref = allRefs[index];
      if (ref.step_kind === 'repair' && ref.status === 'completed') {
        latestCompletedRepair = index;
        break;
      }
    }
  }
  const refs = allRefs.slice(latestCompletedRepair + 1).filter((ref) => ref.step_kind === 'review');
  let passed = 0;
  let failed = 0;
  let running = 0;
  for (const ref of refs) {
    if (ref.status === 'running') running += 1;
    else if (ref.status === 'completed' && reviewRefHasExplicitPass(ref)) passed += 1;
    else if (ref.status === 'completed' && reviewRefHasExplicitFailure(ref)) failed += 1;
    else if (ref.status === 'completed') running += 1;
    else failed += 1;
  }
  return { passed, failed, running };
}
function reviewRefHasExplicitPass(ref: JsonRecord): boolean {
  const output = rec(ref.output);
  const verdicts = [
    ref.review_verdict,
    ref.acceptance_verdict,
    ref.verdict,
    output.review_verdict,
    output.acceptance_verdict,
    output.verdict,
  ].map((value) => String(value ?? '').toLowerCase());
  return verdicts.some((value) => value === 'passed' || value === 'accepted' || value === 'accept_with_notes' || value === 'accepted_with_notes');
}
function reviewRefHasExplicitFailure(ref: JsonRecord): boolean {
  const output = rec(ref.output);
  const verdicts = [
    ref.review_verdict,
    ref.acceptance_verdict,
    ref.verdict,
    output.review_verdict,
    output.acceptance_verdict,
    output.verdict,
  ].map((value) => String(value ?? '').toLowerCase());
  if (verdicts.some((value) => value === 'failed' || value === 'contradicted' || value === 'rejected')) return true;
  const summary = String(ref.summary ?? output.summary ?? '').toLowerCase();
  if (/\b(verdict\s*:\s*)?(rejected|failed)\b/.test(summary)) return true;
  return records(output.changes).some((change) => /^(failed_review|rejected|failed)$/.test(String(change.status ?? '').toLowerCase()));
}
function classifyChangedFileRefs(task: Task, paths: string[]): JsonRecord[] {
  const cwd = opt(task.constraints.cwd) ?? process.cwd();
  return paths.map((path) => {
    const kind = isRealFileRef(cwd, path) ? 'real_file' : 'affected_ref';
    return { path, kind };
  });
}
function isRealFileRef(cwd: string, path: string): boolean {
  const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  return (target === cwd || inside(target, cwd)) && existsSync(target) && statSync(target).isFile();
}
function terminalSummary(result: JsonRecord): JsonRecord {
  const review = reviewSignalsFromResult(result, { resolveAfterRepair: true });
  const reviewQuorum = records(result.acceptance_evidence).find((check) => check.kind === 'review_quorum');
  const nextAction = review.failed > 0 ? 'repair_failed_review'
    : review.running > 0 || reviewQuorum?.status === 'pending' ? 'await_review_resolution'
      : result.acceptance_verdict === 'passed' ? 'ready_for_closeout'
        : result.acceptance_verdict === 'failed' ? 'repair_or_replan'
          : 'continue_or_verify';
  return {
    acceptance_verdict: result.acceptance_verdict ?? 'pending',
    task_summary: result.summary ?? '',
    review_passed_count: review.passed,
    review_failed_count: review.failed,
    review_pending_count: review.running,
    next_action: nextAction,
    real_changed_files_count: stringList(result.real_changed_files).length,
    affected_refs_count: stringList(result.affected_refs).length,
    verification_count: records(result.verification).length,
    residual_risk_count: stringList(result.residual_risks).length,
    observed_incoherency_count: stringList(result.observed_incoherencies).length,
  };
}
function resultForPolicy(result: JsonRecord, resultPolicy: JsonRecord, includeDiagnostics: boolean, state: State): JsonRecord {
  const maxWorkerRefs = integer(resultPolicy.max_worker_refs, state.resultCompaction.maxWorkerRefs, 1, 1000);
  const maxItems = integer(resultPolicy.max_result_items, state.resultCompaction.maxListItems, 1, 5000);
  const refs = workerRefs({ result } as Task);
  const fullSections = {
    worker_refs: refs,
    changed_files: stringList(result.changed_files),
    changed_file_refs: records(result.changed_file_refs),
    real_changed_files: stringList(result.real_changed_files),
    affected_refs: stringList(result.affected_refs),
    parent_changed_files: stringList(result.parent_changed_files),
    worker_reported_changed_files: stringList(result.worker_reported_changed_files),
    observed_files: stringList(result.observed_files),
    nested_workflows: records(result.nested_workflows),
    nested_workflow_changed_files: stringList(result.nested_workflow_changed_files),
    nested_workflow_verification: records(result.nested_workflow_verification),
    verification: records(result.verification),
    residual_risks: stringList(result.residual_risks),
    observed_incoherencies: stringList(result.observed_incoherencies),
  };
  const compacted: JsonRecord = {
    ...result,
    terminal_summary: terminalSummary(result),
    worker_refs: fullSections.worker_refs.slice(0, maxWorkerRefs),
    worker_ref_count: refs.length,
    worker_refs_truncated: refs.length > maxWorkerRefs,
    changed_files: fullSections.changed_files.slice(0, maxItems),
    changed_files_count: fullSections.changed_files.length,
    changed_file_refs: fullSections.changed_file_refs.slice(0, maxItems),
    changed_file_refs_count: fullSections.changed_file_refs.length,
    real_changed_files: fullSections.real_changed_files.slice(0, maxItems),
    real_changed_files_count: fullSections.real_changed_files.length,
    affected_refs: fullSections.affected_refs.slice(0, maxItems),
    affected_refs_count: fullSections.affected_refs.length,
    parent_changed_files: fullSections.parent_changed_files.slice(0, maxItems),
    parent_changed_files_count: fullSections.parent_changed_files.length,
    worker_reported_changed_files: fullSections.worker_reported_changed_files.slice(0, maxItems),
    worker_reported_changed_files_count: fullSections.worker_reported_changed_files.length,
    observed_files: fullSections.observed_files.slice(0, maxItems),
    observed_files_count: fullSections.observed_files.length,
    nested_workflows: fullSections.nested_workflows.slice(0, maxItems),
    nested_workflow_count: fullSections.nested_workflows.length,
    nested_workflow_changed_files: fullSections.nested_workflow_changed_files.slice(0, maxItems),
    nested_workflow_changed_files_count: fullSections.nested_workflow_changed_files.length,
    nested_workflow_verification: fullSections.nested_workflow_verification.slice(0, maxItems),
    nested_workflow_verification_count: fullSections.nested_workflow_verification.length,
    verification: fullSections.verification.slice(0, maxItems),
    verification_count: fullSections.verification.length,
    residual_risks: fullSections.residual_risks.slice(0, maxItems),
    residual_risk_count: fullSections.residual_risks.length,
    observed_incoherencies: fullSections.observed_incoherencies.slice(0, maxItems),
    observed_incoherency_count: fullSections.observed_incoherencies.length,
  };
  const truncated = refs.length > maxWorkerRefs || fullSections.changed_files.length > maxItems || fullSections.changed_file_refs.length > maxItems || fullSections.real_changed_files.length > maxItems || fullSections.affected_refs.length > maxItems || fullSections.parent_changed_files.length > maxItems || fullSections.worker_reported_changed_files.length > maxItems || fullSections.observed_files.length > maxItems || fullSections.nested_workflows.length > maxItems || fullSections.nested_workflow_changed_files.length > maxItems || fullSections.nested_workflow_verification.length > maxItems || fullSections.verification.length > maxItems || fullSections.residual_risks.length > maxItems || fullSections.observed_incoherencies.length > maxItems;
  if (truncated) compacted.output_refs = materializeOutputSections(state, fullSections);
  if (resultPolicy.compact_completed_worker_refs === true && !includeDiagnostics) {
    compacted.worker_refs = records(compacted.worker_refs).map((ref) => ({ step_id: ref.step_id, step_kind: ref.step_kind, run_id: ref.run_id, status: ref.status, summary: ref.summary }));
  }
  if (resultPolicy.expose_worker_refs !== false || includeDiagnostics) return compacted;
  const { worker_refs: _workerRefs, ...rest } = compacted;
  return { ...rest, worker_refs_redacted: true };
}
function workerToolOption(value: unknown): WorkerTool { if (typeof value === 'function') return value as WorkerTool; return async (name, args, state) => rec(await callWorkerTool(name, args, state)); }
function materializeOutputSections(state: State, sections: Record<string, unknown>): JsonRecord[] {
  mkdirSync(state.outputRoot, { recursive: true });
  return Object.entries(sections).filter(([, value]) => Array.isArray(value) && value.length > 0).map(([name, value]) => {
    const body = JSON.stringify({ schema: 'narada.delegated_task.output_section.v1', name, value }, null, 2);
    const id = `delegated_task_output_${hash(`${name}:${body}`).slice(0, 16)}`;
    const path = resolve(state.outputRoot, `${id}.json`);
    writeFileSync(path, `${body}\n`, 'utf8');
    return { name, output_ref: id, path, count: Array.isArray(value) ? value.length : 0 };
  });
}
function annotateCancelledWorkerRefs(result: JsonRecord): JsonRecord {
  const refs = records(result.worker_refs).map((ref) => ref.status === 'running' ? { ...ref, cancellation: { requested: true, reason: 'parent_task_cancelled' } } : ref);
  return { ...result, worker_refs: refs, worker_ref_count: refs.length };
}
function taskPaths(state: State, id: string) { safeId(id); const taskDir = resolve(state.taskRoot, 'tasks', id); return { taskDir, taskPath: resolve(taskDir, 'task.json'), eventsPath: resolve(taskDir, 'events.jsonl') }; }
function readTask(state: State, id: string): Task { const paths = taskPaths(state, id); if (!existsSync(paths.taskPath)) throw diag('delegated_task_not_found', `delegated_task_not_found:${id}`, { task_id: id }); return JSON.parse(readFileSync(paths.taskPath, 'utf8')) as Task; }
function writeTask(state: State, task: Task): void { const paths = taskPaths(state, task.task_id); mkdirSync(dirname(paths.taskPath), { recursive: true }); writeFileSync(paths.taskPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8'); }
function appendEvent(state: State, id: string, event_kind: string, details: JsonRecord): JsonRecord { const paths = taskPaths(state, id); mkdirSync(dirname(paths.eventsPath), { recursive: true }); const event = { schema: 'narada.delegated_task.event.v1', event_id: `evt_${stamp()}_${randomUUID().slice(0, 8)}`, task_id: id, event_kind, recorded_at: now(), details }; appendFileSync(paths.eventsPath, `${JSON.stringify(event)}\n`, 'utf8'); return event; }
function readEvents(state: State, id: string): JsonRecord[] { const path = taskPaths(state, id).eventsPath; return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as JsonRecord) : []; }
function eventCountsByKind(events: JsonRecord[]): Record<string, number> { const counts: Record<string, number> = {}; for (const event of events) { const kind = String(event.event_kind ?? 'unknown'); counts[kind] = (counts[kind] ?? 0) + 1; } return counts; }
function eventSummaryByStep(events: JsonRecord[]): Record<string, JsonRecord> {
  const summary: Record<string, JsonRecord> = {};
  for (const event of events) {
    const details = rec(event.details);
    const stepId = opt(details.step_id);
    if (!stepId) continue;
    const current = rec(summary[stepId]);
    const eventKind = String(event.event_kind ?? 'unknown');
    const counts = rec(current.event_counts_by_kind);
    counts[eventKind] = Number(counts[eventKind] ?? 0) + 1;
    summary[stepId] = { step_id: stepId, event_count: Number(current.event_count ?? 0) + 1, event_counts_by_kind: counts, last_event: compactEvent(event) };
  }
  return summary;
}
function lastMeaningfulEventByActiveStep(task: Task, events: JsonRecord[]): Record<string, JsonRecord> {
  const latestByStep: Record<string, JsonRecord> = {};
  for (const event of events) {
    const details = rec(event.details);
    const stepId = opt(details.step_id);
    if (stepId) latestByStep[stepId] = compactEvent(event);
  }
  const active: Record<string, JsonRecord> = {};
  for (const [stepId, state] of Object.entries(rec(task.result.step_states))) {
    if (rec(state).status === 'running' && latestByStep[stepId]) active[stepId] = latestByStep[stepId];
  }
  return active;
}
function compactEvent(event: JsonRecord): JsonRecord { return { event_id: event.event_id, event_kind: event.event_kind, recorded_at: event.recorded_at, details: event.details }; }
function taskId(args: JsonRecord): string { return required(args.task_id, 'delegated_task_requires_task_id'); }
function required(value: unknown, code: string): string { const text = String(value ?? '').trim(); if (!text) throw diag(code); return text; }
function opt(value: unknown): string | null { const text = String(value ?? '').trim(); return text || null; }
function integer(value: unknown, fallback: number, min: number, max: number): number { const parsed = Number(value ?? fallback); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback; }
function safeId(id: string): void { if (!/^task_[a-zA-Z0-9_-]+$/.test(id)) throw diag('delegated_task_id_invalid', `delegated_task_id_invalid:${id}`, { task_id: id }); }
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function stamp(): string { return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15); }
function now(): string { return new Date().toISOString(); }
function normalizeRoots(roots: string[]): string[] { const seen = new Set<string>(); const out: string[] = []; for (const root of roots) { const r = resolve(root); const key = r.toLowerCase(); if (!seen.has(key)) { seen.add(key); out.push(r); } } return out; }
function optionList(value: unknown): string[] { if (value === undefined || value === null || value === true) return []; return Array.isArray(value) ? value.map(String).filter(Boolean) : [String(value)].filter(Boolean); }
function stringList(value: unknown, fallback: string[] = []): string[] { if (value === undefined || value === null) return fallback; return Array.isArray(value) ? value.map(String).filter(Boolean) : [String(value)].filter(Boolean); }
function records(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.map(rec).filter((record) => Object.keys(record).length > 0) : []; }
function recordList(value: unknown): JsonRecord[] { return Array.isArray(value) ? records(value) : Object.keys(rec(value)).length > 0 ? [rec(value)] : []; }
function uniqueStrings(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function uniqueRecords(values: JsonRecord[]): JsonRecord[] { const seen = new Set<string>(); const out: JsonRecord[] = []; for (const value of values) { const key = JSON.stringify(value); if (!seen.has(key)) { seen.add(key); out.push(value); } } return out; }
function inside(path: string, root: string): boolean { const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); }
function loadSiteExtraAllowedRoots(siteRoot: string): string[] { try { const configPath = join(siteRoot, '.narada', 'allowed-roots.json'); if (!existsSync(configPath)) return []; const data = JSON.parse(readFileSync(configPath, 'utf8')); if (Array.isArray(data.extra_allowed_roots)) return data.extra_allowed_roots.filter((r: unknown) => typeof r === 'string' && r.trim().length > 0); } catch { } return []; }
function loadSiteSecrets(siteRoot: string, targetEnv: NodeJS.ProcessEnv): void { try { const configPath = join(siteRoot, '.narada', 'secrets.json'); if (!existsSync(configPath)) return; const data = JSON.parse(readFileSync(configPath, 'utf8')); const env = data.env; if (env && typeof env === 'object' && !Array.isArray(env)) { for (const [key, value] of Object.entries(env)) { if (typeof value === 'string' && value.trim() && !targetEnv[key]) { targetEnv[key] = value; } } } } catch { } }
function rec(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function diag(code: string, message = code, details: JsonRecord = {}) { const error = new Error(message); Object.assign(error, { codeName: code, details }); return error; }
function errorData(error: unknown): JsonRecord { const record = rec(error); return { schema: 'narada.delegated_task.error.v1', code: String(record.codeName ?? 'delegated_task_error'), message: error instanceof Error ? error.message : String(error), details: rec(record.details) }; }
function render(result: JsonRecord): string { return [`delegated_task: ${result.status ?? result.task_status ?? 'ok'}`, `task_id: ${result.task_id ?? ''}`, `task_status: ${result.task_status ?? ''}`, `objective: ${result.objective ?? ''}`].filter((line) => !line.endsWith(': ')).join('\n'); }
function drainJsonLines(buffer: string) { const lines = buffer.split(/\r?\n/); return { framed: false, remaining: lines.pop() ?? '', requests: lines.filter((line) => line.trim()).map((line) => rec(JSON.parse(line))) }; }
function drainJsonRpcFrames(buffer: string) { const requests: JsonRecord[] = []; let remaining = buffer; while (true) { const headerEnd = remaining.indexOf('\r\n\r\n'); if (headerEnd < 0) break; const match = /Content-Length:\s*(\d+)/i.exec(remaining.slice(0, headerEnd)); if (!match) break; const start = headerEnd + 4; const end = start + Number(match[1]); if (remaining.length < end) break; requests.push(rec(JSON.parse(remaining.slice(start, end)))); remaining = remaining.slice(end); } return { framed: true, remaining, requests }; }
function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) { const body = JSON.stringify(response); if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`); else process.stdout.write(`${body}\n`); }
function parseArgs(argv: string[]) { const options: JsonRecord = {}; const allowedRoots: string[] = []; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === '--task-root') options.taskRoot = argv[++i]; else if (arg === '--output-root') options.outputRoot = argv[++i]; else if (arg === '--allowed-root') allowedRoots.push(argv[++i]); else throw new Error(`unknown_argument:${arg}`); } if (allowedRoots.length) options.allowedRoots = allowedRoots; return options; }
function sleep(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

export async function runStdioServer(options: JsonRecord = {}): Promise<void> { const state = createServerState(options); let buffer = ''; let framed = false; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) { buffer += chunk; const drained = /^Content-Length:/i.test(buffer) ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer); framed ||= drained.framed; buffer = drained.remaining; for (const request of drained.requests) { const response = await handleRequest(request, state); if (response) writeJsonRpcResponse(response, { framed }); } } }
export { parseArgs };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
