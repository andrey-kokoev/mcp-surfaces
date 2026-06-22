#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
const WRITE_CAPABLE_WORKER_KINDS = new Set(['worker', 'repair']);
const CONDITION_LANGUAGE = [
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
];

type JsonRecord = Record<string, unknown>;
type WorkerTool = (name: string, args: JsonRecord, state: WorkerMcpState) => Promise<JsonRecord>;
type TaskStatus = 'accepted_for_execution' | 'running' | 'completed' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked' | 'noted';
type State = {
  taskRoot: string;
  siteRoot: string;
  currentSiteId: string | null;
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
  owner_site_id?: string | null;
  owner_site_root?: string | null;
  created_by_site_id?: string | null;
  visibility_scope?: string;
  task_root_scope?: string;
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
  milestone_id: string | null;
  depends_on: string[];
  imports: string[];
  if: string | null;
  acceptance_scope: string[];
  write_set: string[];
  constraints: JsonRecord;
  authority_gate: JsonRecord;
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
  active_posture?: JsonRecord | null;
};
type AdvanceOptions = { waitUntilTerminal?: boolean; timeoutMs?: number; pollMs?: number };

export function createServerState(options: JsonRecord = {}): State {
  const taskRoot = resolve(String(options.taskRoot ?? options.outputRoot ?? process.cwd()));
  const siteRoot = resolve(String(options.siteRoot ?? taskRoot));
  const stateEnv = { ...process.env };
  loadSiteSecrets(siteRoot, stateEnv);
  loadProviderCredentialSecrets(siteRoot, stateEnv, options);
  const currentSiteId = resolveCurrentSiteId(options, siteRoot, stateEnv);
  const siteExtraRoots = loadSiteExtraAllowedRoots(siteRoot);
  const roots = normalizeRoots([...siteExtraRoots, ...optionList(options.allowedRoot), ...optionList(options.allowedRoots)]);
  const allowedRoots = roots.length ? roots : [taskRoot];
  if (!allowedRoots.some((root) => taskRoot === root || inside(taskRoot, root))) {
    throw diag('delegated_task_root_outside_allowed_roots', 'delegated_task_root_outside_allowed_roots', { task_root: taskRoot, allowed_roots: allowedRoots });
  }
  const workerPolicyOptions = rec(options.workerPolicy);
  const workerState: WorkerMcpState = {
    policy: createWorkerPolicy({ runRoot: resolve(taskRoot, '.narada', 'runtime', 'worker-delegation'), ...workerPolicyOptions, allowedRoots }),
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
  return { taskRoot, siteRoot, currentSiteId, allowedRoots, allowedWorkflowKinds, allowedProfiles: profiles.length ? profiles : null, resultCompaction, outputRoot: resolve(taskRoot, 'outputs'), workerState, workerTool: workerToolOption(options.workerTool) };
}

export function listTools() {
  return [
    tool('delegated_task_policy_inspect', 'Inspect delegated task orchestration policy and defaults.', {}, [], true, false, true),
    tool('delegated_task_template_catalog', 'List built-in delegated workflow templates, milestones, and worker delegation contracts.', { template_id: { type: 'string' } }, [], true, false, true),
    tool('delegated_task_validate', 'Validate delegated task input without creating or running a task.', { objective: { type: 'string' }, intent: intentSchema(), constraints: constraintsSchema(), workflow: workflowSchema(), acceptance: acceptanceSchema(), result_policy: resultPolicySchema(), execution: executionSchema() }, [], true, false, true),
    tool('delegated_task_run', 'Create and optionally start a durable delegated workflow task.', { objective: { type: 'string' }, intent: intentSchema(), constraints: constraintsSchema(), workflow: workflowSchema(), acceptance: acceptanceSchema(), result_policy: resultPolicySchema(), execution: executionSchema(), idempotency_key: { type: 'string' } }, [], false, false, false),
    tool('delegated_task_status', 'Return compact delegated task status. Set refresh=true to refresh running workers and schedule any newly ready steps once.', { task_id: { type: 'string' }, refresh: { type: 'boolean', default: false } }, ['task_id'], true, false, true),
    tool('delegated_task_advance', 'Explicitly advance a delegated task by refreshing workers and scheduling ready pending steps once.', { task_id: { type: 'string' }, include_diagnostics: { type: 'boolean', default: false } }, ['task_id'], false, false, false),
    tool('delegated_task_wait', 'Wait for a delegated task to advance toward terminal status.', { task_id: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 0, maximum: 600000, default: 30000 }, poll_ms: { type: 'integer', minimum: 50, maximum: 30000, default: 500 }, include_diagnostics: { type: 'boolean', default: false } }, ['task_id'], true, false, true),
    tool('delegated_tasks_list', 'List delegated tasks by lifecycle and site scope. Defaults to the current site active_queue when a site can be resolved.', { limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 }, view: { type: 'string', enum: ['active_queue', 'operator_inbox', 'history', 'acknowledged_archive', 'all'], default: 'active_queue' }, site_scope: { type: 'string', enum: ['current_site', 'all_sites', 'user_global'], description: 'current_site is the default when a current site is known. all_sites/user_global must be requested explicitly for shared queues and legacy records.' }, owner_site_id: { type: 'string', description: 'Optional owner-site filter. Requires site_scope=all_sites or user_global when it differs from the current site.' }, include_terminal: { type: 'boolean', default: false, description: 'Legacy lifecycle filter override. Prefer view.' }, include_active: { type: 'boolean', default: true, description: 'Legacy lifecycle filter override. Prefer view.' }, include_acknowledged: { type: 'boolean', default: false } }, [], true, false, true),
    tool('delegated_task_result', 'Return delegated task result handoff. Set refresh=true to refresh running workers and schedule any newly ready steps once.', { task_id: { type: 'string' }, include_diagnostics: { type: 'boolean', default: false }, refresh: { type: 'boolean', default: false } }, ['task_id'], true, false, true),
    tool('delegated_task_summary', 'Return a compact human review summary for one delegated task. Set refresh=true to refresh running workers and schedule any newly ready steps once.', { task_id: { type: 'string' }, refresh: { type: 'boolean', default: false } }, ['task_id'], true, false, true),
    tool('delegated_task_events', 'List delegated task events.', { task_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 } }, ['task_id'], true, false, true),
    tool('delegated_task_cancel', 'Cancel a nonterminal delegated task. Known cross-site ownership requires allow_cross_site=true.', { task_id: { type: 'string' }, reason: { type: 'string' }, expected_owner_site_id: { type: 'string' }, allow_cross_site: { type: 'boolean', default: false } }, ['task_id'], false, true, false),
    tool('delegated_task_acknowledge', 'Acknowledge a terminal delegated task and move it into the archive projection. Known cross-site ownership requires allow_cross_site=true.', { task_id: { type: 'string' }, acknowledged_by: { type: 'string' }, note: { type: 'string' }, expected_owner_site_id: { type: 'string' }, allow_cross_site: { type: 'boolean', default: false } }, ['task_id'], false, false, false),
    tool('delegated_task_parent_takeover', 'Mark a nonterminal delegated task as superseded by parent ownership. Known cross-site ownership requires allow_cross_site=true.', { task_id: { type: 'string' }, parent_task_id: { type: 'string' }, reason: { type: 'string' }, acknowledged_by: { type: 'string' }, expected_owner_site_id: { type: 'string' }, allow_cross_site: { type: 'boolean', default: false } }, ['task_id'], false, false, false),
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
  const workflow = normalizeWorkflow(args.workflow, state);
  const task: Task = {
    schema: 'narada.delegated_task.task.v1',
    task_id: taskId,
    ...newTaskOwnership(state),
    status: 'accepted_for_execution',
    objective: taskIntent.objective,
    constraints: rec(args.constraints),
    workflow,
    acceptance: normalizeAcceptance(args.acceptance, workflow),
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
  const validation = validateTaskShape({ ...args, workflow: task.workflow, acceptance: task.acceptance, execution, result_policy: task.result_policy }, state, false);
  if (validation.status === 'rejected') throw diag('delegated_task_validation_failed', 'delegated_task_validation_failed', { diagnostics: validation.diagnostics });
  writeTask(state, task);
  appendEvent(state, taskId, 'task_created', { intent: taskIntent, status: task.status, ownership: ownershipProjection(task) });
  const advanced = execution.start === false ? task : await advanceTask(task, state, { waitUntilTerminal: execution.wait_for_completion === true, timeoutMs: execution.wait_for_completion === true ? integer(execution.timeout_ms, 30000, 0, 600000) : integer(execution.timeout_ms, 0, 0, 600000), pollMs: integer(execution.poll_ms, 500, 50, 30000) });
  return runResult(advanced, paths, true);
}

export async function delegatedTaskStatus(args: JsonRecord, state: State): Promise<JsonRecord> {
  const before = readTask(state, taskId(args));
  const task = args.refresh === true ? await advanceTask(before, state, { waitUntilTerminal: false }) : before;
  return { schema: 'narada.delegated_task.status.v1', status: 'ok', task_id: task.task_id, task_status: task.status, objective: task.objective, ownership: ownershipProjection(task), lifecycle: lifecycleSummary(task), operator_posture: normalizedOperatorPosture(task), scheduler_state: schedulerState(task), step_counts: stepCounts(task.workflow), step_status_counts: stepStatusCounts(task), acceptance_verdict: rec(task.result).acceptance_verdict ?? 'pending', progress: rec(task.result).progress, progress_delta: progressDelta(before, task), active_step_posture: activeStepPosture(task), step_findings: stepFindings(task).slice(0, state.resultCompaction.maxListItems), review_consensus: reviewConsensus(task.result), closeout_synthesis: closeoutSynthesis(task.result), created_at: task.created_at, updated_at: task.updated_at, cancelled_at: task.cancelled_at };
}

export async function delegatedTaskAdvance(args: JsonRecord, state: State): Promise<JsonRecord> {
  const before = readTask(state, taskId(args));
  const task = await advanceTask(before, state, { waitUntilTerminal: false });
  return { schema: 'narada.delegated_task.advance.v1', status: 'ok', task_id: task.task_id, task_status: task.status, scheduler_state: schedulerState(task), progress: rec(task.result).progress, progress_delta: progressDelta(before, task), active_step_posture: activeStepPosture(task), closeout_synthesis: closeoutSynthesis(task.result), result: delegatedTaskResultView(task, state, args.include_diagnostics === true) };
}

export function delegatedTaskValidate(args: JsonRecord, state: State): JsonRecord {
  return validateTaskShape(args, state, true);
}

export async function delegatedTaskWait(args: JsonRecord, state: State): Promise<JsonRecord> {
  const started = Date.now();
  const timeoutMs = integer(args.timeout_ms, 30000, 0, 600000);
  const pollMs = integer(args.poll_ms, 500, 50, 30000);
  const before = readTask(state, taskId(args));
  const task = await advanceTask(before, state, { waitUntilTerminal: true, timeoutMs, pollMs });
  const result = delegatedTaskResultView(task, state, args.include_diagnostics === true);
  const waitStatus = TERMINAL.has(task.status) ? 'finished' : 'timeout';
  const response: JsonRecord = { schema: 'narada.delegated_task.wait.v1', status: waitStatus, elapsed_ms: Date.now() - started, timeout_ms: timeoutMs, poll_ms: pollMs, task_id: task.task_id, task_status: task.status, scheduler_state: schedulerState(task), progress: rec(task.result).progress, progress_delta: progressDelta(before, task), active_step_posture: activeStepPosture(task), closeout_synthesis: closeoutSynthesis(task.result), result };
  if (waitStatus === 'timeout') response.timeout_diagnostics = { active_steps: activeStepIds(task), active_step_posture: activeStepPosture(task), scheduler_state: schedulerState(task), progress_delta: response.progress_delta, next_action: normalizedOperatorPosture(task).next_action, message: 'delegated_task_wait timed out before task reached a terminal status' };
  return response;
}

export function delegatedTasksList(args: JsonRecord, state: State): JsonRecord {
  const limit = integer(args.limit, 20, 1, 200);
  const view = String(args.view ?? 'active_queue');
  const siteScope = normalizeSiteScope(args.site_scope, state);
  const ownerSiteId = opt(args.owner_site_id);
  const includeAcknowledged = args.include_acknowledged === true;
  const legacyFilter = args.include_terminal !== undefined || args.include_active !== undefined;
  const includeTerminal = args.include_terminal === true;
  const includeActive = args.include_active !== false;
  const tasksDir = resolve(state.taskRoot, 'tasks');
  const tasks = existsSync(tasksDir) ? readdirSync(tasksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    try { return readTask(state, entry.name); } catch { return null; }
  }).filter((task): task is Task => task !== null) : [];
  const scoped = tasks.filter((task) => siteScopeIncludes(siteScope, task, state, ownerSiteId));
  const filtered = scoped.filter((task) => legacyFilter ? (TERMINAL.has(task.status) ? includeTerminal : includeActive) && (includeAcknowledged || !isAcknowledged(task)) : lifecycleViewIncludes(view, task, includeAcknowledged)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
  const rows = filtered.map((task) => {
    const posture = normalizedOperatorPosture(task);
    const ownership = ownershipProjection(task);
    return { task_id: task.task_id, task_status: task.status, objective: task.objective, updated_at: task.updated_at, owner_site_id: ownership.owner_site_id, owner_site_root: ownership.owner_site_root, created_by_site_id: ownership.created_by_site_id, visibility_scope: ownership.visibility_scope, task_root_scope: ownership.task_root_scope, ownership_resolution: ownership.ownership_resolution, lifecycle: lifecycleSummary(task), list_category: posture.list_category, progress: rec(task.result).progress, scheduler_state: schedulerState(task), operator_posture: posture, acceptance_verdict: rec(task.result).acceptance_verdict ?? 'pending', next_action: posture.next_action };
  });
  const activeCount = rows.filter((task) => task.list_category === 'active_queue').length;
  return { schema: 'narada.delegated_task.list.v1', status: 'ok', view, site_scope: siteScope, current_site_id: state.currentSiteId, owner_site_id: ownerSiteId ?? null, limit, count: rows.length, total_scoped_count: scoped.length, active_count: activeCount, history_count: rows.length - activeCount, include_active: includeActive, include_terminal: includeTerminal, include_acknowledged: includeAcknowledged, queue_summary: lifecycleQueueSummary(scoped), queue_summary_all_sites: siteScope === 'all_sites' || siteScope === 'user_global' ? lifecycleQueueSummary(tasks) : undefined, tasks: rows };
}

export function delegatedTaskPolicyInspect(state: State): JsonRecord {
  return {
    schema: 'narada.delegated_task.policy.v1',
    status: 'ok',
    task_root: state.taskRoot,
    site_root: state.siteRoot,
    current_site_id: state.currentSiteId,
    list_defaults: { view: 'active_queue', site_scope: state.currentSiteId ? 'current_site' : 'user_global' },
    allowed_roots: state.allowedRoots,
    allowed_workflow_kinds: state.allowedWorkflowKinds,
    allowed_profiles: state.allowedProfiles,
    execution_defaults: normalizeExecution({}),
    result_policy_defaults: normalizeResultPolicy({}),
    result_compaction: state.resultCompaction,
    policy_schema: 'narada.delegated_task.policy.v1',
    workflow_engine: workflowEngineMetadata(),
    template_catalog: workflowTemplateCatalog().map(compactTemplate),
    condition_language: CONDITION_LANGUAGE,
    worker_policy: publicWorkerPolicy(state.workerState.policy),
  };
}

export async function delegatedTaskResult(args: JsonRecord, state: State): Promise<JsonRecord> {
  const before = readTask(state, taskId(args));
  const task = args.refresh === true ? await advanceTask(before, state, { waitUntilTerminal: false }) : before;
  return delegatedTaskResultView(task, state, args.include_diagnostics === true);
}

export async function delegatedTaskSummary(args: JsonRecord, state: State): Promise<JsonRecord> {
  const before = readTask(state, taskId(args));
  const task = args.refresh === true ? await advanceTask(before, state, { waitUntilTerminal: false }) : before;
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
    step_findings: stepFindings(task).slice(0, state.resultCompaction.maxListItems),
    review_consensus: reviewConsensus(task.result),
    closeout_synthesis: closeoutSynthesis(task.result),
    progress: rec(task.result).progress,
    milestones: rec(task.workflow).milestones ?? [],
    terminal_summary: terminalSummary(task.result),
  };
}

