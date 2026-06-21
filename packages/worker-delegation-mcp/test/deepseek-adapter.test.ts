import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDeepseekArgv, deepseekRuntimeName, createServerState, handleRequest } from '../src/main.js';
import { runtimeName, supportsResume } from '../src/deepseek-adapter.js';
import { parseLastMessage, resultStatus } from '../src/codex-adapter.js';

const root = mkdtempSync(join(tmpdir(), 'deepseek-adapter-'));
const runRoot = join(root, 'runs');

type RpcResponse = {
  result?: Record<string, any>;
  error?: Record<string, any>;
};

const rpc = handleRequest as unknown as (request: Record<string, unknown>, state: ReturnType<typeof createServerState>) => Promise<RpcResponse>;

// --- Adapter unit tests ---

assert.equal(runtimeName(), 'deepseek-api');
assert.equal(supportsResume(), true);

const argv = buildDeepseekArgv({
  schemaPath: 'schema.json',
  lastMessagePath: 'last.json',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  mcpConfigPath: '/path/to/mcp.json',
  workerSessionId: 'session-1',
});
assert.deepEqual(argv.slice(0, 8), ['--schema-path', 'schema.json', '--last-message-path', 'last.json', '--model', 'deepseek-v4-flash', '--reasoning-effort', 'high']);
assert.equal(argv.includes('--mcp-config-file'), true);
assert.equal(argv.includes('/path/to/mcp.json'), true);
assert.equal(argv.includes('--worker-session-id'), true);
assert.equal(argv.includes('session-1'), true);

const argvMinimal = buildDeepseekArgv({
  schemaPath: 'schema.json',
  lastMessagePath: 'last.json',
  model: null,
  reasoningEffort: null,
  mcpConfigPath: null,
});
assert.equal(argvMinimal.includes('--mcp-config-file'), false);
assert.equal(argvMinimal.includes('--worker-session-id'), false);
assert.equal(argvMinimal[5], 'deepseek-v4-flash');
assert.equal(argvMinimal[7], 'high');

// --- Deepseek runtime name ---

assert.equal(deepseekRuntimeName(), 'deepseek-api');

// --- Policy integration ---

const state = createServerState({
  allowedRoot: root,
  runRoot,
});
assert.deepEqual(state.policy.allowedRuntimes, ['codex', 'deepseek-api']);
assert.equal(state.policy.runtimes.deepseek.command, 'node');
assert.equal(state.policy.runtimes.deepseek.defaultSandbox, 'read-only');
assert.equal(state.policy.runtimes.deepseek.defaultReasoningEffort, 'high');

// --- Deepseek runtime in policy_inspect ---

const policy = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'worker_policy_inspect', arguments: {} } }, state);
assert.equal(policy.result?.structuredContent.allowed_runtimes.includes('deepseek-api'), true);
assert.equal(policy.result?.structuredContent.runtimes.deepseek.command, 'node');
assert.equal(policy.result?.structuredContent.runtimes.deepseek.default_sandbox, 'read-only');
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.low, { model: null, reasoning_effort: null });
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.medium, { model: null, reasoning_effort: null });
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.high, { model: null, reasoning_effort: null });

// --- Constructor validation ---

assert.throws(() => createServerState({ allowedRoot: root, allowedRuntime: 'unknown-runtime' }), /worker_runtime_not_allowed/);

// --- parseLastMessage is reusable ---

const validPath = join(root, 'valid-last-message.json');
writeFileSync(validPath, JSON.stringify({
  summary: 'deepseek worker complete',
  deliverables: [{ path: 'result.txt', description: 'output' }],
  open_questions: [],
  next_actions: ['verify'],
  edits_performed: true,
  target_state_changed: false,
  changes: [{ path: 'result.txt', status: 'modified', summary: 'created output' }],
  verification: [{ tool: 'test', command: null, status: 'passed', summary: 'ok' }],
  exit_interview: null,
}), 'utf8');
const parsed = parseLastMessage(validPath);
assert.equal(parsed.ok, true);
if (parsed.ok) {
  assert.equal(parsed.data.summary, 'deepseek worker complete');
  assert.equal(parsed.data.edits_performed, true);
}

// --- resultStatus is reusable ---

const completedResult = resultStatus(
  { exit_code: 0, cancelled: false, error: null },
  parsed,
);
assert.equal(completedResult.status, 'completed');
assert.equal(completedResult.error, null);

const failedResult = resultStatus(
  { exit_code: 1, cancelled: false, error: 'API error' },
  parsed,
);
assert.equal(failedResult.status, 'completed_with_errors');
assert.equal(failedResult.error, 'API error');

