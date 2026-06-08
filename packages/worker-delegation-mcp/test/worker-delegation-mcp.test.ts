import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgv, createServerState, handleRequest, parseArgs } from '../src/main.js';
import { commandRequiresWindowsShell, parseLastMessage } from '../src/codex-adapter.js';
import { resolveWorkingDirectory } from '../src/policy.js';

type RpcResponse = {
  result?: Record<string, any>;
  error?: Record<string, any>;
};

const root = mkdtempSync(join(tmpdir(), 'worker-delegation-'));
const runRoot = join(root, 'runs');
const auditLogDir = join(root, 'audit');
const fakeCodexScript = join(root, 'exec');
const fakeCodexErrorScript = join(root, 'exec-error-with-output');
const platformRootCase = process.platform === 'win32' ? root.toUpperCase() : root;
writeFileSync(fakeCodexScript, `
const fs = require('fs');
const args = process.argv.slice(2);
const lastMessagePath = args[args.indexOf('-o') + 1];
const isResume = args.includes('resume');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ thread_id: isResume ? 'thread-resumed' : 'thread-created' }) + '\\n');
  const output = {
    summary: isResume ? 'resumed worker ok' : 'worker ok',
    deliverables: [{ path: 'result.txt', description: prompt.includes('Intent') ? 'saw intent' : 'missing intent' }],
    open_questions: [],
    next_actions: ['done'],
    edits_performed: prompt.includes('Implement:'),
    target_state_changed: prompt.includes('Implement:'),
    changes: prompt.includes('Implement:') ? [{ path: 'result.txt', status: 'modified', summary: 'fake edit result' }] : [],
    verification: [{ tool: 'fake-codex', command: null, status: 'passed', summary: 'fake worker completed' }],
    exit_interview: null
  };
  if (prompt.includes('Exit interview')) output.exit_interview = {
    ergonomics_feedback: 'fake worker found the exit interview easy to answer',
    friction_points: ['progress visibility was limited'],
    missing_affordances: ['no push notification'],
    observed_incoherencies: ['status naming was too coarse'],
    suggested_improvements: ['surface latest progress in status']
  };
  fs.writeFileSync(lastMessagePath, JSON.stringify(output));
});
`, 'utf8');
writeFileSync(fakeCodexErrorScript, `
const fs = require('fs');
const args = process.argv.slice(2);
const lastMessagePath = args[args.indexOf('-o') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ thread_id: 'thread-error-output' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'error', message: 'simulated mcp tool error' }) + '\\n');
  fs.writeFileSync(lastMessagePath, JSON.stringify({
    summary: 'usable output despite tool error',
    deliverables: [],
    open_questions: [],
    next_actions: [],
    edits_performed: false,
    target_state_changed: false,
    changes: [],
    verification: [{ tool: 'fake-codex', command: null, status: 'failed', summary: 'simulated tool error' }],
    exit_interview: null
  }));
});
`, 'utf8');
const rpc = handleRequest as unknown as (request: Record<string, unknown>, state: ReturnType<typeof createServerState>) => Promise<RpcResponse>;
const rpcWithContext = handleRequest as unknown as (request: Record<string, unknown>, state: ReturnType<typeof createServerState>, context: { abortSignal?: AbortSignal }) => Promise<RpcResponse>;
const state = createServerState({
  allowedRoot: root,
  runRoot,
  auditLogDir,
  codexCommand: process.execPath,
  maxOutputBytes: 2 * 1024 * 1024,
}, { PATH: process.env.PATH, WORKER_SECRET: 'must-not-leak' });

const tools = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, state);
assert.deepEqual(tools.result?.tools.map((tool) => tool.name), [
  'worker_policy_inspect',
  'worker_run',
  'worker_edit',
  'worker_resume',
  'worker_run_status',
  'worker_runs_list',
  'worker_run_wait',
  'worker_output_show',
]);
for (const tool of tools.result?.tools ?? []) {
  assert.equal(tool.outputSchema?.type, 'object', tool.name);
  assert.equal(typeof tool.annotations?.title, 'string', tool.name);
  assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name);
}
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.annotations?.readOnlyHint, false);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_edit')?.annotations?.readOnlyHint, false);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_policy_inspect')?.annotations?.readOnlyHint, true);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_policy_inspect')?.outputSchema?.properties?.schema?.const, 'narada.worker.policy.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_edit')?.outputSchema?.properties?.schema?.const, 'narada.worker.run.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_status')?.outputSchema?.properties?.schema?.const, 'narada.worker.run.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_wait')?.outputSchema?.properties?.schema?.const, 'narada.worker.run_wait.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_runs_list')?.outputSchema?.properties?.schema?.const, 'narada.worker.runs_list.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_output_show')?.outputSchema?.properties?.schema?.const, 'narada.worker.output_show.v1');
assert.deepEqual(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.authority?.enum, ['read', 'write', 'command']);
assert.deepEqual(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.cognition?.enum, ['low', 'medium', 'high']);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.wait_for_completion?.type, 'boolean');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.exit_interview?.type, 'boolean');
assert.deepEqual(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.intent?.properties?.mode?.enum, ['audit_only', 'plan_only', 'implement', 'implement_and_verify']);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.preflight_paths?.type, 'array');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.required_mcp_tools?.type, 'array');
assert.equal(commandRequiresWindowsShell('codex.cmd', 'win32'), true);
assert.equal(commandRequiresWindowsShell('codex.bat', 'win32'), true);
assert.equal(commandRequiresWindowsShell(process.execPath, 'win32'), false);
assert.equal(commandRequiresWindowsShell('codex.cmd', 'linux'), false);

