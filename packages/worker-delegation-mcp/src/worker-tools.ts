import { constants, accessSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { diagnosticError } from './errors.js';
import { buildCodexArgv, buildInvocation as codexBuildInvocation, parseLastMessage, resultStatus, runCodexInvocation, type Invocation, type ResolvedWorkerConfig, type WorkerOutput } from './codex-adapter.js';
import { buildDeepseekArgv, buildInvocation as deepseekBuildInvocation, runDeepseekInvocation } from './deepseek-adapter.js';
import { defaultConfigForCognition, defaultSandboxForAuthority, environmentForWorker, publicWorkerPolicy, resolveAuthority, resolveCognition, resolveConfig, resolveSandbox, resolveWorkingDirectory, validateRuntime } from './policy.js';
import { audit, createRunRecord, readWorkerSessionRecord, writeJson, writeText, writeWorkerOutputSchema, writeWorkerSessionRecord } from './run-record.js';
import type { WorkerMcpState } from './state.js';
import type { WorkerPolicy, PrimitiveConfigValue } from './policy.js';
import type { WorkerConstraintOverrides, WorkerConstraintRequest, WorkerDelegationMode, WorkerEditToolInput, WorkerExecutorRequest, WorkerIntent, WorkerPreflightCheck, WorkerPreflightPath, WorkerProgressPreview, WorkerRunMetadata, WorkerRunToolInput } from './worker-types.js';
import type { RunRecordPaths } from './run-record.js';

export type WorkerRequestContext = {
  abortSignal?: AbortSignal;
};

export async function callWorkerTool(name: string, args: Record<string, unknown>, state: WorkerMcpState, context: WorkerRequestContext = {}): Promise<unknown> {
  if (name === 'worker_policy_inspect') return publicWorkerPolicy(state.policy);
  if (name === 'worker_config_resolve') return workerConfigResolve(args, state);
  if (name === 'worker_run') return workerRun(args, state, null, context, 'worker_run');
  if (name === 'worker_edit') return workerRun(workerEditRunArgs(args, state), state, null, context, 'worker_edit');
  if (name === 'worker_resume') return workerRun(args, state, requiredNonEmptyString(args.worker_session_id, 'worker_runtime_resume_not_supported'), context, 'worker_resume');
  if (name === 'worker_run_status') return workerRunStatus(args, state);
  if (name === 'worker_runs_list') return workerRunsList(args, state);
  if (name === 'worker_run_wait') return workerRunWait(args, state);
  throw diagnosticError('worker_unknown_tool', `worker_unknown_tool:${name}`, { tool_name: name });
}

function workerConfigResolve(args: Record<string, unknown>, state: WorkerMcpState): Record<string, unknown> {
  if (args.config_overrides !== undefined) throw diagnosticError('worker_raw_config_overrides_not_allowed');
  const resumeSessionId = args.worker_session_id === undefined || args.worker_session_id === null || args.worker_session_id === ''
    ? null
    : requiredNonEmptyString(args.worker_session_id, 'worker_runtime_resume_not_supported');
  const request = normalizeWorkerRunToolInput(args, resumeSessionId !== null);
  const inheritedSession = resumeSessionId ? readWorkerSessionRecord(state.policy, resumeSessionId) : null;
  if (inheritedSession) inheritSessionConstraints(request, inheritedSession.resolved_worker_config);
  const requestedOverrides = request.constraints.overrides ? { ...request.constraints.overrides, config: { ...(request.constraints.overrides.config ?? {}) } } : {};
  const authority = resolveAuthority(request.constraints.authority, state.policy);
  const cognition = resolveCognition(request.constraints.cognition, state.policy);
  request.constraints.authority = authority;
  request.constraints.cognition = cognition;
  let overrides = request.constraints.overrides ?? {};
  const runtime = validateRuntime(overrides.runtime, state.policy);
  const cwd = resolveWorkingDirectory(request.constraints.cwd, state.policy);
  const sandbox = resolveSandbox(overrides.sandbox ?? defaultSandboxForAuthority(authority), state.policy, runtime);
  applyCognitionDefaults(request, cognition, state, runtime);
  overrides = request.constraints.overrides ?? {};
  const resolvedConfigInput = resolveConfig(overrides, state.policy);
  const requestedMode = request.intent.mode ?? defaultModeForAuthority(authority);
  request.intent.mode = requestedMode;
  const preflight = buildPreflight({ cwd, authority, mode: requestedMode, waitForCompletion: request.constraints.wait_for_completion === true, isResume: resumeSessionId !== null, preflightPaths: request.constraints.preflight_paths ?? [], requiredMcpTools: request.constraints.required_mcp_tools ?? [], allowedRoots: state.policy.allowedRoots });
  const environment = environmentForWorker(state.env);
  const runtimeAvailability = checkRuntimeAvailability(runtime, state.policy, environment);
  const prompt = buildWorkerPrompt({ intent: request.intent, cwd, mode: requestedMode, preflight, exitInterview: request.constraints.exit_interview === true });
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > state.policy.maxPromptBytes) throw diagnosticError('worker_prompt_too_large', 'worker_prompt_too_large', { prompt_byte_length: promptBytes, max_prompt_bytes: state.policy.maxPromptBytes });
  const skipGitRepoCheck = Boolean(overrides.skip_git_repo_check);
  const resumable = resumeSessionId !== null || request.constraints.resumable === true;
  const ephemeral = !resumable;
  const dryRunPaths = {
    schemaPath: '<dry-run>/worker_output.schema.json',
    lastMessagePath: '<dry-run>/last_message.json',
  };

  let resolvedWorkerConfig: ResolvedWorkerConfig;
  let invocation: Invocation;
  if (runtime === 'deepseek-api') {
    const deepseekRuntime = state.policy.runtimes.deepseek;
    const mcpConfigPath = environment.NARADA_WORKER_MCP_CONFIG || null;
    const argv = buildDeepseekArgv({
      schemaPath: dryRunPaths.schemaPath,
      lastMessagePath: dryRunPaths.lastMessagePath,
      model: resolvedConfigInput.model,
      reasoningEffort: resolvedConfigInput.reasoning_effort,
      mcpConfigPath,
      workerSessionId: resumeSessionId ?? undefined,
    });
    resolvedWorkerConfig = {
      runtime: 'deepseek-api',
      authority,
      cognition,
      command: runtimeAvailability.command ?? deepseekRuntime.command,
      command_args: deepseekRuntime.commandArgs,
      argv,
      cwd,
      sandbox,
      model: resolvedConfigInput.model,
      reasoning_effort: resolvedConfigInput.reasoning_effort,
      config: resolvedConfigInput.config,
      skip_git_repo_check: skipGitRepoCheck,
      resumable,
      ephemeral,
      json_events: deepseekRuntime.jsonEvents,
      prompt_byte_length: promptBytes,
      max_output_bytes: state.policy.maxOutputBytes,
      max_run_ms: state.policy.maxRunMs,
      environment_keys: Object.keys(environment).sort(),
    };
    invocation = deepseekBuildInvocation(resolvedWorkerConfig, environment);
  } else {
    const codexRuntime = state.policy.runtimes.codex;
    const argv = buildCodexArgv({
      cwd,
      sandbox,
      schemaPath: dryRunPaths.schemaPath,
      lastMessagePath: dryRunPaths.lastMessagePath,
      workerSessionId: resumeSessionId ?? undefined,
      ephemeral,
      skipGitRepoCheck,
      config: resolvedConfigInput.config,
    });
    resolvedWorkerConfig = {
      runtime: 'codex',
      authority,
      cognition,
      command: runtimeAvailability.command ?? codexRuntime.command,
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
    invocation = codexBuildInvocation(resolvedWorkerConfig, environment);
  }

  const configResolution = configResolutionMetadata({ requestedOverrides, resolvedConfigInput, runtime, cognition, policy: state.policy });
  const warnings = [
    'dry_run_paths_are_placeholders: invocation argv uses <dry-run> paths and does not create run artifacts',
    ...(configResolution.model_source === 'runtime_default_opaque' ? ['model_delegated_to_runtime_default: concrete model is not knowable before launching this runtime'] : []),
    ...(configResolution.reasoning_effort_source === 'runtime_default_opaque' ? ['reasoning_effort_delegated_to_runtime_default: concrete reasoning effort is not knowable before launching this runtime'] : []),
    ...preflight.filter((check) => check.status === 'blocked').map((check) => `blocked_preflight: ${check.message}`),
  ];
  return {
    schema: 'narada.worker.config_resolve.v1',
    status: 'ok',
    dry_run: true,
    requested_mode: requestedMode,
    resume_worker_session_id: resumeSessionId,
    resolved_worker_config: resolvedWorkerConfig,
    invocation: { command: invocation.command, argv: invocation.argv, cwd: invocation.cwd, environment_keys: resolvedWorkerConfig.environment_keys },
    preflight,
    runtime_availability: runtimeAvailability.available
      ? { available: true, command: runtimeAvailability.command ?? resolvedWorkerConfig.command }
      : { available: false, reason: runtimeAvailability.reason ?? null, remediation: runtimeAvailability.remediation ?? null, command: runtimeAvailability.command ?? null },
    config_resolution: configResolution,
    warnings,
  };
}

function modeWithInference(run: Record<string, unknown>): { requestedMode: WorkerDelegationMode | null; inferred: boolean } {
  const direct = run.requested_mode ?? asRecord(run.executor_request).requested_mode ?? asRecord(asRecord(run.executor_request).intent).mode;
  if (direct === 'audit_only' || direct === 'plan_only' || direct === 'implement' || direct === 'implement_and_verify') return { requestedMode: direct, inferred: false };
  const authority = asRecord(run.resolved_worker_config).authority;
  if (authority === 'write' || authority === 'command') return { requestedMode: 'implement', inferred: true };
  if (authority === 'read') return { requestedMode: 'audit_only', inferred: true };
  return { requestedMode: null, inferred: false };
}

function normalizeStringList(value: unknown, code: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw diagnosticError(code, code);
  return value.map((item) => requiredNonEmptyString(item, code));
}

function normalizePreflightPaths(value: unknown): WorkerPreflightPath[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw diagnosticError('worker_invalid_preflight_paths', 'worker_invalid_preflight_paths');
  return value.map((item, index) => {
    const record = asRecord(item);
    const path = requiredNonEmptyString(record.path, 'worker_invalid_preflight_paths');
    const access = String(record.access ?? 'read').trim();
    if (access !== 'read' && access !== 'write' && access !== 'create') throw diagnosticError('worker_invalid_preflight_paths', 'worker_invalid_preflight_path_access', { index, access });
    const result: WorkerPreflightPath = { path, access };
    if (record.label !== undefined && record.label !== null && String(record.label).trim()) result.label = String(record.label).trim();
    return result;
  });
}

export async function workerRun(args: Record<string, unknown>, state: WorkerMcpState, resumeSessionId: string | null, context: WorkerRequestContext = {}, auditTool = resumeSessionId ? 'worker_resume' : 'worker_run'): Promise<Record<string, unknown>> {
  acquireWorkerRunSlot(state);
  let releaseOnReturn = true;
  const releaseSlot = () => {
    releaseWorkerRunSlot(state);
    releaseOnReturn = false;
  };
  const deferRelease = () => { releaseOnReturn = false; };
  try {
    return await workerRunInner(args, state, resumeSessionId, context, auditTool, { releaseSlot, deferRelease });
  } finally {
    if (releaseOnReturn) releaseWorkerRunSlot(state);
  }
}

function recoverOrphanedRunningRun(run: Record<string, unknown>, state: WorkerMcpState): Record<string, unknown> {
  if (run.status !== 'running') return run;
  const runDir = typeof run.run_dir === 'string' ? run.run_dir : null;
  if (!runDir) return run;
  const timing = asRecord(run.timing);
  const startedAtMs = Date.parse(String(timing.started_at ?? ''));
  if (!Number.isFinite(startedAtMs)) return run;
  const resolvedConfig = asRecord(run.resolved_worker_config);
  const maxRunMsValue = typeof resolvedConfig.max_run_ms === 'number' ? resolvedConfig.max_run_ms : state.policy.maxRunMs;
  if (Date.now() - startedAtMs <= maxRunMsValue + 60_000) return run;
  const parsed = parseLastMessage(resolve(runDir, 'last_message.json'));
  if (!parsed.ok) return run;
  const output = parsed.data;
  const finishedAt = new Date(startedAtMs + maxRunMsValue);
  const existingWarnings = Array.isArray(run.runtime_warnings) ? run.runtime_warnings.map(String) : [];
  const warning = 'worker_run_orphaned_final_output: valid last_message.json exists, but result.json was not finalized before max_run_ms elapsed';
  const runtimeWarnings = existingWarnings.includes(warning) ? existingWarnings : [...existingWarnings, warning];
  return {
    ...run,
    status: 'completed_with_errors',
    edits_performed: output.edits_performed,
    target_state_changed: output.target_state_changed,
    confidence: 'partial',
    runtime_warnings: runtimeWarnings,
    warning_count: runtimeWarnings.length,
    summary: output.summary,
    deliverables: output.deliverables,
    open_questions: output.open_questions,
    next_actions: output.next_actions,
    changes: output.changes,
    verification_results: output.verification,
    exit_interview: output.exit_interview ?? null,
    timing: {
      ...timing,
      finished_at: finishedAt.toISOString(),
      duration_ms: maxRunMsValue,
    },
    error: warning,
  };
}

function recoverCompletedRunFromEvents(run: Record<string, unknown>, resultPath: string): Record<string, unknown> {
  if (run.status !== 'running') return run;
  const runDir = typeof run.run_dir === 'string' ? run.run_dir : null;
  if (!runDir) return run;
  const lastMessagePath = resolve(runDir, 'last_message.json');
  if (existsSync(lastMessagePath)) return run;
  const recovered = recoverWorkerOutputFromEvents(resolve(runDir, 'events.jsonl'));
  if (!recovered) return run;

  writeJson(lastMessagePath, recovered.output);
  const timing = asRecord(run.timing);
  const startedAtMs = Date.parse(String(timing.started_at ?? ''));
  const finishedAtMs = recovered.finishedAt.getTime();
  const existingWarnings = Array.isArray(run.runtime_warnings) ? run.runtime_warnings.map(String) : [];
  const warning = 'worker_run_recovered_from_events: turn.completed observed with final agent_message, but last_message.json was missing';
  const runtimeWarnings = existingWarnings.includes(warning) ? existingWarnings : [...existingWarnings, warning];
  const output = recovered.output;
  const recoveredRun = {
    ...run,
    status: 'completed_with_errors',
    edits_performed: output.edits_performed,
    target_state_changed: output.target_state_changed,
    confidence: 'partial',
    runtime_warnings: runtimeWarnings,
    warning_count: runtimeWarnings.length,
    summary: output.summary,
    deliverables: output.deliverables,
    open_questions: output.open_questions,
    next_actions: output.next_actions,
    changes: output.changes,
    verification_results: output.verification,
    exit_interview: output.exit_interview ?? null,
    artifacts: Array.isArray(run.artifacts) ? run.artifacts : runArtifacts({
      runId: String(run.run_id ?? ''),
      runDir,
      requestPath: resolve(runDir, 'request.json'),
      executorRequestPath: resolve(runDir, 'executor_request.json'),
      resolvedConfigPath: resolve(runDir, 'resolved_worker_config.json'),
      promptPath: resolve(runDir, 'worker_prompt.txt'),
      invocationPath: resolve(runDir, 'worker_invocation.json'),
      eventsPath: resolve(runDir, 'events.jsonl'),
      diagnosticPath: resolve(runDir, 'diagnostic.log'),
      lastMessagePath,
      resultPath,
      schemaPath: resolve(runDir, 'worker_output.schema.json'),
    }),
    timing: {
      ...timing,
      finished_at: recovered.finishedAt.toISOString(),
      duration_ms: Number.isFinite(startedAtMs) ? Math.max(0, finishedAtMs - startedAtMs) : null,
    },
    error: warning,
  };
  writeJson(resultPath, recoveredRun);
  return recoveredRun;
}

function recoverWorkerOutputFromEvents(eventsPath: string): { output: WorkerOutput; finishedAt: Date } | null {
  if (!existsSync(eventsPath)) return null;
  let terminalSeen = false;
  let finalAgentMessage: string | null = null;
  let finishedAt: Date | null = null;
  try {
    const lines = readFileSync(eventsPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const type = eventType(event);
      if (type === 'agent_message') {
        finalAgentMessage = eventText(event) ?? finalAgentMessage;
      }
      if (type === 'turn.completed') {
        terminalSeen = true;
        finishedAt = eventTimestamp(event) ?? finishedAt;
      }
    }
  } catch {
    return null;
  }
  if (!terminalSeen || !finalAgentMessage) return null;
  return { output: workerOutputFromAgentMessage(finalAgentMessage), finishedAt: finishedAt ?? new Date() };
}

function workerOutputFromAgentMessage(message: string): WorkerOutput {
  const parsed = parseWorkerOutputJson(message);
  if (parsed) return parsed;
  return {
    summary: message,
    deliverables: [],
    open_questions: [],
    next_actions: [],
    edits_performed: false,
    target_state_changed: false,
    changes: [],
    verification: [{ tool: 'codex-events', command: null, status: 'passed', summary: 'Recovered final agent_message after turn.completed' }],
    exit_interview: null,
  };
}

function parseWorkerOutputJson(message: string): WorkerOutput | null {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (typeof parsed.summary !== 'string') return null;
    if (!Array.isArray(parsed.deliverables) || !Array.isArray(parsed.open_questions) || !Array.isArray(parsed.next_actions) || !Array.isArray(parsed.changes) || !Array.isArray(parsed.verification)) return null;
    if (typeof parsed.edits_performed !== 'boolean' || typeof parsed.target_state_changed !== 'boolean') return null;
    return parsed as WorkerOutput;
  } catch {
    return null;
  }
}

