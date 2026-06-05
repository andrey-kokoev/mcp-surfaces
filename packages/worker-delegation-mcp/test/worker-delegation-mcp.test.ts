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
  'worker_resume',
  'worker_output_show',
]);

const policy = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worker_policy_inspect', arguments: {} } }, state);
assert.equal(policy.result?.structuredContent.schema, 'narada.worker.policy.v1');
assert.equal(policy.result?.structuredContent.default_runtime, 'codex');
assert.deepEqual(policy.result?.structuredContent.allowed_runtimes, ['codex']);
assert.equal(policy.result?.structuredContent.allow_raw_config_overrides, false);
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

const allowedConfigRun = await rpc({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('run with allowed config', { model: 'gpt-test', reasoning_effort: 'low', config: { model: 'gpt-test' } }) },
}, state);
assert.equal(allowedConfigRun.result?.structuredContent.status, 'completed');
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
const resolvedConfig = JSON.parse(readFileSync(join(completedRunDir, 'resolved_worker_config.json'), 'utf8'));
assert.equal(resolvedConfig.runtime, 'codex');
assert.equal(resolvedConfig.command, process.execPath);
assert.equal(resolvedConfig.config.model, 'gpt-test');
assert.equal(resolvedConfig.config.model_reasoning_effort, 'low');
assert.deepEqual(resolvedConfig.environment_keys, ['PATH']);
assert.equal(JSON.stringify(resolvedConfig).includes('must-not-leak'), false);
const executorRequest = JSON.parse(readFileSync(join(completedRunDir, 'executor_request.json'), 'utf8'));
assert.equal(executorRequest.schema, 'narada.worker.executor_request.v1');
assert.equal(executorRequest.intent.instruction, 'run with allowed config');
assert.equal(executorRequest.resolved_execution_policy.cwd, root);
const invocation = JSON.parse(readFileSync(join(completedRunDir, 'worker_invocation.json'), 'utf8'));
assert.equal(invocation.argv[0], 'exec');
assert.equal(invocation.argv.includes('--json'), true);
assert.equal(invocation.argv.at(-1), '-');
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
  params: { name: 'worker_resume', arguments: { cwd: root, worker_session_id: 'thread-existing' } },
}, state);
assert.equal(resume.result?.structuredContent.status, 'completed');
assert.equal(resume.result?.structuredContent.worker_session_id, 'thread-resumed');
const resumeConfig = JSON.parse(readFileSync(join(resume.result?.structuredContent.run_dir, 'resolved_worker_config.json'), 'utf8'));
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

const materializedState = createServerState({ allowedRoot: root, runRoot: join(root, 'small-output'), maxOutputBytes: 120 });
const materialized = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'worker_policy_inspect', arguments: {} } }, materializedState);
assert.equal(materialized.result?.structuredContent.result_materialized, true);
assert.equal(materialized.result?.structuredContent.reader_tool, 'worker_output_show');
assert.match(materialized.result?.content[0].text, /worker_policy_inspect: materialized/);
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

const unknown = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'worker_autopilot', arguments: {} } }, state);
assert.equal(unknown.error?.data.code, 'worker_unknown_tool');

function hasCode(code: string): (error: unknown) => boolean {
  return (error: any) => error?.codeName === code;
}

function runArgs(instruction: string, constraints: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: { instruction },
    constraints: { cwd: root, ...constraints },
  };
}