const initialize = await rpc({ jsonrpc: '2.0', id: 11, method: 'initialize', params: {} }, state);
assert.deepEqual(Object.keys(initialize.result?.capabilities ?? {}).sort(), ['completions', 'logging', 'prompts', 'resources', 'tools']);
const prompts = await rpc({ jsonrpc: '2.0', id: 12, method: 'prompts/list', params: {} }, state);
assert.equal(prompts.result?.prompts[0].name, 'worker_delegation_task');
const prompt = await rpc({ jsonrpc: '2.0', id: 13, method: 'prompts/get', params: { name: 'worker_delegation_task' } }, state);
assert.match(prompt.result?.messages[0].content.text, /Delegate bounded work/);
const logging = await rpc({ jsonrpc: '2.0', id: 14, method: 'logging/setLevel', params: { level: 'debug' } }, state);
assert.deepEqual(logging.result, {});

const policy = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worker_policy_inspect', arguments: {} } }, state);
assert.equal(policy.result?.structuredContent.schema, 'narada.worker.policy.v1');
assert.equal(policy.result?.structuredContent.default_runtime, 'codex');
assert.equal(policy.result?.structuredContent.default_authority, 'read');
assert.equal(policy.result?.structuredContent.default_cognition, 'low');
assert.deepEqual(policy.result?.structuredContent.allowed_runtimes, ['codex']);
assert.deepEqual(policy.result?.structuredContent.allowed_authorities, ['read', 'write', 'command']);
assert.deepEqual(policy.result?.structuredContent.allowed_cognition, ['low', 'medium', 'high']);
assert.equal(policy.result?.structuredContent.allow_raw_config_overrides, false);
assert.equal(policy.result?.structuredContent.runtimes.codex.ephemeral, true);
assert.equal(policy.result?.structuredContent.max_parallel_runs, 10);
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.low, { model: 'gpt-5.4-mini', reasoning_effort: 'low' });
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.medium, { model: 'gpt-5.4-mini', reasoning_effort: 'medium' });
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.high, { model: 'gpt-5.4', reasoning_effort: 'high' });
assert.match(policy.result?.content[0].text, /worker_policy: ok/);

assert.throws(() => createServerState({ allowedRoot: root, allowedRuntime: 'agent-cli' }), /worker_runtime_not_allowed/);
assert.throws(() => createServerState({ allowedRoot: root, allowedSandbox: 'invalid' }), /worker_invalid_sandbox/);
assert.throws(() => createServerState({ allowedRoot: root, allowedSandbox: 'danger-full-access' }), /worker_danger_full_access_not_allowed/);
createServerState({ allowedRoot: root, allowedSandboxes: ['read-only', 'workspace-write'] });

if (process.platform === 'win32') {
  const mixedCaseState = createServerState({ allowedRoot: root.toLowerCase(), runRoot, codexCommand: process.execPath });
  assert.equal(mixedCaseState.policy.allowedRoots.length, 1);
  assert.equal(mixedCaseState.policy.allowedRoots[0].toLowerCase(), root.toLowerCase());
  assert.equal(createServerState({ allowedRoot: platformRootCase, runRoot, codexCommand: process.execPath }).policy.allowedRoots[0].toLowerCase(), root.toLowerCase());
  assert.equal(resolveWorkingDirectory(platformRootCase, mixedCaseState.policy).toLowerCase(), root.toLowerCase());
  const mixedCaseChild = join(platformRootCase, 'Child');
  mkdirSync(mixedCaseChild, { recursive: true });
  assert.equal(resolveWorkingDirectory(mixedCaseChild, mixedCaseState.policy).toLowerCase(), mixedCaseChild.toLowerCase());
}

const deniedRuntime = await rpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('x', { runtime: 'agent-cli' }) },
}, state);
assert.equal(deniedRuntime.error?.data.schema, 'narada.worker.error.v1');
assert.equal(deniedRuntime.error?.data.code, 'worker_invalid_runtime');

const deniedAuthority = await rpc({
  jsonrpc: '2.0',
  id: 31,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('x', {}, 'workspace-edit') },
}, state);
assert.equal(deniedAuthority.error?.data.code, 'worker_invalid_authority');

const deniedConfig = await rpc({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('x', { config: { shell_environment_policy: 'all' } }) },
}, state);
assert.equal(deniedConfig.error?.data.code, 'worker_config_key_not_allowed');

const deniedRawOverrides = await rpc({
  jsonrpc: '2.0',
  id: 41,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { ...runArgs('x'), config_overrides: ['model=\"x\"'] } },
}, state);
assert.equal(deniedRawOverrides.error?.data.code, 'worker_raw_config_overrides_not_allowed');

const badConfigPath = join(root, 'bad-config.toml');
writeFileSync(badConfigPath, '[worker]\nrun_root = nope\n', 'utf8');
assert.throws(() => createServerState({ config: badConfigPath, allowedRoot: root }), hasCode('worker_invalid_config_file'));
assert.throws(() => createServerState({ allowedRoot: root, maxOutputBytes: 'nope' }), hasCode('worker_invalid_config_value'));
assert.throws(() => createServerState({ allowedRoot: root, ephemeral: 'treu' }), hasCode('worker_invalid_config_value'));
assert.throws(() => parseArgs(['--allowed-root']), hasCode('worker_invalid_cli_args'));
assert.throws(() => parseArgs(['--codex-command-arg']), hasCode('worker_invalid_cli_args'));
assert.deepEqual(parseArgs(['--codex-command-arg', 'codex.js', '--codex-command-arg', 'arg2']).codexCommandArgs, ['codex.js', 'arg2']);
assert.equal(parseArgs(['--cognition-low-reasoning-effort', 'minimal']).cognitionLowReasoningEffort, 'minimal');
assert.equal(parseArgs(['--cognition-high-model', 'gpt-test-high']).cognitionHighModel, 'gpt-test-high');

const busyState = createServerState({ allowedRoot: root, runRoot: join(root, 'busy'), codexCommand: process.execPath, maxParallelRuns: 1 });
busyState.activeRunCount = 1;
const busyRun = await rpc({
  jsonrpc: '2.0',
  id: 42,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('busy worker') },
}, busyState);
assert.equal(busyRun.error?.data.code, 'worker_parallel_limit_exceeded');
assert.equal(busyState.activeRunCount, 1);

