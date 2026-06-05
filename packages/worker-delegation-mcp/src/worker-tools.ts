import { existsSync, mkdirSync } from 'node:fs';
import { diagnosticError } from './errors.js';
import { buildCodexArgv, buildInvocation, parseLastMessage, resultStatus, runCodexInvocation, type ResolvedWorkerConfig } from './codex-adapter.js';
import { defaultSandboxForProfile, environmentForWorker, publicWorkerPolicy, resolveConfig, resolveProfile, resolveSandbox, resolveWorkingDirectory, validateRuntime } from './policy.js';
import { audit, createRunRecord, readWorkerSessionRecord, writeJson, writeText, writeWorkerOutputSchema, writeWorkerSessionRecord } from './run-record.js';
import { showOutput } from './output-ref.js';
import type { WorkerMcpState } from './state.js';
import type { PrimitiveConfigValue } from './policy.js';
import type { WorkerConstraintOverrides, WorkerConstraintRequest, WorkerEditToolInput, WorkerExecutorRequest, WorkerIntent, WorkerRunToolInput } from './worker-types.js';

export type WorkerRequestContext = {
  abortSignal?: AbortSignal;
};

export async function callWorkerTool(name: string, args: Record<string, unknown>, state: WorkerMcpState, context: WorkerRequestContext = {}): Promise<unknown> {
  if (name === 'worker_policy_inspect') return publicWorkerPolicy(state.policy);
  if (name === 'worker_run') return workerRun(args, state, null, context, 'worker_run');
  if (name === 'worker_edit') return workerRun(workerEditRunArgs(args, state), state, null, context, 'worker_edit');
  if (name === 'worker_resume') return workerRun(args, state, requiredNonEmptyString(args.worker_session_id, 'worker_runtime_resume_not_supported'), context, 'worker_resume');
  if (name === 'worker_output_show') return showOutput(state.policy, args);
  throw diagnosticError('worker_unknown_tool', `worker_unknown_tool:${name}`, { tool_name: name });
}

