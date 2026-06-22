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
mkdirSync(join(root, '.narada'), { recursive: true });
process.env.NARADA_SITE_ROOT = root;
process.env.CODEX_HOME = root;
const runRoot = join(root, 'runs');
const auditLogDir = join(root, 'audit');
const fakeCodexScript = join(root, 'exec.cjs');
const fakeCodexErrorScript = join(root, 'exec-error-with-output.cjs');
const fakeCodexPrestartFailureScript = join(root, 'exec-prestart-failure.cjs');
const fakeAgentRuntimeServerScript = join(root, 'agent-runtime-server.cjs');
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
    verification: [{ tool: 'fake-codex', command: null, status: 'passed', summary: 'fake worker completed', command_classification: 'not_applicable' }],
    verification_budget_respected: true,
    broad_unrelated_failures: [],
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
    verification: [{ tool: 'fake-codex', command: null, status: 'failed', summary: 'simulated tool error', command_classification: 'not_applicable' }],
    verification_budget_respected: true,
    broad_unrelated_failures: [],
    exit_interview: null
  }));
});
`, 'utf8');
writeFileSync(fakeCodexPrestartFailureScript, `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified.\n');
  process.exit(1);
});
`, 'utf8');
writeFileSync(fakeAgentRuntimeServerScript, `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdout.write(JSON.stringify({ event: 'session_started', session_id: 'carrier-worker-runtime', agent_id: 'worker.agent', mcp_operational_state: 'healthy' }) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.method === 'conversation.send') {
      if (frame.params.message.includes('agent runtime provider failure')) {
        process.stdout.write(JSON.stringify({ event: 'turn_started', request_id: frame.id, turn_id: 'turn-provider-failed' }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'turn_failed', request_id: frame.id, turn_id: 'turn-provider-failed', error: 'API error 429: rate_limit_reached_error: quota exhausted' }) + '\\n');
        continue;
      }
      if (frame.params.message.includes('server runtime loose output')) {
        const output = {
          summary: 'loose agent runtime worker ok',
          edits_performed: false,
          target_state_changed: false,
          verification: { tool: 'fake-agent-runtime-server', status: 'passed', summary: 'loose verification object accepted' },
          verification_budget_respected: true,
          broad_unrelated_failures: [],
          exit_interview: {
            ergonomics_feedback: 'loose output preserved',
            friction_points: ['verification object was not an array'],
            missing_affordances: ['normalizer should preserve exit interviews'],
            observed_incoherencies: [],
            suggested_improvements: ['normalize salvageable NARS worker JSON']
          }
        };
        process.stdout.write(JSON.stringify({ event: 'turn_started', request_id: frame.id, turn_id: 'turn-worker-loose' }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'assistant_message', request_id: frame.id, turn_id: 'turn-worker-loose', content: '\`\`\`json\\n' + JSON.stringify(output, null, 2) + '\\n\`\`\`' }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'turn_complete', request_id: frame.id, turn_id: 'turn-worker-loose', terminal_state: 'completed' }) + '\\n');
        continue;
      }
      const output = {
        summary: 'agent runtime worker ok',
        deliverables: [{ path: 'server-result.txt', description: 'server runtime saw ' + (frame.params.message.includes('Intent') ? 'intent' : 'prompt') }],
        open_questions: [],
        next_actions: ['done'],
        edits_performed: false,
        target_state_changed: false,
        changes: [],
        verification: [{ tool: 'fake-agent-runtime-server', command: null, status: 'passed', summary: 'fake server completed', command_classification: 'not_applicable' }],
        verification_budget_respected: true,
        broad_unrelated_failures: [],
        exit_interview: null
      };
      process.stdout.write(JSON.stringify({ event: 'turn_started', request_id: frame.id, turn_id: 'turn-worker' }) + '\\n');
      process.stdout.write(JSON.stringify({ event: 'assistant_message', request_id: frame.id, turn_id: 'turn-worker', content: JSON.stringify(output) }) + '\\n');
      process.stdout.write(JSON.stringify({ event: 'turn_complete', request_id: frame.id, turn_id: 'turn-worker', terminal_state: 'completed' }) + '\\n');
    }
    if (frame.method === 'session.close') process.exit(0);
  }
});
`, 'utf8');
const rpc = handleRequest as unknown as (request: Record<string, unknown>, state: ReturnType<typeof createServerState>) => Promise<RpcResponse>;
const rpcWithContext = handleRequest as unknown as (request: Record<string, unknown>, state: ReturnType<typeof createServerState>, context: { abortSignal?: AbortSignal }) => Promise<RpcResponse>;
const state = createServerState({
  allowedRoot: root,
  runRoot,
  auditLogDir,
  codexCommand: process.execPath,
  codexCommandArgs: [fakeCodexScript],
  maxOutputBytes: 2 * 1024 * 1024,
}, { PATH: process.env.PATH, KIMI_CODE_API_KEY: 'kimi-secret-must-not-leak', WORKER_SECRET: 'must-not-leak' });

const tools = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, state);
assert.deepEqual(tools.result?.tools.map((tool) => tool.name), [
  'worker_policy_inspect',
  'worker_config_resolve',
  'worker_run',
  'worker_edit',
  'worker_resume',
  'worker_run_status',
  'worker_run_reap',
  'worker_runs_list',
  'worker_run_wait',
  'worker_run_batch',
  'worker_run_wait_batch',
  'worker_runs_synthesize',
  'worker_dashboard_describe',
]);
for (const tool of tools.result?.tools ?? []) {
  assert.equal(tool.outputSchema?.type, 'object', tool.name);
  assert.equal(typeof tool.annotations?.title, 'string', tool.name);
  assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name);
}
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.annotations?.readOnlyHint, false);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_edit')?.annotations?.readOnlyHint, false);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_policy_inspect')?.annotations?.readOnlyHint, true);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_config_resolve')?.annotations?.readOnlyHint, true);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_policy_inspect')?.outputSchema?.properties?.schema?.const, 'narada.worker.policy.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_config_resolve')?.outputSchema?.properties?.schema?.const, 'narada.worker.config_resolve.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_edit')?.outputSchema?.properties?.schema?.const, 'narada.worker.run.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_status')?.outputSchema?.properties?.schema?.const, 'narada.worker.run.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_reap')?.outputSchema?.properties?.schema?.const, 'narada.worker.run_reap.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_wait')?.outputSchema?.properties?.schema?.const, 'narada.worker.run_wait.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_runs_list')?.outputSchema?.properties?.schema?.const, 'narada.worker.runs_list.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_batch')?.outputSchema?.properties?.schema?.const, 'narada.worker.run_batch.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_wait_batch')?.outputSchema?.properties?.schema?.const, 'narada.worker.run_wait_batch.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_runs_synthesize')?.outputSchema?.properties?.schema?.const, 'narada.worker.runs_synthesis.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_dashboard_describe')?.outputSchema?.properties?.schema?.const, 'narada.worker.dashboard.v1');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_batch')?.annotations?.readOnlyHint, false);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_reap')?.annotations?.readOnlyHint, false);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run_reap')?.annotations?.destructiveHint, true);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_runs_synthesize')?.annotations?.readOnlyHint, true);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_dashboard_describe')?.annotations?.readOnlyHint, true);
assert.equal(tools.result?.tools.some((tool) => tool.name === 'worker_output_show'), false);
assert.deepEqual(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.authority?.enum, ['read', 'write', 'command']);
assert.deepEqual(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.cognition?.enum, ['low', 'medium', 'high']);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.wait_for_completion?.type, 'boolean');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.exit_interview?.type, 'boolean');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.verification_budget?.type, 'object');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.test_budget?.type, 'object');
assert.deepEqual(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.intent?.properties?.mode?.enum, ['audit_only', 'plan_only', 'implement', 'implement_and_verify']);
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.preflight_paths?.type, 'array');
assert.equal(tools.result?.tools.find((tool) => tool.name === 'worker_run')?.inputSchema?.properties?.constraints?.properties?.required_mcp_tools?.type, 'array');
assert.equal(commandRequiresWindowsShell('codex.cmd', 'win32'), true);
assert.equal(commandRequiresWindowsShell('codex.bat', 'win32'), true);
assert.equal(commandRequiresWindowsShell('codex.ps1', 'win32'), true);
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
assert.deepEqual(policy.result?.structuredContent.allowed_runtimes, ['codex', 'deepseek-api', 'narada-agent-runtime-server']);
assert.deepEqual(policy.result?.structuredContent.allowed_authorities, ['read', 'write', 'command']);
assert.deepEqual(policy.result?.structuredContent.allowed_cognition, ['low', 'medium', 'high']);
assert.equal(policy.result?.structuredContent.allow_raw_config_overrides, false);
assert.equal(policy.result?.structuredContent.runtimes.codex.ephemeral, true);
assert.equal(policy.result?.structuredContent.runtimes.codex.id, 'codex');
assert.equal(policy.result?.structuredContent.runtimes.deepseek.ephemeral, true);
assert.equal(policy.result?.structuredContent.runtimes.deepseek.id, 'deepseek-api');
assert.equal(policy.result?.structuredContent.runtimes.deepseek.default_sandbox, 'read-only');
assert.equal(policy.result?.structuredContent.runtimes['deepseek-api'].id, 'deepseek-api');
assert.equal(policy.result?.structuredContent.runtimes['deepseek-api'].default_sandbox, 'read-only');
assert.equal(policy.result?.structuredContent.runtimes['narada-agent-runtime-server'].site_bound, true);
assert.deepEqual(policy.result?.structuredContent.runtimes['narada-agent-runtime-server'].site_root_markers, ['.narada/', '.ai/mcp/']);
assert.deepEqual(policy.result?.structuredContent.runtimes['narada-agent-runtime-server'].site_environment_keys, ['NARADA_SITE_ROOT', 'NARADA_WORKSPACE_ROOT', 'NARADA_AGENT_ID', 'NARADA_CARRIER_SESSION_ID']);
assert.match(policy.result?.structuredContent.runtimes['narada-agent-runtime-server'].site_root_required_remediation, /constraints\.site_root/);
assert.equal(policy.result?.structuredContent.nars_site_semantics.site_bound, true);
assert.deepEqual(policy.result?.structuredContent.nars_site_semantics.required_markers, ['.narada/', '.ai/mcp/']);
assert.match(policy.result?.structuredContent.nars_site_semantics.remediation, /constraints\.site_root/);
assert.equal(policy.result?.structuredContent.max_parallel_runs, 10);
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.low, { model: null, reasoning_effort: null });
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.medium, { model: null, reasoning_effort: null });
assert.deepEqual(policy.result?.structuredContent.cognition_defaults.high, { model: null, reasoning_effort: null });
assert.match(policy.result?.content[0].text, /worker_policy: ok/);
assert.match(policy.result?.content[0].text, /nars_site_bound: true/);
assert.match(policy.result?.content[0].text, /nars_site_markers: \.narada\/,.ai\/mcp\//);

const configPreview = await rpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'worker_config_resolve', arguments: {
  intent: { instruction: 'inspect repository shape' },
  constraints: { cwd: root, authority: 'read', cognition: 'high', required_mcp_tools: ['mcp__narada_andrey_local_filesystem'], verification_budget: { focus: 'focused', max_commands: 1, stop_on_first_failure: true }, test_budget: { focus: 'focused', max_minutes: 2, broad_commands_allowed: false } },
} } }, state);
assert.equal(configPreview.result?.structuredContent.schema, 'narada.worker.config_resolve.v1');
assert.equal(configPreview.result?.structuredContent.dry_run, true);
assert.equal(configPreview.result?.structuredContent.requested_mode, 'audit_only');
assert.equal(configPreview.result?.structuredContent.resolved_worker_config.runtime, 'codex');
assert.equal(configPreview.result?.structuredContent.resolved_worker_config.model, null);
assert.equal(configPreview.result?.structuredContent.config_resolution.model_source, 'runtime_default_opaque');
assert.equal(configPreview.result?.structuredContent.config_resolution.reasoning_effort_source, 'runtime_default_opaque');
assert.equal(configPreview.result?.structuredContent.runtime_availability.available, true);
assert.deepEqual(configPreview.result?.structuredContent.requested_mcp_tools, ['mcp__narada_andrey_local_filesystem']);
assert.equal(configPreview.result?.structuredContent.mcp_tool_verification.verification_state, 'delegated_to_worker');
assert.equal(configPreview.result?.structuredContent.output_contract.schema, 'narada.worker.output_contract.v1');
assert.equal(configPreview.result?.structuredContent.output_contract.findings.required_for_audit_only, true);
assert.equal(configPreview.result?.structuredContent.output_contract.verification_command_classification.required, true);
assert.deepEqual(configPreview.result?.structuredContent.output_contract.verification_budget, { focus: 'focused', max_commands: 1, stop_on_first_failure: true });
assert.deepEqual(configPreview.result?.structuredContent.output_contract.test_budget, { focus: 'focused', max_minutes: 2, broad_commands_allowed: false });
assert.equal(configPreview.result?.structuredContent.resolved_worker_config.environment_keys.includes('KIMI_CODE_API_KEY'), true);
assert.equal(JSON.stringify(configPreview.result?.structuredContent).includes('kimi-secret-must-not-leak'), false);
assert.match(configPreview.result?.structuredContent.invocation.argv.join(' '), /<dry-run>\/worker_output\.schema\.json/);
assert.match(configPreview.result?.structuredContent.warnings.join('\n'), /model_delegated_to_runtime_default/);
assert.match(configPreview.result?.content[0].text, /worker_config_resolve: ok/);

const explicitConfig = await rpc({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'worker_config_resolve', arguments: {
  intent: { instruction: 'inspect repository shape', mode: 'plan_only' },
  constraints: { cwd: root, authority: 'read', overrides: { model: 'gpt-test', reasoning_effort: 'low' } },
} } }, state);
assert.equal(explicitConfig.result?.structuredContent.resolved_worker_config.model, 'gpt-test');
assert.equal(explicitConfig.result?.structuredContent.resolved_worker_config.reasoning_effort, 'low');
assert.equal(explicitConfig.result?.structuredContent.config_resolution.model_source, 'request_override');
assert.equal(explicitConfig.result?.structuredContent.config_resolution.reasoning_effort_source, 'request_override');
assert.doesNotMatch(explicitConfig.result?.structuredContent.warnings.join('\n'), /runtime_default/);

assert.throws(() => createServerState({ allowedRoot: root, allowedRuntime: 'agent-cli' }), /worker_runtime_not_allowed/);
assert.throws(() => createServerState({ allowedRoot: root, allowedSandbox: 'invalid' }), /worker_invalid_sandbox/);
assert.throws(() => createServerState({ allowedRoot: root, allowedSandbox: 'danger-full-access' }), /worker_danger_full_access_not_allowed/);
createServerState({ allowedRoot: root, allowedSandboxes: ['read-only', 'workspace-write'] });

const secretProcessValue = process.env.WORKER_DELEGATION_TEST_SECRET;
delete process.env.WORKER_DELEGATION_TEST_SECRET;
const secretSiteRoot = join(root, 'secret-site');
const secretRunRoot = join(root, 'secret-runs');
mkdirSync(join(secretSiteRoot, '.narada'), { recursive: true });
writeFileSync(join(secretSiteRoot, '.narada', 'secrets.json'), JSON.stringify({ env: { WORKER_DELEGATION_TEST_SECRET: 'from-site-secret' } }), 'utf8');
const secretState = createServerState({ siteRoot: secretSiteRoot, allowedRoot: secretSiteRoot, runRoot: secretRunRoot, codexCommand: process.execPath }, { PATH: process.env.PATH });
assert.equal(secretState.env.WORKER_DELEGATION_TEST_SECRET, 'from-site-secret');
assert.equal(process.env.WORKER_DELEGATION_TEST_SECRET, undefined);
if (secretProcessValue === undefined) delete process.env.WORKER_DELEGATION_TEST_SECRET;
else process.env.WORKER_DELEGATION_TEST_SECRET = secretProcessValue;

const providerRoot = join(root, 'provider-secret-site');
const providerRunRoot = join(root, 'provider-secret-runs');
const providerRegistryPath = join(providerRoot, 'provider-registry.json');
const providerSecretLookupScript = join(providerRoot, 'secret-lookup.js');
mkdirSync(providerRoot, { recursive: true });
writeFileSync(providerRegistryPath, JSON.stringify({
  schema: 'narada.carrier.provider_registry.v1',
  providers: {
    'deepseek-api': {
      base_url: 'https://api.deepseek.com',
      base_url_env_names: ['DEEPSEEK_API_BASE_URL'],
      credential_requirement: {
        kind: 'api_key_secret',
        secret_ref: 'narada/provider/deepseek-api/api-key',
        env_names: ['DEEPSEEK_API_KEY'],
      },
    },
  },
}), 'utf8');
writeFileSync(providerSecretLookupScript, `
if (process.env.NARADA_SECRET_LOOKUP_NAME === 'narada/provider/deepseek-api/api-key') {
  process.stdout.write('deepseek-from-secret-store');
  process.exit(0);
}
process.exit(2);
`, 'utf8');
const providerState = createServerState({
  siteRoot: providerRoot,
  allowedRoot: providerRoot,
  runRoot: providerRunRoot,
  codexCommand: process.execPath,
  providerRegistryPath,
  secretLookupCommand: process.execPath,
  secretLookupCommandArgs: [providerSecretLookupScript],
}, { PATH: process.env.PATH });
assert.equal(providerState.env.DEEPSEEK_API_KEY, 'deepseek-from-secret-store');
assert.equal(providerState.env.DEEPSEEK_API_BASE_URL, 'https://api.deepseek.com');
const providerPolicy = await rpc({ jsonrpc: '2.0', id: 197, method: 'tools/call', params: { name: 'worker_policy_inspect', arguments: {} } }, providerState);
assert.equal(JSON.stringify(providerPolicy.result?.structuredContent).includes('deepseek-from-secret-store'), false);
const deepseekResolve = await rpc({ jsonrpc: '2.0', id: 198, method: 'tools/call', params: { name: 'worker_config_resolve', arguments: { intent: { instruction: 'deepseek secret check' }, constraints: { cwd: providerRoot, overrides: { runtime: 'deepseek-api' } } } } }, providerState);
assert.equal(deepseekResolve.result?.structuredContent.runtime_availability.available, true);
assert.equal(JSON.stringify(deepseekResolve.result?.structuredContent).includes('deepseek-from-secret-store'), false);

if (process.platform === 'win32') {
  const mixedCaseState = createServerState({ allowedRoot: root.toLowerCase(), runRoot, codexCommand: process.execPath });
  assert.equal(mixedCaseState.policy.allowedRoots.length, 1);
  assert.equal(mixedCaseState.policy.allowedRoots[0].toLowerCase(), root.toLowerCase());
  assert.equal(createServerState({ allowedRoot: platformRootCase, runRoot, codexCommand: process.execPath }).policy.allowedRoots[0].toLowerCase(), root.toLowerCase());
  assert.equal(resolveWorkingDirectory(platformRootCase, mixedCaseState.policy).toLowerCase(), root.toLowerCase());
  const mixedCaseChild = join(platformRootCase, 'Child');
  mkdirSync(mixedCaseChild, { recursive: true });
  assert.equal(resolveWorkingDirectory(mixedCaseChild, mixedCaseState.policy).toLowerCase(), mixedCaseChild.toLowerCase());

  const ps1Bin = join(root, 'ps1-bin');
  mkdirSync(ps1Bin, { recursive: true });
  const codexPs1 = join(ps1Bin, 'codex.ps1');
  writeFileSync(codexPs1, `
