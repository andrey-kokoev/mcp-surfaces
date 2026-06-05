import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgv, createServerState, handleRequest, parseArgs } from '../src/main.js';
import { parseLastMessage } from '../src/codex-adapter.js';

type RpcResponse = {
  result?: Record<string, any>;
  error?: Record<string, any>;
};

const root = mkdtempSync(join(tmpdir(), 'worker-delegation-'));
const runRoot = join(root, 'runs');
const auditLogDir = join(root, 'audit');
const fakeCodexScript = join(root, 'exec');
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
  fs.writeFileSync(lastMessagePath, JSON.stringify({
    summary: isResume ? 'resumed worker ok' : 'worker ok',
    deliverables: [{ path: 'result.txt', description: prompt.includes('Intent') ? 'saw intent' : 'missing intent' }],
    open_questions: [],
    next_actions: ['done']
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
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_output_show')?.outputSchema?.properties?.schema?.const, 'narada.worker.output_show.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.profile?.enum?.includes('delegating-agent-research'), true);

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
assert.equal(policy.result?.structuredContent.default_profile, 'default');
assert.deepEqual(policy.result?.structuredContent.allowed_runtimes, ['codex']);
assert.deepEqual(policy.result?.structuredContent.allowed_profiles, ['default', 'delegating-agent-read', 'delegating-agent-research', 'delegating-agent-write', 'delegating-agent-command']);
assert.equal(policy.result?.structuredContent.allow_raw_config_overrides, false);
assert.equal(policy.result?.structuredContent.runtimes.codex.ephemeral, true);
assert.equal(policy.result?.structuredContent.max_parallel_runs, 10);
assert.deepEqual(policy.result?.structuredContent.edit_defaults, { model: 'gpt-5.4-mini', reasoning_effort: 'low' });
assert.deepEqual(policy.result?.structuredContent.profile_defaults['delegating-agent-read'], { model: 'gpt-5.4-mini', reasoning_effort: 'low' });
assert.deepEqual(policy.result?.structuredContent.profile_defaults['delegating-agent-research'], { model: 'gpt-5.4-mini', reasoning_effort: 'medium' });
assert.deepEqual(policy.result?.structuredContent.profile_defaults['delegating-agent-command'], { model: 'gpt-5.4-mini', reasoning_effort: 'low' });
assert.match(policy.result?.content[0].text, /worker_policy: ok/);

assert.throws(() => createServerState({ allowedRoot: root, allowedRuntime: 'agent-cli' }), /worker_runtime_not_allowed/);
assert.throws(() => createServerState({ allowedRoot: root, allowedSandbox: 'invalid' }), /worker_invalid_sandbox/);
assert.throws(() => createServerState({ allowedRoot: root, allowedSandbox: 'danger-full-access' }), /worker_danger_full_access_not_allowed/);
createServerState({ allowedRoot: root, allowedSandboxes: ['read-only', 'workspace-write'] });

const deniedRuntime = await rpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('x', { runtime: 'agent-cli' }) },
}, state);
assert.equal(deniedRuntime.error?.data.schema, 'narada.worker.error.v1');
assert.equal(deniedRuntime.error?.data.code, 'worker_invalid_runtime');

const deniedProfile = await rpc({
  jsonrpc: '2.0',
  id: 31,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('x', {}, 'workspace-edit') },
}, state);
assert.equal(deniedProfile.error?.data.code, 'worker_invalid_profile');

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
assert.equal(parseArgs(['--edit-default-reasoning-effort', 'minimal']).editDefaultReasoningEffort, 'minimal');
assert.equal(parseArgs(['--profile-research-reasoning-effort', 'high']).profileResearchReasoningEffort, 'high');

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
const request = JSON.parse(readFileSync(join(completedRunDir, 'request.json'), 'utf8'));
assert.equal(request.intent.instruction, 'run with allowed config');
assert.equal(request.constraints.cwd, root);
assert.equal(request.constraints.profile, 'default');
assert.equal(request.constraints.resumable, undefined);
assert.equal(request.constraints.overrides.model, 'gpt-test');
const resolvedConfig = JSON.parse(readFileSync(join(completedRunDir, 'resolved_worker_config.json'), 'utf8'));
assert.equal(resolvedConfig.runtime, 'codex');
assert.equal(resolvedConfig.profile, 'default');
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
assert.equal(executorRequest.resolved_execution_policy.cwd, root);
assert.equal(executorRequest.resolved_execution_policy.profile, 'default');
const invocation = JSON.parse(readFileSync(join(completedRunDir, 'worker_invocation.json'), 'utf8'));
assert.equal(invocation.argv[0], 'exec');
assert.equal(invocation.argv.includes('--ephemeral'), true);
assert.equal(invocation.argv.includes('--json'), true);
assert.equal(invocation.argv.at(-1), '-');

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