const allowedConfigRun = await rpc({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('run with allowed config', { model: 'gpt-test', reasoning_effort: 'low', config: { model: 'gpt-test' } }) },
}, state);
assert.equal(allowedConfigRun.result?.structuredContent.status, 'completed');
assert.equal(state.activeRunCount, 0);
assert.equal(allowedConfigRun.result?.structuredContent.worker_session_id, 'thread-created');
assert.equal(allowedConfigRun.result?.structuredContent.summary, 'worker ok');
assert.equal(allowedConfigRun.result?.structuredContent.requested_mode, 'audit_only');
assert.equal(allowedConfigRun.result?.structuredContent.edits_performed, false);
assert.equal(allowedConfigRun.result?.structuredContent.target_state_changed, false);
assert.equal(allowedConfigRun.result?.structuredContent.confidence, 'complete');
assert.equal(allowedConfigRun.result?.structuredContent.preflight.some((check) => check.name === 'cwd_readable' && check.status === 'ok'), true);
if (process.platform === 'win32') {
  const caseInsensitiveRun = await rpc({
    jsonrpc: '2.0',
    id: 50,
    method: 'tools/call',
    params: { name: 'worker_run', arguments: runArgs(platformRootCase, { model: 'gpt-test', reasoning_effort: 'low', config: { model: 'gpt-test' } }) },
  }, state);
  assert.equal(caseInsensitiveRun.error, undefined);
  assert.equal(caseInsensitiveRun.result?.structuredContent.preflight.some((check) => check.name === 'cwd_readable' && check.status === 'ok'), true);
}
assert.deepEqual(allowedConfigRun.result?.structuredContent.final_checklist, ['state whether files were edited', 'list evidence inspected', 'list blocked or unreadable paths', 'separate recommendations from completed work']);
const completedRunDir = allowedConfigRun.result?.structuredContent.run_dir;
const promptArtifactLink = allowedConfigRun.result?.content.find((item) => item.type === 'resource_link' && String(item.uri).startsWith('worker-artifact:') && item.name.endsWith('/worker_prompt.txt'));
assert.ok(promptArtifactLink);
const listedResources = await rpc({ jsonrpc: '2.0', id: 51, method: 'resources/list', params: {} }, state);
assert.equal(listedResources.result?.resources.some((resource) => resource.uri === promptArtifactLink.uri), true);
const promptResource = await rpc({ jsonrpc: '2.0', id: 52, method: 'resources/read', params: { uri: promptArtifactLink.uri } }, state);
assert.match(promptResource.result?.contents[0].text, /Do not call any worker_\* MCP tools\./);
for (const file of ['request.json', 'executor_request.json', 'resolved_worker_config.json', 'worker_prompt.txt', 'worker_invocation.json', 'events.jsonl', 'diagnostic.log', 'last_message.json', 'result.json', 'worker_output.schema.json']) {
  assert.equal(existsSync(join(completedRunDir, file)), true, file);
}
const workerOutputSchema = JSON.parse(readFileSync(join(completedRunDir, 'worker_output.schema.json'), 'utf8'));
assertStrictStructuredOutputSchema(workerOutputSchema, 'worker_output_schema');
assert.equal(workerOutputSchema.required.includes('exit_interview'), true);
assert.deepEqual(workerOutputSchema.properties.verification.items.required, ['tool', 'command', 'status', 'summary']);
assert.deepEqual(workerOutputSchema.properties.verification.items.properties.tool.type, ['string', 'null']);
assert.deepEqual(workerOutputSchema.properties.verification.items.properties.command.type, ['string', 'null']);
assert.deepEqual(workerOutputSchema.properties.exit_interview.type, ['object', 'null']);
const request = JSON.parse(readFileSync(join(completedRunDir, 'request.json'), 'utf8'));
assert.equal(request.intent.instruction, 'run with allowed config');
assert.equal(request.constraints.cwd, root);
assert.equal(request.constraints.authority, 'read');
assert.equal(request.constraints.cognition, 'low');
assert.equal(request.constraints.resumable, undefined);
assert.equal(request.constraints.overrides.model, 'gpt-test');
const resolvedConfig = JSON.parse(readFileSync(join(completedRunDir, 'resolved_worker_config.json'), 'utf8'));
assert.equal(resolvedConfig.runtime, 'codex');
assert.equal(resolvedConfig.authority, 'read');
assert.equal(resolvedConfig.cognition, 'low');
assert.equal(resolvedConfig.command, process.execPath);
assert.deepEqual(resolvedConfig.command_args, []);
assert.equal(resolvedConfig.resumable, false);
assert.equal(resolvedConfig.ephemeral, true);
assert.equal(resolvedConfig.config.model, 'gpt-test');
assert.equal(resolvedConfig.config.model_reasoning_effort, 'low');
assert.deepEqual(resolvedConfig.environment_keys, ['PATH']);
assert.equal(JSON.stringify(resolvedConfig).includes('must-not-leak'), false);
const executorRequest = JSON.parse(readFileSync(join(completedRunDir, 'executor_request.json'), 'utf8'));
assert.equal(executorRequest.schema, 'narada.worker.executor_request.v1');
assert.equal(executorRequest.intent.instruction, 'run with allowed config');
assert.equal(executorRequest.intent.mode, 'audit_only');
assert.equal(executorRequest.requested_mode, 'audit_only');
assert.equal(executorRequest.preflight.some((check) => check.name === 'cwd_readable' && check.status === 'ok'), true);
assert.equal(executorRequest.resolved_execution_policy.cwd, root);
assert.equal(executorRequest.resolved_execution_policy.authority, 'read');
assert.equal(executorRequest.resolved_execution_policy.cognition, 'low');
const invocation = JSON.parse(readFileSync(join(completedRunDir, 'worker_invocation.json'), 'utf8'));
assert.equal(invocation.argv[0], 'exec');
assert.equal(invocation.argv.includes('--ephemeral'), true);
assert.equal(invocation.argv.includes('--json'), true);
assert.equal(invocation.argv.at(-1), '-');