function eventText(value: unknown): string | null {
  const record = asRecord(value);
  for (const key of ['message', 'text', 'summary']) {
    const item = record[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  const content = record.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const parts = content.map((item) => eventText(item)).filter((item): item is string => Boolean(item));
    if (parts.length > 0) return parts.join('\n').trim();
  }
  const nested = asRecord(record.message);
  for (const key of ['content', 'text']) {
    const item = nested[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return null;
}

function eventTimestamp(value: unknown): Date | null {
  const record = asRecord(value);
  for (const key of ['timestamp', 'created_at', 'time']) {
    const item = record[key];
    if (typeof item === 'string') {
      const ms = Date.parse(item);
      if (Number.isFinite(ms)) return new Date(ms);
    }
  }
  return null;
}

function withFreshProgress(run: Record<string, unknown>): Record<string, unknown> {
  const runDir = typeof run.run_dir === 'string' ? run.run_dir : null;
  if (!runDir) return run;
  return { ...run, progress: readRunProgress(resolve(runDir, 'events.jsonl')) };
}

async function workerRunInner(args: Record<string, unknown>, state: WorkerMcpState, resumeSessionId: string | null, context: WorkerRequestContext, auditTool: string, slot: { releaseSlot: () => void; deferRelease: () => void }): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  if (args.config_overrides !== undefined) throw diagnosticError('worker_raw_config_overrides_not_allowed');
  const request = normalizeWorkerRunToolInput(args, resumeSessionId !== null);
  const inheritedSession = resumeSessionId ? readWorkerSessionRecord(state.policy, resumeSessionId) : null;
  if (inheritedSession) inheritSessionConstraints(request, inheritedSession.resolved_worker_config);
  const authority = resolveAuthority(request.constraints.authority, state.policy);
  const cognition = resolveCognition(request.constraints.cognition, state.policy);
  request.constraints.authority = authority;
  request.constraints.cognition = cognition;
  let overrides = request.constraints.overrides ?? {};
  const runtime = validateRuntime(overrides.runtime, state.policy);
  const cwd = resolveWorkingDirectory(request.constraints.cwd, state.policy);
  const sandbox = resolveSandbox(overrides.sandbox ?? defaultSandboxForAuthority(authority), state.policy, runtime);
  applyCognitionDefaults(request, cognition, state, runtime);
  overrides = request.constraints.overrides ?? {};
  const resolvedConfigInput = resolveConfig(overrides, state.policy);
  const requestedMode = request.intent.mode ?? defaultModeForAuthority(authority);
  request.intent.mode = requestedMode;
  const preflight = buildPreflight({ cwd, authority, mode: requestedMode, waitForCompletion: request.constraints.wait_for_completion === true, isResume: resumeSessionId !== null, preflightPaths: request.constraints.preflight_paths ?? [], requiredMcpTools: request.constraints.required_mcp_tools ?? [], allowedRoots: state.policy.allowedRoots });
  enforcePreflightForMode(requestedMode, preflight);

  // Runtime availability preflight: fail fast with a clear remediation if the selected runtime is not runnable.
  const environment = environmentForWorker(state.env);
  const runtimeAvailability = checkRuntimeAvailability(runtime, state.policy, environment);
  if (!runtimeAvailability.available) {
    throw diagnosticError('worker_runtime_unavailable', `worker_runtime_unavailable:${runtime}`, {
      runtime,
      reason: runtimeAvailability.reason,
      remediation: runtimeAvailability.remediation,
    });
  }

  const prompt = buildWorkerPrompt({ intent: request.intent, cwd, mode: requestedMode, preflight, exitInterview: request.constraints.exit_interview === true });
  const resumable = resumeSessionId !== null || request.constraints.resumable === true;
  const ephemeral = !resumable;
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > state.policy.maxPromptBytes) throw diagnosticError('worker_prompt_too_large', 'worker_prompt_too_large', { prompt_byte_length: promptBytes, max_prompt_bytes: state.policy.maxPromptBytes });

  const runRecord = createRunRecord(state.policy);
  writeWorkerOutputSchema(runRecord.schemaPath);
  const skipGitRepoCheck = Boolean(overrides.skip_git_repo_check);

  let resolvedWorkerConfig: ResolvedWorkerConfig;
  let invocation: Invocation;

  if (runtime === 'deepseek-api') {
    const deepseekRuntime = state.policy.runtimes.deepseek;
    const mcpConfigPath = environment.NARADA_WORKER_MCP_CONFIG || null;
    const argv = buildDeepseekArgv({
      schemaPath: runRecord.schemaPath,
      lastMessagePath: runRecord.lastMessagePath,
      model: resolvedConfigInput.model,
      reasoningEffort: resolvedConfigInput.reasoning_effort,
      mcpConfigPath,
      workerSessionId: resumeSessionId ?? undefined,
    });
    const baseConfig: ResolvedWorkerConfig = {
      runtime: 'deepseek-api',
      authority,
      cognition,
      command: runtimeAvailability.command ?? deepseekRuntime.command,
      command_args: deepseekRuntime.commandArgs,
      argv,
      cwd,
      sandbox,
      model: resolvedConfigInput.model,
      reasoning_effort: resolvedConfigInput.reasoning_effort,
      config: resolvedConfigInput.config,
      skip_git_repo_check: skipGitRepoCheck,
      resumable,
      ephemeral,
      json_events: deepseekRuntime.jsonEvents,
      prompt_byte_length: promptBytes,
      max_output_bytes: state.policy.maxOutputBytes,
      max_run_ms: state.policy.maxRunMs,
      environment_keys: Object.keys(environment).sort(),
    };
    resolvedWorkerConfig = baseConfig;
    invocation = deepseekBuildInvocation(baseConfig, environment);
  } else {
    const codexRuntime = state.policy.runtimes.codex;
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
    const baseConfig: ResolvedWorkerConfig = {
      runtime: 'codex',
      authority,
      cognition,
      command: runtimeAvailability.command ?? codexRuntime.command,
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
    resolvedWorkerConfig = baseConfig;
    invocation = codexBuildInvocation(baseConfig, environment);
  }
  const executorRequest: WorkerExecutorRequest = {
    schema: 'narada.worker.executor_request.v1',
    run_id: runRecord.runId,
    resume_worker_session_id: resumeSessionId,
    intent: request.intent,
    requested_mode: requestedMode,
    preflight,
    resolved_execution_policy: resolvedWorkerConfig,
  };

  mkdirSync(runRecord.runDir, { recursive: true });
  writeJson(runRecord.requestPath, request);
  writeJson(runRecord.executorRequestPath, executorRequest);
  writeJson(runRecord.resolvedConfigPath, resolvedWorkerConfig);
  writeText(runRecord.promptPath, prompt);
  writeJson(runRecord.invocationPath, { command: invocation.command, argv: invocation.argv, cwd: invocation.cwd, environment_keys: resolvedWorkerConfig.environment_keys });
  writeText(runRecord.eventsPath, '');
  writeText(runRecord.diagnosticPath, '');

  const waitForCompletion = request.constraints.wait_for_completion === true;
  const launchedAt = new Date();
  const runningPayload = buildWorkerRunPayload({
    status: 'running',
    runRecord,
    runtime,
    workerSessionId: resumeSessionId,
    resolvedWorkerConfig,
    executorRequest,
    startedAt,
    finishedAt: null,
    error: null,
    metadata: buildRunMetadata({ requestedMode, preflight, status: 'running', output: null, error: null }),
  });
  writeJson(runRecord.resultPath, runningPayload);
  if (!waitForCompletion) {
    audit(state.policy, { tool: auditTool, payload: { ...runningPayload, event: 'worker_run_started', launched_at: launchedAt.toISOString() } });
    slot.deferRelease();
    void completeWorkerRun({
      state,
      runRecord,
      invocation,
      prompt,
      resolvedWorkerConfig,
      runtime,
      resumeSessionId,
      resumable,
      startedAt,
      executorRequest,
      auditTool,
      inheritedOriginTool: inheritedSession?.origin_tool,
      inheritedCreatedRunId: inheritedSession?.created_run_id,
    }).catch(() => {
      // The failure payload has already been written by completeWorkerRun.
    }).finally(slot.releaseSlot);
    return runningPayload;
  }

  return await completeWorkerRun({
    state,
    runRecord,
    invocation,
    prompt,
    resolvedWorkerConfig,
    runtime,
    resumeSessionId,
    resumable,
    startedAt,
    executorRequest,
    auditTool,
    inheritedOriginTool: inheritedSession?.origin_tool,
    inheritedCreatedRunId: inheritedSession?.created_run_id,
    abortSignal: context.abortSignal,
  });
}

async function completeWorkerRun(options: {
  state: WorkerMcpState;
  runRecord: RunRecordPaths;
  invocation: Invocation;
  prompt: string;
  resolvedWorkerConfig: ResolvedWorkerConfig;
  runtime: string;
  resumeSessionId: string | null;
  resumable: boolean;
  startedAt: Date;
  executorRequest: WorkerExecutorRequest;
  auditTool: string;
  inheritedOriginTool?: string;
  inheritedCreatedRunId?: string;
  abortSignal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { state, runRecord, invocation, prompt, resolvedWorkerConfig, runtime, resumeSessionId, resumable, startedAt, executorRequest, auditTool } = options;
  try {
  const runner = runtime === 'deepseek-api' ? runDeepseekInvocation : runCodexInvocation;
  const codexResult = await runner({
    invocation,
    prompt,
    eventsPath: runRecord.eventsPath,
    diagnosticPath: runRecord.diagnosticPath,
    lastMessagePath: runRecord.lastMessagePath,
    maxRunMs: resolvedWorkerConfig.max_run_ms,
    abortSignal: options.abortSignal,
  });
  if (!existsSync(runRecord.lastMessagePath)) writeJson(runRecord.lastMessagePath, { absent: true, reason: 'worker_runtime_did_not_produce_last_message' });
  const parsed = parseLastMessage(runRecord.lastMessagePath);
  const outcome = resultStatus(codexResult, parsed);
  const output = parsed.ok ? parsed.data : null;
  const finishedAt = new Date();
  const payload = buildWorkerRunPayload({
    status: outcome.status,
    runRecord,
    runtime,
    workerSessionId: codexResult.worker_session_id ?? resumeSessionId,
    resolvedWorkerConfig,
    executorRequest,
    startedAt,
    finishedAt,
    error: outcome.error,
    runtimeWarnings: outcome.warnings,
    output,
    workerOutputError: parsed.ok === false ? { reason: parsed.reason, message: parsed.message } : undefined,
    metadata: buildRunMetadata({ requestedMode: executorRequest.requested_mode, preflight: executorRequest.preflight, status: outcome.status, output, error: outcome.error }),
  });
  writeJson(runRecord.resultPath, payload);
  const workerSessionId = codexResult.worker_session_id ?? resumeSessionId;
  if (workerSessionId && (outcome.status === 'completed' || outcome.status === 'completed_with_errors') && resumable) {
    writeWorkerSessionRecord(state.policy, {
      schema: 'narada.worker.session.v1',
      worker_session_id: workerSessionId,
      origin_tool: options.inheritedOriginTool ?? auditTool,
      created_run_id: options.inheritedCreatedRunId ?? runRecord.runId,
      updated_run_id: runRecord.runId,
      resolved_worker_config: resolvedWorkerConfig,
      updated_at: finishedAt.toISOString(),
    });
  }
  audit(state.policy, { tool: auditTool, payload });
  if (outcome.status === 'failed') throw diagnosticError('worker_runtime_failed', 'worker_runtime_failed', { error: outcome.error, run_id: runRecord.runId, run_dir: runRecord.runDir });
  if (outcome.status === 'cancelled') throw diagnosticError('worker_runtime_cancelled', 'worker_runtime_cancelled', { run_id: runRecord.runId, run_dir: runRecord.runDir });
  return payload;
  } catch (error) {
    const codeName = (error as { codeName?: unknown })?.codeName;
    if (codeName === 'worker_runtime_failed' || codeName === 'worker_runtime_cancelled') throw error;
    const finishedAt = new Date();
    const message = error instanceof Error ? error.message : String(error);
    const payload = buildWorkerRunPayload({
      status: 'failed',
      runRecord,
      runtime,
      workerSessionId: resumeSessionId,
      resolvedWorkerConfig,
      executorRequest,
      startedAt,
      finishedAt,
      error: message,
      metadata: buildRunMetadata({ requestedMode: executorRequest.requested_mode, preflight: executorRequest.preflight, status: 'failed', output: null, error: message }),
    });
    writeJson(runRecord.resultPath, payload);
    audit(state.policy, { tool: auditTool, payload });
    throw error;
  }
}

function buildWorkerRunPayload(options: {
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
  runRecord: RunRecordPaths;
  runtime: string;
  workerSessionId: string | null;
  resolvedWorkerConfig: ResolvedWorkerConfig;
  executorRequest: WorkerExecutorRequest;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  runtimeWarnings?: string[];
  output?: WorkerOutput | null;
  workerOutputError?: { reason: string; message: string };
  metadata: WorkerRunMetadata;
}): Record<string, unknown> {
  return {
    schema: 'narada.worker.run.v1',
    status: options.status,
    run_id: options.runRecord.runId,
    run_dir: options.runRecord.runDir,
    runtime: options.runtime,
    worker_session_id: options.workerSessionId,
    resolved_worker_config: options.resolvedWorkerConfig,
    executor_request: options.executorRequest,
    requested_mode: options.metadata.requested_mode,
    edits_performed: options.metadata.edits_performed,
    target_state_changed: options.metadata.target_state_changed,
    confidence: options.metadata.confidence,
    completion_state: options.metadata.confidence,
    blocked_paths: options.metadata.blocked_paths,
    verification: options.metadata.verification,
    runtime_warnings: options.runtimeWarnings ?? [],
    warning_count: options.runtimeWarnings?.length ?? 0,
    preflight: options.metadata.preflight,
    final_checklist: options.metadata.final_checklist,
    summary: options.output?.summary ?? '',
    deliverables: options.output?.deliverables ?? [],
    open_questions: options.output?.open_questions ?? [],
    next_actions: options.output?.next_actions ?? [],
    changes: options.output?.changes ?? [],
    verification_results: options.output?.verification ?? [],
    exit_interview: options.output?.exit_interview ?? null,
    progress: readRunProgress(options.runRecord.eventsPath),
    artifacts: runArtifacts(options.runRecord),
    timing: {
      started_at: options.startedAt.toISOString(),
      finished_at: options.finishedAt?.toISOString() ?? null,
      duration_ms: options.finishedAt ? options.finishedAt.getTime() - options.startedAt.getTime() : null,
    },
    error: options.error,
    ...(options.workerOutputError ? { worker_output_error: options.workerOutputError } : {}),
  };
}

function runArtifacts(runRecord: RunRecordPaths) {
  return [
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
  ];
}

function workerRunStatus(args: Record<string, unknown>, state: WorkerMcpState): Record<string, unknown> {
  const runId = requiredNonEmptyString(args.run_id, 'worker_run_id_required');
  return readRunResult(state, runId);
}

function workerRunsList(args: Record<string, unknown>, state: WorkerMcpState): Record<string, unknown> {
  const limit = boundedInteger(args.limit, 20, 1, 200, 'worker_runs_list_limit_invalid');
  const includeCompleted = args.include_completed === undefined ? true : Boolean(args.include_completed);
  const includeRunning = args.include_running === undefined ? true : Boolean(args.include_running);
  const verbose = Boolean(args.verbose);
  const includeSummary = Boolean(args.include_summary) || verbose;
  const runs = listRunIds(state)
    .map((runId) => readRunResult(state, runId, false))
    .filter((run): run is Record<string, unknown> => Boolean(run))
    .filter((run) => includeRunByStatus(String(run.status ?? ''), { includeCompleted, includeRunning }))
    .sort((a, b) => runSortKey(b).localeCompare(runSortKey(a)))
    .slice(0, limit)
    .map((run) => runListItem(run, { verbose, includeSummary }));
  return {
    schema: 'narada.worker.runs_list.v1',
    status: 'ok',
    count: runs.length,
    limit,
    verbose,
    include_summary: includeSummary,
    runs,
  };
}

async function workerRunWait(args: Record<string, unknown>, state: WorkerMcpState): Promise<Record<string, unknown>> {
  const runId = requiredNonEmptyString(args.run_id, 'worker_run_id_required');
  const timeoutMs = boundedInteger(args.timeout_ms, 10_000, 0, 300_000, 'worker_run_wait_timeout_invalid');
  const pollMs = boundedInteger(args.poll_ms, 250, 25, 10_000, 'worker_run_wait_poll_invalid');
  const verbose = Boolean(args.verbose);
  const summaryOnly = Boolean(args.summary_only);
  const started = Date.now();
  while (true) {
    const result = readRunResult(state, runId);
    if (String(result.status ?? '') !== 'running') return runWaitPayload(result, { status: 'finished', timeoutMs, elapsedMs: Date.now() - started, verbose, summaryOnly });
    if (Date.now() - started >= timeoutMs) return runWaitPayload(result, { status: 'timed_out', timeoutMs, elapsedMs: Date.now() - started, verbose, summaryOnly });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - started)))));
  }
}