export async function workerRun(args: Record<string, unknown>, state: WorkerMcpState, resumeSessionId: string | null, context: WorkerRequestContext = {}, auditTool = resumeSessionId ? 'worker_resume' : 'worker_run'): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  if (args.config_overrides !== undefined) throw diagnosticError('worker_raw_config_overrides_not_allowed');
  const request = normalizeWorkerRunToolInput(args, resumeSessionId !== null);
  const inheritedSession = resumeSessionId ? readWorkerSessionRecord(state.policy, resumeSessionId) : null;
  if (inheritedSession) inheritSessionConstraints(request, inheritedSession.resolved_worker_config);
  const profile = resolveProfile(request.constraints.profile, state.policy);
  const overrides = request.constraints.overrides ?? {};
  const runtime = validateRuntime(overrides.runtime, state.policy);
  const cwd = resolveWorkingDirectory(request.constraints.cwd, state.policy);
  const sandbox = resolveSandbox(overrides.sandbox ?? defaultSandboxForProfile(profile), state.policy);
  const resolvedConfigInput = resolveConfig(overrides, state.policy);
  const prompt = buildWorkerPrompt({ intent: request.intent, cwd });
  const resumable = resumeSessionId !== null || request.constraints.resumable === true;
  const ephemeral = !resumable;
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > state.policy.maxPromptBytes) throw diagnosticError('worker_prompt_too_large', 'worker_prompt_too_large', { prompt_byte_length: promptBytes, max_prompt_bytes: state.policy.maxPromptBytes });

  const runRecord = createRunRecord(state.policy);
  writeWorkerOutputSchema(runRecord.schemaPath);
  const codexRuntime = state.policy.runtimes.codex;
  const skipGitRepoCheck = Boolean(overrides.skip_git_repo_check);
  const argv = buildCodexArgv({
    cwd,
    sandbox,
    schemaPath: runRecord.schemaPath,
    lastMessagePath: runRecord.lastMessagePath,
    workerSessionId: resumeSessionId ?? undefined,
    ephemeral,
    skipGitRepoCheck,
    config: resolvedConfigInput.config,
  });
  const environment = environmentForWorker(state.env);
  const resolvedWorkerConfig: ResolvedWorkerConfig = {
    runtime,
    profile,
    command: codexRuntime.command,
    command_args: codexRuntime.commandArgs,
    argv,
    cwd,
    sandbox,
    model: resolvedConfigInput.model,
    reasoning_effort: resolvedConfigInput.reasoning_effort,
    config: resolvedConfigInput.config,
    skip_git_repo_check: skipGitRepoCheck,
    resumable,
    ephemeral,
    json_events: codexRuntime.jsonEvents,
    prompt_byte_length: promptBytes,
    max_output_bytes: state.policy.maxOutputBytes,
    max_run_ms: state.policy.maxRunMs,
    environment_keys: Object.keys(environment).sort(),
  };
  const executorRequest: WorkerExecutorRequest = {
    schema: 'narada.worker.executor_request.v1',
    run_id: runRecord.runId,
    resume_worker_session_id: resumeSessionId,
    intent: request.intent,
    resolved_execution_policy: resolvedWorkerConfig,
  };
  const invocation = buildInvocation(resolvedWorkerConfig, environment);

  mkdirSync(runRecord.runDir, { recursive: true });
  writeJson(runRecord.requestPath, request);
  writeJson(runRecord.executorRequestPath, executorRequest);
  writeJson(runRecord.resolvedConfigPath, resolvedWorkerConfig);
  writeText(runRecord.promptPath, prompt);
  writeJson(runRecord.invocationPath, { command: invocation.command, argv: invocation.argv, cwd: invocation.cwd, environment_keys: resolvedWorkerConfig.environment_keys });
  writeText(runRecord.eventsPath, '');
  writeText(runRecord.diagnosticPath, '');

  const codexResult = await runCodexInvocation({
    invocation,
    prompt,
    eventsPath: runRecord.eventsPath,
    diagnosticPath: runRecord.diagnosticPath,
    lastMessagePath: runRecord.lastMessagePath,
    maxRunMs: resolvedWorkerConfig.max_run_ms,
    abortSignal: context.abortSignal,
  });
  if (!existsSync(runRecord.lastMessagePath)) writeJson(runRecord.lastMessagePath, { absent: true, reason: 'worker_runtime_did_not_produce_last_message' });
  const parsed = parseLastMessage(runRecord.lastMessagePath);
  const outcome = resultStatus(codexResult, parsed);
  const output = parsed.ok ? parsed.data : null;
  const finishedAt = new Date();
  const payload = {
    schema: 'narada.worker.run.v1',
    status: outcome.status,
    run_id: runRecord.runId,
    run_dir: runRecord.runDir,
    runtime,
    worker_session_id: codexResult.worker_session_id ?? resumeSessionId,
    resolved_worker_config: resolvedWorkerConfig,
    executor_request: executorRequest,
    summary: output?.summary ?? '',
    deliverables: output?.deliverables ?? [],
    open_questions: output?.open_questions ?? [],
    next_actions: output?.next_actions ?? [],
    artifacts: [
      { name: 'request.json', path: runRecord.requestPath },
      { name: 'executor_request.json', path: runRecord.executorRequestPath },
      { name: 'resolved_worker_config.json', path: runRecord.resolvedConfigPath },
      { name: 'worker_prompt.txt', path: runRecord.promptPath },
      { name: 'worker_invocation.json', path: runRecord.invocationPath },
      { name: 'events.jsonl', path: runRecord.eventsPath },
      { name: 'diagnostic.log', path: runRecord.diagnosticPath },
      { name: 'last_message.json', path: runRecord.lastMessagePath },
      { name: 'result.json', path: runRecord.resultPath },
      { name: 'worker_output.schema.json', path: runRecord.schemaPath },
    ],
    timing: { started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(), duration_ms: finishedAt.getTime() - startedAt.getTime() },
    error: outcome.error,
    ...(parsed.ok === false ? { worker_output_error: { reason: parsed.reason, message: parsed.message } } : {}),
  };
  writeJson(runRecord.resultPath, payload);
  const workerSessionId = codexResult.worker_session_id ?? resumeSessionId;
  if (workerSessionId && outcome.status === 'completed' && resumable) {
    writeWorkerSessionRecord(state.policy, {
      schema: 'narada.worker.session.v1',
      worker_session_id: workerSessionId,
      origin_tool: inheritedSession?.origin_tool ?? auditTool,
      created_run_id: inheritedSession?.created_run_id ?? runRecord.runId,
      updated_run_id: runRecord.runId,
      resolved_worker_config: resolvedWorkerConfig,
      updated_at: finishedAt.toISOString(),
    });
  }
  audit(state.policy, { tool: auditTool, payload });
  if (outcome.status === 'failed') throw diagnosticError('worker_runtime_failed', 'worker_runtime_failed', { error: outcome.error, run_id: runRecord.runId, run_dir: runRecord.runDir });
  if (outcome.status === 'cancelled') throw diagnosticError('worker_runtime_cancelled', 'worker_runtime_cancelled', { run_id: runRecord.runId, run_dir: runRecord.runDir });
  return payload;
}

