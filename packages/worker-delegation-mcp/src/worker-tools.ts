import { existsSync, mkdirSync } from 'node:fs';
import { diagnosticError } from './errors.js';
import { buildCodexArgv, buildInvocation, parseLastMessage, resultStatus, runCodexInvocation, type ResolvedWorkerConfig } from './codex-adapter.js';
import { environmentForWorker, publicWorkerPolicy, resolveConfig, resolveSandbox, resolveWorkingDirectory, validateRuntime } from './policy.js';
import { audit, createRunRecord, writeJson, writeText, writeWorkerOutputSchema } from './run-record.js';
import { showOutput } from './output-ref.js';
import type { WorkerMcpState } from './state.js';
import type { PrimitiveConfigValue } from './policy.js';
import type { WorkerConstraintRequest, WorkerExecutorRequest, WorkerIntent, WorkerRunToolInput } from './worker-types.js';

export type WorkerRequestContext = {
  abortSignal?: AbortSignal;
};

export async function callWorkerTool(name: string, args: Record<string, unknown>, state: WorkerMcpState, context: WorkerRequestContext = {}): Promise<unknown> {
  if (name === 'worker_policy_inspect') return publicWorkerPolicy(state.policy);
  if (name === 'worker_run') return workerRun(args, state, null, context);
  if (name === 'worker_resume') return workerRun(args, state, requiredNonEmptyString(args.worker_session_id, 'worker_runtime_resume_not_supported'), context);
  if (name === 'worker_output_show') return showOutput(state.policy, args);
  throw diagnosticError('worker_unknown_tool', `worker_unknown_tool:${name}`, { tool_name: name });
}

export async function workerRun(args: Record<string, unknown>, state: WorkerMcpState, resumeSessionId: string | null, context: WorkerRequestContext = {}): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  if (args.config_overrides !== undefined) throw diagnosticError('worker_raw_config_overrides_not_allowed');
  const request = normalizeWorkerRunToolInput(args, resumeSessionId !== null);
  const runtime = validateRuntime(request.constraints.runtime, state.policy);
  const cwd = resolveWorkingDirectory(request.constraints.cwd, state.policy);
  const sandbox = resolveSandbox(request.constraints.sandbox, state.policy);
  const resolvedConfigInput = resolveConfig(request.constraints, state.policy);
  const prompt = buildWorkerPrompt({ intent: request.intent, cwd });
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > state.policy.maxPromptBytes) throw diagnosticError('worker_prompt_too_large', 'worker_prompt_too_large', { prompt_byte_length: promptBytes, max_prompt_bytes: state.policy.maxPromptBytes });

  const runRecord = createRunRecord(state.policy);
  writeWorkerOutputSchema(runRecord.schemaPath);
  const codexRuntime = state.policy.runtimes.codex;
  const skipGitRepoCheck = Boolean(request.constraints.skip_git_repo_check);
  const argv = buildCodexArgv({
    cwd,
    sandbox,
    schemaPath: runRecord.schemaPath,
    lastMessagePath: runRecord.lastMessagePath,
    workerSessionId: resumeSessionId ?? undefined,
    ephemeral: codexRuntime.ephemeral,
    skipGitRepoCheck,
    config: resolvedConfigInput.config,
  });
  const environment = environmentForWorker(state.env);
  const resolvedWorkerConfig: ResolvedWorkerConfig = {
    runtime,
    command: codexRuntime.command,
    argv,
    cwd,
    sandbox,
    model: resolvedConfigInput.model,
    reasoning_effort: resolvedConfigInput.reasoning_effort,
    config: resolvedConfigInput.config,
    skip_git_repo_check: skipGitRepoCheck,
    ephemeral: codexRuntime.ephemeral,
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
  audit(state.policy, { tool: resumeSessionId ? 'worker_resume' : 'worker_run', payload });
  if (outcome.status === 'failed') throw diagnosticError('worker_runtime_failed', 'worker_runtime_failed', { error: outcome.error, run_id: runRecord.runId, run_dir: runRecord.runDir });
  if (outcome.status === 'cancelled') throw diagnosticError('worker_runtime_timed_out', 'worker_runtime_timed_out', { run_id: runRecord.runId, run_dir: runRecord.runDir });
  return payload;
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
  const constraints: WorkerConstraintRequest = {
    cwd: requiredNonEmptyString(constraintsInput.cwd ?? args.cwd, 'worker_cwd_required'),
  };
  copyString(constraints, 'runtime', constraintsInput.runtime ?? args.runtime);
  copyString(constraints, 'sandbox', constraintsInput.sandbox ?? args.sandbox);
  copyString(constraints, 'model', constraintsInput.model ?? args.model);
  copyString(constraints, 'reasoning_effort', constraintsInput.reasoning_effort ?? args.reasoning_effort);
  const config = primitiveConfigRecord(constraintsInput.config ?? args.config);
  if (Object.keys(config).length > 0) constraints.config = config;
  if (constraintsInput.skip_git_repo_check !== undefined || args.skip_git_repo_check !== undefined) constraints.skip_git_repo_check = Boolean(constraintsInput.skip_git_repo_check ?? args.skip_git_repo_check);
  return constraints;
}

function copyString(target: Record<string, unknown>, key: keyof WorkerConstraintRequest, value: unknown): void {
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