function readRunResult(state: WorkerMcpState, runId: string, required = true): Record<string, unknown> | null {
  if (!/^run-[A-Za-z0-9TZ-]+$/.test(runId)) throw diagnosticError('worker_run_id_invalid', 'worker_run_id_invalid', { run_id: runId });
  const runDir = resolve(state.policy.runRoot, runId);
  const resultPath = resolve(runDir, 'result.json');
  if (!existsSync(resultPath)) {
    if (!required) return null;
    throw diagnosticError('worker_run_not_found', 'worker_run_not_found', { run_id: runId });
  }
  try {
    const run = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    return enrichFailedRunDiagnostics(withFreshProgress(recoverOrphanedRunningRun(recoverCompletedRunFromEvents(run, resultPath), state)));
  } catch (error) {
    if (!required) return null;
    const message = error instanceof Error ? error.message : String(error);
    throw diagnosticError('worker_run_result_unreadable', 'worker_run_result_unreadable', { run_id: runId, error: message });
  }
}

function listRunIds(state: WorkerMcpState): string[] {
  if (!existsSync(state.policy.runRoot)) return [];
  return readdirSync(state.policy.runRoot).filter((entry) => entry.startsWith('run-') && statSync(resolve(state.policy.runRoot, entry)).isDirectory());
}