const legacyRunDir = join(runRoot, 'run-20000101T000000Z-legacy1');
mkdirSync(legacyRunDir, { recursive: true });
writeFileSync(join(legacyRunDir, 'result.json'), JSON.stringify({
  schema: 'narada.worker.run.v1',
  status: 'completed',
  run_id: 'run-20000101T000000Z-legacy1',
  run_dir: legacyRunDir,
  runtime: 'codex',
  worker_session_id: null,
  resolved_worker_config: { authority: 'read' },
  executor_request: { intent: {} },
  summary: 'legacy run',
  deliverables: [],
  open_questions: [],
  next_actions: [],
  artifacts: [],
  timing: { started_at: '2000-01-01T00:00:00.000Z', finished_at: '2000-01-01T00:00:01.000Z', duration_ms: 1000 },
  error: null,
}), 'utf8');
const legacyList = await rpc({ jsonrpc: '2.0', id: 520, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { limit: 200 } } }, state);
const legacyListItem = legacyList.result?.structuredContent.runs.find((run) => run.run_id === 'run-20000101T000000Z-legacy1');
assert.equal(legacyListItem?.requested_mode, 'audit_only');
assert.equal(legacyListItem?.requested_mode_inferred, true);

const asyncRun = await rpc({
  jsonrpc: '2.0',
  id: 521,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'default async run' }, constraints: { cwd: root, authority: 'read', cognition: 'low' } } },
}, state);
assert.equal(asyncRun.result?.structuredContent.status, 'running');
assert.equal(asyncRun.result?.structuredContent.timing.finished_at, null);
assert.deepEqual(asyncRun.result?.structuredContent.progress, { event_count: 0, latest_event_type: null, latest_event_preview: null, readable: true, tail_truncated: false });
assert.equal(state.activeRunCount, 1);
const listedRuns = await rpc({ jsonrpc: '2.0', id: 522, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { limit: 20 } } }, state);
assert.ok(listedRuns.result, JSON.stringify(listedRuns.error));
assert.equal(listedRuns.result?.structuredContent.runs.some((run) => run.run_id === asyncRun.result?.structuredContent.run_id), true);
assert.equal(listedRuns.result?.structuredContent.runs[0].summary, undefined);
assert.equal(typeof listedRuns.result?.structuredContent.runs[0].summary_preview === 'string' || listedRuns.result?.structuredContent.runs[0].summary_preview === null, true);
assert.equal(typeof listedRuns.result?.structuredContent.runs[0].requested_mode, 'string');
assert.equal(typeof listedRuns.result?.structuredContent.runs[0].authority, 'string');
const asyncStatus = await rpc({ jsonrpc: '2.0', id: 523, method: 'tools/call', params: { name: 'worker_run_wait', arguments: { run_id: asyncRun.result?.structuredContent.run_id, timeout_ms: 5000, poll_ms: 25 } } }, state);
assert.equal(asyncStatus.result?.structuredContent.schema, 'narada.worker.run_wait.v1');
assert.equal(asyncStatus.result?.structuredContent.wait.status, 'finished');
assert.equal(asyncStatus.result?.structuredContent.run.summary, undefined);
assert.equal(asyncStatus.result?.structuredContent.run.summary_preview, 'worker ok');
assert.match(String(asyncStatus.result?.structuredContent.run.progress_preview), /thread-created/);
assert.equal(asyncStatus.result?.structuredContent.full_run, undefined);
assert.equal(state.activeRunCount, 0);
const directStatus = await rpc({ jsonrpc: '2.0', id: 5231, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: asyncRun.result?.structuredContent.run_id } } }, state);
assert.match(String(directStatus.result?.structuredContent.progress.latest_event_preview), /thread-created/);
assert.equal(directStatus.result?.structuredContent.exit_interview, null);
const exitInterviewRun = await rpc({ jsonrpc: '2.0', id: 5233, method: 'tools/call', params: { name: 'worker_run', arguments: { intent: { instruction: 'ask for ergonomics feedback' }, constraints: { cwd: root, authority: 'read', cognition: 'low', wait_for_completion: true, exit_interview: true } } } }, state);
assert.equal(exitInterviewRun.result?.structuredContent.status, 'completed');
assert.equal(exitInterviewRun.result?.structuredContent.exit_interview.ergonomics_feedback, 'fake worker found the exit interview easy to answer');
assert.deepEqual(exitInterviewRun.result?.structuredContent.exit_interview.friction_points, ['progress visibility was limited']);
assert.deepEqual(exitInterviewRun.result?.structuredContent.exit_interview.observed_incoherencies, ['status naming was too coarse']);
assert.match(readFileSync(join(exitInterviewRun.result?.structuredContent.run_dir, 'worker_prompt.txt'), 'utf8'), /Exit interview/);
const orphanedRunId = 'run-20000101T000002Z-orphan1';
const orphanedRunDir = join(runRoot, orphanedRunId);
mkdirSync(orphanedRunDir, { recursive: true });
writeFileSync(join(orphanedRunDir, 'events.jsonl'), '', 'utf8');
writeFileSync(join(orphanedRunDir, 'last_message.json'), JSON.stringify({
  summary: 'orphaned worker output',
  deliverables: [{ path: 'artifact.txt', description: 'usable artifact' }],
  open_questions: [],
  next_actions: ['inspect recovered output'],
  edits_performed: true,
  target_state_changed: true,
  changes: [{ path: 'artifact.txt', status: 'modified', summary: 'recovered change' }],
  verification: [{ tool: 'manual', command: null, status: 'passed', summary: 'output parsed' }],
}), 'utf8');
writeFileSync(join(orphanedRunDir, 'result.json'), JSON.stringify({
  schema: 'narada.worker.run.v1',
  status: 'running',
  run_id: orphanedRunId,
  run_dir: orphanedRunDir,
  runtime: 'codex',
  worker_session_id: null,
  resolved_worker_config: { authority: 'write', max_run_ms: 1000 },
  executor_request: { requested_mode: 'implement' },
  requested_mode: 'implement',
  edits_performed: null,
  target_state_changed: null,
  confidence: 'complete',
  blocked_paths: [],
  verification: [],
  runtime_warnings: [],
  warning_count: 0,
  preflight: [],
  final_checklist: [],
  summary: '',
  deliverables: [],
  open_questions: [],
  next_actions: [],
  changes: [],
  verification_results: [],
  artifacts: [],
  timing: { started_at: '2000-01-01T00:00:02.000Z', finished_at: null, duration_ms: null },
  error: null,
}), 'utf8');
const orphanedStatus = await rpc({ jsonrpc: '2.0', id: 5232, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: orphanedRunId } } }, state);
assert.equal(orphanedStatus.result?.structuredContent.status, 'completed_with_errors');
assert.equal(orphanedStatus.result?.structuredContent.summary, 'orphaned worker output');
assert.equal(orphanedStatus.result?.structuredContent.warning_count, 1);
assert.match(orphanedStatus.result?.structuredContent.error, /worker_run_orphaned_final_output/);
const recentRuns = await rpc({ jsonrpc: '2.0', id: 524, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { limit: 10 } } }, state);
const recentAsyncRun = recentRuns.result?.structuredContent.runs.find((run) => run.run_id === asyncRun.result?.structuredContent.run_id);
assert.ok(recentAsyncRun);
assert.match(String(recentAsyncRun.progress_preview), /thread-created/);
const verboseRuns = await rpc({ jsonrpc: '2.0', id: 525, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { limit: 1, verbose: true } } }, state);
assert.equal(verboseRuns.result?.structuredContent.runs[0].summary, 'worker ok');
assert.equal(typeof verboseRuns.result?.structuredContent.runs[0].run_dir, 'string');
assert.equal(verboseRuns.result?.structuredContent.runs[0].progress.readable, true);
const summaryOnlyWait = await rpc({ jsonrpc: '2.0', id: 526, method: 'tools/call', params: { name: 'worker_run_wait', arguments: { run_id: asyncRun.result?.structuredContent.run_id, timeout_ms: 0, summary_only: true } } }, state);
assert.deepEqual(Object.keys(summaryOnlyWait.result?.structuredContent.run).sort(), ['error_preview', 'progress', 'run_id', 'status', 'summary']);
assert.match(String(summaryOnlyWait.result?.structuredContent.run.progress.latest_event_preview), /thread-created/);
const verboseWait = await rpc({ jsonrpc: '2.0', id: 527, method: 'tools/call', params: { name: 'worker_run_wait', arguments: { run_id: asyncRun.result?.structuredContent.run_id, timeout_ms: 0, verbose: true } } }, state);
assert.equal(verboseWait.result?.structuredContent.full_run.summary, 'worker ok');