$out = $args[$args.IndexOf('-o') + 1]
Set-Content -LiteralPath $out -Encoding UTF8 -Value '{"summary":"ps1 worker ok","deliverables":[],"open_questions":[],"next_actions":[],"edits_performed":false,"target_state_changed":false,"changes":[],"verification":[],"verification_budget_respected":null,"broad_unrelated_failures":[],"exit_interview":null}'
Write-Output '{"thread_id":"ps1-thread"}'
`, 'utf8');
  const ps1State = createServerState({ allowedRoot: root, runRoot: join(root, 'ps1-runs'), codexCommand: 'codex.ps1' }, { Path: `${ps1Bin};${process.env.Path ?? process.env.PATH ?? ''}` } as NodeJS.ProcessEnv);
  const ps1Run = await rpc({ jsonrpc: '2.0', id: 158, method: 'tools/call', params: { name: 'worker_run', arguments: runArgs('ps1 command lookup') } }, ps1State);
  const ps1RunDir = ps1Run.result?.structuredContent.run_dir ?? ps1Run.error?.data.details.run_dir;
  assert.equal(typeof ps1RunDir, 'string');
  const ps1Invocation = JSON.parse(readFileSync(join(ps1RunDir, 'worker_invocation.json'), 'utf8'));
  assert.equal(ps1Invocation.command.toLowerCase(), codexPs1.toLowerCase());

  const agentRuntimeShimBin = join(root, 'agent-runtime-shim-bin');
  mkdirSync(agentRuntimeShimBin, { recursive: true });
  const agentRuntimeCmd = join(agentRuntimeShimBin, 'agent-runtime-server.cmd');
  writeFileSync(agentRuntimeCmd, `