function includeRunByStatus(status: string, options: { includeCompleted: boolean; includeRunning: boolean }): boolean {
  if (status === 'running') return options.includeRunning;
  if (status === 'completed' || status === 'completed_with_errors' || status === 'failed' || status === 'cancelled') return options.includeCompleted;
  return true;
}

function runSortKey(run: Record<string, unknown>): string {
  const timing = asRecord(run.timing);
  return String(timing.finished_at ?? timing.started_at ?? run.run_id ?? '');
}

function runListItem(run: Record<string, unknown>, options: { verbose: boolean; includeSummary: boolean }): Record<string, unknown> {
  const timing = asRecord(run.timing);
  const mode = modeWithInference(run);
  const progress = asRecord(run.progress);
  const item: Record<string, unknown> = {
    run_id: run.run_id,
    status: run.status,
    completion_state: run.completion_state ?? run.confidence ?? null,
    requested_mode: mode.requestedMode,
    requested_mode_inferred: mode.inferred,
    authority: asRecord(run.resolved_worker_config).authority ?? null,
    started_at: timing.started_at ?? null,
    finished_at: timing.finished_at ?? null,
    duration_ms: timing.duration_ms ?? null,
    summary_preview: previewString(run.summary, 180),
    error_preview: previewString(compactRunError(run), 180),
    error_classification: run.error_classification ?? null,
    warning_count: run.warning_count ?? 0,
    progress_preview: progress.latest_event_preview ?? null,
    latest_event_type: progress.latest_event_type ?? null,
    progress: run.progress ?? null,
  };
  if (options.includeSummary) item.summary = String(run.summary ?? '');
  if (options.verbose) {
    item.run_dir = run.run_dir;
    item.worker_session_id = run.worker_session_id;
    item.timing = run.timing;
    item.error = run.error;
    item.diagnostic_tail = run.diagnostic_tail ?? null;
    item.error_classification = run.error_classification ?? null;
  }
  return item;
}