const readProfile = await rpc({
  jsonrpc: '2.0',
  id: 54,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('read profile', {}, 'delegating-agent-read') },
}, state);
assert.equal(readProfile.result?.structuredContent.resolved_worker_config.sandbox, 'read-only');
assert.equal(readProfile.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(readProfile.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
const researchProfile = await rpc({
  jsonrpc: '2.0',
  id: 541,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('research profile', {}, 'delegating-agent-research') },
}, state);
assert.equal(researchProfile.result?.structuredContent.resolved_worker_config.sandbox, 'read-only');
assert.equal(researchProfile.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(researchProfile.result?.structuredContent.resolved_worker_config.reasoning_effort, 'medium');
const writeProfile = await rpc({
  jsonrpc: '2.0',
  id: 55,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('write profile', {}, 'delegating-agent-write') },
}, state);
assert.equal(writeProfile.result?.structuredContent.resolved_worker_config.sandbox, 'workspace-write');
const commandProfile = await rpc({
  jsonrpc: '2.0',
  id: 56,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('command profile', {}, 'delegating-agent-command') },
}, state);
assert.equal(commandProfile.result?.structuredContent.resolved_worker_config.sandbox, 'workspace-write');
assert.equal(commandProfile.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(commandProfile.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');

const editRun = await rpc({
  jsonrpc: '2.0',
  id: 561,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'edit profile shortcut', overrides: { model: 'gpt-edit-test' } } },
}, state);
assert.equal(editRun.result?.structuredContent.status, 'completed');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.profile, 'delegating-agent-write');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.sandbox, 'workspace-write');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.model, 'gpt-edit-test');
assert.equal(editRun.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
const editRequest = JSON.parse(readFileSync(join(editRun.result?.structuredContent.run_dir, 'request.json'), 'utf8'));
assert.equal(editRequest.intent.instruction, 'edit profile shortcut');
assert.equal(editRequest.constraints.profile, 'delegating-agent-write');
assert.equal(editRequest.constraints.resumable, undefined);
assert.equal(editRequest.constraints.overrides.model, 'gpt-edit-test');
assert.equal(editRequest.constraints.overrides.reasoning_effort, 'low');

const defaultEditRun = await rpc({
  jsonrpc: '2.0',
  id: 5611,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'default edit profile shortcut' } },
}, state);
assert.equal(defaultEditRun.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(defaultEditRun.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');

const customEditDefaultsState = createServerState({ allowedRoot: root, runRoot: join(root, 'edit-defaults'), codexCommand: process.execPath, editDefaultModel: 'gpt-edit-default', editDefaultReasoningEffort: 'minimal' });
const customEditDefaults = await rpc({
  jsonrpc: '2.0',
  id: 562,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'custom edit defaults' } },
}, customEditDefaultsState);
assert.equal(customEditDefaults.result?.structuredContent.resolved_worker_config.model, 'gpt-edit-default');
assert.equal(customEditDefaults.result?.structuredContent.resolved_worker_config.reasoning_effort, 'minimal');

const callerEditOverride = await rpc({
  jsonrpc: '2.0',
  id: 563,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'caller edit override', overrides: { reasoning_effort: 'high' } } },
}, customEditDefaultsState);
assert.equal(callerEditOverride.result?.structuredContent.resolved_worker_config.model, 'gpt-edit-default');
assert.equal(callerEditOverride.result?.structuredContent.resolved_worker_config.reasoning_effort, 'high');