export function delegatedTaskTemplateCatalog(args: JsonRecord = {}): JsonRecord {
  const templateId = opt(args.template_id);
  const templates = workflowTemplateCatalog().filter((template) => !templateId || template.template_id === templateId);
  return { schema: 'narada.delegated_task.template_catalog.v1', status: templateId && templates.length === 0 ? 'not_found' : 'ok', template_id: templateId ?? null, count: templates.length, templates };
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
  const ownership = assertMutationSiteScope(task, state, args);
  if (TERMINAL.has(task.status)) throw diag('delegated_task_terminal_status', `delegated_task_terminal_status:${task.status}`, { task_id: id, status: task.status });
  task.status = 'cancelled';
  task.updated_at = now();
  task.cancelled_at = now();
  task.summary = opt(args.reason) ?? 'cancelled';
  const stepStates = cancelActiveStepStates(stepStateMap(task));
  task.result = { ...rec(task.result), step_states: stepStates, acceptance_verdict: 'cancelled', acceptance_status: 'cancelled', summary: task.summary, residual_risks: uniqueStrings([...stringList(rec(task.result).residual_risks), 'task_cancelled_before_completion']), progress: progressSummary(task, stepStates), active_step_posture: [] };
  writeTask(state, task);
  const event = appendEvent(state, id, 'task_cancelled', { reason: task.summary, ownership, allow_cross_site: args.allow_cross_site === true });
  task.result = annotateCancelledWorkerRefs(task.result);
  task.result = enrichHandoff(task, state, stepStates);
  writeTask(state, task);
  return { schema: 'narada.delegated_task.cancel.v1', status: 'cancelled', task_id: id, task_status: task.status, ownership, event };
}

export function delegatedTaskAcknowledge(args: JsonRecord, state: State): JsonRecord {
  const id = taskId(args);
  const task = readTask(state, id);
  const ownership = assertMutationSiteScope(task, state, args);
  if (!TERMINAL.has(task.status)) throw diag('delegated_task_not_terminal', `delegated_task_not_terminal:${task.status}`, { task_id: id, status: task.status });
  const acknowledgement = { acknowledged: true, acknowledged_at: now(), acknowledged_by: opt(args.acknowledged_by) ?? null, note: opt(args.note) ?? null };
  task.result = { ...rec(task.result), lifecycle_acknowledgement: acknowledgement };
  task.updated_at = now();
  writeTask(state, task);
  const event = appendEvent(state, id, 'task_acknowledged', { ...acknowledgement, ownership, allow_cross_site: args.allow_cross_site === true });
  return { schema: 'narada.delegated_task.acknowledge.v1', status: 'acknowledged', task_id: id, task_status: task.status, ownership, acknowledgement, event };
}

export function delegatedTaskParentTakeover(args: JsonRecord, state: State): JsonRecord {
  const id = taskId(args);
  const task = readTask(state, id);
  const ownership = assertMutationSiteScope(task, state, args);
  if (TERMINAL.has(task.status)) throw diag('delegated_task_terminal_status', `delegated_task_terminal_status:${task.status}`, { task_id: id, status: task.status });
  const takeover = { parent_task_id: opt(args.parent_task_id) ?? null, reason: opt(args.reason) ?? 'parent_took_over_execution', acknowledged_by: opt(args.acknowledged_by) ?? null, recorded_at: now() };
  task.status = 'cancelled';
  task.updated_at = now();
  task.cancelled_at = now();
  task.summary = `parent_takeover:${takeover.reason}`;
  const stepStates = cancelActiveStepStates(stepStateMap(task));
  task.result = { ...rec(task.result), parent_takeover: takeover, step_states: stepStates, acceptance_verdict: 'cancelled', acceptance_status: 'cancelled', summary: task.summary, residual_risks: uniqueStrings([...stringList(rec(task.result).residual_risks), 'parent_took_over_before_completion']), progress: progressSummary(task, stepStates), active_step_posture: [] };
  task.result = annotateCancelledWorkerRefs(task.result);
  task.result = enrichHandoff(task, state, stepStates);
  writeTask(state, task);
  const event = appendEvent(state, id, 'task_parent_takeover', { ...takeover, ownership, allow_cross_site: args.allow_cross_site === true });
  return { schema: 'narada.delegated_task.parent_takeover.v1', status: 'parent_takeover_recorded', task_id: id, task_status: task.status, ownership, parent_takeover: takeover, event };
}

async function dispatch(method: string, params: JsonRecord, state: State) {
  if (method === 'initialize') return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
  if (method === 'tools/list') return { tools: listTools() };
  if (method !== 'tools/call') throw diag('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  const name = String(params.name ?? '');
  const args = rec(params.arguments);
  const result = name === 'delegated_task_policy_inspect' ? delegatedTaskPolicyInspect(state)
    : name === 'delegated_task_template_catalog' ? delegatedTaskTemplateCatalog(args)
    : name === 'delegated_task_validate' ? delegatedTaskValidate(args, state)
    : name === 'delegated_task_run' ? await delegatedTaskRun(args, state)
    : name === 'delegated_task_status' ? await delegatedTaskStatus(args, state)
      : name === 'delegated_task_advance' ? await delegatedTaskAdvance(args, state)
        : name === 'delegated_task_wait' ? await delegatedTaskWait(args, state)
        : name === 'delegated_tasks_list' ? delegatedTasksList(args, state)
            : name === 'delegated_task_result' ? await delegatedTaskResult(args, state)
              : name === 'delegated_task_summary' ? await delegatedTaskSummary(args, state)
                : name === 'delegated_task_events' ? delegatedTaskEvents(args, state)
                  : name === 'delegated_task_cancel' ? delegatedTaskCancel(args, state)
                    : name === 'delegated_task_acknowledge' ? delegatedTaskAcknowledge(args, state)
                      : name === 'delegated_task_parent_takeover' ? delegatedTaskParentTakeover(args, state)
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

async function refreshTaskStatus(task: Task, state: State): Promise<Task> {
  if (TERMINAL.has(task.status)) return task;
  const stepStates = stepStateMap(task);
  await refreshRunningSteps(task, state, stepStates);
  return readTask(state, task.task_id);
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
      const writeSetConflict = writeSetConflictForStep(task, step, stepStates, readyWorkerSteps.map((item) => item.step));
      if (writeSetConflict.conflict) continue;
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
          const failure = recordWorkerLaunchFailure(task, step, state, error);
          markStep(stepState, 'failed', String(failure.message));
          appendEvent(state, task.task_id, 'step_failed', failure);
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
      try {
        statusResult = await recoverWorkerRunStatus(stepState.current_run_id, state, error);
      } catch (recoveryError) {
        stepState.error = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        dataChanged = true;
        continue;
      }
    }
    const workerRef = summarizeWorkerRef({ id: stepState.step_id, kind: stepState.kind, profile: null, instruction: null, milestone_id: null, depends_on: [], imports: [], if: null, acceptance_scope: [], write_set: [], constraints: {}, authority_gate: {} }, statusResult);
    upsertWorkerRef(task, workerRef, statusResult);
    const refreshedStatus = String(statusResult.status ?? 'unknown');
    stepState.active_posture = refreshedStatus === 'running' ? workerActivePosture(stepState, statusResult) : null;
    if (refreshedStatus === 'completed') {
      const runId = stepState.current_run_id;
      markStep(stepState, 'completed', opt(statusResult.summary));
      stepState.worker_session_id = opt(statusResult.worker_session_id);
      appendEvent(state, task.task_id, 'step_completed', { step_id: stepState.step_id, run_id: runId });
      dataChanged = true;
    } else if (FAILED_WORKER_STATUSES.has(refreshedStatus)) {
      const maxRetries = executionPolicy(task).max_retries;
      if (stepState.attempts <= maxRetries) {
        stepState.status = 'pending';
        stepState.error = `retry_after:${refreshedStatus}`;
        const runId = stepState.current_run_id;
        appendEvent(state, task.task_id, 'step_retry_scheduled', { step_id: stepState.step_id, run_id: runId, attempts: stepState.attempts, max_retries: maxRetries });
        stepState.current_run_id = null;
        stepState.active_posture = null;
      } else {
        const runId = stepState.current_run_id;
        markStep(stepState, 'failed', opt(statusResult.error) ?? `worker_status:${refreshedStatus}`);
        appendEvent(state, task.task_id, 'step_failed', { step_id: stepState.step_id, run_id: runId, status: refreshedStatus });
      }
      dataChanged = true;
    }
  }
  if (dataChanged) {
    finalizeTask(task, state, stepStates);
    writeTask(state, task);
  }
}