@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=${root}\\node_modules"
)
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe" "%~dp0\\..\\agent-runtime-server.cjs" %*
) ELSE (
  node "%~dp0\\..\\agent-runtime-server.cjs" %*
)
`, 'utf8');
  const agentRuntimeShimState = createServerState({
    allowedRoot: root,
    runRoot: join(root, 'agent-runtime-shim-runs'),
    agentRuntimeServerCommand: agentRuntimeCmd,
  }, { PATH: process.env.PATH });
  const agentRuntimeShimRun = await rpc({ jsonrpc: '2.0', id: 159, method: 'tools/call', params: { name: 'worker_run', arguments: runArgs('agent runtime shim lookup', { runtime: 'narada-agent-runtime-server' }) } }, agentRuntimeShimState);
  assert.equal(agentRuntimeShimRun.result?.structuredContent.status, 'completed');
  const agentRuntimeShimInvocation = JSON.parse(readFileSync(join(agentRuntimeShimRun.result?.structuredContent.run_dir, 'worker_invocation.json'), 'utf8'));
  assert.equal(agentRuntimeShimInvocation.command, process.execPath);
  assert.equal(agentRuntimeShimInvocation.argv[0], fakeAgentRuntimeServerScript);
  assert.equal(agentRuntimeShimInvocation.argv[1], '--raw-jsonl');
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
assert.deepEqual(parseArgs(['--agent-runtime-server-command-arg', 'server.js', '--agent-runtime-server-command-arg', '--raw-jsonl']).agentRuntimeServerCommandArgs, ['server.js', '--raw-jsonl']);
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
assert.equal(allowedConfigRun.result?.structuredContent.completion_state, 'complete');
assert.equal(allowedConfigRun.result?.structuredContent.preflight.some((check) => check.name === 'cwd_readable' && check.status === 'ok'), true);

const agentRuntimeState = createServerState({
  allowedRoot: root,
  runRoot: join(root, 'agent-runtime-runs'),
  agentRuntimeServerCommand: process.execPath,
  agentRuntimeServerCommandArgs: [fakeAgentRuntimeServerScript],
});
const agentRuntimeResolve = await rpc({ jsonrpc: '2.0', id: 501, method: 'tools/call', params: { name: 'worker_config_resolve', arguments: runArgs('server runtime resolve', { runtime: 'narada-agent-runtime-server' }) } }, agentRuntimeState);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.runtime, 'narada-agent-runtime-server');
assert.deepEqual(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.argv, ['--raw-jsonl']);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_root, root);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_bound, true);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_marker, '.narada/');
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_root_source, 'nearest_marker');
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_binding.site_bound, true);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_binding.source, 'nearest_parent_marker');
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_binding.matched_marker, '.narada/');
assert.deepEqual(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_binding.required_markers, ['.narada/', '.ai/mcp/']);
assert.deepEqual(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.site_binding.environment_keys, ['NARADA_SITE_ROOT', 'NARADA_WORKSPACE_ROOT', 'NARADA_AGENT_ID', 'NARADA_CARRIER_SESSION_ID']);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.workspace_root, root);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_AGENT_ID'), true);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_CARRIER_SESSION_ID'), true);
assert.equal(agentRuntimeResolve.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_SITE_ROOT'), true);
assert.equal(agentRuntimeResolve.result?.structuredContent.runtime_availability.available, true);
assert.match(agentRuntimeResolve.result?.content[0].text, /site_bound: true/);
assert.match(agentRuntimeResolve.result?.content[0].text, /site_root: /);
assert.match(agentRuntimeResolve.result?.content[0].text, /workspace_root: /);
assert.match(agentRuntimeResolve.result?.content[0].text, /site_root_source: nearest_parent_marker/);
assert.match(agentRuntimeResolve.result?.content[0].text, /site_matched_marker: \.narada\//);
assert.match(agentRuntimeResolve.result?.content[0].text, /site_required_markers: \.narada\/,.ai\/mcp\//);
assert.match(agentRuntimeResolve.result?.content[0].text, /site_environment: NARADA_SITE_ROOT=true NARADA_WORKSPACE_ROOT=true NARADA_AGENT_ID=true NARADA_CARRIER_SESSION_ID=true/);
const agentRuntimeRun = await rpc({ jsonrpc: '2.0', id: 502, method: 'tools/call', params: { name: 'worker_run', arguments: runArgs('server runtime worker', { runtime: 'narada-agent-runtime-server' }) } }, agentRuntimeState);
assert.equal(agentRuntimeRun.result?.structuredContent.status, 'completed');
assert.equal(agentRuntimeRun.result?.structuredContent.runtime, 'narada-agent-runtime-server');
assert.equal(agentRuntimeRun.result?.structuredContent.worker_session_id, 'carrier-worker-runtime');
assert.equal(agentRuntimeRun.result?.structuredContent.summary, 'agent runtime worker ok');
assert.equal(agentRuntimeRun.result?.structuredContent.resolved_worker_config.command, process.execPath);
assert.deepEqual(agentRuntimeRun.result?.structuredContent.resolved_worker_config.command_args, [fakeAgentRuntimeServerScript]);
assert.deepEqual(agentRuntimeRun.result?.structuredContent.resolved_worker_config.argv, ['--raw-jsonl', '--session', agentRuntimeRun.result?.structuredContent.run_id]);
assert.equal(agentRuntimeRun.result?.structuredContent.resolved_worker_config.site_root, root);
assert.equal(agentRuntimeRun.result?.structuredContent.resolved_worker_config.site_binding.source, 'nearest_parent_marker');
assert.equal(agentRuntimeRun.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_AGENT_ID'), true);
assert.equal(agentRuntimeRun.result?.structuredContent.resolved_worker_config.environment_keys.includes('NARADA_CARRIER_SESSION_ID'), true);
assert.equal(agentRuntimeRun.result?.structuredContent.verification_results[0].tool, 'fake-agent-runtime-server');
const agentRuntimePrompt = readFileSync(join(agentRuntimeRun.result?.structuredContent.run_dir, 'worker_prompt.txt'), 'utf8');
assert.match(agentRuntimePrompt, /NARS worker completion guard/);
assert.match(agentRuntimePrompt, /Do not call lifecycle, pause, sleep, wait, delegation, or worker_\* tools/);
assert.match(agentRuntimePrompt, /Do not invent or guess tool names such as narada-andrey-filesystem/);
assert.match(agentRuntimePrompt, /admission_required, surface_registry_tool_not_declared, mcp_runtime_fault/);
assert.match(readFileSync(join(agentRuntimeRun.result?.structuredContent.run_dir, 'events.jsonl'), 'utf8'), /turn_complete/);
const agentRuntimeFailed = await rpc({ jsonrpc: '2.0', id: 5021, method: 'tools/call', params: { name: 'worker_run', arguments: runArgs('agent runtime provider failure', { runtime: 'narada-agent-runtime-server' }) } }, agentRuntimeState);
assert.equal(agentRuntimeFailed.error?.data.code, 'worker_runtime_failed');
assert.match(agentRuntimeFailed.error?.data.details.error, /rate_limit_reached_error/);
const agentRuntimeFailedRunId = String(agentRuntimeFailed.error?.data.details.run_id);
const agentRuntimeFailedStatus = await rpc({ jsonrpc: '2.0', id: 5022, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: agentRuntimeFailedRunId } } }, agentRuntimeState);
assert.match(agentRuntimeFailedStatus.result?.structuredContent.error, /rate_limit_reached_error/);
assert.equal(agentRuntimeFailedStatus.result?.structuredContent.error_classification, 'provider_rate_limited');
assert.equal(agentRuntimeFailedStatus.result?.structuredContent.progress.latest_event_type, 'turn_failed');
const agentRuntimeFailedWait = await rpc({ jsonrpc: '2.0', id: 5023, method: 'tools/call', params: { name: 'worker_run_wait', arguments: { run_id: agentRuntimeFailedRunId } } }, agentRuntimeState);
assert.match(agentRuntimeFailedWait.result?.structuredContent.run.error_preview, /rate_limit_reached_error/);
const agentRuntimeLoose = await rpc({ jsonrpc: '2.0', id: 5024, method: 'tools/call', params: { name: 'worker_run', arguments: runArgs('server runtime loose output', { runtime: 'narada-agent-runtime-server' }) } }, agentRuntimeState);
assert.equal(agentRuntimeLoose.result?.structuredContent.status, 'completed');
assert.equal(agentRuntimeLoose.result?.structuredContent.summary, 'loose agent runtime worker ok');
assert.equal(agentRuntimeLoose.result?.structuredContent.verification_results[0].summary, 'loose verification object accepted');
assert.equal(agentRuntimeLoose.result?.structuredContent.exit_interview.ergonomics_feedback, 'loose output preserved');
assert.deepEqual(agentRuntimeLoose.result?.structuredContent.exit_interview.friction_points, ['verification object was not an array']);
const nonSiteRoot = join(root, 'not-a-site-outside-site-root');
mkdirSync(nonSiteRoot, { recursive: true });
const nonSiteState = createServerState({
  allowedRoot: nonSiteRoot,
  runRoot: join(root, 'non-site-runs'),
  agentRuntimeServerCommand: process.execPath,
  agentRuntimeServerCommandArgs: [fakeAgentRuntimeServerScript],
});
const nonSiteResolve = await rpc({ jsonrpc: '2.0', id: 503, method: 'tools/call', params: { name: 'worker_config_resolve', arguments: {
  intent: { instruction: 'server runtime outside site' },
  constraints: { cwd: nonSiteRoot, authority: 'read', cognition: 'low', wait_for_completion: true, overrides: { runtime: 'narada-agent-runtime-server' } },
} } }, nonSiteState);
assert.equal(nonSiteResolve.error?.data.code, 'worker_narada_site_root_not_found');
assert.deepEqual(nonSiteResolve.error?.data.details.required_markers, ['.narada/', '.ai/mcp/']);
assert.match(nonSiteResolve.error?.data.details.remediation, /\.narada\/ or \.ai\/mcp\//);
assert.match(nonSiteResolve.error?.data.details.remediation, /constraints\.site_root/);

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
assert.deepEqual(allowedConfigRun.result?.content.map((item) => item.type), ['text']);
const listedResources = await rpc({ jsonrpc: '2.0', id: 51, method: 'resources/list', params: {} }, state);
const promptArtifact = listedResources.result?.resources.find((resource) => String(resource.uri).startsWith('worker-artifact:') && resource.name.endsWith('/worker_prompt.txt'));
assert.ok(promptArtifact);
const promptResource = await rpc({ jsonrpc: '2.0', id: 52, method: 'resources/read', params: { uri: promptArtifact.uri } }, state);
assert.match(promptResource.result?.contents[0].text, /Do not call any worker_\* MCP tools\./);
for (const file of ['request.json', 'executor_request.json', 'resolved_worker_config.json', 'worker_prompt.txt', 'worker_invocation.json', 'events.jsonl', 'diagnostic.log', 'last_message.json', 'result.json', 'worker_output.schema.json']) {
  assert.equal(existsSync(join(completedRunDir, file)), true, file);
}
const workerOutputSchema = JSON.parse(readFileSync(join(completedRunDir, 'worker_output.schema.json'), 'utf8'));
assertStrictStructuredOutputSchema(workerOutputSchema, 'worker_output_schema');
assert.equal(workerOutputSchema.required.includes('exit_interview'), true);
assert.equal(workerOutputSchema.required.includes('verification_budget_respected'), true);
assert.equal(workerOutputSchema.required.includes('broad_unrelated_failures'), true);
assert.deepEqual(workerOutputSchema.properties.verification.items.required, ['tool', 'command', 'status', 'summary', 'command_classification']);
assert.deepEqual(workerOutputSchema.properties.verification.items.properties.tool.type, ['string', 'null']);
assert.deepEqual(workerOutputSchema.properties.verification.items.properties.command.type, ['string', 'null']);
assert.deepEqual(workerOutputSchema.properties.verification.items.properties.command_classification.enum, ['focused', 'broad', 'not_applicable']);
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
assert.deepEqual(resolvedConfig.command_args, [fakeCodexScript]);
assert.equal(resolvedConfig.resumable, false);
assert.equal(resolvedConfig.ephemeral, true);
assert.equal(resolvedConfig.config.model, 'gpt-test');
assert.equal(resolvedConfig.config.model_reasoning_effort, 'low');
assert.equal(resolvedConfig.environment_keys.includes('PATH'), true);
assert.equal(JSON.stringify(resolvedConfig).includes('must-not-leak'), false);
assert.equal(JSON.stringify(resolvedConfig).includes('deepseek-from-secret-store'), false);
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
assert.equal(invocation.argv[0], fakeCodexScript);
assert.equal(invocation.argv[1], 'exec');
assert.equal(invocation.argv.includes('--ephemeral'), true);
assert.equal(invocation.argv.includes('--json'), true);
assert.equal(invocation.argv.at(-1), '-');

const legacyRunId = 'run-20990101T000000Z-legacy1';
const legacyRunDir = join(runRoot, legacyRunId);
mkdirSync(legacyRunDir, { recursive: true });
writeFileSync(join(legacyRunDir, 'result.json'), JSON.stringify({
  schema: 'narada.worker.run.v1',
  status: 'completed',
  run_id: legacyRunId,
  run_dir: legacyRunDir,
  runtime: 'codex',
  worker_session_id: null,
  resolved_worker_config: { authority: 'read' },
  requested_mode: 'audit_only',
  executor_request: { intent: {} },
  summary: 'legacy run',
  deliverables: [],
  open_questions: [],
  next_actions: [],
  artifacts: [],
  timing: { started_at: '2099-01-01T00:00:00.000Z', finished_at: '2099-01-01T00:00:01.000Z', duration_ms: 1000 },
  error: null,
}), 'utf8');
const legacyList = await rpc({ jsonrpc: '2.0', id: 520, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { limit: 200 } } }, state);
const legacyListItem = legacyList.result?.structuredContent.runs.find((run) => run.run_id === legacyRunId);
assert.equal(legacyListItem?.requested_mode, 'audit_only');
assert.equal(legacyListItem?.requested_mode_inferred, false);

const asyncRun = await rpc({
  jsonrpc: '2.0',
  id: 521,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'default async run' }, constraints: { cwd: root, authority: 'read', cognition: 'low' } } },
}, state);
assert.equal(asyncRun.result?.structuredContent.status, 'running');
assert.deepEqual(asyncRun.result?.content.map((item) => item.type), ['text']);
assert.equal(asyncRun.result?.structuredContent.timing.finished_at, null);
assert.deepEqual(asyncRun.result?.structuredContent.progress, { event_count: 0, latest_event_type: null, latest_event_preview: null, latest_event_at: null, readable: true, tail_truncated: false });
assert.equal(state.activeRunCount, 1);
const listedRuns = await rpc({ jsonrpc: '2.0', id: 522, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { limit: 20 } } }, state);
assert.ok(listedRuns.result, JSON.stringify(listedRuns.error));
assert.equal(listedRuns.result?.structuredContent.runs.some((run) => run.run_id === asyncRun.result?.structuredContent.run_id), true);
assert.equal(listedRuns.result?.structuredContent.runs[0].summary, undefined);
assert.equal(typeof listedRuns.result?.structuredContent.runs[0].summary_preview === 'string' || listedRuns.result?.structuredContent.runs[0].summary_preview === null, true);
assert.equal(['complete', 'partial', null].includes(listedRuns.result?.structuredContent.runs[0].completion_state), true);
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
const terminalReap = await rpc({ jsonrpc: '2.0', id: 52301, method: 'tools/call', params: { name: 'worker_run_reap', arguments: { run_id: asyncRun.result?.structuredContent.run_id, reason: 'already terminal no-op test' } } }, state);
assert.equal(terminalReap.result?.structuredContent.status, 'already_terminal');
assert.equal(terminalReap.result?.structuredContent.reaped, false);
const directStatus = await rpc({ jsonrpc: '2.0', id: 5231, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: asyncRun.result?.structuredContent.run_id } } }, state);
assert.match(String(directStatus.result?.structuredContent.progress.latest_event_preview), /thread-created/);
assert.equal(directStatus.result?.structuredContent.progress_state.state, 'completed');
assert.equal(directStatus.result?.structuredContent.progress_state.recommended_action, 'inspect_result');
assert.equal(typeof directStatus.result?.structuredContent.budget_status.elapsed_ms, 'number');
assert.equal(Array.isArray(directStatus.result?.structuredContent.recent_activity), true);
assert.equal(directStatus.result?.structuredContent.recent_activity.length > 0, true);
assert.equal(typeof directStatus.result?.structuredContent.recent_activity[0].kind, 'string');
assert.equal(directStatus.result?.structuredContent.exit_interview, null);
assert.equal(directStatus.result?.structuredContent.artifact_readback.readable_via_worker_delegation, true);
assert.equal(directStatus.result?.structuredContent.artifact_readback.local_filesystem_access_required, false);
const runDashboard = await rpc({ jsonrpc: '2.0', id: 52315, method: 'tools/call', params: { name: 'worker_dashboard_describe', arguments: { run_id: asyncRun.result?.structuredContent.run_id } } }, state);
assert.equal(runDashboard.result?.structuredContent.schema, 'narada.worker.dashboard.v1');
assert.equal(runDashboard.result?.structuredContent.mode, 'single_run');
assert.equal(runDashboard.result?.structuredContent.include_terminal, true);
assert.equal(runDashboard.result?.structuredContent.dashboard.server.started, false);
assert.equal(runDashboard.result?.structuredContent.dashboard.api_endpoints.some((endpoint) => endpoint.path === 'mcp://tools/worker_run_status'), true);
assert.equal(runDashboard.result?.structuredContent.runs[0].run_id, asyncRun.result?.structuredContent.run_id);
assert.equal(runDashboard.result?.structuredContent.runs[0].progress_state.state, 'completed');
assert.equal(typeof runDashboard.result?.structuredContent.runs[0].budget_status.event_count, 'number');
assert.equal(runDashboard.result?.structuredContent.runs[0].recent_activity.length > 0, true);
assert.equal(runDashboard.result?.structuredContent.runs[0].worker_session_id, 'thread-created');
assert.equal(runDashboard.result?.structuredContent.runs[0].result_refs.some((ref) => ref.name === 'events.jsonl'), true);
assert.equal(runDashboard.result?.structuredContent.topology.nodes[0].id, asyncRun.result?.structuredContent.run_id);
assert.deepEqual(runDashboard.result?.structuredContent.topology.edges, []);
assert.equal(runDashboard.result?.structuredContent.steps[0].step_id, `run:${asyncRun.result?.structuredContent.run_id}`);
assert.equal(runDashboard.result?.structuredContent.event_stream.some((event) => event.run_id === asyncRun.result?.structuredContent.run_id && String(event.preview).includes('thread-created')), true);
assert.match(runDashboard.result?.content[0].text, /worker_dashboard_describe: ok/);
const activeDashboard = await rpc({ jsonrpc: '2.0', id: 52316, method: 'tools/call', params: { name: 'worker_dashboard_describe', arguments: { mode: 'all_active', limit: 50 } } }, state);
assert.equal(activeDashboard.result?.structuredContent.mode, 'all_active');
assert.equal(activeDashboard.result?.structuredContent.runs.some((run) => run.run_id === asyncRun.result?.structuredContent.run_id), false);
assert.equal(activeDashboard.result?.structuredContent.counts.terminal, 0);
const batchRun = await rpc({ jsonrpc: '2.0', id: 52311, method: 'tools/call', params: { name: 'worker_run_batch', arguments: { requests: [
  { intent: { instruction: 'batch one' }, constraints: { cwd: root, authority: 'read', cognition: 'low', wait_for_completion: true } },
  { intent: { instruction: 'batch two' }, constraints: { cwd: root, authority: 'read', cognition: 'low', wait_for_completion: true, required_mcp_tools: ['local-filesystem.fs_read_file'] } },
] } } }, state);
assert.equal(batchRun.result?.structuredContent.schema, 'narada.worker.run_batch.v1');
assert.equal(batchRun.result?.structuredContent.status, 'ok');
assert.equal(batchRun.result?.structuredContent.run_ids.length, 2);
const batchWait = await rpc({ jsonrpc: '2.0', id: 52312, method: 'tools/call', params: { name: 'worker_run_wait_batch', arguments: { run_ids: batchRun.result?.structuredContent.run_ids, timeout_ms: 0, summary_only: true } } }, state);
assert.equal(batchWait.result?.structuredContent.schema, 'narada.worker.run_wait_batch.v1');
assert.equal(batchWait.result?.structuredContent.finished_count, 2);
assert.equal(batchWait.result?.structuredContent.synthesis.rows.length, 2);
assert.equal(batchWait.result?.structuredContent.synthesis.rows[1].verification[0].tool, 'fake-codex');
const batchSynthesis = await rpc({ jsonrpc: '2.0', id: 52313, method: 'tools/call', params: { name: 'worker_runs_synthesize', arguments: { run_ids: batchRun.result?.structuredContent.run_ids } } }, state);
assert.equal(batchSynthesis.result?.structuredContent.schema, 'narada.worker.runs_synthesis.v1');
assert.equal(batchSynthesis.result?.structuredContent.synthesis.rows[0].summary, 'worker ok');
const batchSecondStatus = await rpc({ jsonrpc: '2.0', id: 52314, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: batchRun.result?.structuredContent.run_ids[1] } } }, state);
assert.deepEqual(batchSecondStatus.result?.structuredContent.requested_mcp_tools, ['local-filesystem.fs_read_file']);
assert.equal(batchSecondStatus.result?.structuredContent.mcp_tool_verification.fallback_reason_required, true);
assert.equal(batchSecondStatus.result?.structuredContent.output_contract.confidence_level.minimum, 0);
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
const legacyHomeRunId = 'run-20000101T000002Z-legacyhome';
const legacyHomeRunDir = join(root, 'worker-delegation', 'runs', legacyHomeRunId);
mkdirSync(legacyHomeRunDir, { recursive: true });
writeFileSync(join(legacyHomeRunDir, 'events.jsonl'), JSON.stringify({ type: 'turn.completed', timestamp: '2000-01-01T00:00:03.000Z', text: 'legacy complete' }) + '\n', 'utf8');
writeFileSync(join(legacyHomeRunDir, 'diagnostic.log'), 'legacy diagnostic detail\n', 'utf8');
writeFileSync(join(legacyHomeRunDir, 'worker_invocation.json'), JSON.stringify({ command: 'codex', argv: ['exec'], cwd: root }), 'utf8');
writeFileSync(join(legacyHomeRunDir, 'resolved_worker_config.json'), JSON.stringify({ runtime: 'codex', authority: 'read', secret_like: 'not-secret' }), 'utf8');
writeFileSync(join(legacyHomeRunDir, 'result.json'), JSON.stringify({
  schema: 'narada.worker.run.v1',
  status: 'completed',
  run_id: legacyHomeRunId,
  run_dir: legacyHomeRunDir,
  runtime: 'codex',
  worker_session_id: 'legacy-session',
  resolved_worker_config: { authority: 'read', max_run_ms: 1000 },
  executor_request: { requested_mode: 'audit_only', preflight: [] },
  requested_mode: 'audit_only',
  edits_performed: false,
  target_state_changed: false,
  confidence: 'complete',
  completion_state: 'complete',
  blocked_paths: [],
  verification: [],
  runtime_warnings: [],
  warning_count: 0,
  preflight: [],
  final_checklist: [],
  summary: 'legacy completed worker',
  deliverables: [],
  open_questions: [],
  next_actions: [],
  changes: [],
  verification_results: [],
  artifacts: [],
  timing: { started_at: '2000-01-01T00:00:02.000Z', finished_at: '2000-01-01T00:00:03.000Z', duration_ms: 1000 },
  error: null,
}), 'utf8');
const originalUserProfile = process.env.USERPROFILE;
process.env.USERPROFILE = root;
const legacyHomeStatus = await rpc({ jsonrpc: '2.0', id: 52322, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: legacyHomeRunId } } }, state);
if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
assert.equal(legacyHomeStatus.result?.structuredContent.status, 'completed');
assert.equal(legacyHomeStatus.result?.structuredContent.summary, 'legacy completed worker');
assert.equal(legacyHomeStatus.result?.structuredContent.artifact_readback.rediscovered, true);
assert.equal(legacyHomeStatus.result?.structuredContent.artifact_readback.resources_available, false);
assert.match(legacyHomeStatus.result?.structuredContent.artifact_readback.diagnostic_tail, /legacy diagnostic detail/);
assert.match(legacyHomeStatus.result?.structuredContent.artifact_readback.events_tail, /legacy complete/);
const expiredRunId = 'run-20000101T000002Z-expire1';
const expiredRunDir = join(runRoot, expiredRunId);
mkdirSync(expiredRunDir, { recursive: true });
writeFileSync(join(expiredRunDir, 'events.jsonl'), JSON.stringify({ type: 'item.completed', timestamp: '2000-01-01T00:00:02.000Z' }) + '\n', 'utf8');
writeFileSync(join(expiredRunDir, 'diagnostic.log'), 'runtime process stopped before final message\n', 'utf8');
writeFileSync(join(expiredRunDir, 'result.json'), JSON.stringify({
  schema: 'narada.worker.run.v1',
  status: 'running',
  run_id: expiredRunId,
  run_dir: expiredRunDir,
  runtime: 'codex',
  worker_session_id: null,
  resolved_worker_config: { authority: 'read', max_run_ms: 1000 },
  executor_request: { requested_mode: 'audit_only', preflight: [] },
  requested_mode: 'audit_only',
  edits_performed: null,
  target_state_changed: null,
  confidence: 'complete',
  completion_state: 'complete',
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
const expiredStatus = await rpc({ jsonrpc: '2.0', id: 52320, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: expiredRunId } } }, state);
assert.equal(expiredStatus.result?.structuredContent.status, 'failed');
assert.equal(expiredStatus.result?.structuredContent.completion_state, 'partial');
assert.equal(expiredStatus.result?.structuredContent.error_classification, 'worker_run_expired_without_terminal_output');
assert.match(expiredStatus.result?.structuredContent.error, /expired_without_terminal_output/);
const persistedExpiredStatus = JSON.parse(readFileSync(join(expiredRunDir, 'result.json'), 'utf8'));
assert.equal(persistedExpiredStatus.status, 'failed');
assert.equal(persistedExpiredStatus.error_classification, 'worker_run_expired_without_terminal_output');
assert.match(persistedExpiredStatus.diagnostic_tail, /runtime process stopped before final message/);
assert.equal(expiredStatus.result?.structuredContent.progress.latest_event_type, 'item.completed');
assert.equal(expiredStatus.result?.structuredContent.progress.latest_event_at, '2000-01-01T00:00:02.000Z');
const staleRunId = 'run-20990101T000002Z-stale1';
const staleRunDir = join(runRoot, staleRunId);
const staleStartedAt = new Date(Date.now() - 10 * 60_000).toISOString();
mkdirSync(staleRunDir, { recursive: true });
writeFileSync(join(staleRunDir, 'events.jsonl'), JSON.stringify({ type: 'item.completed', timestamp: staleStartedAt }) + '\n', 'utf8');
writeFileSync(join(staleRunDir, 'result.json'), JSON.stringify({
  schema: 'narada.worker.run.v1',
  status: 'running',
  run_id: staleRunId,
  run_dir: staleRunDir,
  runtime: 'codex',
  worker_session_id: null,
  resolved_worker_config: { authority: 'read', max_run_ms: 60 * 60_000 },
  executor_request: { requested_mode: 'audit_only', preflight: [] },
  requested_mode: 'audit_only',
  edits_performed: null,
  target_state_changed: null,
  confidence: 'complete',
  completion_state: 'complete',
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
  timing: { started_at: staleStartedAt, finished_at: null, duration_ms: null },
  error: null,
}), 'utf8');
const staleStatus = await rpc({ jsonrpc: '2.0', id: 52319, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: staleRunId } } }, state);
assert.equal(staleStatus.result?.structuredContent.status, 'running');
assert.equal(staleStatus.result?.structuredContent.completion_state, 'partial');
assert.equal(staleStatus.result?.structuredContent.status_liveness.state, 'stale');
assert.equal(staleStatus.result?.structuredContent.status_liveness.process_liveness, 'unknown');
assert.equal(typeof staleStatus.result?.structuredContent.status_liveness.stale_for_ms, 'number');
assert.equal(staleStatus.result?.structuredContent.progress_state.state, 'idle_stale');
assert.equal(staleStatus.result?.structuredContent.progress_state.recommended_action, 'inspect_artifacts');
assert.equal(staleStatus.result?.structuredContent.budget_status.event_count, 1);
assert.equal(staleStatus.result?.structuredContent.recent_activity[0].kind, 'model_turn');
const freshRunId = 'run-20990101T000003Z-fresh1';
const freshRunDir = join(runRoot, freshRunId);
const freshStartedAt = new Date().toISOString();
mkdirSync(freshRunDir, { recursive: true });
writeFileSync(join(freshRunDir, 'events.jsonl'), JSON.stringify({ type: 'item.completed', timestamp: freshStartedAt }) + '\n', 'utf8');
writeFileSync(join(freshRunDir, 'result.json'), JSON.stringify({
  schema: 'narada.worker.run.v1',
  status: 'running',
  run_id: freshRunId,
  run_dir: freshRunDir,
  runtime: 'codex',
  worker_session_id: null,
  resolved_worker_config: { authority: 'read', max_run_ms: 60 * 60_000 },
  executor_request: { requested_mode: 'audit_only', preflight: [] },
  requested_mode: 'audit_only',
  confidence: 'complete',
  completion_state: 'complete',
  runtime_warnings: [],
  warning_count: 0,
  summary: '',
  deliverables: [],
  open_questions: [],
  next_actions: [],
  timing: { started_at: freshStartedAt, finished_at: null, duration_ms: null },
  error: null,
}), 'utf8');
const activeReapDenied = await rpc({ jsonrpc: '2.0', id: 523191, method: 'tools/call', params: { name: 'worker_run_reap', arguments: { run_id: freshRunId, reason: 'active refusal test' } } }, state);
assert.equal(activeReapDenied.error?.data?.code, 'worker_run_reap_refused_active_run');
const staleReap = await rpc({ jsonrpc: '2.0', id: 523192, method: 'tools/call', params: { name: 'worker_run_reap', arguments: { run_id: staleRunId, reason: 'test stale cleanup' } } }, state);
assert.equal(staleReap.result?.structuredContent.status, 'reaped');
assert.equal(staleReap.result?.structuredContent.reaped, true);
assert.equal(staleReap.result?.structuredContent.run.status, 'cancelled');
assert.equal(staleReap.result?.structuredContent.run.error_classification, 'worker_run_reaped_stale_orphan');
assert.equal(staleReap.result?.structuredContent.evidence.stale_confirmed, true);
assert.equal(staleReap.result?.structuredContent.evidence.process_verification, 'not_available:no_run_pid_recorded');
const staleReapedPersisted = JSON.parse(readFileSync(join(staleRunDir, 'result.json'), 'utf8'));
assert.equal(staleReapedPersisted.status, 'cancelled');
assert.equal(staleReapedPersisted.reaped.reason, 'test stale cleanup');
const eventRecoveredRunId = 'run-20000101T000003Z-events1';
const eventRecoveredRunDir = join(runRoot, eventRecoveredRunId);
mkdirSync(eventRecoveredRunDir, { recursive: true });
writeFileSync(join(eventRecoveredRunDir, 'events.jsonl'), [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-events-recovered' }),
  JSON.stringify({ type: 'agent_message', message: 'Recovered recommendation from events.', timestamp: '2000-01-01T00:00:04.000Z' }),
  JSON.stringify({ type: 'turn.completed', timestamp: '2000-01-01T00:00:05.000Z' }),
].join('\n') + '\n', 'utf8');
writeFileSync(join(eventRecoveredRunDir, 'result.json'), JSON.stringify({
  schema: 'narada.worker.run.v1',
  status: 'running',
  run_id: eventRecoveredRunId,
  run_dir: eventRecoveredRunDir,
  runtime: 'codex',
  worker_session_id: null,
  resolved_worker_config: { authority: 'read', max_run_ms: 60_000 },
  executor_request: { requested_mode: 'audit_only', preflight: [] },
  requested_mode: 'audit_only',
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
  timing: { started_at: '2000-01-01T00:00:03.000Z', finished_at: null, duration_ms: null },
  error: null,
}), 'utf8');
const eventRecoveredStatus = await rpc({ jsonrpc: '2.0', id: 52321, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: eventRecoveredRunId } } }, state);
assert.equal(eventRecoveredStatus.result?.structuredContent.status, 'completed_with_errors');
assert.equal(eventRecoveredStatus.result?.structuredContent.summary, 'Recovered recommendation from events.');
assert.match(eventRecoveredStatus.result?.structuredContent.error, /worker_run_recovered_from_events/);
assert.equal(eventRecoveredStatus.result?.structuredContent.timing.finished_at, '2000-01-01T00:00:05.000Z');
assert.equal(JSON.parse(readFileSync(join(eventRecoveredRunDir, 'result.json'), 'utf8')).status, 'completed_with_errors');
const recoveredResources = await rpc({ jsonrpc: '2.0', id: 52322, method: 'resources/list', params: {} }, state);
const recoveredLastMessageResource = recoveredResources.result?.resources.find((resource) => resource.name === `${eventRecoveredRunId}/last_message.json`);
assert.ok(recoveredLastMessageResource);
const recoveredLastMessage = await rpc({ jsonrpc: '2.0', id: 52323, method: 'resources/read', params: { uri: recoveredLastMessageResource.uri } }, state);
assert.match(recoveredLastMessage.result?.contents[0].text, /Recovered recommendation from events/);
const recentRuns = await rpc({ jsonrpc: '2.0', id: 524, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { limit: 10 } } }, state);
const recentAsyncRun = recentRuns.result?.structuredContent.runs.find((run) => run.run_id === asyncRun.result?.structuredContent.run_id);
assert.ok(recentAsyncRun);
assert.match(String(recentAsyncRun.progress_preview), /thread-created/);
const verboseRuns = await rpc({ jsonrpc: '2.0', id: 525, method: 'tools/call', params: { name: 'worker_runs_list', arguments: { limit: 20, verbose: true } } }, state);
const verboseAsyncRun = verboseRuns.result?.structuredContent.runs.find((run) => run.run_id === asyncRun.result?.structuredContent.run_id);
assert.equal(verboseAsyncRun.summary, 'worker ok');
assert.equal(typeof verboseAsyncRun.run_dir, 'string');
assert.equal(verboseAsyncRun.progress.readable, true);
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
assert.equal(readAuthority.result?.structuredContent.resolved_worker_config.model, null);
assert.equal(readAuthority.result?.structuredContent.resolved_worker_config.reasoning_effort, null);
const mediumCognition = await rpc({
  jsonrpc: '2.0',
  id: 541,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: runArgs('medium cognition', {}, 'read', 'medium') },
}, state);
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.authority, 'read');
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.cognition, 'medium');
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.sandbox, 'read-only');
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.model, null);
assert.equal(mediumCognition.result?.structuredContent.resolved_worker_config.reasoning_effort, null);
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
assert.equal(commandAuthority.result?.structuredContent.resolved_worker_config.model, null);
assert.equal(commandAuthority.result?.structuredContent.resolved_worker_config.reasoning_effort, null);

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
assert.equal(editRun.result?.structuredContent.resolved_worker_config.reasoning_effort, null);
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
assert.equal(editRequest.constraints.overrides.reasoning_effort, undefined);

const defaultEditRun = await rpc({
  jsonrpc: '2.0',
  id: 5611,
  method: 'tools/call',
  params: { name: 'worker_edit', arguments: { cwd: root, instruction: 'default edit shortcut', wait_for_completion: true } },
}, state);
assert.equal(defaultEditRun.result?.structuredContent.resolved_worker_config.model, null);
assert.equal(defaultEditRun.result?.structuredContent.resolved_worker_config.reasoning_effort, null);

const customLowCognitionState = createServerState({ allowedRoot: root, runRoot: join(root, 'low-cognition-defaults'), codexCommand: process.execPath, codexCommandArgs: [fakeCodexScript], cognitionLowModel: 'gpt-low-default', cognitionLowReasoningEffort: 'minimal' });
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
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.model, null);
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.reasoning_effort, null);
assert.equal(resumableEdit.result?.structuredContent.resolved_worker_config.ephemeral, false);
const editSessionRecord = JSON.parse(readFileSync(join(runRoot, 'sessions', `${encodeURIComponent('thread-created')}.json`), 'utf8'));
assert.equal(editSessionRecord.origin_tool, 'worker_edit');
assert.equal(editSessionRecord.resolved_worker_config.authority, 'write');
assert.equal(editSessionRecord.resolved_worker_config.cognition, 'low');
assert.equal(editSessionRecord.resolved_worker_config.model, null);
const restartedState = createServerState({ allowedRoot: root, runRoot, auditLogDir, codexCommand: process.execPath, codexCommandArgs: [fakeCodexScript] }, { PATH: process.env.PATH });
const resumedEdit = await rpc({
  jsonrpc: '2.0',
  id: 565,
  method: 'tools/call',
  params: { name: 'worker_resume', arguments: { worker_session_id: 'thread-created', constraints: { cwd: root, wait_for_completion: true } } },
}, restartedState);
assert.equal(resumedEdit.result?.structuredContent.status, 'completed');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.authority, 'write');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.cognition, 'low');
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.model, null);
assert.equal(resumedEdit.result?.structuredContent.resolved_worker_config.reasoning_effort, null);
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
assert.doesNotMatch(readFileSync(join(completedRunDir, 'worker_prompt.txt'), 'utf8'), /NARS worker completion guard/);
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
assert.equal(spawnFailure.error?.data.code, 'worker_runtime_unavailable');
assert.match(spawnFailure.error?.data.details.reason, /command not found/);
assert.equal(typeof spawnFailure.error?.data.details.remediation, 'string');

const unavailableRoot = mkdtempSync(join(tmpdir(), 'worker-delegation-unavailable-'));
const unavailableState = createServerState({ allowedRoot: unavailableRoot, runRoot: join(unavailableRoot, 'runs'), codexCommand: 'definitely-not-a-real-codex-binary' });
const unavailableRun = await rpc({
  jsonrpc: '2.0',
  id: 611,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'unavailable runtime' }, constraints: { cwd: unavailableRoot, wait_for_completion: true } } },
}, unavailableState);
assert.equal(unavailableRun.error?.data.code, 'worker_runtime_unavailable');

const deepseekRoot = mkdtempSync(join(tmpdir(), 'worker-delegation-deepseek-spawn-'));
const deepseekState = createServerState({ allowedRoot: deepseekRoot, runRoot: join(deepseekRoot, 'runs'), defaultRuntime: 'deepseek-api' }, { PATH: process.env.PATH, NARADA_PROVIDER_SECRET_STORE: 'disabled' });
const deepseekUnavailable = await rpc({
  jsonrpc: '2.0',
  id: 612,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'deepseek unavailable' }, constraints: { cwd: deepseekRoot, wait_for_completion: true, overrides: { runtime: 'deepseek-api' } } } },
}, deepseekState);
assert.equal(deepseekUnavailable.error?.data.code, 'worker_runtime_unavailable');
assert.match(String(deepseekUnavailable.error?.data.details.reason), /DEEPSEEK_API_KEY/);

const eventRoot = mkdtempSync(join(tmpdir(), 'worker-delegation-bad-event-'));
const badEventScript = join(eventRoot, 'exec.cjs');
writeFileSync(badEventScript, `
const fs = require('fs');
const args = process.argv.slice(2);
const lastMessagePath = args[args.indexOf('-o') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('not json\\n');
  fs.writeFileSync(lastMessagePath, JSON.stringify({ summary: 'ok', deliverables: [], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [] }));
});
`, 'utf8');
const badEventState = createServerState({ allowedRoot: eventRoot, runRoot: join(eventRoot, 'runs'), codexCommand: process.execPath, codexCommandArgs: [badEventScript] });
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
assert.equal(preflightRun.result?.structuredContent.preflight.some((check) => check.name === 'effective_authority' && check.status === 'warning' && check.message.includes('raw MCP surfaces may advertise mutation-capable tools')), true);
assert.equal(preflightRun.result?.structuredContent.output_contract.effective_authority, 'read');
assert.match(preflightRun.result?.structuredContent.output_contract.tool_capability_note, /mutation tools/);
assert.match(readFileSync(join(preflightRun.result?.structuredContent.run_dir, 'worker_prompt.txt'), 'utf8'), /effective_authority=read/);
assert.equal(preflightRun.result?.structuredContent.preflight.some((check) => check.name === 'required_mcp_tools' && check.status === 'warning' && check.message.includes('not_verified_by_delegation') && check.message.includes('structured-command.structured_command_execute')), true);

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
const runtimeErrorScript = join(runtimeErrorRoot, 'exec.cjs');
writeFileSync(runtimeErrorScript, `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-runtime-error' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'model not available for account' } }) + '\\n');
  process.exit(1);
});
`, 'utf8');
const runtimeErrorState = createServerState({ allowedRoot: runtimeErrorRoot, runRoot: join(runtimeErrorRoot, 'runs'), codexCommand: process.execPath, codexCommandArgs: [runtimeErrorScript] });
const runtimeError = await rpc({
  jsonrpc: '2.0',
  id: 63,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'runtime error' }, constraints: { cwd: runtimeErrorRoot, wait_for_completion: true } } },
}, runtimeErrorState);
assert.equal(runtimeError.error?.data.code, 'worker_runtime_failed');
assert.equal(runtimeError.error?.data.details.error, 'model not available for account');

const prestartFailureState = createServerState({ allowedRoot: root, runRoot: join(root, 'prestart-failure'), codexCommand: process.execPath, codexCommandArgs: [fakeCodexPrestartFailureScript] });
const prestartFailure = await rpc({
  jsonrpc: '2.0',
  id: 631,
  method: 'tools/call',
  params: { name: 'worker_run', arguments: { intent: { instruction: 'prestart failure' }, constraints: { cwd: root, wait_for_completion: true } } },
}, prestartFailureState);
assert.equal(prestartFailure.error?.data.code, 'worker_runtime_failed');
const prestartRunId = readdirSync(join(root, 'prestart-failure')).find((entry) => entry.startsWith('run-'));
assert.ok(prestartRunId);
const prestartStatus = await rpc({ jsonrpc: '2.0', id: 632, method: 'tools/call', params: { name: 'worker_run_status', arguments: { run_id: prestartRunId } } }, prestartFailureState);
assert.equal(prestartStatus.result?.structuredContent.error_classification, 'codex_untrusted_directory');
assert.match(prestartStatus.result?.structuredContent.diagnostic_tail, /Not inside a trusted directory/);
const prestartList = await rpc({ jsonrpc: '2.0', id: 633, method: 'tools/call', params: { name: 'worker_runs_list', arguments: {} } }, prestartFailureState);
assert.match(prestartList.result?.structuredContent.runs[0].error_preview, /Not inside a trusted directory/);
assert.equal(prestartList.result?.structuredContent.runs[0].error_classification, 'codex_untrusted_directory');

const materializedState = createServerState({ allowedRoot: root, runRoot: join(root, 'small-output'), maxOutputBytes: 120 });
const materialized = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'worker_policy_inspect', arguments: {} } }, materializedState);
assert.equal(materialized.result?.structuredContent.result_materialized, true);
assert.equal(materialized.result?.structuredContent.reader_tool, null);
assert.equal(materialized.result?.structuredContent.schema, 'narada.worker.policy.v1');
assert.match(materialized.result?.content[0].text, /worker_policy_inspect: output exceeds compact text limit/);
assert.deepEqual(materialized.result?.content.map((item) => item.type), ['text']);
const materializedResources = await rpc({ jsonrpc: '2.0', id: 71, method: 'resources/list', params: {} }, materializedState);
assert.equal(materializedResources.result?.resources.some((resource) => String(resource.uri).startsWith('worker-output:')), false);
const executorRequestResource = (await rpc({ jsonrpc: '2.0', id: 72, method: 'resources/list', params: {} }, state)).result?.resources.find((resource) => resource.name === `${allowedConfigRun.result?.structuredContent.run_id}/executor_request.json`);
assert.ok(executorRequestResource);
const shownArtifact = await rpc({ jsonrpc: '2.0', id: 801, method: 'resources/read', params: { uri: executorRequestResource.uri } }, state);
assert.match(shownArtifact.result?.contents[0].text, /narada.worker.executor_request.v1/);

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