const resumableEdit = await rpc({
  jsonrpc: '2.0',
  id: 564,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'resumable edit inheritance', resumable: true } },
}, state);
assert.equal(resumableEdit.result?.structuredContent.worker_session_id, 'thread-created');
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.ephemeral, false);
const editSessionRecord = JSON.parse(readFileSync(join(runRoot, 'sessions', `${encodeURIComponent('thread-created')}.json`), 'utf8'));
assert.equal(editSessionRecord.origin_tool, 'worker_edit');
assert.equal(editSessionRecord.resolved_worker_config.model, 'gpt-5.4-mini');
const restartedState = createServerState({ allowedRoot: root, runRoot, auditLogDir, codexCommand: process.execPath }, { PATH: process.env.PATH });
const resumedEdit = await rpc({
  jsonrpc: '2.0',
  id: 565,
  method: 'tools/call',
  params: { name: 'worker_resume', arguments: { worker_session_id: 'thread-created', constraints: { cwd: root } } },
}, restartedState);
assert.equal(resumedEdit.result?.structuredContent.status, 'completed');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.profile, 'delegating-agent-write');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.model, 'gpt-5.4-mini');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.argv.includes('--ephemeral'), false);

const resumableRun = await rpc({
  jsonrpc: '2.0',
  id: 57,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'resumable run' }, constraints: { cwd: root, profile: 'delegating-agent-read', resumable: true } } },
}, state);
assert.equal(resumableRun.result?.structuredContent.resolved_worker_config.resumable, true);
assert.equal(resumableRun.result?.structuredContent.resolved_worker_config.ephemeral, false);
const resumableInvocation = JSON.parse(readFileSync(join(resumableRun.result?.structuredContent.run_dir, 'worker_invocation.json'), 'utf8'));
assert.equal(resumableInvocation.argv.includes('--ephemeral'), false);
assert.match(readFileSync(join(completedRunDir, 'worker_prompt.txt'), 'utf8'), /Do not call any worker_\* MCP tools\./);
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
  params: { name: 'worker_resume', arguments: { worker_session_id: 'thread-existing', constraints: { cwd: root, profile: 'default' } } },
}, state);
assert.equal(resume.result?.structuredContent.status, 'completed');
assert.equal(resume.result?.structuredContent.worker_session_id, 'thread-resumed');
const resumeConfig = JSON.parse(readFileSync(join(resume.result?.structuredContent.run_dir, 'resolved_worker_config.json'), 'utf8'));
assert.equal(resumeConfig.resumable, true);
assert.equal(resumeConfig.ephemeral, false);
assert.equal(resumeConfig.argv.includes('resume'), true);
assert.equal(resumeConfig.argv.includes('thread-existing'), true);

const invalidMessagePath = join(root, 'invalid-last-message.json');
writeFileSync(invalidMessagePath, JSON.stringify({ summary: 'bad', deliverables: [{ path: 'x' }], open_questions: [], next_actions: [] }), 'utf8');
const invalidMessage = parseLastMessage(invalidMessagePath);
assert.equal(invalidMessage.ok, false);
assert.equal(invalidMessage.ok ? '' : invalidMessage.reason, 'invalid_shape');

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
  fs.writeFileSync(lastMessagePath, JSON.stringify({ summary: 'ok', deliverables: [], open_questions: [], next_actions: [] }));
});
`, 'utf8');
const badEventState = createServerState({ allowedRoot: eventRoot, runRoot: join(eventRoot, 'runs'), codexCommand: process.execPath });
const badEvent = await rpc({
  jsonrpc: '2.0',
  id: 62,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'bad event' }, constraints: { cwd: eventRoot } } },
}, badEventState);
assert.equal(badEvent.error?.data.code, 'worker_runtime_failed');
assert.match(badEvent.error?.data.details.error, /invalid json event/);

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
  params: { name: 'worker_run', arguments: { intent: { instruction: 'runtime error' }, constraints: { cwd: runtimeErrorRoot } } },
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

function runArgs(instruction: string, constraints: Record<string, unknown> = {}, profile = 'default'): Record<string, unknown> {
  return {
    intent: { instruction },
    constraints: { cwd: root, profile, overrides: constraints },
  };
}