const missingFile = parseLastMessage(join(root, 'nonexistent.json'));
assert.equal(missingFile.ok, false);
if (!missingFile.ok) {
  assert.equal(missingFile.reason, 'missing_file');
}

// --- Environment variable passthrough ---

const envState = createServerState({ allowedRoot: root, runRoot }, {
  PATH: process.env.PATH,
  DEEPSEEK_API_KEY: 'sk-test-key',
  DEEPSEEK_API_BASE_URL: 'https://test.deepseek.com',
  NARADA_WORKER_MCP_CONFIG: '/path/to/mcp.json',
});
const envKeys = Object.keys(envState.env).sort();
assert.equal(envState.env.DEEPSEEK_API_KEY, 'sk-test-key');
assert.equal(envState.env.DEEPSEEK_API_BASE_URL, 'https://test.deepseek.com');
assert.equal(envState.env.NARADA_WORKER_MCP_CONFIG, '/path/to/mcp.json');

// --- Environment passthrough via environmentForWorker ---

const { environmentForWorker } = await import('../src/policy.js');
const env = environmentForWorker({
  PATH: '/bin',
  DEEPSEEK_API_KEY: 'sk-test',
  DEEPSEEK_API_BASE_URL: 'https://custom.api.com',
  NARADA_WORKER_MCP_CONFIG: '/custom/mcp.json',
} as Record<string, string>);
assert.equal(env.DEEPSEEK_API_KEY, 'sk-test');
assert.equal(env.DEEPSEEK_API_BASE_URL, 'https://custom.api.com');
assert.equal(env.NARADA_WORKER_MCP_CONFIG, '/custom/mcp.json');
if (process.platform === 'win32') {
  assert.equal(environmentForWorker({ Path: 'C:/tools' } as Record<string, string>).PATH, 'C:/tools');
}

// --- Deepseek CLI args via parseArgs ---

const { parseArgs } = await import('../src/mcp-server.js');
const deepseekArgs = parseArgs(['--deepseek-command-arg', 'worker.mjs', '--deepseek-command-arg', 'extra']);
assert.deepEqual(deepseekArgs.deepseekCommandArgs, ['worker.mjs', 'extra']);
assert.equal(parseArgs(['--deepseek-command', 'node20']).deepseekCommand, 'node20');
assert.equal(parseArgs(['--deepseek-model', 'deepseek-v4']).deepseekModel, 'deepseek-v4');

// --- Run directory artifacts for deepseek ---

const deepseekRunDir = join(runRoot, 'run-deepseek-test');
mkdirSync(deepseekRunDir, { recursive: true });

// api_requests.jsonl
writeFileSync(join(deepseekRunDir, 'api_requests.jsonl'), '{"model":"deepseek-v4-flash"}\n');
assert.equal(existsSync(join(deepseekRunDir, 'api_requests.jsonl')), true);

// api_responses.jsonl
writeFileSync(join(deepseekRunDir, 'api_responses.jsonl'), '{"choices":[{"message":{"content":"ok"}}]}\n');
assert.equal(existsSync(join(deepseekRunDir, 'api_responses.jsonl')), true);

// mcp_tools.json
writeFileSync(join(deepseekRunDir, 'mcp_tools.json'), '[]');
assert.equal(existsSync(join(deepseekRunDir, 'mcp_tools.json')), true);

// conversation.json
writeFileSync(join(deepseekRunDir, 'conversation.json'), '[{"role":"system","content":"test"}]');
assert.equal(existsSync(join(deepseekRunDir, 'conversation.json')), true);

// --- MCP config for worker (mcpServers shape) ---

const mcpConfigPath = join(root, 'narada-mcp.json');
writeFileSync(mcpConfigPath, JSON.stringify({
  mcpServers: {
    'test-server': {
      command: process.execPath,
      args: ['-e', 'process.stdin.on("data",d=>{const l=JSON.parse(d);process.stdout.write("Content-Length: "+Buffer.byteLength(JSON.stringify({id:l.id,result:{}}))+"\\r\\n\\r\\n"+JSON.stringify({id:l.id,result:{}}))})'],
      env: {},
    },
  },
}), 'utf8');
assert.equal(existsSync(mcpConfigPath), true);

// --- Cognition defaults via config ---

const customDeepseekState = createServerState({
  allowedRoot: root,
  runRoot: join(root, 'custom-deepseek'),
  cognitionLowModel: 'deepseek-chat',
  cognitionLowReasoningEffort: 'max',
});
assert.equal(customDeepseekState.policy.cognitionDefaults.low.model, 'deepseek-chat');
assert.equal(customDeepseekState.policy.cognitionDefaults.low.reasoningEffort, 'max');

console.log('deepseek-adapter tests passed');