const prefixedState = createServerState({ allowedRoot: root, runRoot: join(root, 'prefixed'), codexCommand: process.execPath, codexCommandArgs: [fakeCodexScript] });
const prefixedRun = await rpc({
  jsonrpc: '2.0',
  id: 53,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('run with command args') },
}, prefixedState);
assert.equal(prefixedRun.result?.structuredContent.status, 'completed');
const prefixedInvocation = JSON.parse(readFileSync(join(prefixedRun.result?.structuredContent.run_dir, 'worker_invocation.json'), 'utf8'));
assert.equal(prefixedInvocation.command, process.execPath);
assert.equal(prefixedInvocation.argv[0], fakeCodexScript);
assert.equal(prefixedInvocation.argv[1], 'exec');

const readAuthority = await rpc({
  jsonrpc: '2.0',
  id: 54,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('read authority') },
}, state);
assert.equal(readAuthority.result?.structuredContent.resolved_worker_config.authority, 'read');
assert.equal(readAuthority.result?.structuredContent.resolved_worker_config.cognition, 'low');
assert.equal(readAuthority.result?.structuredContent.resolved_worker_config.sandbox, 'read-only');
assert.equal(readAuthority.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(readAuthority.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
const mediumCognition = await rpc({
  jsonrpc: '2.0',
  id: 541,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('medium cognition', {}, 'read', 'medium') },
}, state);
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.authority, 'read');
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.cognition, 'medium');
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.sandbox, 'read-only');
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.reasoning_effort, 'medium');
const writeAuthority = await rpc({
  jsonrpc: '2.0',
  id: 55,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('write authority', {}, 'write') },
}, state);
assert.equal(writeAuthority.result?.structuredContent.resolved_worker_config.authority, 'write');
assert.equal(writeAuthority.result?.structuredContent.resolved_worker_config.sandbox, 'workspace-write');
const commandAuthority = await rpc({
  jsonrpc: '2.0',
  id: 56,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('command authority', {}, 'command') },
}, state);
assert.equal(commandAuthority.result?.structuredContent.resolved_worker_config.authority, 'command');
assert.equal(commandAuthority.result?.structuredContent.resolved_worker_config.sandbox, 'workspace-write');
assert.equal(commandAuthority.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(commandAuthority.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');

const editRun = await rpc({
  jsonrpc: '2.0',
  id: 561,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'edit shortcut', wait_for_completion: true, overrides: { model: 'gpt-edit-test' } } },
}, state);
assert.equal(editRun.result?.structuredContent.status, 'completed');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.authority, 'write');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.cognition, 'low');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.sandbox, 'workspace-write');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.model, 'gpt-edit-test');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
assert.equal(editRun.result?.structuredContent.requested_mode, 'implement');
assert.equal(editRun.result?.structuredContent.edits_performed, true);
assert.equal(editRun.result?.structuredContent.target_state_changed, true);
assert.equal(editRun.result?.structuredContent.changes[0].status, 'modified');
assert.equal(editRun.result?.structuredContent.verification_results[0].status, 'passed');
assert.deepEqual(editRun.result?.structuredContent.final_checklist, ['list files changed', 'list tests or checks run', 'include git/worktree status if available', 'list remaining blockers']);
const editRequest = JSON.parse(readFileSync(join(editRun.result?.structuredContent.run_dir, 'request.json'), 'utf8'));
assert.equal(editRequest.intent.instruction, 'edit shortcut');
assert.equal(editRequest.intent.mode, 'implement');
assert.equal(editRequest.constraints.authority, 'write');
assert.equal(editRequest.constraints.cognition, 'low');
assert.equal(editRequest.constraints.resumable, undefined);
assert.equal(editRequest.constraints.overrides.model, 'gpt-edit-test');
assert.equal(editRequest.constraints.overrides.reasoning_effort, 'low');