function inheritSessionConstraints(request: WorkerRunToolInput, inherited: ResolvedWorkerConfig): void {
  if (request.constraints.profile === undefined || request.constraints.profile === 'default') request.constraints.profile = inherited.profile;
  const overrides = { ...(request.constraints.overrides ?? {}) };
  const config = { ...(overrides.config ?? {}) };
  if (overrides.runtime === undefined) overrides.runtime = inherited.runtime;
  if (overrides.sandbox === undefined) overrides.sandbox = inherited.sandbox;
  if (overrides.model === undefined && config.model === undefined && inherited.model) overrides.model = inherited.model;
  if (overrides.reasoning_effort === undefined && config.model_reasoning_effort === undefined && inherited.reasoning_effort) {
    overrides.reasoning_effort = inherited.reasoning_effort;
  }
  for (const [key, value] of Object.entries(inherited.config)) {
    if (config[key] === undefined && key !== 'model' && key !== 'model_reasoning_effort') config[key] = value;
  }
  if (Object.keys(config).length > 0) overrides.config = config;
  if (Object.keys(overrides).length > 0) request.constraints.overrides = overrides;
}

function workerEditRunArgs(args: Record<string, unknown>, state: WorkerMcpState): Record<string, unknown> {
  const editInput = normalizeWorkerEditToolInput(args);
  const overrides = applyEditDefaults(editInput.overrides ?? {}, state);
  return {
    intent: { instruction: editInput.instruction },
    constraints: {
      cwd: editInput.cwd,
      profile: 'delegating-agent-write',
      ...(editInput.resumable !== undefined ? { resumable: editInput.resumable } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    },
  };
}

function applyEditDefaults(overrides: WorkerConstraintOverrides, state: WorkerMcpState): WorkerConstraintOverrides {
  const config = { ...(overrides.config ?? {}) };
  const result: WorkerConstraintOverrides = { ...overrides, ...(Object.keys(config).length > 0 ? { config } : {}) };
  if (state.policy.editDefaults.model && result.model === undefined && config.model === undefined) result.model = state.policy.editDefaults.model;
  if (state.policy.editDefaults.reasoningEffort && result.reasoning_effort === undefined && config.model_reasoning_effort === undefined) {
    result.reasoning_effort = state.policy.editDefaults.reasoningEffort;
  }
  return result;
}

function normalizeWorkerEditToolInput(args: Record<string, unknown>): WorkerEditToolInput {
  const overridesInput = asRecord(args.overrides);
  const editInput: WorkerEditToolInput = {
    cwd: requiredNonEmptyString(args.cwd, 'worker_cwd_required'),
    instruction: requiredNonEmptyString(args.instruction, 'worker_prompt_too_large'),
  };
  if (args.resumable !== undefined) editInput.resumable = Boolean(args.resumable);
  const overrides: NonNullable<WorkerEditToolInput['overrides']> = {};
  copyString(overrides, 'runtime', overridesInput.runtime);
  copyString(overrides, 'sandbox', overridesInput.sandbox);
  copyString(overrides, 'model', overridesInput.model);
  copyString(overrides, 'reasoning_effort', overridesInput.reasoning_effort);
  const config = primitiveConfigRecord(overridesInput.config);
  if (Object.keys(config).length > 0) overrides.config = config;
  if (overridesInput.skip_git_repo_check !== undefined) overrides.skip_git_repo_check = Boolean(overridesInput.skip_git_repo_check);
  if (Object.keys(overrides).length > 0) editInput.overrides = overrides;
  return editInput;
}

function buildWorkerPrompt(options: { intent: WorkerIntent; cwd: string }): string {
  return [
    'Intent',
    options.intent.instruction,
    '',
    'Working directory',
    options.cwd,
    '',
    'Recursion guard',
    'Do not call any worker_* MCP tools.',
    '',
    'Output requirements',
    'Return one JSON object matching worker_output.schema.json.',
    '',
  ].join('\n');
}

function normalizeWorkerRunToolInput(args: Record<string, unknown>, isResume: boolean): WorkerRunToolInput {
  const intentInput = asRecord(args.intent);
  const constraintsInput = asRecord(args.constraints);
  const instructionValue = intentInput.instruction ?? (isResume ? 'Continue the previous worker session and return an updated structured result.' : undefined);
  const instruction = requiredNonEmptyString(instructionValue, 'worker_prompt_too_large');
  return {
    intent: { instruction },
    constraints: normalizeWorkerConstraintRequest(args, constraintsInput),
  };
}

function normalizeWorkerConstraintRequest(args: Record<string, unknown>, constraintsInput: Record<string, unknown>): WorkerConstraintRequest {
  const overridesInput = asRecord(constraintsInput.overrides);
  const constraints: WorkerConstraintRequest = {
    cwd: requiredNonEmptyString(constraintsInput.cwd ?? args.cwd, 'worker_cwd_required'),
    profile: String(constraintsInput.profile ?? args.profile ?? 'default').trim() || 'default',
  };
  if (constraintsInput.resumable !== undefined || args.resumable !== undefined) constraints.resumable = Boolean(constraintsInput.resumable ?? args.resumable);
  const overrides: NonNullable<WorkerConstraintRequest['overrides']> = {};
  copyString(overrides, 'runtime', overridesInput.runtime ?? constraintsInput.runtime ?? args.runtime);
  copyString(overrides, 'sandbox', overridesInput.sandbox ?? constraintsInput.sandbox ?? args.sandbox);
  copyString(overrides, 'model', overridesInput.model ?? constraintsInput.model ?? args.model);
  copyString(overrides, 'reasoning_effort', overridesInput.reasoning_effort ?? constraintsInput.reasoning_effort ?? args.reasoning_effort);
  const config = primitiveConfigRecord(overridesInput.config ?? constraintsInput.config ?? args.config);
  if (Object.keys(config).length > 0) overrides.config = config;
  if (overridesInput.skip_git_repo_check !== undefined || constraintsInput.skip_git_repo_check !== undefined || args.skip_git_repo_check !== undefined) {
    overrides.skip_git_repo_check = Boolean(overridesInput.skip_git_repo_check ?? constraintsInput.skip_git_repo_check ?? args.skip_git_repo_check);
  }
  if (Object.keys(overrides).length > 0) constraints.overrides = overrides;
  return constraints;
}

function copyString(target: Record<string, unknown>, key: keyof WorkerConstraintOverrides, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  target[key] = String(value).trim();
}

function primitiveConfigRecord(value: unknown): Record<string, PrimitiveConfigValue> {
  const record = asRecord(value);
  const result: Record<string, PrimitiveConfigValue> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) {
      result[key] = item;
      continue;
    }
    throw diagnosticError('worker_config_key_not_allowed', 'worker_config_value_must_be_primitive', { key });
  }
  return result;
}

function requiredNonEmptyString(value: unknown, code: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code);
  return text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