function compactRunError(run: Record<string, unknown>): string | null {
  const error = previewString(run.error, 120);
  const diagnosticTail = previewString(run.diagnostic_tail, 220);
  if (error && diagnosticTail) return `${error}: ${diagnosticTail}`;
  return error ?? diagnosticTail;
}

function enrichFailedRunDiagnostics(run: Record<string, unknown>): Record<string, unknown> {
  if (run.status !== 'failed') return run;
  const progress = asRecord(run.progress);
  if (progress.event_count !== 0 || run.worker_session_id) return run;
  const runDir = typeof run.run_dir === 'string' ? run.run_dir : null;
  if (!runDir) return run;
  const diagnosticTail = readDiagnosticTail(resolve(runDir, 'diagnostic.log'));
  if (!diagnosticTail) return run;
  return {
    ...run,
    diagnostic_tail: diagnosticTail,
    error_classification: classifyDiagnosticTail(diagnosticTail),
  };
}

function readDiagnosticTail(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (!text) return null;
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length <= 800 ? normalized : normalized.slice(-800);
  } catch {
    return null;
  }
}

function classifyDiagnosticTail(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('not inside a trusted directory') || lower.includes('--skip-git-repo-check')) return 'codex_untrusted_directory';
  if (lower.includes('permission denied') || lower.includes('access is denied')) return 'permission_denied';
  if (lower.includes('command not found') || lower.includes('not recognized as')) return 'runtime_command_unavailable';
  return 'runtime_prestart_diagnostic';
}