const defaultEditRun = await rpc({
  jsonrpc: '2.0',
  id: 5611,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'default edit shortcut', wait_for_completion: true } },
}, state);
assert.equal(defaultEditRun.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(defaultEditRun.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');

const customLowCognitionState = createServerState({ allowedRoot: root, runRoot: join(root, 'low-cognition-defaults'), codexCommand: process.execPath, cognitionLowModel: 'gpt-low-default', cognitionLowReasoningEffort: 'minimal' });
const customLowCognition = await rpc({
  jsonrpc: '2.0',
  id: 562,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'custom low cognition defaults', wait_for_completion: true } },
}, customLowCognitionState);
assert.equal(customLowCognition.result?.structuredContent.resolved_worker_config.model, 'gpt-low-default');
assert.equal(customLowCognition.result?.structuredContent.resolved_worker_config.reasoning_effort, 'minimal');

const callerEditOverride = await rpc({
  jsonrpc: '2.0',
  id: 563,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'caller edit override', wait_for_completion: true, overrides: { reasoning_effort: 'high' } } },
}, customLowCognitionState);
assert.equal(callerEditOverride.result?.structuredContent.resolved_worker_config.model, 'gpt-low-default');
assert.equal(callerEditOverride.result?.structuredContent.resolved_worker_config.reasoning_effort, 'high');

const resumableEdit = await rpc({
  jsonrpc: '2.0',
  id: 564,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'resumable edit inheritance', resumable: true, wait_for_completion: true } },
}, state);
assert.equal(resumableEdit.result?.structuredContent.worker_session_id, 'thread-created');
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.ephemeral, false);
const editSessionRecord = JSON.parse(readFileSync(join(runRoot, 'sessions', `${encodeURIComponent('thread-created')}.json`), 'utf8'));
assert.equal(editSessionRecord.origin_tool, 'worker_edit');
assert.equal(editSessionRecord.resolved_worker_config.authority, 'write');
assert.equal(editSessionRecord.resolved_worker_config.cognition, 'low');
assert.equal(editSessionRecord.resolved_worker_config.model, 'gpt-5.4-mini');
const restartedState = createServerState({ allowedRoot: root, runRoot, auditLogDir, codexCommand: process.execPath }, { PATH: process.env.PATH });
const resumedEdit = await rpc({
  jsonrpc: '2.0',
  id: 565,
  method: 'tools/call',
  params: { name: 'worker_resume', arguments: { worker_session_id: 'thread-created', constraints: { cwd: root, wait_for_completion: true } } },
}, restartedState);
assert.equal(resumedEdit.result?.structuredContent.status, 'completed');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.authority, 'write');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.cognition, 'low');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.argv.includes('--ephemeral'), false);

const resumableRun = await rpc({
  jsonrpc: '2.0',
  id: 57,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'resumable run' }, constraints: { cwd: root, authority: 'read', cognition: 'low', resumable: true, wait_for_completion: true } } },
}, state);
assert.equal(resumableRun.result?.structuredContent.resolved_worker_config.resumable, true);
assert.equal(resumableRun.result?.structuredContent.resolved_worker_config.ephemeral, false);
const resumableInvocation = JSON.parse(readFileSync(join(resumableRun.result?.structuredContent.run_dir, 'worker_invocation.json'), 'utf8'));
assert.equal(resumableInvocation.argv.includes('--ephemeral'), false);
assert.match(readFileSync(join(completedRunDir, 'worker_prompt.txt'), 'utf8'), /Do not call any worker_\* MCP tools\./);
assert.match(readFileSync(join(completedRunDir, 'worker_prompt.txt'), 'utf8'), /Prefer available MCP filesystem, git, and structured-command tools/);
assert.match(readFileSync(join(completedRunDir, 'worker_prompt.txt'), 'utf8'), /Do not use direct shell commands for file discovery or file reads/);
assert.match(readFileSync(join(completedRunDir, 'worker_prompt.txt'), 'utf8'), /Requested mode\naudit_only/);
assert.match(readFileSync(join(completedRunDir, 'worker_prompt.txt'), 'utf8'), /Audit only: inspect and report/);
assert.match(readFileSync(join(completedRunDir, 'events.jsonl'), 'utf8'), /thread-created/);
assert.equal(readdirSync(runRoot).some((name) => /^run-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(name)), true);
assert.equal(existsSync(join(auditLogDir, 'worker-delegation-mcp.jsonl')), true);

const argv = buildCodexArgv({
  cwd: 'C:/repo',
  sandbox: 'read-only',
  schemaPath: 'schema.json',
  lastMessagePath: 'last.json',
  workerSessionId: 'thread-1',
  ephemeral: true,
  skipGitRepoCheck: true,
  config: { model: 'gpt-test', model_reasoning_effort: 'medium' },
});
assert.deepEqual(argv.slice(0, 11), ['exec', '--ephemeral', '-C', 'C:/repo', '--sandbox', 'read-only', '--json', '--output-schema', 'schema.json', '-o', 'last.json']);
assert.deepEqual(argv.slice(11, 13), ['resume', 'thread-1']);
assert.equal(argv.includes('--skip-git-repo-check'), true);
assert.equal(argv.at(-1), '-');