async function recoverWorkerRunStatus(runId: string, state: State, originalError: unknown): Promise<JsonRecord> {
  const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
  if (!/worker_run_not_found/.test(originalMessage)) throw originalError;
  try {
    return await state.workerTool('worker_run_wait', { run_id: runId, timeout_ms: 1, poll_ms: 1, summary_only: false }, state.workerState);
  } catch (waitError) {
    const waitMessage = waitError instanceof Error ? waitError.message : String(waitError);
    if (/worker_run_not_found/.test(waitMessage)) throw originalError;
    throw waitError;
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
  stepState.active_posture = stepState.status === 'running' ? workerActivePosture(stepState, workerResult) : null;
  const workerRef = summarizeWorkerRef(step, workerResult);
  upsertWorkerRef(task, workerRef, workerResult);
  if (stepState.status === 'failed' && stepState.attempts <= executionPolicy(task).max_retries) {
    const runId = stepState.current_run_id;
    stepState.status = 'pending';
    stepState.finished_at = null;
    stepState.error = `retry_after:${workerResult.status}`;
    appendEvent(state, task.task_id, 'step_retry_scheduled', { step_id: stepState.step_id, run_id: runId, attempts: stepState.attempts, max_retries: executionPolicy(task).max_retries });
    stepState.current_run_id = null;
    return;
  }
  appendEvent(state, task.task_id, stepState.status === 'completed' ? 'step_completed' : stepState.status === 'failed' ? 'step_failed' : 'step_worker_started', workerRef);
  if (stepState.status !== 'running') stepState.current_run_id = null;
}

function recordWorkerLaunchFailure(task: Task, step: WorkflowStep, state: State, error: unknown): JsonRecord {
  const args = buildWorkerArgs(task, step, state);
  const workerConstraints = rec(args.constraints);
  const failure = {
    schema: 'narada.delegated_task.worker_launch_failure.v1',
    step_id: step.id,
    step_kind: step.kind,
    tool_name: 'worker_run',
    message: error instanceof Error ? error.message : String(error),
    cwd: workerConstraints.cwd ?? null,
    authority: workerConstraints.authority ?? task.constraints.authority ?? null,
    constraints_keys: Object.keys(workerConstraints).sort(),
    has_overrides: Object.keys(rec(workerConstraints.overrides)).length > 0,
    instruction_preview: String(rec(args.intent).instruction ?? '').slice(0, 240),
  };
  const existing = records(rec(task.result).worker_launch_failures).filter((item) => item.step_id !== step.id);
  task.result = { ...rec(task.result), worker_launch_failures: [...existing, failure] };
  return failure;
}

function completeLocalStep(task: Task, state: State, step: WorkflowStep, stepState: StepState, stepStates: Record<string, StepState>): void {
  if (step.kind === 'join') {
    const dependencyRefs = workerRefs(task).filter((ref) => step.depends_on.includes(String(ref.step_id ?? '')));
    const summary = `joined ${dependencyRefs.length} worker result${dependencyRefs.length === 1 ? '' : 's'}`;
    const joinSynthesis = synthesizeJoinStep(step, dependencyRefs);
    const existing = records(rec(task.result).join_syntheses).filter((item) => item.step_id !== step.id);
    task.result = { ...rec(task.result), join_syntheses: [...existing, joinSynthesis] };
    markStep(stepState, 'completed', summary);
    appendEvent(state, task.task_id, 'step_join_completed', { step_id: step.id, dependency_count: step.depends_on.length, worker_ref_count: dependencyRefs.length, synthesis: joinSynthesis });
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
  task.result = enrichHandoff(task, state, stepStates);
  task.updated_at = now();
}

function consolidateResult(task: Task, _state: State, stepStates: Record<string, StepState>): JsonRecord {
  const refs = workerRefs(task);
  const outputs = refs.map((ref) => rec(ref.output));
  const parentChangedFiles = uniqueStrings(stringList(rec(task.result).parent_changed_files));
  const workerReportedChangedFiles = uniqueStrings(refs.flatMap((ref) => writeCapableWorkerRef(task, ref) ? changedPathsFromOutput(rec(ref.output)) : []));
  const observedFiles = uniqueStrings(refs.flatMap((ref) => {
    const output = rec(ref.output);
    return [...deliverablePathsFromOutput(output), ...(writeCapableWorkerRef(task, ref) ? [] : changedPathsFromOutput(output))];
  }));
  const nestedWorkflows = uniqueRecords(outputs.flatMap(nestedWorkflowRecords));
  const nestedWorkflowChangedFiles = uniqueStrings(nestedWorkflows.flatMap((workflow) => stringList(workflow.changed_files)));
  const changedFiles = uniqueStrings([...parentChangedFiles, ...workerReportedChangedFiles, ...nestedWorkflowChangedFiles]);
  const changedFileRefs = classifyChangedFileRefs(task, changedFiles);
  const realChangedFiles = changedFileRefs.filter((ref) => ref.kind === 'real_file').map((ref) => String(ref.path));
  const affectedRefs = changedFileRefs.filter((ref) => ref.kind !== 'real_file').map((ref) => String(ref.path));
  const nestedWorkflowVerification = uniqueRecords(nestedWorkflows.flatMap((workflow) => records(workflow.verification_results).length ? records(workflow.verification_results) : records(workflow.verification)));
  const verification = uniqueRecords([...records(rec(task.result).verification), ...outputs.flatMap((output) => records(output.verification_results)), ...outputs.flatMap((output) => records(output.verification)), ...nestedWorkflowVerification]);
  const hasRunningStep = Object.values(stepStates).some((step) => step.status === 'running');
  const priorResidualRisks = stringList(rec(task.result).residual_risks).filter((risk) => hasRunningStep || risk !== 'worker_runs_still_in_progress');
  const residualRisks = uniqueStrings([...priorResidualRisks, ...outputs.flatMap((output) => stringList(output.residual_risks)), ...(hasRunningStep ? ['worker_runs_still_in_progress'] : [])]);
  const workerTerminalDiagnostics = workerTerminalDiagnosticRecords(refs);
  const exitInterviews = exitInterviewRecords(refs);
  const exitInterviewFeedback = exitInterviewFeedbackSummary(exitInterviews);
  const observedIncoherencies = uniqueStrings([...stringList(rec(task.result).observed_incoherencies), ...outputs.flatMap((output) => stringList(output.observed_incoherencies)), ...stringList(exitInterviewFeedback.observed_incoherencies)]);
  const workerLaunchFailures = records(rec(task.result).worker_launch_failures);
  const launchFailureIncoherencies = workerLaunchFailures.map((failure) => `worker_launch_failed:${failure.step_id ?? 'unknown'}:${failure.message ?? 'unknown_error'}`);
  const joinSyntheses = records(rec(task.result).join_syntheses);
  return { schema: 'narada.delegated_task.handoff.v1', changed_files: changedFiles, changed_file_refs: changedFileRefs, real_changed_files: realChangedFiles, affected_refs: affectedRefs, parent_changed_files: parentChangedFiles, worker_reported_changed_files: workerReportedChangedFiles, observed_files: observedFiles, nested_workflows: nestedWorkflows, nested_workflow_changed_files: nestedWorkflowChangedFiles, nested_workflow_verification: nestedWorkflowVerification, join_syntheses: joinSyntheses, verification, residual_risks: residualRisks, observed_incoherencies: uniqueStrings([...observedIncoherencies, ...launchFailureIncoherencies]), worker_terminal_diagnostics: workerTerminalDiagnostics, worker_terminal_diagnostic_count: workerTerminalDiagnostics.length, exit_interviews: exitInterviews, exit_interview_count: exitInterviews.length, exit_interview_feedback: exitInterviewFeedback, worker_launch_failures: workerLaunchFailures, worker_refs: refs, worker_ref_count: refs.length };
}

function workerTerminalDiagnosticRecords(refs: JsonRecord[]): JsonRecord[] {
  return refs.flatMap((ref) => {
    const output = rec(ref.output);
    const error = opt(output.error);
    const errorClassification = opt(output.error_classification);
    const diagnosticTail = opt(output.diagnostic_tail);
    const runtimeWarnings = stringList(output.runtime_warnings);
    if (!error && !errorClassification && !diagnosticTail && runtimeWarnings.length === 0) return [];
    return [{ step_id: ref.step_id ?? null, step_kind: ref.step_kind ?? null, run_id: ref.run_id ?? null, status: ref.status ?? null, error, error_classification: errorClassification, diagnostic_tail: diagnosticTail, runtime_warnings: runtimeWarnings }];
  });
}

function exitInterviewRecords(refs: JsonRecord[]): JsonRecord[] {
  return refs.flatMap((ref) => {
    const exitInterview = rec(rec(ref.output).exit_interview);
    if (Object.keys(exitInterview).length === 0) return [];
    return [{ step_id: ref.step_id ?? null, step_kind: ref.step_kind ?? null, run_id: ref.run_id ?? null, worker_session_id: ref.worker_session_id ?? null, status: ref.status ?? null, exit_interview: exitInterview }];
  });
}

function exitInterviewFeedbackSummary(exitInterviews: JsonRecord[]): JsonRecord {
  const interviews = exitInterviews.map((item) => rec(item.exit_interview));
  return {
    ergonomics_feedback: uniqueStrings(interviews.map((item) => String(item.ergonomics_feedback ?? '')).filter(Boolean)),
    friction_points: uniqueStrings(interviews.flatMap((item) => stringList(item.friction_points))),
    missing_affordances: uniqueStrings(interviews.flatMap((item) => stringList(item.missing_affordances))),
    observed_incoherencies: uniqueStrings(interviews.flatMap((item) => stringList(item.observed_incoherencies))),
    suggested_improvements: uniqueStrings(interviews.flatMap((item) => stringList(item.suggested_improvements))),
  };
}

function changedPathsFromOutput(output: JsonRecord): string[] {
  return [...stringList(output.changed_files), ...records(output.changes).map((change) => String(change.path ?? '')).filter(Boolean)];
}

function deliverablePathsFromOutput(output: JsonRecord): string[] {
  return records(output.deliverables).map((item) => String(item.path ?? '')).filter(Boolean);
}

function writeCapableWorkerRef(task: Task, ref: JsonRecord): boolean {
  const step = workflowSteps(task.workflow).find((item) => item.id === ref.step_id);
  if (!step || !WRITE_CAPABLE_WORKER_KINDS.has(step.kind)) return false;
  const constraints = { ...task.constraints, ...step.constraints };
  return String(constraints.authority ?? '').toLowerCase() === 'write';
}

function enrichHandoff(task: Task, state: State, stepStates: Record<string, StepState>): JsonRecord {
  const result = rec(task.result);
  const terminal = terminalSemantics(task, stepStates, result);
  return {
    ...result,
    ...terminal,
    ownership: ownershipProjection(task),
    target_state_changed: scopedTargetStateChanged(task, state, result),
    graph_execution_synthesis: graphExecutionSynthesis(task, stepStates, result, terminal),
  };
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
  for (const item of acceptanceItems(task.acceptance.focused_tests)) {
    const target = String(item.command ?? item.target ?? item.value ?? '');
    const requiredStatus = String(item.status ?? 'passed');
    const matching = records(result.verification).filter((record) => JSON.stringify(record).includes(target));
    checks.push({ kind: 'focused_test', target, required_status: requiredStatus, status: matching.some((record) => String(record.status ?? '').includes(requiredStatus)) || verificationText.includes(target) ? 'passed' : 'pending' });
  }
  const verificationBudget = rec(task.acceptance.verification_budget);
  if (Object.keys(verificationBudget).length > 0) {
    const maxAttempts = integer(verificationBudget.max_attempts, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const maxCommands = integer(verificationBudget.max_commands, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const count = records(result.verification).length;
    checks.push({ kind: 'verification_budget', verification_count: count, max_attempts: maxAttempts, max_commands: maxCommands, status: count <= maxAttempts && count <= maxCommands ? 'passed' : 'failed' });
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
  const result: JsonRecord = { schema: 'narada.delegated_task.result.v1', status: 'ok', task_id: task.task_id, task_status: task.status, objective: task.objective, ownership: ownershipProjection(task), result: resultView, workflow_summary: { ...workflowSummary, step_count: workflowSummary.total }, acceptance_summary: acceptanceSummary(task.acceptance) };
  if (includeDiagnostics) result.diagnostics = { task_id: task.task_id, task_path: taskPaths(state, task.task_id).taskPath, events_path: taskPaths(state, task.task_id).eventsPath, constraints: task.constraints, workflow: task.workflow, result_policy: task.result_policy, execution: task.execution };
  return result;
}

function tool(name: string, description: string, properties: JsonRecord, requiredFields: string[], readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean) {
  return { name, description, inputSchema: { type: 'object', properties, required: requiredFields, additionalProperties: false }, annotations: { title: name, readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false }, outputSchema: { type: 'object', additionalProperties: true } };
}
function intentSchema(): JsonRecord { return { type: 'object', properties: { objective: { type: 'string' }, instructions: { type: 'string' }, behavior: { type: 'string' }, mode: { type: 'string' } }, additionalProperties: false }; }
function constraintsSchema(): JsonRecord { return { type: 'object', properties: { authority: { type: 'string', enum: ['read', 'write', 'command'] }, cwd: { type: 'string' }, site_root: { type: 'string', description: 'Optional Narada Site root forwarded to worker-delegation for site-bound runtimes.' }, profile: { type: 'string' }, cognition: { type: 'string', enum: ['low', 'medium', 'high'] }, model: { type: 'string' }, sandbox: { type: 'string' }, runtime: { type: 'string' }, skip_git_repo_check: { type: 'boolean' }, resumable: { type: 'boolean' }, wait_for_completion: { type: 'boolean' }, exit_interview: { type: 'boolean' }, max_concurrency: { type: 'integer', minimum: 1 }, max_retries: { type: 'integer', minimum: 0 }, repair_policy: repairPolicySchema(), authority_gates: authorityGatesSchema(), required_mcp_tools: { type: 'array', items: { type: 'string' } }, preflight_paths: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, access: { type: 'string', enum: ['read', 'write', 'create'] }, label: { type: 'string' } }, required: ['path', 'access'], additionalProperties: false } }, overrides: constraintOverridesSchema() }, additionalProperties: false }; }
function constraintOverridesSchema(): JsonRecord { return { type: 'object', properties: { runtime: { type: 'string' }, sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] }, model: { type: 'string' }, reasoning_effort: { type: 'string' }, config: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } }, skip_git_repo_check: { type: 'boolean' } }, additionalProperties: false }; }
function workflowSchema(): JsonRecord {
  const templateIds = workflowTemplateCatalog().map((template) => String(template.template_id));
  const stepSchema = { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' }, profile: { type: 'string' }, instruction: { type: 'string' }, milestone_id: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } }, imports: { type: 'array', items: { type: 'string' }, description: 'Optional explicit external dependency or context labels imported by this step; advisory only, not scheduling dependencies.' }, if: { type: 'string' }, acceptance_scope: { type: 'array', items: { type: 'string' } }, write_set: { type: 'array', items: { type: 'string' }, description: 'Advisory paths/resources this step may write. Used for disjoint write-set scheduling when enabled.' }, authority_gate: authorityGateSchema(), constraints: constraintsSchema() }, required: ['id', 'kind'], additionalProperties: false };
  return { type: 'object', description: 'Workflow DAG: every depends_on value must name a step id in this request, and cycles are rejected by delegated_task_validate. work_order may be a legacy step-list alias or a governing contract layered over explicit steps.', properties: { template_id: { type: 'string', enum: templateIds }, strategy: { type: 'string', enum: templateIds }, template: { type: 'string', enum: templateIds, description: 'Alias for strategy for template-oriented callers.' }, instruction: { type: 'string', description: 'Optional template-level instruction used by built-in templates when a step omits its own instruction.' }, milestones: { type: 'array', items: milestoneSchema() }, authority_gates: authorityGatesSchema(), steps: { type: 'array', items: stepSchema }, work_order: workOrderSchema(stepSchema), imports: { type: 'array', items: { type: 'string' }, description: 'Workflow-level external dependency or context labels imported by this DAG; advisory only.' }, migration: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Optional caller migration metadata preserved in the task record.' } }, additionalProperties: false, examples: [{ template_id: 'implement_review_repair_verify', instruction: 'Implement, review, repair if needed, and verify.' }, { template: 'implement_review_repair_verify' }, { work_order: [{ id: 'implement', kind: 'worker' }, { id: 'review', kind: 'review', depends_on: ['implement'] }] }, { steps: [{ id: 'implement', kind: 'worker' }], work_order: { scope: ['packages/delegated-task-mcp'], budget: { max_verification_attempts: 1 }, verification: { focused_tests: ['pnpm --filter @narada2/delegated-task-mcp test'] }, acceptance: { residual_risk_policy: 'allow' } } }, { steps: [{ id: 'research-a', kind: 'research', milestone_id: 'research' }, { id: 'research-b', kind: 'research', milestone_id: 'research' }, { id: 'synthesize', kind: 'worker', depends_on: ['research-a', 'research-b'] }, { id: 'review', kind: 'review', depends_on: ['synthesize'] }] }] };
}
function workOrderSchema(stepSchema: JsonRecord): JsonRecord { return { oneOf: [{ type: 'array', items: stepSchema, description: 'Backward-compatible alias for steps when workflow.steps is omitted.' }, { type: 'object', properties: { scope: { type: 'array', items: { type: 'string' } }, budget: { type: 'object', properties: { max_worker_runs: { type: 'integer', minimum: 1 }, max_verification_attempts: { type: 'integer', minimum: 1 }, timeout_ms: { type: 'integer', minimum: 0 }, max_minutes: { type: 'number', minimum: 0 }, allowed_repositories: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }, verification: { type: 'object', properties: { required_tests: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string', enum: ['passed', 'pending', 'failed'] } }, additionalProperties: false }] } }, focused_tests: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string', enum: ['passed', 'pending', 'failed'] } }, additionalProperties: false }] } }, verification_budget: { type: 'object', properties: { max_attempts: { type: 'integer', minimum: 1 }, max_commands: { type: 'integer', minimum: 1 } }, additionalProperties: false } }, additionalProperties: false }, acceptance: acceptanceSchema(), steps: { type: 'array', items: stepSchema }, items: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] }, description: 'Declarative item set used by map stages.' }, stages: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Declarative stages expanded into explicit steps before scheduling.' }, stage_policy: { type: 'object', additionalProperties: true } }, additionalProperties: false, description: 'First-class governing contract layered over the workflow DAG. Optional items/stages are expanded into explicit DAG steps.' }] }; }
function milestoneSchema(): JsonRecord { return { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } }, step_ids: { type: 'array', items: { type: 'string' } }, acceptance_scope: { type: 'array', items: { type: 'string' } } }, required: ['id', 'title'], additionalProperties: false }; }
function authorityGateSchema(): JsonRecord { return { type: 'object', properties: { operation: { type: 'string', enum: ['commit', 'push'] }, mode: { type: 'string', enum: ['disallowed', 'requires_explicit_authority', 'allowed'] }, reason: { type: 'string' }, required_authority: { type: 'string', enum: ['write', 'command'] } }, additionalProperties: false }; }
function authorityGatesSchema(): JsonRecord { return { type: 'object', properties: { commit: authorityGateSchema(), push: authorityGateSchema() }, additionalProperties: false }; }
function repairPolicySchema(): JsonRecord { return { type: 'object', properties: { strategy: { type: 'string', enum: ['retry_same_step', 'named_repair_step'] }, repair_step_id: { type: 'string' }, require_review_after_repair: { type: 'boolean' } }, additionalProperties: false }; }
function acceptanceSchema(): JsonRecord { return { type: 'object', properties: { required_files: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string' }, contains: { type: 'string' } }, required: ['path'], additionalProperties: false }] } }, required_tests: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { command: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['passed', 'pending', 'failed'] } }, additionalProperties: false }] } }, focused_tests: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { command: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['passed', 'pending', 'failed'] } }, additionalProperties: false }] } }, verification_budget: { type: 'object', properties: { max_attempts: { type: 'integer', minimum: 1 }, max_commands: { type: 'integer', minimum: 1 } }, additionalProperties: false }, required_tools: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string', enum: ['passed', 'pending', 'failed'] } }, required: ['name'], additionalProperties: false }] } }, forbidden_patterns: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { pattern: { type: 'string' }, scope: { type: 'string' } }, required: ['pattern'], additionalProperties: false }] } }, review_questions: { type: 'array', items: { type: 'string' } }, review_quorum: { type: 'object', properties: { min_passed: { type: 'integer', minimum: 0 }, max_failed: { type: 'integer', minimum: 0 } }, additionalProperties: false }, residual_risk_policy: { type: 'string', enum: ['allow', 'none_allowed'] } }, additionalProperties: false }; }
function resultPolicySchema(): JsonRecord { return { type: 'object', properties: { include_diagnostics_by_default: { type: 'boolean' }, expose_worker_refs: { type: 'boolean' }, compact_completed_worker_refs: { type: 'boolean' }, max_events: { type: 'integer', minimum: 1, maximum: 1000 }, max_worker_refs: { type: 'integer', minimum: 1, maximum: 1000 }, max_result_items: { type: 'integer', minimum: 1, maximum: 5000 } }, additionalProperties: false }; }
function executionSchema(): JsonRecord { return { type: 'object', properties: { start: { type: 'boolean', default: true }, wait_for_completion: { type: 'boolean', default: false }, timeout_ms: { type: 'integer', minimum: 0, maximum: 600000, default: 0 }, poll_ms: { type: 'integer', minimum: 50, maximum: 30000, default: 500 }, resumable: { type: 'boolean', default: true }, exit_interview: { type: 'boolean', default: false }, max_concurrency: { type: 'integer', minimum: 1, maximum: 32, default: 10 }, max_retries: { type: 'integer', minimum: 0, maximum: 10, default: 0 } }, additionalProperties: false }; }

