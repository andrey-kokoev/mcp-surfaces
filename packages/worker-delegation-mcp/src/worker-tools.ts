import { existsSync, mkdirSync } from 'node:fs';
import { diagnosticError } from './errors.js';
import { buildCodexArgv, buildInvocation, parseLastMessage, resultStatus, runCodexInvocation, type ResolvedWorkerConfig } from './codex-adapter.js';
import { environmentForWorker, publicWorkerPolicy, resolveConfig, resolveSandbox, resolveWorkingDirectory, validateRuntime } from './policy.js';
import { audit, createRunRecord, writeJson, writeText, writeWorkerOutputSchema } from './run-record.js';
import { showOutput } from './output-ref.js';
import type { WorkerMcpState } from './state.js';

export async function callWorkerTool(name: string, args: Record<string, unknown>, state: WorkerMcpState): Promise<unknown> {
  if (name === 'worker_policy_inspect') return publicWorkerPolicy(state.policy);
  if (name === 'worker_run') return workerRun(args, state, null);
  if (name === 'worker_resume') return workerRun(args, state, requiredNonEmptyString(args.worker_session_id, 'worker_runtime_resume_not_supported'));
  if (name === 'worker_output_show') return showOutput(state.policy, args);
  throw diagnosticError('worker_unknown_tool', `worker_unknown_tool:${name}`, { tool_name: name });
}

export async function workerRun(args: Record<string, unknown>, state: WorkerMcpState, resumeSessionId: string | null): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  if (args.config_overrides !== undefined) throw diagnosticError('worker_raw_config_overrides_not_allowed');
  const runtime = validateRuntime(args.runtime, state.policy);
  const cwd = resolveWorkingDirectory(args.cwd, state.policy);
  const role = String(args.role ?? 'specialist').trim() || 'specialist';
  const task = resumeSessionId ? String(args.task ?? 'Continue the previous worker session and return an updated structured result.').trim() : requiredNonEmptyString(args.task, 'worker_prompt_too_large');
  const sandbox = resolveSandbox(args.sandbox, state.policy);
  const resolvedConfigInput = resolveConfig(args, state.policy);
  const prompt = buildWorkerPrompt({ role, cwd, task });
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > state.policy.maxPromptBytes) throw diagnosticError('worker_prompt_too_large', 'worker_prompt_too_large', { prompt_byte_length: promptBytes, max_prompt_bytes: state.policy.maxPromptBytes });

  const runRecord = createRunRecord(state.policy);
  writeWorkerOutputSchema(runRecord.schemaPath);
  const codexRuntime = state.policy.runtimes.codex;
  const skipGitRepoCheck = Boolean(args.skip_git_repo_check);
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
  const invocation = buildInvocation(resolvedWorkerConfig, environment);

  mkdirSync(runRecord.runDir, { recursive: true });
  writeJson(runRecord.requestPath, args);
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
    summary: output?.summary ?? '',
    deliverables: output?.deliverables ?? [],
    open_questions: output?.open_questions ?? [],
    next_actions: output?.next_actions ?? [],
    artifacts: [
      { name: 'request.json', path: runRecord.requestPath },
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

function buildWorkerPrompt(options: { role: string; cwd: string; task: string }): string {
  return [
    'Role',
    options.role,
    '',
    'Working directory',
    options.cwd,
    '',
    'Task',
    options.task,
    '',
    'Recursion guard',
    'Do not call any worker_* MCP tools.',
    '',
    'Output requirements',
    'Return one JSON object matching worker_output.schema.json.',
    '',
  ].join('\n');
}

function requiredNonEmptyString(value: unknown, code: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code);
  return text;
}