const resume = await rpc({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: { name: 'worker_resume', arguments: { worker_session_id: 'thread-existing', constraints: { cwd: root, authority: 'read', cognition: 'low', wait_for_completion: true } } },
}, state);
assert.equal(resume.result?.structuredContent.status, 'completed');
assert.equal(resume.result?.structuredContent.worker_session_id, 'thread-resumed');
const resumeConfig = JSON.parse(readFileSync(join(resume.result?.structuredContent.run_dir, 'resolved_worker_config.json'), 'utf8'));
assert.equal(resumeConfig.resumable, true);
assert.equal(resumeConfig.ephemeral, false);
assert.equal(resumeConfig.argv.includes('resume'), true);
assert.equal(resumeConfig.argv.includes('thread-existing'), true);

const invalidMessagePath = join(root, 'invalid-last-message.json');
writeFileSync(invalidMessagePath, JSON.stringify({ summary: 'bad', deliverables: [{ path: 'x' }], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [] }), 'utf8');
const invalidMessage = parseLastMessage(invalidMessagePath);
assert.equal(invalidMessage.ok, false);
assert.equal(invalidMessage.ok ? '' : invalidMessage.reason, 'invalid_shape');
const nullableVerificationMessagePath = join(root, 'nullable-verification-last-message.json');
writeFileSync(nullableVerificationMessagePath, JSON.stringify({ summary: 'ok', deliverables: [], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [{ tool: null, command: null, status: 'passed', summary: 'nullable accepted' }] }), 'utf8');
const nullableVerificationMessage = parseLastMessage(nullableVerificationMessagePath);
assert.equal(nullableVerificationMessage.ok, true);
if (nullableVerificationMessage.ok) assert.deepEqual(nullableVerificationMessage.data.verification[0], { tool: null, command: null, status: 'passed', summary: 'nullable accepted' });
if (nullableVerificationMessage.ok) assert.equal(nullableVerificationMessage.data.exit_interview, null);
const missingVerificationCommandPath = join(root, 'missing-verification-command-last-message.json');
writeFileSync(missingVerificationCommandPath, JSON.stringify({ summary: 'bad', deliverables: [], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [{ tool: 'test', status: 'passed', summary: 'missing command rejected' }] }), 'utf8');
const missingVerificationCommand = parseLastMessage(missingVerificationCommandPath);
assert.equal(missingVerificationCommand.ok, false);
assert.match(missingVerificationCommand.ok ? '' : missingVerificationCommand.message, /nullable string tool and command/);

const spawnFailureState = createServerState({ allowedRoot: root, runRoot: join(root, 'spawn-failure'), codexCommand: join(root, 'missing-codex.exe') });
const spawnFailure = await rpc({
  jsonrpc: '2.0',
  id: 61,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('spawn failure') },
}, spawnFailureState);
assert.equal(spawnFailure.error?.data.code, 'worker_runtime_failed');
assert.equal(typeof spawnFailure.error?.data.details.run_dir, 'string');
const failureResult = JSON.parse(readFileSync(join(spawnFailure.error?.data.details.run_dir, 'result.json'), 'utf8'));
assert.equal(failureResult.summary, '');
assert.deepEqual(failureResult.next_actions, []);
assert.equal(failureResult.worker_output_error.reason, 'invalid_shape');

const eventRoot = mkdtempSync(join(tmpdir(), 'worker-delegation-bad-event-'));
writeFileSync(join(eventRoot, 'exec'), `
const fs = require('fs');
const args = process.argv.slice(2);
const lastMessagePath = args[args.indexOf('-o') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('not json\\n');
  fs.writeFileSync(lastMessagePath, JSON.stringify({ summary: 'ok', deliverables: [], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [] }));
});
`, 'utf8');
const badEventState = createServerState({ allowedRoot: eventRoot, runRoot: join(eventRoot, 'runs'), codexCommand: process.execPath });
const badEvent = await rpc({
  jsonrpc: '2.0',
  id: 62,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'bad event' }, constraints: { cwd: eventRoot, wait_for_completion: true } } },
}, badEventState);
assert.equal(badEvent.result?.structuredContent.status, 'completed_with_errors');
assert.equal(badEvent.result?.structuredContent.summary, 'ok');
assert.match(badEvent.result?.structuredContent.error, /invalid json event/);
assert.equal(badEvent.result?.structuredContent.warning_count, 0);

const completedWithToolErrorState = createServerState({ allowedRoot: root, runRoot: join(root, 'completed-with-tool-error'), codexCommand: process.execPath, codexCommandArgs: [fakeCodexErrorScript] });
const completedWithToolError = await rpc({
  jsonrpc: '2.0',
  id: 621,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('tool error with output') },
}, completedWithToolErrorState);
assert.equal(completedWithToolError.result?.structuredContent.status, 'completed');
assert.equal(completedWithToolError.result?.structuredContent.summary, 'usable output despite tool error');
assert.equal(completedWithToolError.result?.structuredContent.error, null);
assert.equal(completedWithToolError.result?.structuredContent.warning_count, 1);
assert.deepEqual(completedWithToolError.result?.structuredContent.runtime_warnings, ['simulated mcp tool error']);
const filteredCompletedWithErrors = await rpc({ jsonrpc: '2.0', id: 622, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { include_completed: false } } }, completedWithToolErrorState);
assert.equal(filteredCompletedWithErrors.result?.structuredContent.runs.some((run) => run.status === 'completed'), false);

const preflightRun = await rpc({
  jsonrpc: '2.0',
  id: 623,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'preflight paths', mode: 'plan_only' }, constraints: { cwd: root, authority: 'read', cognition: 'low', wait_for_completion: true, preflight_paths: [{ path: root, access: 'read', label: 'old authority' }, { path: join(root, 'new-repo'), access: 'create', label: 'new repo' }], required_mcp_tools: ['local-filesystem-read.fs_glob_search', 'structured-command.structured_command_execute'] } } },
}, state);
assert.equal(preflightRun.result?.structuredContent.requested_mode, 'plan_only');
assert.equal(preflightRun.result?.structuredContent.edits_performed, false);
assert.equal(preflightRun.result?.structuredContent.preflight.some((check) => check.message.includes('old authority') && check.status === 'ok'), true);
assert.equal(preflightRun.result?.structuredContent.preflight.some((check) => check.message.includes('new repo') && check.status === 'ok'), true);
assert.equal(preflightRun.result?.structuredContent.preflight.some((check) => check.name === 'required_mcp_tools' && check.status === 'warning' && check.message.includes('structured-command.structured_command_execute')), true);