function runResult(task: Task, paths: ReturnType<typeof taskPaths>, created: boolean): JsonRecord { return { schema: 'narada.delegated_task.run.v1', status: created ? 'accepted_for_execution' : 'existing', task_id: task.task_id, task_status: task.status, created, ownership: ownershipProjection(task), task_path: paths.taskPath, events_path: paths.eventsPath, summary: task.summary, progress: rec(task.result).progress, worker_refs: rec(task.result).worker_refs ?? [] }; }
function handoff(): JsonRecord { return { schema: 'narada.delegated_task.handoff.v1', acceptance_verdict: 'pending', changed_files: [], verification: [], residual_risks: [], observed_incoherencies: [], exit_interviews: [], exit_interview_count: 0, exit_interview_feedback: exitInterviewFeedbackSummary([]), worker_refs: [], worker_ref_count: 0, summary: null }; }
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
    if (condition.status === 'invalid') diagnostics.push({ severity: 'error', code: 'invalid_condition', step_id: step.id, condition: step.if, message: condition.message, allowed: condition.allowed, suggestions: conditionSuggestions(step.if, step, steps) });
  }
  const cycles = detectCycles(steps);
  for (const cycle of cycles) diagnostics.push({ severity: 'error', code: 'workflow_cycle', cycle });
  diagnostics.push(...unknownKeyDiagnostics(rec(args.constraints), ['authority', 'cwd', 'site_root', 'profile', 'cognition', 'model', 'sandbox', 'runtime', 'skip_git_repo_check', 'resumable', 'wait_for_completion', 'exit_interview', 'max_concurrency', 'max_retries', 'repair_policy', 'authority_gates', 'required_mcp_tools', 'preflight_paths', 'overrides'], 'constraints'));
  diagnostics.push(...unknownKeyDiagnostics(rec(rec(args.constraints).overrides), ['runtime', 'sandbox', 'model', 'reasoning_effort', 'config', 'skip_git_repo_check'], 'constraint_overrides'));
  diagnostics.push(...gitTrustDiagnostics(rec(args.constraints), steps, state));
  diagnostics.push(...unknownKeyDiagnostics(rec(args.result_policy), ['include_diagnostics_by_default', 'expose_worker_refs', 'compact_completed_worker_refs', 'max_events', 'max_worker_refs', 'max_result_items'], 'result_policy'));
  const acceptance = normalizeAcceptance(args.acceptance, workflow);
  const acceptanceDiagnostics = validateAcceptanceContract(acceptance);
  diagnostics.push(...acceptanceDiagnostics);
  diagnostics.push(...workflowShapeDiagnostics(rec(args.workflow)));
  diagnostics.push(...gitPublishAuthorityDiagnostics(args, steps));
  const repairPolicy = rec(rec(args.constraints).repair_policy ?? rec(args.execution).repair_policy);
  if (Object.keys(repairPolicy).length > 0) {
    const strategy = repairPolicy.strategy;
    if (strategy !== 'retry_same_step' && strategy !== 'named_repair_step') diagnostics.push({ severity: 'error', code: 'repair_policy_strategy_invalid', strategy });
    if (strategy === 'named_repair_step' && !ids.has(String(repairPolicy.repair_step_id ?? ''))) diagnostics.push({ severity: 'error', code: 'repair_policy_repair_step_missing', repair_step_id: repairPolicy.repair_step_id });
  }
  return { schema: 'narada.delegated_task.validate.v1', status: diagnostics.some((item) => item.severity === 'error') ? 'rejected' : 'ok', dry_run: dryRun, diagnostics, workflow_preview: { template_id: opt(workflow.template_id) ?? opt(workflow.strategy) ?? opt(workflow.template) ?? null, step_count: steps.length, milestones: records(workflow.milestones), authority_gates: rec(workflow.authority_gates), work_order: rec(workflow.work_order), declarative_expansion: rec(rec(workflow.work_order).declarative_expansion), steps: steps.map((step) => ({ id: step.id, kind: step.kind, milestone_id: step.milestone_id, depends_on: step.depends_on, imports: step.imports, if: step.if, acceptance_scope: step.acceptance_scope, write_set: step.write_set, authority_gate: step.authority_gate })), shape: workflowShape(steps), imports: workflowImports(rec(args.workflow), steps), condition_language: CONDITION_LANGUAGE }, validation_hints: workflowValidationHints(steps, diagnostics), policy: { allowed_workflow_kinds: state.allowedWorkflowKinds, allowed_profiles: state.allowedProfiles, allowed_roots: state.allowedRoots } };
}
function expandWorkflowPreset(workflow: JsonRecord): JsonRecord {
  if (Array.isArray(workflow.steps) || Array.isArray(workflow.work_order)) return workflow;
  const strategy = opt(workflow.template_id) ?? opt(workflow.strategy) ?? opt(workflow.template);
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
  };
  const catalogTemplate = workflowTemplateCatalog().find((template) => template.template_id === strategy);
  const catalogSteps = records(catalogTemplate?.steps).map((step) => step.id === 'implement' ? { ...step, instruction: opt(step.instruction) ?? objectiveInstruction } : step);
  return { ...catalogTemplate, ...workflow, template_id: strategy, steps: presets[strategy] ?? catalogSteps };
}
function normalizeWorkflow(value: unknown, state: State): JsonRecord {
  const workflow = rec(value);
  const expanded = expandWorkflowPreset(workflow);
  const workOrder = normalizeWorkOrder(expanded.work_order);
  const declarativeSteps = expandDeclarativeWorkOrder(workOrder);
  const rawSteps = Array.isArray(expanded.steps) ? expanded.steps : Array.isArray(expanded.work_order) ? expanded.work_order : declarativeSteps.length > 0 ? declarativeSteps : Array.isArray(workOrder.steps) ? workOrder.steps : null;
  const steps = rawSteps ? rawSteps.map((step) => normalizeStep(step, state)) : [normalizeStep({ id: 'primary', kind: 'worker' }, state)];
  return { ...expanded, work_order: workOrder, milestones: normalizeMilestones(expanded.milestones, steps), authority_gates: normalizeAuthorityGates(expanded.authority_gates), steps };
}
function normalizeWorkOrder(value: unknown): JsonRecord {
  if (Array.isArray(value)) return { schema: 'narada.delegated_task.work_order.v1', source: 'legacy_step_list', scope: [], budget: {}, verification: {}, acceptance: {}, steps: value };
  const input = rec(value);
  if (Object.keys(input).length === 0) return {};
  const verification = rec(input.verification);
  const acceptance = { ...rec(input.acceptance) };
  if (verification.required_tests !== undefined && acceptance.required_tests === undefined) acceptance.required_tests = verification.required_tests;
  if (verification.focused_tests !== undefined && acceptance.focused_tests === undefined) acceptance.focused_tests = verification.focused_tests;
  if (verification.verification_budget !== undefined && acceptance.verification_budget === undefined) acceptance.verification_budget = verification.verification_budget;
  const items = normalizeWorkOrderItems(input.items);
  const stages = records(input.stages);
  return {
    schema: 'narada.delegated_task.work_order.v1',
    source: 'governing_contract',
    scope: stringList(input.scope),
    budget: rec(input.budget),
    verification,
    acceptance,
    steps: Array.isArray(input.steps) ? input.steps : [],
    items,
    stages,
    stage_policy: rec(input.stage_policy),
    declarative_expansion: Object.keys(input).some((key) => key === 'items' || key === 'stages' || key === 'stage_policy') ? { schema: 'narada.delegated_task.declarative_expansion.v1', expanded: false, item_count: items.length, stage_count: stages.length } : null,
  };
}
function normalizeWorkOrderItems(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = typeof item === 'string' ? { id: item, value: item } : rec(item);
    const id = opt(record.id) ?? opt(record.name) ?? opt(record.path) ?? `item-${index + 1}`;
    return { ...record, id, value: record.value ?? id };
  });
}
function expandDeclarativeWorkOrder(workOrder: JsonRecord): JsonRecord[] {
  const stages = records(workOrder.stages);
  if (stages.length === 0) return [];
  const defaultItems = records(workOrder.items);
  const steps: JsonRecord[] = [];
  const aliases = new Map<string, string[]>();
  for (const stage of stages) {
    const stageId = required(stage.id, 'delegated_task_declarative_stage_requires_id');
    const stageItems = Array.isArray(stage.items) ? normalizeWorkOrderItems(stage.items) : defaultItems;
    const mapMode = stage.map === true || stage.mode === 'map' || stage.each === true;
    const rawDepends = stringList(stage.depends_on).flatMap((dependency) => aliases.get(dependency) ?? [dependency]);
    const common = {
      kind: opt(stage.kind) ?? 'worker',
      profile: stage.profile,
      milestone_id: stage.milestone_id,
      imports: stage.imports,
      if: stage.if,
      acceptance_scope: stage.acceptance_scope,
      constraints: stage.constraints,
      authority_gate: stage.authority_gate,
    };
    let produced: string[] = [];
    if (mapMode) {
      if (stageItems.length === 0) throw diag('delegated_task_declarative_map_requires_items', 'delegated_task_declarative_map_requires_items', { stage_id: stageId });
      for (const item of stageItems) {
        const itemId = safeStepId(String(item.id));
        const stepId = `${stageId}-${itemId}`;
        produced.push(stepId);
        steps.push({
          ...common,
          id: stepId,
          depends_on: rawDepends,
          instruction: renderDeclarativeTemplate(opt(stage.instruction) ?? `Run ${stageId} for {{item.id}}.`, item, stage),
          write_set: renderDeclarativeList(stage.write_set, item, stage),
          declarative: { stage_id: stageId, item_id: item.id, mode: 'map' },
        });
      }
    } else {
      produced = [stageId];
      steps.push({
        ...common,
        id: stageId,
        depends_on: rawDepends,
        instruction: opt(stage.instruction),
        write_set: stringList(stage.write_set),
        declarative: { stage_id: stageId, mode: opt(stage.derive_from) ? 'derive' : 'stage', derive_from: opt(stage.derive_from) },
      });
    }
    aliases.set(stageId, produced);
    const joinSpec = stage.join === true ? { id: `${stageId}-join` } : rec(stage.join);
    if (Object.keys(joinSpec).length > 0) {
      const joinId = opt(joinSpec.id) ?? `${stageId}-join`;
      steps.push({ id: joinId, kind: opt(joinSpec.kind) ?? 'join', depends_on: produced, instruction: opt(joinSpec.instruction), milestone_id: joinSpec.milestone_id ?? stage.milestone_id, declarative: { stage_id: stageId, mode: 'join' } });
      aliases.set(stageId, [joinId]);
      aliases.set(joinId, [joinId]);
    }
  }
  const expansion = rec(workOrder.declarative_expansion);
  workOrder.declarative_expansion = { ...expansion, expanded: true, expanded_step_count: steps.length, stage_ids: stages.map((stage) => opt(stage.id)).filter(Boolean) };
  return steps;
}
function renderDeclarativeTemplate(template: string, item: JsonRecord, stage: JsonRecord): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey).trim();
    if (key === 'item') return String(item.value ?? item.id ?? '');
    if (key.startsWith('item.')) return String(item[key.slice('item.'.length)] ?? '');
    if (key.startsWith('stage.')) return String(stage[key.slice('stage.'.length)] ?? '');
    return '';
  });
}
function renderDeclarativeList(value: unknown, item: JsonRecord, stage: JsonRecord): string[] {
  return stringList(value).map((entry) => renderDeclarativeTemplate(entry, item, stage)).filter(Boolean);
}
function safeStepId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || hash(value).slice(0, 8);
}
function normalizeStep(value: unknown, state?: State): WorkflowStep {
  const step = rec(value);
  const kind = opt(step.kind) ?? 'worker';
  if (state && !state.allowedWorkflowKinds.includes(kind)) throw diag('delegated_task_workflow_kind_not_allowed', 'delegated_task_workflow_kind_not_allowed', { kind, allowed_workflow_kinds: state.allowedWorkflowKinds });
  const profile = opt(step.profile);
  if (state?.allowedProfiles && profile && !state.allowedProfiles.includes(profile)) throw diag('delegated_task_profile_not_allowed', 'delegated_task_profile_not_allowed', { profile, allowed_profiles: state.allowedProfiles });
  return { ...step, id: opt(step.id) ?? `step_${hash(JSON.stringify(step)).slice(0, 8)}`, kind, profile, instruction: opt(step.instruction), milestone_id: opt(step.milestone_id), depends_on: Array.isArray(step.depends_on) ? step.depends_on.map(String).filter(Boolean) : [], imports: stringList(step.imports), if: opt(step.if), acceptance_scope: Array.isArray(step.acceptance_scope) ? step.acceptance_scope.map(String).filter(Boolean) : [], write_set: stringList(step.write_set), constraints: rec(step.constraints), authority_gate: normalizeAuthorityGate(step.authority_gate) };
}
function normalizeMilestones(value: unknown, steps: WorkflowStep[]): JsonRecord[] {
  const explicit = records(value).map((milestone) => ({ ...milestone, id: required(milestone.id, 'delegated_task_milestone_requires_id'), title: required(milestone.title, 'delegated_task_milestone_requires_title'), depends_on: stringList(milestone.depends_on), step_ids: stringList(milestone.step_ids), acceptance_scope: stringList(milestone.acceptance_scope) }));
  if (explicit.length > 0) return explicit;
  const byMilestone = new Map<string, string[]>();
  for (const step of steps) if (step.milestone_id) byMilestone.set(step.milestone_id, [...(byMilestone.get(step.milestone_id) ?? []), step.id]);
  return [...byMilestone.entries()].map(([id, stepIds]) => ({ id, title: id, depends_on: [], step_ids: stepIds, acceptance_scope: [] }));
}
function normalizeAuthorityGate(value: unknown): JsonRecord {
  const gate = rec(value);
  if (Object.keys(gate).length === 0) return {};
  const operation = opt(gate.operation);
  return { operation, mode: opt(gate.mode) ?? 'requires_explicit_authority', reason: opt(gate.reason), required_authority: opt(gate.required_authority) ?? (operation === 'push' ? 'command' : 'write') };
}
function normalizeAuthorityGates(value: unknown): JsonRecord {
  const gates = rec(value);
  if (Object.keys(gates).length === 0) return {};
  return Object.fromEntries(['commit', 'push'].filter((operation) => gates[operation] !== undefined).map((operation) => [operation, normalizeAuthorityGate({ operation, ...rec(gates[operation]) })]));
}
function normalizeExecution(value: unknown): JsonRecord { const input = rec(value); const waitForCompletion = input.wait_for_completion === true; return { start: input.start !== false, wait_for_completion: waitForCompletion, timeout_ms: integer(input.timeout_ms, waitForCompletion ? 30000 : 0, 0, 600000), poll_ms: integer(input.poll_ms, 500, 50, 30000), resumable: input.resumable !== false, exit_interview: input.exit_interview === true, max_concurrency: integer(input.max_concurrency, 10, 1, 32), max_retries: integer(input.max_retries, 0, 0, 10) }; }
function normalizeResultPolicy(value: unknown): JsonRecord { const input = rec(value); return { include_diagnostics_by_default: input.include_diagnostics_by_default === true, expose_worker_refs: input.expose_worker_refs !== false, compact_completed_worker_refs: input.compact_completed_worker_refs === true, max_events: integer(input.max_events, 100, 1, 1000), max_worker_refs: integer(input.max_worker_refs, 50, 1, 1000), max_result_items: integer(input.max_result_items, 200, 1, 5000) }; }
function normalizeAcceptance(value: unknown, workflow: JsonRecord): JsonRecord {
  const base = rec(value);
  const workOrderAcceptance = rec(rec(workflow.work_order).acceptance);
  return {
    ...workOrderAcceptance,
    ...base,
    required_tests: [...acceptanceItems(workOrderAcceptance.required_tests), ...acceptanceItems(base.required_tests)],
    focused_tests: [...acceptanceItems(workOrderAcceptance.focused_tests), ...acceptanceItems(base.focused_tests)],
  };
}
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
function markStep(stepState: StepState, status: StepStatus, summary: string | null): void {
  stepState.status = status;
  stepState.finished_at = now();
  stepState.summary = summary;
  stepState.error = status === 'failed' || status === 'blocked' ? summary : stepState.error;
  if (status !== 'running' && status !== 'pending') {
    stepState.current_run_id = null;
    stepState.active_posture = null;
  }
}
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
  const allowed = CONDITION_LANGUAGE;
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
function conditionSuggestions(condition: string | null, step: WorkflowStep, steps: WorkflowStep[]): string[] {
  const text = String(condition ?? '').trim();
  if (!text) return [];
  const suggestions: string[] = [];
  const firstDependency = step.depends_on[0] ?? steps.find((candidate) => candidate.id !== step.id)?.id;
  if (/^all\(/.test(text) && parseConditionCall(text)?.args.length === 1) suggestions.push('all(<expr>,<expr>) requires at least two expressions; use the single expression directly if only one guard is needed.');
  if (/^any\(/.test(text) && parseConditionCall(text)?.args.length === 1) suggestions.push('any(<expr>,<expr>) requires at least two expressions; use the single expression directly if only one guard is needed.');
  if (/^step:/.test(text) && firstDependency) suggestions.push(`step:${firstDependency}:completed`);
  if (/review/.test(text)) suggestions.push('review_failed');
  if (/accept/.test(text)) suggestions.push('acceptance:passed');
  if (suggestions.length === 0) suggestions.push('always', 'on_success', 'on_failure');
  return uniqueStrings(suggestions).slice(0, 5);
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
  diagnostics.push(...unknownKeyDiagnostics(acceptance, ['required_files', 'required_tests', 'focused_tests', 'verification_budget', 'required_tools', 'forbidden_patterns', 'review_questions', 'review_quorum', 'residual_risk_policy'], 'acceptance'));
  for (const item of acceptanceItems(acceptance.required_files)) {
    if (!String(item.path ?? item.target ?? item.value ?? '').trim()) diagnostics.push({ severity: 'error', code: 'acceptance_required_file_missing_path', item });
  }
  for (const item of acceptanceItems(acceptance.required_tests)) {
    if (!String(item.command ?? item.target ?? item.value ?? '').trim()) diagnostics.push({ severity: 'error', code: 'acceptance_required_test_missing_command', item });
  }
  for (const item of acceptanceItems(acceptance.focused_tests)) {
    if (!String(item.command ?? item.target ?? item.value ?? '').trim()) diagnostics.push({ severity: 'error', code: 'acceptance_focused_test_missing_command', item });
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
  const verificationBudget = rec(acceptance.verification_budget);
  if (Object.keys(verificationBudget).length > 0) {
    if (verificationBudget.max_attempts !== undefined && integer(verificationBudget.max_attempts, 1, 1, Number.MAX_SAFE_INTEGER) !== Number(verificationBudget.max_attempts)) diagnostics.push({ severity: 'error', code: 'acceptance_verification_budget_max_attempts_invalid', value: verificationBudget.max_attempts });
    if (verificationBudget.max_commands !== undefined && integer(verificationBudget.max_commands, 1, 1, Number.MAX_SAFE_INTEGER) !== Number(verificationBudget.max_commands)) diagnostics.push({ severity: 'error', code: 'acceptance_verification_budget_max_commands_invalid', value: verificationBudget.max_commands });
  }
  return diagnostics;
}
function unknownKeyDiagnostics(value: JsonRecord, allowed: string[], scope: string): JsonRecord[] {
  if (Object.keys(value).length === 0) return [];
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).map((key) => ({ severity: 'error', code: `${scope}_unknown_key`, scope, key, allowed }));
}
function workflowShapeDiagnostics(workflow: JsonRecord): JsonRecord[] {
  const diagnostics = unknownKeyDiagnostics(workflow, ['template_id', 'strategy', 'template', 'milestones', 'authority_gates', 'steps', 'work_order', 'imports', 'migration', 'instruction'], 'workflow');
  const workOrder = rec(workflow.work_order);
  diagnostics.push(...unknownKeyDiagnostics(workOrder, ['schema', 'source', 'scope', 'budget', 'verification', 'acceptance', 'steps', 'items', 'stages', 'stage_policy', 'declarative_expansion'], 'workflow_work_order'));
  diagnostics.push(...unknownKeyDiagnostics(rec(workOrder.budget), ['max_worker_runs', 'max_verification_attempts', 'timeout_ms', 'max_minutes', 'allowed_repositories'], 'workflow_work_order_budget'));
  diagnostics.push(...unknownKeyDiagnostics(rec(workOrder.verification), ['required_tests', 'focused_tests', 'verification_budget'], 'workflow_work_order_verification'));
  diagnostics.push(...unknownKeyDiagnostics(rec(rec(workOrder.stage_policy).execution), ['schedule_by_disjoint_write_set'], 'workflow_work_order_stage_policy_execution'));
  for (const stage of records(workOrder.stages)) {
    diagnostics.push(...unknownKeyDiagnostics(stage, ['id', 'kind', 'mode', 'map', 'each', 'items', 'profile', 'instruction', 'milestone_id', 'depends_on', 'imports', 'if', 'acceptance_scope', 'write_set', 'authority_gate', 'constraints', 'join', 'derive_from'], 'workflow_work_order_stage').map((diagnostic) => ({ ...diagnostic, stage_id: stage.id ?? null })));
  }
  const stepValues = Array.isArray(workflow.steps) ? workflow.steps : Array.isArray(workflow.work_order) ? workflow.work_order : Array.isArray(workOrder.steps) ? workOrder.steps : [];
  for (const step of stepValues.map(rec)) {
    diagnostics.push(...unknownKeyDiagnostics(step, ['id', 'kind', 'profile', 'instruction', 'milestone_id', 'depends_on', 'imports', 'if', 'acceptance_scope', 'write_set', 'authority_gate', 'constraints', 'declarative'], 'workflow_step').map((diagnostic) => ({ ...diagnostic, step_id: step.id ?? null })));
  }
  return diagnostics;
}
function gitPublishAuthorityDiagnostics(args: JsonRecord, steps: WorkflowStep[]): JsonRecord[] {
  const constraints = rec(args.constraints);
  const authority = String(constraints.authority ?? 'read');
  const intent = rec(args.intent);
  const texts = [args.objective, intent.objective, intent.instructions, ...steps.flatMap((step) => [step.instruction, rec(step.constraints).instructions])].map((value) => String(value ?? ''));
  const requested = gitPublishRequest(texts);
  if (requested.push && authority !== 'command') return [{
    severity: 'error',
    code: 'git_publish_requires_command_authority',
    authority,
    required_authority: 'command',
    operation: 'push',
    message: 'Delegated tasks that request git push require constraints.authority="command".',
  }];
  if (requested.commit && authority !== 'write' && authority !== 'command') return [{
    severity: 'error',
    code: 'git_publish_requires_write_authority',
    authority,
    required_authority: 'write',
    operation: 'commit',
    message: 'Delegated tasks that request git commit require constraints.authority="write" or "command".',
  }];
  return [];
}
function gitPublishRequest(texts: string[]): { commit: boolean; push: boolean } {
  return texts.reduce((acc, text) => {
    const request = gitPublishRequestFromText(text);
    return { commit: acc.commit || request.commit, push: acc.push || request.push };
  }, { commit: false, push: false });
}
function gitPublishRequestFromText(text: string): { commit: boolean; push: boolean } {
  const lower = text.toLowerCase();
  const safetyText = stripNegatedPublishClauses(lower);
  const push = /\bgit\s+push\b/.test(safetyText) || /\b(commit\s+and\s+push|commit\/push|push\s+the\s+branch)\b/.test(safetyText);
  const commit = /\bgit\s+commit\b/.test(safetyText) || /\b(commit\s+and\s+push|commit\/push)\b/.test(safetyText);
  return { commit, push };
}
function stripNegatedPublishClauses(text: string): string {
  return text
    .replace(/\b(do not|don't|must not|should not|never|without|no)\s+(git\s+)?(commit\s+(or|and|\/)\s+push|commit\/push|commit|push)(\s+the\s+(changes|branch))?\b/g, ' ')
    .replace(/\b(commit\s+(or|and|\/)\s+push|commit\/push|commit|push)\s+(is|are)\s+(not|disallowed|forbidden)\b/g, ' ')
    .replace(/\b(no|without)\s+git\s+(commit|push)\b/g, ' ');
}
function gitTrustDiagnostics(constraints: JsonRecord, steps: WorkflowStep[], state: State): JsonRecord[] {
  if (constraints.skip_git_repo_check === true || rec(constraints.overrides).skip_git_repo_check === true) return [];
  const runtime = opt(rec(constraints.overrides).runtime) ?? opt(constraints.runtime) ?? state.workerState.policy.defaultRuntime;
  if (runtime !== 'codex') return [];
  const cwd = resolve(opt(constraints.cwd) ?? state.allowedRoots[0]);
  if (isGitRepositoryRoot(cwd)) return [];
  const childRepos = directChildGitRepositories(cwd).slice(0, 8);
  if (!steps.some((step) => WORKER_KINDS.has(step.kind)) || childRepos.length === 0) return [];
  return [{
    severity: 'warning',
    code: 'codex_cross_repo_workspace_requires_skip_git_repo_check',
    locus: 'constraints.cwd',
    cwd,
    child_git_repositories: childRepos,
    recommendation: 'Set constraints.skip_git_repo_check=true for read-only cross-repo research DAGs, or use a trusted repository root as cwd.',
  }];
}
function isGitRepositoryRoot(path: string): boolean { return existsSync(join(path, '.git')); }
function directChildGitRepositories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
      .filter(isGitRepositoryRoot);
  } catch { return []; }
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
function summarizeWorkerRef(step: WorkflowStep, result: JsonRecord): JsonRecord { return { step_id: step.id, step_kind: step.kind, run_id: result.run_id, worker_session_id: result.worker_session_id ?? null, status: String(result.status ?? 'unknown'), confidence: result.confidence ?? null, summary: result.summary ?? '', run_dir: result.run_dir, output_ref: result.output_ref ?? null, result_ref: result.result_ref ?? null, write_set: step.write_set, declarative: rec(step).declarative ?? null }; }
function summarizeWorkerOutput(output: JsonRecord): JsonRecord { return { summary: output.summary ?? '', deliverables: output.deliverables ?? [], changes: output.changes ?? [], changed_files: output.changed_files ?? [], nested_workflows: nestedWorkflowRecords(output), verification_results: output.verification_results ?? output.verification ?? [], residual_risks: output.residual_risks ?? [], observed_incoherencies: output.observed_incoherencies ?? [], exit_interview: output.exit_interview ?? null, review_verdict: output.review_verdict ?? null, acceptance_verdict: output.acceptance_verdict ?? null, verdict: output.verdict ?? null, error: output.error ?? null, error_classification: output.error_classification ?? null, diagnostic_tail: output.diagnostic_tail ?? null, runtime_warnings: output.runtime_warnings ?? [], completion_state: output.completion_state ?? null }; }
function nestedWorkflowRecords(output: JsonRecord): JsonRecord[] { return uniqueRecords([...recordList(output.nested_workflows), ...recordList(output.nested_workflow), ...recordList(output.nested_tasks), ...recordList(output.nested_task_results)]); }
function buildWorkerArgs(task: Task, step: WorkflowStep, state: State): JsonRecord {
  const constraints = { ...task.constraints, ...step.constraints };
  const cwd = opt(constraints.cwd) ?? state.allowedRoots[0];
  const workerConstraints: JsonRecord = { ...constraints, cwd, resumable: task.execution.resumable !== false, exit_interview: task.execution.exit_interview === true || constraints.exit_interview === true };
  const overrides = { ...rec(workerConstraints.overrides) };
  for (const key of ['runtime', 'model', 'reasoning_effort', 'sandbox', 'skip_git_repo_check']) {
    if (workerConstraints[key] !== undefined) overrides[key] = workerConstraints[key];
    delete workerConstraints[key];
  }
  for (const key of ['max_concurrency', 'max_retries', 'profile', 'repair_policy']) delete workerConstraints[key];
  if (Object.keys(overrides).length > 0) workerConstraints.overrides = overrides;
  else delete workerConstraints.overrides;
  return { intent: { instruction: workerInstruction(task, step), mode: step.kind === 'review' || step.kind === 'verify' ? 'audit_only' : step.kind === 'research' ? 'audit_only' : undefined }, constraints: workerConstraints };
}
function workerInstruction(task: Task, step: WorkflowStep): string { return [`Delegated task objective: ${task.objective}`, step.instruction ? `Step instruction: ${step.instruction}` : null, `Step id: ${step.id}`, `Step kind: ${step.kind}`, step.write_set.length > 0 ? `Step write_set: ${JSON.stringify(step.write_set)}` : null, Object.keys(rec(task.workflow.work_order)).length > 0 ? `Work order: ${JSON.stringify(task.workflow.work_order)}` : null, `Acceptance: ${JSON.stringify(task.acceptance)}`, step.kind === 'review' ? 'Review output contract: include review_verdict as one of accepted, rejected, or accepted_with_findings.' : null, 'Return a concise result with changes, verification, residual risks, and observed incoherencies.'].filter((line): line is string => Boolean(line)).join('\n'); }
function progressSummary(task: Task, states = stepStateMap(task)): JsonRecord {
  const counts = stepStatusCounts(task, states);
  const runningSteps = Object.values(states).filter((step) => step.status === 'running');
  if (TERMINAL.has(task.status)) {
    const terminalCounts = { ...counts, running: 0 };
    return { total: Object.keys(states).length, ...terminalCounts, running_run_ids: [], historical_run_ids: historicalRunIds(states), terminal_running_step_ids: runningSteps.map((step) => step.step_id), liveness: 'terminal_no_active_execution' };
  }
  return { total: Object.keys(states).length, ...counts, running_run_ids: runningSteps.map((step) => step.current_run_id).filter(Boolean), historical_run_ids: historicalRunIds(states), liveness: runningSteps.length > 0 ? 'active_worker_runs' : 'active_queue_no_running_worker' };
}
function activeStepIds(task: Task): string[] { return Object.entries(stepStateMap(task)).filter(([, step]) => step.status === 'running').map(([stepId]) => stepId); }
function activeStepPosture(task: Task): JsonRecord[] { if (TERMINAL.has(task.status)) return []; return Object.values(stepStateMap(task)).filter((step) => step.status === 'running').map((step) => step.active_posture ? rec(step.active_posture) : fallbackActivePosture(step)); }
function schedulerState(task: Task): JsonRecord {
  const states = stepStateMap(task);
  const running = Object.values(states).filter((step) => step.status === 'running');
  const ready = readyPendingSteps(task, states);
  const writeSetConflicts = writeSetConflictSummary(task, states);
  const pending = Object.values(states).filter((step) => step.status === 'pending');
  const blocked = Object.values(states).filter((step) => step.status === 'blocked');
  let state = 'active_queue_no_running_worker';
  let nextAction = ready.length > 0 ? 'advance_ready_steps' : 'wait_for_dependencies_or_inspect';
  if (TERMINAL.has(task.status)) {
    state = 'terminal_no_active_execution';
    nextAction = terminalNextAction(task.status, String(rec(task.result).acceptance_verdict ?? 'pending'), String(closeoutSynthesis(task.result).next_action));
  } else if (running.length > 0) {
    state = 'active_worker_runs';
    nextAction = 'wait_or_refresh_running_workers';
  } else if (ready.length > 0) {
    state = 'ready_pending_steps';
  } else if (pending.length > 0 || blocked.length > 0) {
    state = 'blocked_or_waiting_dependencies';
  }
  return {
    schema: 'narada.delegated_task.scheduler_state.v1',
    state,
    next_action: nextAction,
    active_run_ids: running.map((step) => step.current_run_id).filter(Boolean),
    running_step_ids: running.map((step) => step.step_id),
    ready_step_ids: ready.map((step) => step.id),
    write_set_scheduling: writeSetSchedulingEnabled(task),
    write_set_conflicts: writeSetConflicts,
    pending_step_ids: pending.map((step) => step.step_id),
    blocked_step_ids: blocked.map((step) => step.step_id),
  };
}
function readyPendingSteps(task: Task, states = stepStateMap(task)): WorkflowStep[] {
  return workflowSteps(task.workflow).filter((step) => {
    const stepState = states[step.id] ?? initialStepState(step);
    if (stepState.status !== 'pending') return false;
    const dependency = dependencyStatus(step, states);
    if (!dependency.ready || dependency.blocked.length > 0) return false;
    if (writeSetConflictForStep(task, step, states).conflict) return false;
    return evaluateCondition(step.if, task, states).pass;
  });
}
function writeSetSchedulingEnabled(task: Task): boolean {
  return rec(rec(rec(rec(task.workflow).work_order).stage_policy).execution).schedule_by_disjoint_write_set === true;
}
function writeSetConflictForStep(task: Task, step: WorkflowStep, states: Record<string, StepState>, selected: WorkflowStep[] = []): JsonRecord {
  if (!writeSetSchedulingEnabled(task) || step.write_set.length === 0) return { conflict: false, conflicting_step_ids: [], write_set: step.write_set };
  const runningIds = Object.values(states).filter((state) => state.status === 'running').map((state) => state.step_id);
  const candidateIds = [...runningIds, ...selected.map((item) => item.id)];
  const byId = new Map(workflowSteps(task.workflow).map((item) => [item.id, item]));
  const conflicts = candidateIds.filter((candidateId) => {
    const candidate = byId.get(candidateId);
    if (!candidate || candidate.id === step.id) return false;
    return writeSetsOverlap(step.write_set, candidate.write_set);
  });
  return { conflict: conflicts.length > 0, conflicting_step_ids: conflicts, write_set: step.write_set };
}
function writeSetConflictSummary(task: Task, states: Record<string, StepState>): JsonRecord[] {
  if (!writeSetSchedulingEnabled(task)) return [];
  return workflowSteps(task.workflow).filter((step) => (states[step.id] ?? initialStepState(step)).status === 'pending').map((step) => ({ step_id: step.id, ...writeSetConflictForStep(task, step, states) } as JsonRecord)).filter((item) => item.conflict === true);
}
function writeSetsOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  return left.some((leftItem) => right.some((rightItem) => writeSetItemOverlaps(leftItem, rightItem)));
}
function writeSetItemOverlaps(left: string, right: string): boolean {
  const a = left.replaceAll('\\', '/').replace(/\/+$/g, '');
  const b = right.replaceAll('\\', '/').replace(/\/+$/g, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function normalizedOperatorPosture(task: Task): JsonRecord {
  const result = rec(task.result);
  const terminal = TERMINAL.has(task.status);
  const acceptanceVerdict = String(result.acceptance_verdict ?? 'pending');
  const nextAction = closeoutSynthesis(result).next_action;
  const scheduler = schedulerState(task);
  const acknowledged = isAcknowledged(task);
  const superseded = isSupersededByParent(task);
  const listCategory = !terminal ? 'active_queue' : acknowledged ? 'acknowledged_archive' : 'terminal_history';
  const operatorCategory = superseded ? 'archive_superseded_by_parent'
    : acknowledged ? 'archive_acknowledged'
      : task.status === 'cancelled' ? 'operator_inbox_cancelled'
    : terminal && acceptanceVerdict === 'passed' ? 'archive_ready_for_acknowledgement'
      : terminal ? 'operator_inbox_terminal_attention'
        : 'operator_inbox_active';
  return {
    schema: 'narada.delegated_task.operator_posture.v1',
    task_status: task.status,
    acceptance_verdict: acceptanceVerdict,
    lifecycle_state: lifecycleState(task),
    list_category: listCategory,
    operator_category: operatorCategory,
    active: !terminal,
    terminal,
    acknowledged,
    superseded_by_parent: superseded,
    active_execution: !terminal && activeStepPosture(task).length > 0,
    terminal_posture: terminal ? 'no_active_execution' : null,
    scheduler_state: scheduler,
    running_run_ids: terminal ? [] : stringList(rec(result.progress).running_run_ids),
    historical_run_ids: stringList(rec(result.progress).historical_run_ids).length > 0 ? stringList(rec(result.progress).historical_run_ids) : historicalRunIds(stepStateMap(task)),
    active_step_count: activeStepPosture(task).length,
    next_action: superseded ? 'superseded_by_parent' : acknowledged ? 'archived_acknowledged' : terminal ? terminalNextAction(task.status, acceptanceVerdict, String(nextAction)) : String(scheduler.next_action ?? nextAction),
  };
}
function historicalRunIds(states: Record<string, StepState>): string[] { return uniqueStrings(Object.values(states).flatMap((step) => step.run_ids)); }
function terminalNextAction(status: TaskStatus, acceptanceVerdict: string, nextAction: string): string {
  if (nextAction === 'archived_acknowledged') return nextAction;
  if (nextAction === 'superseded_by_parent') return nextAction;
  if (status === 'cancelled') return 'acknowledge_cancelled_history';
  if (acceptanceVerdict === 'passed') return 'acknowledge_closeout';
  if (acceptanceVerdict === 'failed') return nextAction === 'repair_failed_review' ? nextAction : 'inspect_terminal_failure';
  return 'inspect_terminal_pending_acceptance';
}
function lifecycleState(task: Task): string {
  if (isAcknowledged(task)) return 'acknowledged_archive';
  if (isSupersededByParent(task)) return 'superseded_by_parent';
  if (!TERMINAL.has(task.status)) return 'active_queue';
  return 'operator_inbox';
}
function lifecycleSummary(task: Task): JsonRecord {
  const result = rec(task.result);
  const acknowledgement = rec(result.lifecycle_acknowledgement);
  const takeover = rec(result.parent_takeover);
  return {
    schema: 'narada.delegated_task.lifecycle.v1',
    state: lifecycleState(task),
    active_queue: !TERMINAL.has(task.status),
    operator_inbox: TERMINAL.has(task.status) && !isAcknowledged(task),
    terminal_history: TERMINAL.has(task.status),
    acknowledged_archive: isAcknowledged(task),
    active_execution: !TERMINAL.has(task.status) && activeStepPosture(task).length > 0,
    terminal_posture: TERMINAL.has(task.status) ? 'no_active_execution' : null,
    superseded_by_parent: isSupersededByParent(task),
    acknowledged_at: opt(acknowledgement.acknowledged_at),
    acknowledged_by: opt(acknowledgement.acknowledged_by),
    parent_takeover: Object.keys(takeover).length > 0 ? takeover : null,
  };
}
function isAcknowledged(task: Task): boolean { return Object.keys(rec(rec(task.result).lifecycle_acknowledgement)).length > 0; }
function isSupersededByParent(task: Task): boolean { return Object.keys(rec(rec(task.result).parent_takeover)).length > 0; }
function lifecycleViewIncludes(view: string, task: Task, includeAcknowledged: boolean): boolean {
  const terminal = TERMINAL.has(task.status);
  if (view === 'all') return includeAcknowledged || !isAcknowledged(task);
  if (view === 'active_queue') return !terminal;
  if (view === 'operator_inbox') return terminal && !isAcknowledged(task);
  if (view === 'history') return terminal && (includeAcknowledged || !isAcknowledged(task));
  if (view === 'acknowledged_archive') return terminal && isAcknowledged(task);
  return !terminal;
}
function lifecycleQueueSummary(tasks: Task[]): JsonRecord {
  const byOwnerSite: Record<string, JsonRecord> = {};
  for (const task of tasks) {
    const ownership = ownershipProjection(task);
    const owner = String(ownership.owner_site_id ?? 'unknown');
    const current = rec(byOwnerSite[owner]);
    byOwnerSite[owner] = {
      owner_site_id: owner,
      visibility_scope: ownership.visibility_scope,
      active_queue: Number(current.active_queue ?? 0) + (!TERMINAL.has(task.status) ? 1 : 0),
      operator_inbox: Number(current.operator_inbox ?? 0) + (TERMINAL.has(task.status) && !isAcknowledged(task) ? 1 : 0),
      terminal_history: Number(current.terminal_history ?? 0) + (TERMINAL.has(task.status) ? 1 : 0),
      acknowledged_archive: Number(current.acknowledged_archive ?? 0) + (isAcknowledged(task) ? 1 : 0),
      superseded_by_parent: Number(current.superseded_by_parent ?? 0) + (isSupersededByParent(task) ? 1 : 0),
    };
  }
  return {
    schema: 'narada.delegated_task.queue_summary.v1',
    active_queue: tasks.filter((task) => !TERMINAL.has(task.status)).length,
    operator_inbox: tasks.filter((task) => TERMINAL.has(task.status) && !isAcknowledged(task)).length,
    terminal_history: tasks.filter((task) => TERMINAL.has(task.status)).length,
    acknowledged_archive: tasks.filter(isAcknowledged).length,
    superseded_by_parent: tasks.filter(isSupersededByParent).length,
    by_owner_site: byOwnerSite,
  };
}
function newTaskOwnership(state: State): Pick<Task, 'owner_site_id' | 'owner_site_root' | 'created_by_site_id' | 'visibility_scope' | 'task_root_scope'> {
  return {
    owner_site_id: state.currentSiteId,
    owner_site_root: state.currentSiteId ? state.siteRoot : null,
    created_by_site_id: state.currentSiteId,
    visibility_scope: state.currentSiteId ? 'site' : 'user_global',
    task_root_scope: taskRootScope(state),
  };
}
function ownershipProjection(task: Task): JsonRecord {
  const ownerSiteId = opt(task.owner_site_id);
  const ownerSiteRoot = opt(task.owner_site_root);
  const createdBySiteId = opt(task.created_by_site_id);
  const hasOwnership = ownerSiteId || ownerSiteRoot || createdBySiteId || task.visibility_scope !== undefined || task.task_root_scope !== undefined;
  if (!hasOwnership) {
    return { owner_site_id: 'unknown', owner_site_root: null, created_by_site_id: 'unknown', visibility_scope: 'user_global_legacy', task_root_scope: 'unknown', ownership_resolution: 'legacy_missing_metadata' };
  }
  return {
    owner_site_id: ownerSiteId ?? 'unknown',
    owner_site_root: ownerSiteRoot ?? null,
    created_by_site_id: createdBySiteId ?? 'unknown',
    visibility_scope: opt(task.visibility_scope) ?? (ownerSiteId ? 'site' : 'user_global'),
    task_root_scope: opt(task.task_root_scope) ?? 'unknown',
    ownership_resolution: ownerSiteId ? 'explicit' : 'unknown_owner',
  };
}
function normalizeSiteScope(value: unknown, state: State): string {
  const input = opt(value);
  if (input === 'current_site' || input === 'all_sites' || input === 'user_global') return input;
  return state.currentSiteId ? 'current_site' : 'user_global';
}
function siteScopeIncludes(siteScope: string, task: Task, state: State, ownerSiteId: string | null): boolean {
  const ownership = ownershipProjection(task);
  const owner = String(ownership.owner_site_id ?? 'unknown');
  if (ownerSiteId && owner !== ownerSiteId) return false;
  if (siteScope === 'all_sites') return true;
  if (siteScope === 'user_global') return String(ownership.visibility_scope) === 'user_global' || String(ownership.visibility_scope) === 'user_global_legacy' || owner === 'unknown';
  if (!state.currentSiteId) return String(ownership.visibility_scope) === 'user_global' || String(ownership.visibility_scope) === 'user_global_legacy' || owner === 'unknown';
  return owner === state.currentSiteId;
}
function assertMutationSiteScope(task: Task, state: State, args: JsonRecord): JsonRecord {
  const ownership = ownershipProjection(task);
  const owner = opt(ownership.owner_site_id);
  const expectedOwner = opt(args.expected_owner_site_id);
  if (expectedOwner && owner !== expectedOwner) {
    throw diag('delegated_task_owner_site_mismatch', `delegated_task_owner_site_mismatch:${task.task_id}`, { task_id: task.task_id, expected_owner_site_id: expectedOwner, owner_site_id: owner, visibility_scope: ownership.visibility_scope });
  }
  const crossSite = state.currentSiteId && owner && owner !== state.currentSiteId;
  const legacyGlobal = owner === 'unknown' || ownership.visibility_scope === 'user_global_legacy';
  if ((crossSite || legacyGlobal) && args.allow_cross_site !== true) {
    throw diag('delegated_task_cross_site_mutation_denied', `delegated_task_cross_site_mutation_denied:${task.task_id}`, { task_id: task.task_id, current_site_id: state.currentSiteId, owner_site_id: owner, visibility_scope: ownership.visibility_scope, required_override: 'allow_cross_site' });
  }
  return ownership;
}
function fallbackActivePosture(step: StepState): JsonRecord { return { step_id: step.step_id, step_kind: step.kind, run_id: step.current_run_id, worker_session_id: step.worker_session_id, worker_status: 'running', status_liveness: 'unknown', worker_progress_state: null, budget_status: null, recent_activity_preview: [], recommended_action: 'refresh_status', latest_event_kind: null, latest_event_preview: null, heartbeat_age_ms: ageMs(step.started_at), expected_timeout_ms: null, deadline_at: null, deadline_in_ms: null, runtime: null, provider: null };
}
function workerActivePosture(step: StepState, result: JsonRecord): JsonRecord {
  const progress = rec(result.progress);
  const liveness = rec(result.status_liveness);
  const progressState = rec(result.progress_state);
  const budgetStatus = rec(result.budget_status);
  const resolvedConfig = rec(result.resolved_worker_config);
  const timing = rec(result.timing);
  const startedAt = opt(liveness.started_at) ?? opt(timing.started_at) ?? step.started_at;
  const lastActivityAt = opt(liveness.last_activity_at) ?? opt(progress.latest_event_at) ?? startedAt;
  const maxRunMs = numberOrNull(liveness.max_run_ms ?? resolvedConfig.max_run_ms);
  const deadlineAt = startedAt && maxRunMs !== null ? isoAfter(startedAt, maxRunMs) : null;
  return {
    step_id: step.step_id,
    step_kind: step.kind,
    run_id: step.current_run_id,
    worker_session_id: opt(result.worker_session_id) ?? step.worker_session_id,
    worker_status: String(result.status ?? 'running'),
    runtime: opt(result.runtime) ?? opt(resolvedConfig.runtime),
    provider: opt(result.provider) ?? opt(resolvedConfig.provider),
    status_liveness: opt(liveness.state) ?? 'unknown',
    process_liveness: opt(liveness.process_liveness),
    worker_progress_state: Object.keys(progressState).length > 0 ? progressState : null,
    budget_status: Object.keys(budgetStatus).length > 0 ? budgetStatus : null,
    recent_activity_preview: records(result.recent_activity).slice(-3),
    recommended_action: opt(progressState.recommended_action) ?? (opt(liveness.state) === 'stale' ? 'inspect_artifacts' : 'wait'),
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    heartbeat_age_ms: ageMs(lastActivityAt),
    latest_event_kind: opt(progress.latest_event_type),
    latest_event_preview: opt(progress.latest_event_preview),
    latest_event_at: opt(progress.latest_event_at),
    event_count: typeof progress.event_count === 'number' ? progress.event_count : null,
    expected_timeout_ms: maxRunMs,
    deadline_at: deadlineAt,
    deadline_in_ms: deadlineAt ? Math.max(0, Date.parse(deadlineAt) - Date.now()) : null,
    stale_for_ms: numberOrNull(liveness.stale_for_ms),
  };
}
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function ageMs(timestamp: string | null | undefined): number | null { const parsed = Date.parse(String(timestamp ?? '')); return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null; }
function isoAfter(timestamp: string, deltaMs: number): string | null { const parsed = Date.parse(timestamp); return Number.isFinite(parsed) ? new Date(parsed + deltaMs).toISOString() : null; }
function stepStatusCounts(task: Task, states?: Record<string, StepState>): JsonRecord { const counts: Record<string, number> = {}; for (const step of Object.values(states ?? stepStateMap(task))) counts[step.status] = (counts[step.status] ?? 0) + 1; return counts; }
function summaryForTask(task: Task, states: Record<string, StepState>, acceptance: { verdict: string }): string { const progress = progressSummary(task, states); return `delegated task ${task.status}; steps=${progress.total}; acceptance=${acceptance.verdict}`; }
function stepCounts(workflow: JsonRecord): JsonRecord { const by_kind: Record<string, number> = {}; const steps = workflowSteps(workflow); for (const step of steps) by_kind[step.kind] = (by_kind[step.kind] ?? 0) + 1; return { total: steps.length, by_kind }; }
function count(value: unknown): number { return Array.isArray(value) ? value.length : 0; }
function acceptanceSummary(acceptance: JsonRecord): JsonRecord { return { required_files: count(acceptance.required_files), required_tests: count(acceptance.required_tests), required_tools: count(acceptance.required_tools), forbidden_patterns: count(acceptance.forbidden_patterns) }; }
function workflowEngineMetadata(): JsonRecord { return { schema: 'narada.delegated_task.workflow_engine.v1', workflow_kinds: DEFAULT_WORKFLOW_KINDS, local_kinds: [...LOCAL_KINDS], worker_kinds: [...WORKER_KINDS], supports_dag: true, supports_imports: true, supports_review_quorum: true, milestone_support: { workflow_milestones: true, step_milestone_id: true }, authority_gate_support: { commit: 'modeled_only', push: 'modeled_only', delegated_task_executes_git: false }, template_catalog_schema: 'narada.delegated_task.template_catalog.v1' }; }
function workflowTemplateCatalog(): JsonRecord[] {
  return [
    { template_id: 'implement', strategy: 'implement', title: 'Single implementation worker', feedback_ids: ['sfb_f1ea42cb-062', 'sfb_ac8a8731-f1c'], milestones: [{ id: 'implement', title: 'Implement', step_ids: ['implement'] }], steps: [{ id: 'implement', kind: 'worker', milestone_id: 'implement' }], worker_delegation_contract: workerDelegationContract(['worker']) },
    { template_id: 'implement_review', strategy: 'implement_review', title: 'Implementation with review quorum evidence', feedback_ids: ['sfb_f1ea42cb-062', 'sfb_ac8a8731-f1c', 'sfb_7e043d77-074'], milestones: [{ id: 'implement', title: 'Implement', step_ids: ['implement'] }, { id: 'review', title: 'Review', depends_on: ['implement'], step_ids: ['review'] }], steps: [{ id: 'implement', kind: 'worker', milestone_id: 'implement' }, { id: 'review', kind: 'review', milestone_id: 'review', depends_on: ['implement'] }], worker_delegation_contract: workerDelegationContract(['worker', 'review']) },
    { template_id: 'research_synthesize', strategy: 'research_synthesize', title: 'Research, synthesize, and review', feedback_ids: ['sfb_074b9629-4a8', 'sfb_f1ea42cb-062'], milestones: [{ id: 'research', title: 'Research', step_ids: ['research'] }, { id: 'synthesize', title: 'Synthesize', depends_on: ['research'], step_ids: ['synthesize', 'review'] }], steps: [{ id: 'research', kind: 'research', milestone_id: 'research' }, { id: 'synthesize', kind: 'worker', milestone_id: 'synthesize', depends_on: ['research'] }, { id: 'review', kind: 'review', milestone_id: 'synthesize', depends_on: ['synthesize'] }], worker_delegation_contract: workerDelegationContract(['research', 'worker', 'review']) },
    { template_id: 'implement_review_repair_verify', strategy: 'implement_review_repair_verify', title: 'Implementation, review, conditional repair, and verify', feedback_ids: ['sfb_6924c7b3-48f', 'sfb_074b9629-4a8', 'sfb_f1ea42cb-062', 'sfb_ac8a8731-f1c', 'sfb_7e043d77-074'], milestones: [{ id: 'implement', title: 'Implement', step_ids: ['implement'] }, { id: 'review', title: 'Review', depends_on: ['implement'], step_ids: ['review'] }, { id: 'repair', title: 'Repair if needed', depends_on: ['review'], step_ids: ['repair'] }, { id: 'verify', title: 'Verify', depends_on: ['repair'], step_ids: ['verify'] }], steps: [{ id: 'implement', kind: 'worker', milestone_id: 'implement' }, { id: 'review', kind: 'review', milestone_id: 'review', depends_on: ['implement'] }, { id: 'repair', kind: 'repair', milestone_id: 'repair', depends_on: ['review'], if: 'review_failed' }, { id: 'verify', kind: 'verify', milestone_id: 'verify', depends_on: ['repair'] }], authority_gates: normalizeAuthorityGates({ commit: { mode: 'requires_explicit_authority', reason: 'commit is modeled as an explicit gate and is never executed by delegated-task-mcp' }, push: { mode: 'requires_explicit_authority', required_authority: 'command', reason: 'push must stay opt-in and owned by caller policy or worker constraints' } }), worker_delegation_contract: workerDelegationContract(['worker', 'review', 'repair', 'verify']) },
    { template_id: 'commit_push_guarded', strategy: 'commit_push_guarded', title: 'Review-gated commit and push publication handoff', feedback_ids: ['sfb_98a64342-379', 'sfb_7e043d77-074'], milestones: [{ id: 'prepare', title: 'Prepare evidence', step_ids: ['prepare'] }, { id: 'review', title: 'Review publication readiness', depends_on: ['prepare'], step_ids: ['review'] }, { id: 'publication-gate', title: 'Publication authority gate', depends_on: ['review'], step_ids: ['commit-gate', 'push-gate'] }], authority_gates: normalizeAuthorityGates({ commit: { mode: 'requires_explicit_authority', required_authority: 'write', reason: 'commit only after explicit caller authority' }, push: { mode: 'requires_explicit_authority', required_authority: 'command', reason: 'push only after explicit command authority' } }), steps: [{ id: 'prepare', kind: 'worker', milestone_id: 'prepare' }, { id: 'review', kind: 'review', milestone_id: 'review', depends_on: ['prepare'] }, { id: 'commit-gate', kind: 'gate', milestone_id: 'publication-gate', depends_on: ['review'], if: 'all(step:review:completed,no_residual_risks)', authority_gate: { operation: 'commit', mode: 'requires_explicit_authority', required_authority: 'write' } }, { id: 'push-gate', kind: 'gate', milestone_id: 'publication-gate', depends_on: ['commit-gate'], if: 'acceptance:passed', authority_gate: { operation: 'push', mode: 'requires_explicit_authority', required_authority: 'command' } }], worker_delegation_contract: workerDelegationContract(['worker', 'review']) },
  ];
}
function compactTemplate(template: JsonRecord): JsonRecord { return { template_id: template.template_id, strategy: template.strategy, title: template.title ?? template.description, milestone_count: records(template.milestones).length, step_count: records(template.steps).length, feedback_ids: template.feedback_ids, authority_gates: template.authority_gates ?? {}, worker_delegation_contract: template.worker_delegation_contract }; }
function workerDelegationContract(kinds: string[]): JsonRecord { return { surface_id: 'worker-delegation', routed_feedback_ids: ['sfb_7e043d77-074'], caller_sets_worker_constraints: true, worker_run_is_child_execution: true, required_worker_output_fields: ['summary', 'changes', 'verification', 'residual_risks', 'observed_incoherencies'], step_kinds: kinds }; }
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
    else if (ref.status === 'completed' && reviewRefHasExplicitFailure(ref)) failed += 1;
    else if (ref.status === 'completed' && reviewRefHasExplicitPass(ref)) passed += 1;
    else if (ref.status === 'completed' && reviewRefHasImplicitPass(ref)) passed += 1;
    else if (ref.status === 'completed') running += 1;
    else failed += 1;
  }
  return { passed, failed, running };
}
function reviewRefHasExplicitPass(ref: JsonRecord): boolean {
  const output = rec(ref.output);
  const verdicts = reviewVerdicts(ref, output);
  return verdicts.some((value) => value === 'passed' || value === 'accepted' || value === 'accepted_with_findings' || value === 'accept_with_notes' || value === 'accepted_with_notes');
}
function reviewVerdicts(ref: JsonRecord, output = rec(ref.output)): string[] {
  const summary = String(ref.summary ?? output.summary ?? '');
  const summaryJson = parseSummaryObject(summary);
  const keyValueVerdict = /\breview_verdict\s*[:=]\s*([a-z_]+)/i.exec(summary)?.[1];
  return [
    ref.review_verdict,
    ref.acceptance_verdict,
    ref.verdict,
    output.review_verdict,
    output.acceptance_verdict,
    output.verdict,
    summaryJson.review_verdict,
    summaryJson.acceptance_verdict,
    summaryJson.verdict,
    keyValueVerdict,
  ].map((value) => String(value ?? '').toLowerCase());
}
function parseSummaryObject(summary: string): JsonRecord {
  const trimmed = summary.trim();
  if (!trimmed.startsWith('{')) return {};
  try { return rec(JSON.parse(trimmed)); } catch { return {}; }
}
function reviewRefHasExplicitFailure(ref: JsonRecord): boolean {
  const output = rec(ref.output);
  const verdicts = reviewVerdicts(ref, output);
  if (verdicts.some((value) => value === 'failed' || value === 'contradicted' || value === 'rejected')) return true;
  const summary = String(ref.summary ?? output.summary ?? '').toLowerCase();
  if (/\b(verdict\s*:\s*)?(rejected|failed)\b/.test(summary)) return true;
  return records(output.changes).some((change) => /^(failed_review|rejected|failed)$/.test(String(change.status ?? '').toLowerCase()));
}
function reviewRefHasImplicitPass(ref: JsonRecord): boolean {
  const output = rec(ref.output);
  if (stringList(output.residual_risks).length > 0 || stringList(output.observed_incoherencies).length > 0 || Boolean(output.error)) return false;
  if (records(output.changes).some((change) => /^(finding|findings|failed_review|rejected|failed)$/.test(String(change.status ?? '').toLowerCase()))) return false;
  const summary = String(ref.summary ?? output.summary ?? '').toLowerCase();
  return /\b(passed|passes|pass)\b/.test(summary) && /\b(required|checks?|audit|review|structure|privacy|content|forbidden)\b/.test(summary);
}
function synthesizeJoinStep(step: WorkflowStep, refs: JsonRecord[]): JsonRecord {
  const summaries = refs.map((ref) => String(ref.summary ?? rec(ref.output).summary ?? '')).filter(Boolean);
  const changed = uniqueStrings(refs.flatMap((ref) => {
    const output = rec(ref.output);
    return [...stringList(output.changed_files), ...records(output.changes).map((change) => String(change.path ?? '')).filter(Boolean)];
  }));
  const risks = uniqueStrings(refs.flatMap((ref) => stringList(rec(ref.output).residual_risks)));
  const incoherencies = uniqueStrings(refs.flatMap((ref) => stringList(rec(ref.output).observed_incoherencies)));
  const failed = refs.filter((ref) => String(ref.status ?? '') !== 'completed').map((ref) => String(ref.step_id ?? ref.run_id ?? 'unknown'));
  const review = reviewConsensus({ worker_refs: refs });
  const agreements = summaries.length > 0 && failed.length === 0 ? ['all_joined_workers_returned_terminal_summaries'] : [];
  const disagreements = failed.map((stepId) => `worker_not_completed:${stepId}`);
  if (review.disagreement) disagreements.push('review_verdict_disagreement');
  const evidenceCount = refs.reduce((count, ref) => {
    const output = rec(ref.output);
    return count + records(output.verification_results).length + records(output.verification).length + stringList(output.changed_files).length + records(output.changes).length;
  }, 0);
  return {
    schema: 'narada.delegated_task.join_synthesis.v1',
    step_id: step.id,
    dependency_step_ids: step.depends_on,
    worker_ref_count: refs.length,
    agreements,
    disagreements,
    risks,
    changed_files_by_source: { worker_reported: changed },
    recommended_next_action: failed.length > 0 || risks.length > 0 || incoherencies.length > 0 ? 'inspect_joined_worker_outputs' : 'continue_or_closeout',
    confidence: refs.length === step.depends_on.length && failed.length === 0 ? 'medium' : 'low',
    evidence_coverage: { dependency_count: step.depends_on.length, joined_worker_ref_count: refs.length, evidence_item_count: evidenceCount },
    worker_summaries: refs.map(compactWorkerRef),
  };
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
    steps_terminal: result.steps_terminal ?? false,
    acceptance_terminal: result.acceptance_terminal ?? false,
    pending_acceptance_items: records(result.pending_acceptance_items),
    pending_review_items: records(result.pending_review_items),
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
    worker_terminal_diagnostic_count: integer(result.worker_terminal_diagnostic_count, records(result.worker_terminal_diagnostics).length, 0, 1000000),
    exit_interview_count: integer(result.exit_interview_count, records(result.exit_interviews).length, 0, 1000000),
  };
}
function terminalSemantics(task: Task, stepStates: Record<string, StepState>, result: JsonRecord): JsonRecord {
  const states = Object.values(stepStates);
  const stepsTerminal = states.length > 0 && states.every((step) => step.status !== 'pending' && step.status !== 'running');
  const acceptanceVerdict = String(result.acceptance_verdict ?? 'pending');
  const acceptanceTerminal = ['passed', 'failed', 'cancelled'].includes(acceptanceVerdict);
  return {
    workflow_status: task.status,
    steps_terminal: stepsTerminal,
    acceptance_terminal: acceptanceTerminal,
    pending_acceptance_items: pendingAcceptanceItems(result),
    pending_review_items: pendingReviewItems(result),
  };
}
function pendingAcceptanceItems(result: JsonRecord): JsonRecord[] {
  const verdict = String(result.acceptance_verdict ?? 'pending');
  if (verdict !== 'pending') return [];
  const checks = records(result.acceptance_evidence);
  if (checks.length === 0) return [{ kind: 'acceptance_contract', status: 'pending', reason: 'no_acceptance_evidence_recorded' }];
  return checks.filter((check) => check.status === 'pending' || check.status === 'failed').map((check) => ({ ...check, reason: check.status === 'pending' ? 'acceptance_check_pending' : 'acceptance_check_failed' }));
}
function pendingReviewItems(result: JsonRecord): JsonRecord[] {
  const review = reviewConsensus(result);
  const pending: JsonRecord[] = stringList(review.inconclusive_step_ids).map((stepId) => ({ step_id: stepId, reason: 'review_worker_did_not_report_explicit_verdict' }));
  const quorum = records(result.acceptance_evidence).find((check) => check.kind === 'review_quorum');
  if (quorum?.status === 'pending') pending.push({ kind: 'review_quorum', reason: 'review_quorum_not_satisfied', min_passed: quorum.min_passed, max_failed: quorum.max_failed, passed: quorum.passed, failed: quorum.failed });
  return pending;
}
function scopedTargetStateChanged(task: Task, state: State, result: JsonRecord): JsonRecord {
  const repoFiles = stringList(result.real_changed_files);
  const nestedFiles = stringList(result.nested_workflow_changed_files);
  const workerObserved = uniqueStrings([...stringList(result.worker_reported_changed_files), ...stringList(result.observed_files)]);
  return {
    repo_files_changed: { changed: repoFiles.length > 0, paths: repoFiles, authority_owner: 'target_repository' },
    delegated_task_artifacts_created: { changed: true, paths: [taskPaths(state, task.task_id).taskDir], authority_owner: 'delegated-task-mcp' },
    worker_runtime_artifacts_created: { changed: workerRefs({ result } as Task).some((ref) => Boolean(ref.run_dir)), paths: uniqueStrings(workerRefs({ result } as Task).map((ref) => String(ref.run_dir ?? '')).filter(Boolean)), authority_owner: 'worker-delegation-mcp' },
    worker_observed_changed_files: { changed: workerObserved.length > 0, paths: workerObserved, authority_owner: 'worker_report' },
    nested_delegated_task_changed_files: { changed: nestedFiles.length > 0, paths: nestedFiles, authority_owner: 'nested_delegated_task_report' },
    external_side_effects: { changed: false, paths: [], authority_owner: null },
  };
}
function graphExecutionSynthesis(task: Task, stepStates: Record<string, StepState>, result: JsonRecord, terminal: JsonRecord): JsonRecord {
  const findings = stepFindings(task);
  const refs = workerRefs({ result } as Task);
  const failedSteps = Object.values(stepStates).filter((step) => step.status === 'failed' || step.status === 'blocked').map((step) => step.step_id);
  const pendingSteps = Object.values(stepStates).filter((step) => step.status === 'pending' || step.status === 'running').map((step) => step.step_id);
  const review = reviewConsensus(result);
  const acceptanceVerdict = String(result.acceptance_verdict ?? 'pending');
  const orchestrationSuccess = task.status === 'completed' || (task.status === 'running' && failedSteps.length === 0);
  const verdict = !orchestrationSuccess ? 'orchestration_failed' : acceptanceVerdict === 'passed' ? 'accepted' : acceptanceVerdict === 'failed' ? 'acceptance_failed' : 'workflow_complete_acceptance_pending';
  return {
    schema: 'narada.delegated_task.graph_execution_synthesis.v1',
    parent_workflow_status: task.status,
    orchestration_success: orchestrationSuccess,
    task_acceptance_verdict: acceptanceVerdict,
    synthesized_verdict: verdict,
    next_directive: closeoutSynthesis(result).next_action,
    steps_terminal: terminal.steps_terminal,
    acceptance_terminal: terminal.acceptance_terminal,
    step_status: Object.values(stepStates).map((step) => ({ step_id: step.step_id, step_kind: step.kind, status: step.status, run_ids: step.run_ids, current_run_id: step.current_run_id, summary: step.summary })),
    derived_topology: { shape: workflowShape(workflowSteps(task.workflow)), declarative_expansion: rec(rec(task.workflow).work_order).declarative_expansion ?? null, write_set_scheduling: writeSetSchedulingEnabled(task), write_sets: workflowSteps(task.workflow).filter((step) => step.write_set.length > 0).map((step) => ({ step_id: step.id, write_set: step.write_set })) },
    run_refs: refs.map((ref) => ({ step_id: ref.step_id, run_id: ref.run_id, output_ref: ref.output_ref ?? null, result_ref: ref.result_ref ?? null, run_dir: ref.run_dir ?? null })),
    worker_summaries: refs.map(compactWorkerRef),
    diagnostics: { failed_steps: failedSteps, pending_steps: pendingSteps, pending_acceptance_items: records(terminal.pending_acceptance_items), pending_review_items: records(terminal.pending_review_items) },
    worker_terminal_diagnostics: records(result.worker_terminal_diagnostics),
    residual_risks: stringList(result.residual_risks),
    review_consensus: review,
    changed_files_by_source: changedFilesBySource(result),
    parent_owned_changed_files: stringList(result.parent_changed_files),
    worker_observed_changed_files: stringList(result.worker_reported_changed_files),
    nested_delegated_task_calls: records(result.nested_workflows).map((workflow) => ({ task_id: workflow.task_id ?? null, task_status: workflow.task_status ?? null, acceptance_verdict: workflow.acceptance_verdict ?? null, changed_files_count: stringList(workflow.changed_files).length, verification_count: records(workflow.verification_results).length || records(workflow.verification).length })),
    evidence_coverage: { step_count: findings.length, worker_ref_count: refs.length, verification_count: records(result.verification).length, residual_risk_count: stringList(result.residual_risks).length },
  };
}
function changedFilesBySource(result: JsonRecord): JsonRecord {
  return {
    parent: stringList(result.parent_changed_files),
    worker_reported: stringList(result.worker_reported_changed_files),
    observed_deliverables: stringList(result.observed_files),
    nested_workflows: stringList(result.nested_workflow_changed_files),
    real_files: stringList(result.real_changed_files),
    affected_refs: stringList(result.affected_refs),
  };
}
function operatorSummary(result: JsonRecord): JsonRecord {
  const graph = rec(result.graph_execution_synthesis);
  const terminal = terminalSummary(result);
  const changed = changedFilesBySource(result);
  const failedSteps = stringList(rec(graph.diagnostics).failed_steps);
  const pendingAcceptance = records(result.pending_acceptance_items);
  const rootCause = failedSteps.length > 0 ? `failed_steps:${failedSteps.join(',')}`
    : pendingAcceptance.length > 0 ? 'acceptance_pending'
      : stringList(result.residual_risks).length > 0 ? 'residual_risks_present'
        : 'none';
  return {
    schema: 'narada.delegated_task.operator_summary.v1',
    root_cause: rootCause,
    changed_files: stringList(result.changed_files),
    changed_files_by_source: changed,
    tests: records(result.verification),
    blockers: [...pendingAcceptance.map((item) => item.reason ?? item.kind), ...stringList(result.residual_risks)],
    review_verdict: reviewConsensus(result).consensus,
    acceptance_verdict: result.acceptance_verdict ?? 'pending',
    next_directive: terminal.next_action,
    closeout_ready: closeoutSynthesis(result).closeout_ready,
  };
}
function compactWorkerRef(ref: JsonRecord): JsonRecord {
  const output = rec(ref.output);
  const changePaths = uniqueStrings([...stringList(output.changed_files), ...records(output.changes).map((change) => String(change.path ?? '')).filter(Boolean)]);
  const verificationCount = records(output.verification_results).length || records(output.verification).length;
  const residualRiskCount = stringList(output.residual_risks).length;
  const observedIncoherencyCount = stringList(output.observed_incoherencies).length;
  const diagnostics = {
    has_error: Boolean(output.error),
    has_residual_risks: residualRiskCount > 0,
    has_observed_incoherencies: observedIncoherencyCount > 0,
    has_nested_workflows: records(output.nested_workflows).length > 0,
    verification_count: verificationCount,
  };
  const manualInspect = diagnostics.has_error || diagnostics.has_residual_risks || diagnostics.has_observed_incoherencies || diagnostics.has_nested_workflows || !ref.output_ref && !ref.result_ref && String(ref.summary ?? '').length === 0;
  return {
    step_id: ref.step_id,
    step_kind: ref.step_kind,
    run_id: ref.run_id,
    status: ref.status,
    confidence: ref.confidence ?? null,
    summary: ref.summary,
    output_ref: ref.output_ref ?? null,
    result_ref: ref.result_ref ?? null,
    diagnostic_flags: diagnostics,
    changed_files_count_by_source: {
      worker_reported: changePaths.length,
      deliverables: records(output.deliverables).length,
      nested_workflows: records(output.nested_workflows).reduce((count, workflow) => count + stringList(workflow.changed_files).length, 0),
    },
    manual_artifact_inspection_recommended: manualInspect,
    manual_artifact_inspection_reason: manualInspect ? manualInspectionReason(diagnostics, ref) : null,
  };
}
function manualInspectionReason(diagnostics: JsonRecord, ref: JsonRecord): string {
  if (diagnostics.has_error) return 'worker_reported_error';
  if (diagnostics.has_residual_risks) return 'worker_reported_residual_risks';
  if (diagnostics.has_observed_incoherencies) return 'worker_reported_incoherencies';
  if (diagnostics.has_nested_workflows) return 'worker_reported_nested_workflows';
  if (!ref.output_ref && !ref.result_ref) return 'no_stable_worker_artifact_ref';
  return 'inspect_worker_artifact_for_details';
}
function closeoutSynthesis(result: JsonRecord): JsonRecord {
  const terminal = terminalSummary(result);
  const acceptanceVerdict = String(terminal.acceptance_verdict ?? 'pending');
  const blocked = acceptanceVerdict === 'passed' && Number(terminal.review_failed_count ?? 0) === 0 && Number(terminal.residual_risk_count ?? 0) === 0 ? []
    : [acceptanceVerdict !== 'passed' ? `acceptance:${acceptanceVerdict}` : null, Number(terminal.review_failed_count ?? 0) > 0 ? 'review_failed' : null, Number(terminal.residual_risk_count ?? 0) > 0 ? 'residual_risks_present' : null].filter(Boolean);
  return { schema: 'narada.delegated_task.closeout_synthesis.v1', acceptance_verdict: acceptanceVerdict, closeout_ready: blocked.length === 0, blocked_by: blocked, next_action: terminal.next_action, condition_language: blocked.length === 0 ? 'acceptance:passed' : blocked.join(',') };
}
function reviewConsensus(result: JsonRecord): JsonRecord {
  const refs = workerRefs({ result } as Task).filter((ref) => ref.step_kind === 'review');
  const passed = refs.filter((ref) => reviewRefHasExplicitPass(ref) || reviewRefHasImplicitPass(ref)).map((ref) => String(ref.step_id ?? ref.run_id ?? 'review'));
  const failed = refs.filter(reviewRefHasExplicitFailure).map((ref) => String(ref.step_id ?? ref.run_id ?? 'review'));
  const inconclusive = refs.filter((ref) => !passed.includes(String(ref.step_id ?? ref.run_id ?? 'review')) && !failed.includes(String(ref.step_id ?? ref.run_id ?? 'review'))).map((ref) => String(ref.step_id ?? ref.run_id ?? 'review'));
  const consensus = failed.length > 0 ? 'failed' : passed.length > 0 && inconclusive.length === 0 ? 'passed' : refs.length === 0 ? 'none' : 'mixed_or_inconclusive';
  return { schema: 'narada.delegated_task.review_consensus.v1', consensus, passed_step_ids: passed, failed_step_ids: failed, inconclusive_step_ids: inconclusive, disagreement: passed.length > 0 && failed.length > 0 };
}
function stepFindings(task: Task): JsonRecord[] {
  const refsByStep = new Map(workerRefs(task).map((ref) => [String(ref.step_id ?? ''), ref]));
  return Object.values(stepStateMap(task)).map((step) => {
    const ref = refsByStep.get(step.step_id);
    const output = rec(ref?.output);
    return { step_id: step.step_id, step_kind: step.kind, status: step.status, run_id: ref?.run_id ?? step.current_run_id, summary: step.summary ?? ref?.summary ?? '', verification_count: records(output.verification_results).length || records(output.verification).length, change_count: stringList(output.changed_files).length + records(output.changes).length, residual_risk_count: stringList(output.residual_risks).length, observed_incoherency_count: stringList(output.observed_incoherencies).length };
  });
}
function progressDelta(before: Task, after: Task): JsonRecord {
  const beforeCounts = stepStatusCounts(before);
  const afterCounts = stepStatusCounts(after);
  const keys = uniqueStrings([...Object.keys(beforeCounts), ...Object.keys(afterCounts)]);
  const beforeRunning = stringList(rec(rec(before.result).progress).running_run_ids);
  const afterRunning = stringList(rec(rec(after.result).progress).running_run_ids);
  return { from_task_status: before.status, to_task_status: after.status, changed: before.updated_at !== after.updated_at || before.status !== after.status, step_status_delta: Object.fromEntries(keys.map((key) => [key, Number(afterCounts[key] ?? 0) - Number(beforeCounts[key] ?? 0)])), running_run_ids_added: afterRunning.filter((id) => !beforeRunning.includes(id)), running_run_ids_removed: beforeRunning.filter((id) => !afterRunning.includes(id)) };
}
function workflowShape(steps: WorkflowStep[]): JsonRecord { return { dag: true, entry_step_ids: steps.filter((step) => step.depends_on.length === 0).map((step) => step.id), terminal_step_ids: steps.filter((step) => !steps.some((candidate) => candidate.depends_on.includes(step.id))).map((step) => step.id), edges: steps.flatMap((step) => step.depends_on.map((dependency) => ({ from: dependency, to: step.id }))) }; }
function workflowImports(workflow: JsonRecord, steps: WorkflowStep[]): JsonRecord { return { workflow: stringList(workflow.imports), by_step: Object.fromEntries(steps.filter((step) => step.imports.length > 0).map((step) => [step.id, step.imports])) }; }
function workflowValidationHints(steps: WorkflowStep[], diagnostics: JsonRecord[]): JsonRecord { return { expected_shape: 'directed_acyclic_graph', step_count: steps.length, edge_count: steps.reduce((count, step) => count + step.depends_on.length, 0), entry_step_ids: steps.filter((step) => step.depends_on.length === 0).map((step) => step.id), terminal_step_ids: steps.filter((step) => !steps.some((candidate) => candidate.depends_on.includes(step.id))).map((step) => step.id), cycle_count: diagnostics.filter((item) => item.code === 'workflow_cycle').length, unknown_dependency_count: diagnostics.filter((item) => item.code === 'unknown_dependency').length, condition_language: CONDITION_LANGUAGE, condition_suggestions: uniqueStrings(diagnostics.flatMap((item) => stringList(item.suggestions))).slice(0, 8), examples: workflowSchema().examples };
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
    join_syntheses: records(result.join_syntheses),
    worker_launch_failures: records(result.worker_launch_failures),
    verification: records(result.verification),
    residual_risks: stringList(result.residual_risks),
    observed_incoherencies: stringList(result.observed_incoherencies),
  };
  const compacted: JsonRecord = {
    ...result,
    operator_summary: operatorSummary(result),
    terminal_summary: terminalSummary(result),
    closeout_synthesis: closeoutSynthesis(result),
    review_consensus: reviewConsensus(result),
    graph_execution_synthesis: rec(result.graph_execution_synthesis),
    target_state_changed: rec(result.target_state_changed),
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
    join_syntheses: fullSections.join_syntheses.slice(0, maxItems),
    join_syntheses_count: fullSections.join_syntheses.length,
    worker_launch_failures: fullSections.worker_launch_failures.slice(0, maxItems),
    worker_launch_failure_count: fullSections.worker_launch_failures.length,
    verification: fullSections.verification.slice(0, maxItems),
    verification_count: fullSections.verification.length,
    residual_risks: fullSections.residual_risks.slice(0, maxItems),
    residual_risk_count: fullSections.residual_risks.length,
    observed_incoherencies: fullSections.observed_incoherencies.slice(0, maxItems),
    observed_incoherency_count: fullSections.observed_incoherencies.length,
  };
  const truncated = refs.length > maxWorkerRefs || fullSections.changed_files.length > maxItems || fullSections.changed_file_refs.length > maxItems || fullSections.real_changed_files.length > maxItems || fullSections.affected_refs.length > maxItems || fullSections.parent_changed_files.length > maxItems || fullSections.worker_reported_changed_files.length > maxItems || fullSections.observed_files.length > maxItems || fullSections.nested_workflows.length > maxItems || fullSections.nested_workflow_changed_files.length > maxItems || fullSections.nested_workflow_verification.length > maxItems || fullSections.join_syntheses.length > maxItems || fullSections.worker_launch_failures.length > maxItems || fullSections.verification.length > maxItems || fullSections.residual_risks.length > maxItems || fullSections.observed_incoherencies.length > maxItems;
  if (truncated) compacted.output_refs = materializeOutputSections(state, fullSections);
  if (resultPolicy.compact_completed_worker_refs === true && !includeDiagnostics) {
    compacted.worker_refs = records(compacted.worker_refs).map(compactWorkerRef);
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
function cancelActiveStepStates(stepStates: Record<string, StepState>): Record<string, StepState> {
  for (const stepState of Object.values(stepStates)) {
    if (stepState.status !== 'running') continue;
    stepState.current_run_id = null;
    stepState.active_posture = null;
    stepState.finished_at = now();
    stepState.error = 'parent_task_cancelled';
  }
  return stepStates;
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
function resolveCurrentSiteId(options: JsonRecord, siteRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = opt(options.siteId) ?? opt(options.site_id) ?? opt(options.currentSiteId) ?? opt(options.current_site_id) ?? opt(env.NARADA_SITE_ID) ?? opt(env.SITE_ID) ?? opt(env.NARADA_SITE);
  if (explicit) return explicit;
  try {
    const siteConfigPath = join(siteRoot, '.narada', 'site.json');
    if (existsSync(siteConfigPath)) {
      const data = rec(JSON.parse(readFileSync(siteConfigPath, 'utf8')));
      const configured = opt(data.site_id) ?? opt(data.id);
      if (configured) return configured;
    }
  } catch { }
  const base = siteRoot.split(/[\\/]+/).filter(Boolean).pop();
  return base && base !== '.' ? base : null;
}
function taskRootScope(state: State): string {
  if (state.taskRoot === state.siteRoot || inside(state.taskRoot, state.siteRoot)) return 'site_root';
  return state.currentSiteId ? 'shared_physical_store' : 'user_global';
}
function loadSiteSecrets(siteRoot: string, targetEnv: NodeJS.ProcessEnv): void { try { const configPath = join(siteRoot, '.narada', 'secrets.json'); if (!existsSync(configPath)) return; const data = JSON.parse(readFileSync(configPath, 'utf8')); const env = data.env; if (env && typeof env === 'object' && !Array.isArray(env)) { for (const [key, value] of Object.entries(env)) { if (typeof value === 'string' && value.trim() && !targetEnv[key]) { targetEnv[key] = value; } } } } catch { } }
function loadProviderCredentialSecrets(siteRoot: string, targetEnv: NodeJS.ProcessEnv, options: JsonRecord): void {
  const registryPath = providerRegistryPath(siteRoot, targetEnv, options);
  if (!registryPath || !existsSync(registryPath)) return;
  let registry: JsonRecord;
  try { registry = JSON.parse(readFileSync(registryPath, 'utf8')) as JsonRecord; } catch { return; }
  for (const metadata of Object.values(rec(registry.providers)).map(rec)) {
    const requirement = rec(metadata.credential_requirement);
    if (requirement.kind !== 'api_key_secret') continue;
    const envNames = Array.isArray(requirement.env_names) ? requirement.env_names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0) : [];
    const primaryEnv = envNames[0];
    const secretRef = typeof requirement.secret_ref === 'string' && requirement.secret_ref.trim() ? requirement.secret_ref.trim() : null;
    if (!primaryEnv || !secretRef || envNames.some((name) => typeof targetEnv[name] === 'string' && String(targetEnv[name]).trim())) continue;
    const value = lookupPowerShellSecret(secretRef, targetEnv, options);
    if (!value) continue;
    targetEnv[primaryEnv] = value;
    const baseUrlEnvNames = Array.isArray(metadata.base_url_env_names) ? metadata.base_url_env_names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0) : [];
    const primaryBaseUrlEnv = baseUrlEnvNames[0];
    const baseUrl = typeof metadata.base_url === 'string' && metadata.base_url.trim() ? metadata.base_url.trim() : null;
    if (primaryBaseUrlEnv && baseUrl && !targetEnv[primaryBaseUrlEnv]) targetEnv[primaryBaseUrlEnv] = baseUrl;
  }
}
function providerRegistryPath(siteRoot: string, env: NodeJS.ProcessEnv, options: JsonRecord): string | null {
  const explicit = firstString(options.providerRegistryPath, env.NARADA_INTELLIGENCE_PROVIDER_METADATA_PATH);
  if (explicit) return resolve(explicit);
  const candidates = [
    join(siteRoot, 'packages', 'carrier-provider-contract', 'contracts', 'provider-registry.json'),
    join(siteRoot, '..', 'narada', 'packages', 'carrier-provider-contract', 'contracts', 'provider-registry.json'),
    'D:\\code\\narada\\packages\\carrier-provider-contract\\contracts\\provider-registry.json',
  ];
  return candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate)) ?? null;
}
function lookupPowerShellSecret(secretRef: string, env: NodeJS.ProcessEnv, options: JsonRecord): string | null {
  const mode = String(env.NARADA_PROVIDER_SECRET_STORE ?? options.providerSecretStore ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'disabled', 'none'].includes(mode)) return null;
  const command = firstString(options.secretLookupCommand, env.NARADA_SECRET_LOOKUP_COMMAND) ?? 'pwsh';
  const args = Array.isArray(options.secretLookupCommandArgs) ? options.secretLookupCommandArgs.map(String) : ['-NoProfile', '-NonInteractive', '-Command', SECRET_MANAGEMENT_LOOKUP_SCRIPT];
  const result = spawnSync(command, args, { env: { ...env, NARADA_SECRET_LOOKUP_NAME: secretRef }, encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.status !== 0) return null;
  const value = String(result.stdout ?? '').trim();
  return value || null;
}
function firstString(...values: unknown[]): string | null { for (const value of values) { if (typeof value === 'string' && value.trim()) return value.trim(); } return null; }
const SECRET_MANAGEMENT_LOOKUP_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$name = [Environment]::GetEnvironmentVariable('NARADA_SECRET_LOOKUP_NAME', 'Process')
if ([string]::IsNullOrWhiteSpace($name)) { exit 3 }
if (-not (Get-Module -ListAvailable -Name Microsoft.PowerShell.SecretManagement)) { exit 10 }
Import-Module Microsoft.PowerShell.SecretManagement -ErrorAction Stop
$secret = Get-Secret -Name $name -AsPlainText -ErrorAction SilentlyContinue
if ($null -eq $secret -or [string]::IsNullOrWhiteSpace([string]$secret)) { exit 2 }
[Console]::Out.Write([string]$secret)
`;
function rec(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function diag(code: string, message = code, details: JsonRecord = {}) { const error = new Error(message); Object.assign(error, { codeName: code, details }); return error; }
function errorData(error: unknown): JsonRecord { const record = rec(error); return { schema: 'narada.delegated_task.error.v1', code: String(record.codeName ?? 'delegated_task_error'), message: error instanceof Error ? error.message : String(error), details: rec(record.details) }; }
function render(result: JsonRecord): string { return [`delegated_task: ${result.status ?? result.task_status ?? 'ok'}`, `task_id: ${result.task_id ?? ''}`, `task_status: ${result.task_status ?? ''}`, `objective: ${result.objective ?? ''}`].filter((line) => !line.endsWith(': ')).join('\n'); }
function drainJsonLines(buffer: string) { const lines = buffer.split(/\r?\n/); return { framed: false, remaining: lines.pop() ?? '', requests: lines.filter((line) => line.trim()).map((line) => rec(JSON.parse(line))) }; }
function drainJsonRpcFrames(buffer: string) { const requests: JsonRecord[] = []; let remaining = buffer; while (true) { const headerEnd = remaining.indexOf('\r\n\r\n'); if (headerEnd < 0) break; const match = /Content-Length:\s*(\d+)/i.exec(remaining.slice(0, headerEnd)); if (!match) break; const start = headerEnd + 4; const end = start + Number(match[1]); if (remaining.length < end) break; requests.push(rec(JSON.parse(remaining.slice(start, end)))); remaining = remaining.slice(end); } return { framed: true, remaining, requests }; }
function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) { const body = JSON.stringify(response); if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`); else process.stdout.write(`${body}\n`); }
function parseArgs(argv: string[]) { const options: JsonRecord = {}; const allowedRoots: string[] = []; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === '--task-root') options.taskRoot = argv[++i]; else if (arg === '--output-root') options.outputRoot = argv[++i]; else if (arg === '--site-root') options.siteRoot = argv[++i]; else if (arg === '--site-id') options.siteId = argv[++i]; else if (arg === '--allowed-root') allowedRoots.push(argv[++i]); else throw new Error(`unknown_argument:${arg}`); } if (allowedRoots.length) options.allowedRoots = allowedRoots; return options; }
function sleep(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

export async function runStdioServer(options: JsonRecord = {}): Promise<void> { const state = createServerState(options); let buffer = ''; let framed = false; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) { buffer += chunk; const drained = /^Content-Length:/i.test(buffer) ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer); framed ||= drained.framed; buffer = drained.remaining; for (const request of drained.requests) { const response = await handleRequest(request, state); if (response) writeJsonRpcResponse(response, { framed }); } } }
export { parseArgs };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