function runWaitPayload(run: Record<string, unknown>, options: { status: 'finished' | 'timed_out'; timeoutMs: number; elapsedMs: number; verbose: boolean; summaryOnly: boolean }): Record<string, unknown> {
  const compact = runListItem(run, { verbose: options.verbose, includeSummary: options.summaryOnly || options.verbose });
  const payload: Record<string, unknown> = {
    schema: 'narada.worker.run_wait.v1',
    status: 'ok',
    wait: { status: options.status, timeout_ms: options.timeoutMs, elapsed_ms: options.elapsedMs },
    run: options.summaryOnly ? summaryOnlyRun(compact) : compact,
  };
  if (options.verbose) payload.full_run = run;
  return payload;
}

function summaryOnlyRun(run: Record<string, unknown>): Record<string, unknown> {
  return {
    run_id: run.run_id,
    status: run.status,
    summary: run.summary ?? run.summary_preview ?? '',
    error_preview: run.error_preview ?? null,
    progress: run.progress ?? null,
  };
}

function readRunProgress(eventsPath: string): WorkerProgressPreview {
  const empty: WorkerProgressPreview = { event_count: 0, latest_event_type: null, latest_event_preview: null, readable: true, tail_truncated: false };
  if (!existsSync(eventsPath)) return empty;
  try {
    const stat = statSync(eventsPath);
    if (stat.size === 0) return empty;
    const limit = 64 * 1024;
    const start = Math.max(0, stat.size - limit);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(eventsPath, 'r');
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString('utf8');
    const rawLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lines = start === 0 ? rawLines : rawLines.slice(1);
    let latest: unknown = null;
    let eventCount = 0;
    let parseError: string | null = null;
    for (const line of lines) {
      try {
        latest = JSON.parse(line) as unknown;
        eventCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        parseError ||= message;
      }
    }
    return {
      event_count: eventCount,
      latest_event_type: eventType(latest),
      latest_event_preview: previewString(latestEventText(latest), 240),
      readable: parseError === null,
      tail_truncated: start > 0,
      ...(parseError ? { error_preview: previewString(parseError, 180) ?? undefined } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, readable: false, error_preview: previewString(message, 180) ?? undefined };
  }
}

function eventType(value: unknown): string | null {
  const record = asRecord(value);
  return typeof record.type === 'string' && record.type.trim() ? record.type.trim() : null;
}

function latestEventText(value: unknown): string | null {
  const record = asRecord(value);
  for (const key of ['message', 'msg', 'summary', 'text']) {
    const item = record[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  const type = eventType(value);
  if (type) return type;
  if (value === null) return null;
  return JSON.stringify(value);
}

function previewString(value: unknown, limit: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function boundedInteger(value: unknown, defaultValue: number, min: number, max: number, code: string): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw diagnosticError(code, code, { value, min, max });
  return parsed;
}

function acquireWorkerRunSlot(state: WorkerMcpState): void {
  if (state.activeRunCount >= state.policy.maxParallelRuns) {
    throw diagnosticError('worker_parallel_limit_exceeded', 'worker_parallel_limit_exceeded', { active_run_count: state.activeRunCount, max_parallel_runs: state.policy.maxParallelRuns });
  }
  state.activeRunCount += 1;
}

function releaseWorkerRunSlot(state: WorkerMcpState): void {
  state.activeRunCount = Math.max(0, state.activeRunCount - 1);
}

function applyCognitionDefaults(request: WorkerRunToolInput, cognition: ResolvedWorkerConfig['cognition'], state: WorkerMcpState, runtime: 'codex' | 'deepseek-api' = 'deepseek-api'): void {
  const defaults = defaultConfigForCognition(cognition, state.policy);
  if (!defaults.model && !defaults.reasoningEffort) return;
  const overrides = { ...(request.constraints.overrides ?? {}) };
  const config = { ...(overrides.config ?? {}) };
  if (defaults.model && overrides.model === undefined && config.model === undefined) overrides.model = defaults.model;
  if (defaults.reasoningEffort && overrides.reasoning_effort === undefined && config.model_reasoning_effort === undefined) {
    overrides.reasoning_effort = defaults.reasoningEffort;
  }
  if (Object.keys(config).length > 0) overrides.config = config;
  if (Object.keys(overrides).length > 0) request.constraints.overrides = overrides;
}

function configResolutionMetadata(options: {
  requestedOverrides: WorkerConstraintOverrides;
  resolvedConfigInput: { config: Record<string, PrimitiveConfigValue>; model: string | null; reasoning_effort: string | null };
  runtime: 'codex' | 'deepseek-api';
  cognition: ResolvedWorkerConfig['cognition'];
  policy: WorkerPolicy;
}): Record<string, unknown> {
  const config = options.requestedOverrides.config ?? {};
  const cognitionDefaults = defaultConfigForCognition(options.cognition, options.policy);
  return {
    model_source: configValueSource({
      explicit: options.requestedOverrides.model !== undefined || config.model !== undefined,
      hasResolvedValue: options.resolvedConfigInput.model !== null,
      cognitionDefault: cognitionDefaults.model,
      runtime: options.runtime,
      deepseekAdapterDefault: 'deepseek-v4-flash',
    }),
    reasoning_effort_source: configValueSource({
      explicit: options.requestedOverrides.reasoning_effort !== undefined || config.model_reasoning_effort !== undefined,
      hasResolvedValue: options.resolvedConfigInput.reasoning_effort !== null,
      cognitionDefault: cognitionDefaults.reasoningEffort,
      runtime: options.runtime,
      deepseekAdapterDefault: 'high',
    }),
    allowed_config_keys: options.policy.allowedConfigKeys,
    explicit_config_keys: Object.keys(options.resolvedConfigInput.config).sort(),
  };
}

function configValueSource(options: { explicit: boolean; hasResolvedValue: boolean; cognitionDefault: string | null; runtime: 'codex' | 'deepseek-api'; deepseekAdapterDefault: string }): string {
  if (options.explicit) return 'request_override';
  if (options.hasResolvedValue && options.cognitionDefault) return 'cognition_default';
  if (options.hasResolvedValue) return 'resolved_config';
  if (options.runtime === 'deepseek-api') return `adapter_default:${options.deepseekAdapterDefault}`;
  return 'runtime_default_opaque';
}

function inheritSessionConstraints(request: WorkerRunToolInput, inherited: ResolvedWorkerConfig): void {
  if (request.constraints.authority === undefined) request.constraints.authority = inherited.authority;
  if (request.constraints.cognition === undefined) request.constraints.cognition = inherited.cognition;
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
  return {
    intent: { instruction: editInput.instruction, mode: 'implement' },
    constraints: {
      cwd: editInput.cwd,
      authority: 'write',
      cognition: 'low',
      ...(editInput.resumable !== undefined ? { resumable: editInput.resumable } : {}),
      ...(editInput.wait_for_completion !== undefined ? { wait_for_completion: editInput.wait_for_completion } : {}),
      ...(editInput.exit_interview !== undefined ? { exit_interview: editInput.exit_interview } : {}),
      ...(editInput.overrides && Object.keys(editInput.overrides).length > 0 ? { overrides: editInput.overrides } : {}),
    },
  };
}

function normalizeWorkerEditToolInput(args: Record<string, unknown>): WorkerEditToolInput {
  const overridesInput = asRecord(args.overrides);
  const editInput: WorkerEditToolInput = {
    cwd: requiredNonEmptyString(args.cwd, 'worker_cwd_required'),
    instruction: requiredNonEmptyString(args.instruction, 'worker_prompt_too_large'),
  };
  if (args.resumable !== undefined) editInput.resumable = Boolean(args.resumable);
  if (args.wait_for_completion !== undefined) editInput.wait_for_completion = Boolean(args.wait_for_completion);
  if (args.exit_interview !== undefined) editInput.exit_interview = Boolean(args.exit_interview);
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

function defaultModeForAuthority(authority: ResolvedWorkerConfig['authority']): WorkerDelegationMode {
  return authority === 'write' || authority === 'command' ? 'implement' : 'audit_only';
}

function parseDelegationMode(value: unknown, authority: string | undefined): WorkerDelegationMode {
  if (value === undefined || value === null || value === '') return authority === 'write' || authority === 'command' ? 'implement' : 'audit_only';
  const mode = String(value).trim();
  if (mode === 'audit_only' || mode === 'plan_only' || mode === 'implement' || mode === 'implement_and_verify') return mode;
  throw diagnosticError('worker_invalid_mode', 'worker_invalid_mode', { mode });
}

function buildPreflight(options: { cwd: string; authority: string; mode: WorkerDelegationMode; waitForCompletion: boolean; isResume: boolean; preflightPaths: WorkerPreflightPath[]; requiredMcpTools: string[]; allowedRoots: string[] }): WorkerPreflightCheck[] {
  const checks: WorkerPreflightCheck[] = [
    { name: 'cwd_readable', status: existsSync(options.cwd) ? 'ok' : 'blocked', message: existsSync(options.cwd) ? `cwd exists: ${options.cwd}` : `cwd is missing: ${options.cwd}` },
    { name: 'requested_mode', status: 'ok', message: `requested_mode=${options.mode}` },
    { name: 'authority', status: 'ok', message: `authority=${options.authority}` },
  ];
  if ((options.mode === 'implement' || options.mode === 'implement_and_verify') && options.authority === 'read') {
    checks.push({ name: 'mode_authority_alignment', status: 'blocked', message: `${options.mode} requires write or command authority; read authority can only audit or plan` });
  } else {
    checks.push({ name: 'mode_authority_alignment', status: 'ok', message: `${options.mode} is allowed with ${options.authority} authority` });
  }
  checks.push({ name: 'execution_style', status: options.waitForCompletion ? 'ok' : 'warning', message: options.waitForCompletion ? 'caller will wait for completion' : 'async run; caller must use worker_run_status, worker_runs_list, or worker_run_wait to rediscover result' });
  if (options.isResume) checks.push({ name: 'resume', status: 'ok', message: 'continuing an existing worker session' });
  for (const item of options.preflightPaths) checks.push(preflightPathCheck(item, options.allowedRoots));
  if (options.requiredMcpTools.length > 0) {
    checks.push({ name: 'required_mcp_tools', status: 'warning', message: `worker must verify required MCP tools before work: ${options.requiredMcpTools.join(', ')}` });
  }
  return checks;
}

function preflightPathCheck(item: WorkerPreflightPath, allowedRoots: string[]): WorkerPreflightCheck {
  const path = resolve(item.path);
  const label = item.label ? `${item.label}: ` : '';
  if (!allowedRoots.some((root) => areSamePath(path, root) || isPathInside(path, root))) {
    return { name: `path_${item.access}`, status: 'blocked', message: `${label}${path} is outside allowed roots` };
  }
  try {
    if (item.access === 'read') {
      accessSync(path, constants.R_OK);
      return { name: 'path_read', status: 'ok', message: `${label}${path} is readable` };
    }
    if (item.access === 'write') {
      accessSync(path, constants.W_OK);
      return { name: 'path_write', status: 'ok', message: `${label}${path} is writable` };
    }
    const parent = dirname(path);
    accessSync(parent, constants.W_OK);
    return { name: 'path_create', status: existsSync(path) ? 'warning' : 'ok', message: existsSync(path) ? `${label}${path} already exists; create target is not empty by default` : `${label}${path} can be created; parent is writable` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: `path_${item.access}`, status: 'blocked', message: `${label}${path} failed ${item.access} preflight: ${message}` };
  }
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(normalizePathComparisonKey(root), normalizePathComparisonKey(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function areSamePath(left: string, right: string): boolean {
  return normalizePathComparisonKey(left) === normalizePathComparisonKey(right);
}

function checkRuntimeAvailability(runtime: 'codex' | 'deepseek-api', policy: WorkerPolicy, env: Record<string, string>): { available: boolean; reason?: string; remediation?: string; command?: string } {
  if (runtime === 'deepseek-api') {
    const key = policy.runtimes.deepseek.command === 'node' ? 'DEEPSEEK_API_KEY' : null;
    if (key && !env[key]) {
      return { available: false, reason: `${key} not set`, remediation: `set ${key} in the environment or choose a different runtime` };
    }
    if (policy.runtimes.deepseek.command === 'node') {
      return { available: true, command: policy.runtimes.deepseek.command };
    }
    return commandAvailable(policy.runtimes.deepseek.command, env);
  }
  return commandAvailable(policy.runtimes.codex.command, env);
}

function commandAvailable(command: string, env: Record<string, string>): { available: boolean; reason?: string; remediation?: string; command?: string } {
  if (isAbsolute(command)) {
    if (!existsSync(command)) {
      return { available: false, reason: `command not found: ${command}`, remediation: 'install the runtime or configure an explicit command path that exists' };
    }
    return { available: true, command };
  }
  const pathEnv = env.PATH || '';
  const extensions = process.platform === 'win32' ? [...new Set([...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';'), '.PS1'])] : [''];
  for (const dir of pathEnv.split(process.platform === 'win32' ? ';' : ':')) {
    const candidateNames = process.platform === 'win32' && extname(command) ? [command] : extensions.map((ext) => command + ext);
    for (const name of candidateNames) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return { available: true, command: candidate };
    }
  }
  return { available: false, reason: `command not found on PATH: ${command}`, remediation: 'install the runtime, add it to PATH, or configure an absolute command path' };
}

function normalizePathComparisonKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function enforcePreflightForMode(mode: WorkerDelegationMode, preflight: WorkerPreflightCheck[]): void {
  if (mode !== 'implement' && mode !== 'implement_and_verify') return;
  const blocked = preflight.filter((check) => check.status === 'blocked');
  if (blocked.length === 0) return;
  throw diagnosticError('worker_preflight_blocked', 'worker_preflight_blocked', { requested_mode: mode, blocked_preflight: blocked });
}

function buildRunMetadata(options: {
  requestedMode: WorkerDelegationMode;
  preflight: WorkerPreflightCheck[];
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
  output: WorkerOutput | null;
  error: string | null;
}): WorkerRunMetadata {
  const readOnlyMode = options.requestedMode === 'audit_only' || options.requestedMode === 'plan_only';
  const blockedPaths = options.preflight.filter((check) => check.status === 'blocked').map((check) => check.message);
  const verification = options.output?.verification.map((item) => [item.status, item.tool ?? item.command, item.summary].filter(Boolean).join(': ')) ?? [];
  return {
    requested_mode: options.requestedMode,
    edits_performed: options.status === 'running' ? null : options.output ? options.output.edits_performed : readOnlyMode ? false : null,
    target_state_changed: options.status === 'running' ? null : options.output ? options.output.target_state_changed : readOnlyMode ? false : null,
    confidence: options.error || blockedPaths.length > 0 || options.status === 'completed_with_errors' || options.status === 'failed' ? 'partial' : 'complete',
    blocked_paths: blockedPaths,
    verification,
    preflight: options.preflight,
    final_checklist: finalChecklist(options.requestedMode),
  };
}

function finalChecklist(mode: WorkerDelegationMode): string[] {
  if (mode === 'audit_only' || mode === 'plan_only') {
    return ['state whether files were edited', 'list evidence inspected', 'list blocked or unreadable paths', 'separate recommendations from completed work'];
  }
  return ['list files changed', 'list tests or checks run', 'include git/worktree status if available', 'list remaining blockers'];
}

function buildWorkerPrompt(options: { intent: WorkerIntent; cwd: string; mode: WorkerDelegationMode; preflight: WorkerPreflightCheck[]; exitInterview: boolean }): string {
  return [
    'Intent',
    options.intent.instruction,
    '',
    'Requested mode',
    options.mode,
    '',
    'Working directory',
    options.cwd,
    '',
    'Preflight evidence',
    ...options.preflight.map((check) => `- ${check.status} ${check.name}: ${check.message}`),
    '',
    'Mode contract',
    options.mode === 'audit_only' ? 'Audit only: inspect and report. Do not edit files or change target state.' : options.mode === 'plan_only' ? 'Plan only: produce an implementation plan. Do not edit files or change target state.' : options.mode === 'implement_and_verify' ? 'Implement and verify: make the requested changes, run appropriate checks, and report files changed plus verification.' : 'Implement: make the requested changes and report files changed plus remaining verification needs.',
    '',
    'Recursion guard',
    'Do not call any worker_* MCP tools.',
    '',
    'Tool use discipline',
    'Prefer available MCP filesystem, git, and structured-command tools for inspection and verification.',
    'Do not use direct shell commands for file discovery or file reads when MCP tools can do the work.',
    'Use direct shell execution only when the delegated intent explicitly requires command execution and no narrower MCP surface fits.',
    '',
    'Output requirements',
    'Return one JSON object matching worker_output.schema.json.',
    'For audit_only or plan_only, explicitly state that edits_performed=false in the summary if no files were changed.',
    'Always include explicit edits_performed, target_state_changed, changes, and verification fields.',
    'For implement or implement_and_verify, list changed files in changes and checks run in verification.',
    ...(options.exitInterview ? [
      '',
      'Exit interview',
      'Include exit_interview in the output JSON with ergonomics_feedback, friction_points, missing_affordances, observed_incoherencies, and suggested_improvements.',
      'Focus on concrete tool/interface friction encountered during this delegated run, including anything that made progress harder, ambiguous, slower, or less observable.',
    ] : []),
    '',
  ].join('\n');
}

function normalizeWorkerRunToolInput(args: Record<string, unknown>, isResume: boolean): WorkerRunToolInput {
  const intentInput = asRecord(args.intent);
  const constraintsInput = asRecord(args.constraints);
  const instructionValue = intentInput.instruction ?? (isResume ? 'Continue the previous worker session and return an updated structured result.' : undefined);
  const instruction = requiredNonEmptyString(instructionValue, 'worker_prompt_too_large');
  const authorityValue = String(asRecord(args.constraints).authority ?? args.authority ?? '');
  return {
    intent: { instruction, mode: parseDelegationMode(intentInput.mode ?? args.mode, authorityValue) },
    constraints: normalizeWorkerConstraintRequest(args, constraintsInput),
  };
}

function normalizeWorkerConstraintRequest(args: Record<string, unknown>, constraintsInput: Record<string, unknown>): WorkerConstraintRequest {
  const overridesInput = asRecord(constraintsInput.overrides);
  const constraints: WorkerConstraintRequest = {
    cwd: requiredNonEmptyString(constraintsInput.cwd ?? args.cwd, 'worker_cwd_required'),
  };
  copyString(constraints, 'authority', constraintsInput.authority ?? args.authority);
  copyString(constraints, 'cognition', constraintsInput.cognition ?? args.cognition);
  if (constraintsInput.resumable !== undefined || args.resumable !== undefined) constraints.resumable = Boolean(constraintsInput.resumable ?? args.resumable);
  if (constraintsInput.wait_for_completion !== undefined || args.wait_for_completion !== undefined) constraints.wait_for_completion = Boolean(constraintsInput.wait_for_completion ?? args.wait_for_completion);
  if (constraintsInput.exit_interview !== undefined || args.exit_interview !== undefined) constraints.exit_interview = Boolean(constraintsInput.exit_interview ?? args.exit_interview);
  const preflightPaths = normalizePreflightPaths(constraintsInput.preflight_paths ?? args.preflight_paths);
  if (preflightPaths.length > 0) constraints.preflight_paths = preflightPaths;
  const requiredMcpTools = normalizeStringList(constraintsInput.required_mcp_tools ?? args.required_mcp_tools, 'worker_invalid_required_mcp_tools');
  if (requiredMcpTools.length > 0) constraints.required_mcp_tools = requiredMcpTools;
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

function copyString(target: Record<string, unknown>, key: string, value: unknown): void {
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