const blockedPreflight = await rpc({
  jsonrpc: '2.0',
  id: 624,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'blocked preflight', mode: 'implement' }, constraints: { cwd: root, authority: 'read', cognition: 'low', wait_for_completion: true, preflight_paths: [{ path: join(root, 'missing-input'), access: 'read', label: 'missing input' }] } } },
}, state);
assert.equal(blockedPreflight.error?.data.code, 'worker_preflight_blocked');
assert.equal(blockedPreflight.error?.data.details.requested_mode, 'implement');
assert.equal(blockedPreflight.error?.data.details.blocked_preflight.some((check) => check.message.includes('missing input')), true);
assert.equal(blockedPreflight.error?.data.details.blocked_preflight.some((check) => check.name === 'mode_authority_alignment'), true);

const runtimeErrorRoot = mkdtempSync(join(tmpdir(), 'worker-delegation-runtime-error-'));
writeFileSync(join(runtimeErrorRoot, 'exec'), `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-runtime-error' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'model not available for account' } }) + '\\n');
  process.exit(1);
});
`, 'utf8');
const runtimeErrorState = createServerState({ allowedRoot: runtimeErrorRoot, runRoot: join(runtimeErrorRoot, 'runs'), codexCommand: process.execPath });
const runtimeError = await rpc({
  jsonrpc: '2.0',
  id: 63,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'runtime error' }, constraints: { cwd: runtimeErrorRoot, wait_for_completion: true } } },
}, runtimeErrorState);
assert.equal(runtimeError.error?.data.code, 'worker_runtime_failed');
assert.equal(runtimeError.error?.data.details.error, 'model not available for account');

const materializedState = createServerState({ allowedRoot: root, runRoot: join(root, 'small-output'), maxOutputBytes: 120 });
const materialized = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'worker_policy_inspect', arguments: {} } }, materializedState);
assert.equal(materialized.result?.structuredContent.result_materialized, true);
assert.equal(materialized.result?.structuredContent.reader_tool, 'worker_output_show');
assert.match(materialized.result?.content[0].text, /worker_policy_inspect: materialized/);
const materializedResourceLink = materialized.result?.content.find((item) => item.type === 'resource_link' && String(item.uri).startsWith('worker-output:'));
assert.ok(materializedResourceLink);
const materializedResources = await rpc({ jsonrpc: '2.0', id: 71, method: 'resources/list', params: {} }, materializedState);
assert.equal(materializedResources.result?.resources.some((resource) => resource.uri === materializedResourceLink.uri), true);
const materializedResource = await rpc({ jsonrpc: '2.0', id: 72, method: 'resources/read', params: { uri: materializedResourceLink.uri } }, materializedState);
assert.match(materializedResource.result?.contents[0].text, /narada.worker.policy.v1/);
const shown = await rpc({
  jsonrpc: '2.0',
  id: 8,
  method: 'tools/call',
  params: { name: 'worker_output_show', arguments: { output_ref: materialized.result?.structuredContent.output_ref, offset: 0, limit: 20 } },
}, materializedState);
assert.equal(shown.result?.structuredContent.schema, 'narada.worker.output_show.v1');
assert.equal(shown.result?.content[0].text, shown.result?.structuredContent.output_text);
assert.equal(shown.result?.content[0].text.length <= 20, true);
const shownArtifact = await rpc({
  jsonrpc: '2.0',
  id: 801,
  method: 'tools/call',
  params: { name: 'worker_output_show', arguments: { path: join(completedRunDir, 'executor_request.json'), offset: 0, limit: 80 } },
}, state);
assert.equal(shownArtifact.result?.structuredContent.schema, 'narada.worker.output_show.v1');
assert.equal(shownArtifact.result?.structuredContent.output_ref, null);
assert.match(shownArtifact.result?.structuredContent.output_text, /narada.worker.executor_request.v1/);
const badSlice = await rpc({
  jsonrpc: '2.0',
  id: 81,
  method: 'tools/call',
  params: { name: 'worker_output_show', arguments: { output_ref: materialized.result?.structuredContent.output_ref, offset: 'nope', limit: 20 } },
}, materializedState);
assert.equal(badSlice.error?.data.code, 'worker_invalid_config_value');

const cancelled = new AbortController();
cancelled.abort();
const cancelledRun = await rpcWithContext({
  jsonrpc: '2.0',
  id: 82,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('cancel before runtime starts') },
}, state, { abortSignal: cancelled.signal });
assert.equal(cancelledRun.error?.data.code, 'worker_runtime_cancelled');

const unknown = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'worker_autopilot', arguments: {} } }, state);
assert.equal(unknown.error?.data.code, 'worker_unknown_tool');

function hasCode(code: string): (error: unknown) => boolean {
  return (error: any) => error?.codeName === code;
}

function runArgs(instruction: string, constraints: Record<string, unknown> = {}, authority = 'read', cognition = 'low'): Record<string, unknown> {
  return {
    intent: { instruction },
    constraints: { cwd: root, authority, cognition, wait_for_completion: true, overrides: constraints },
  };
}

function assertStrictStructuredOutputSchema(schema: any, path: string): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const propertyNames = Object.keys(schema.properties);
    assert.deepEqual([...schema.required].sort(), [...propertyNames].sort(), `${path}.required must include every property for Codex structured output`);
    for (const propertyName of propertyNames) {
      assertStrictStructuredOutputSchema(schema.properties[propertyName], `${path}.properties.${propertyName}`);
    }
  }
  if (schema.items) assertStrictStructuredOutputSchema(schema.items, `${path}.items`);
}
