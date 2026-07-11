import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateAffordanceDocument } from '@narada2/mcp-affordances';

const root = mkdtempSync(join(testTempRoot(), 'worker-delegation-protocol-'));
const SMOKE_WAIT_MS = 15_000;
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
const serverBin = packageJson.bin?.['worker-delegation-mcp'];
assert.equal(serverBin, './dist/src/main.js');
const serverPath = join(packageRoot, serverBin);
const child = spawn(process.execPath, [serverPath, '--allowed-root', root, '--run-root', join(root, 'runs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let outputText = '';
let diagnosticText = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  outputText += chunk;
});
child.stderr.on('data', (chunk) => {
  diagnosticText += chunk;
});

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } })}\n`);
await waitForLines(() => outputText, 2);
const initialMessages = outputText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const rootsRequest = initialMessages.find((message) => message.method === 'roots/list');
assert.ok(rootsRequest);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rootsRequest.id, result: { roots: [{ uri: pathToFileURL(root).href, name: 'worker-root' }] } })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: { progressToken: 'worker-progress' }, name: 'worker_policy_inspect', arguments: {} } })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'completion/complete', params: { argument: { name: 'cwd' } } })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'worker_operator_affordances', arguments: {} } })}\n`);
await waitForResponseId(() => outputText, 5);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'worker/unknown', params: {} })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'worker_not_real', arguments: {} } })}\n`);
await waitForResponseId(() => outputText, 7);
child.stdin.end();

const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
assert.equal(exitCode, 0, diagnosticText);
const responses = outputText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const initializeResponse = responses.find((message) => message.id === 1);
assert.equal(initializeResponse.result.serverInfo.name, 'worker-delegation-mcp');
const toolsResponse = responses.find((message) => message.id === 4);
assert.equal(toolsResponse.result.tools.some((tool: { name: string }) => tool.name === 'worker_operator_affordances'), true);
const policyResponse = responses.find((message) => message.id === 2);
assert.equal(policyResponse.result.structuredContent.schema, 'narada.worker.policy.v1');
assert.match(policyResponse.result.content[0].text, /"schema": "narada\.worker\.policy\.v1"/);
assert.equal(responses.some((message) => message.method === 'notifications/progress' && message.params?.progressToken === 'worker-progress'), true);
const completionResponse = responses.find((message) => message.id === 3);
assert.equal(completionResponse.result.completion.values.includes(root), true);
const affordancesResponse = responses.find((message) => message.id === 5);
assert.equal(validateAffordanceDocument(affordancesResponse.result.structuredContent).status, 'ok');
assert.equal(affordancesResponse.result.structuredContent.surface_id, 'worker-delegation');
assert.equal(affordancesResponse.result.structuredContent.actions.some((action) => action.id === 'refresh_dashboard'), true);
assert.equal(affordancesResponse.result.structuredContent.actions.some((action) => action.id === 'reap_stale_run' && action.destructive === true), true);
const unsupportedMethodResponse = responses.find((message) => message.id === 6);
assert.equal(unsupportedMethodResponse.error.data.code, 'worker_unknown_tool');
assert.equal(unsupportedMethodResponse.error.data.details.method, 'worker/unknown');
const unknownToolResponse = responses.find((message) => message.id === 7);
assert.equal(unknownToolResponse.error.data.code, 'worker_unknown_tool');
assert.equal(unknownToolResponse.error.data.details.tool_name, 'worker_not_real');

const legacyRoot = mkdtempSync(join(testTempRoot(), 'worker-delegation-proxy-legacy-'));
mkdirSync(join(legacyRoot, '.narada'), { recursive: true });
const legacyRegistryPath = join(legacyRoot, 'provider-registry.json');
writeFileSync(legacyRegistryPath, JSON.stringify({
  schema: 'narada.carrier.provider_registry.v1',
  default_provider: 'codex-subscription',
  providers: {
    'codex-subscription': {
      base_url: 'codex://local-subscription',
      default_model: 'gpt-5.6-sol',
      available_models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
      cognition_defaults: {
        low: { model: 'gpt-5.6-luna', reasoning_effort: 'low' },
        medium: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
        high: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
      },
      credential_requirement: { kind: 'local_codex_subscription' },
    },
  },
}), 'utf8');
writeFileSync(join(legacyRoot, '.narada', 'worker-cognition-defaults.json'), JSON.stringify({
  schema: 'narada.worker.cognition_defaults.v1',
  version: 9,
  updated_at: '2026-07-10T00:00:00.000Z',
  provider_cognition_defaults: {
    'codex-subscription': { low: { model: 'gpt-5.6-luna', reasoning_effort: null } },
  },
  effective_cognition_defaults: {
    low: { provider: 'codex-subscription', model: 'gpt-5.6-luna', reasoning_effort: 'max' },
  },
}), 'utf8');
const proxyPath = join(packageRoot, '..', 'shared', 'mcp-runtime-proxy', 'dist', 'src', 'main.js');
const proxyChild = spawn(process.execPath, [
  proxyPath,
  '--surface-id', 'worker-delegation',
  '--entrypoint', serverPath,
  '--',
  '--site-root', legacyRoot,
  '--allowed-root', legacyRoot,
  '--run-root', join(legacyRoot, 'runs'),
  '--provider-registry-path', legacyRegistryPath,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, NARADA_PROVIDER_SECRET_STORE: 'disabled' },
});
let proxyOutput = '';
let proxyDiagnostics = '';
proxyChild.stdout.setEncoding('utf8');
proxyChild.stderr.setEncoding('utf8');
proxyChild.stdout.on('data', (chunk) => { proxyOutput += chunk; });
proxyChild.stderr.on('data', (chunk) => { proxyDiagnostics += chunk; });
proxyChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'initialize', params: { capabilities: {} } })}\n`);
proxyChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'worker_cognition_defaults_inspect', arguments: {} } })}\n`);
await waitForResponseId(() => proxyOutput, 102);
proxyChild.stdin.end();
const proxyExitCode = await new Promise<number | null>((resolve) => proxyChild.on('close', resolve));
assert.equal(proxyExitCode, 0, proxyDiagnostics);
const proxyResponses = proxyOutput.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.equal(proxyResponses.find((message) => message.id === 101).result.serverInfo.name, 'worker-delegation-mcp');
const legacyCognitionResponse = proxyResponses.find((message) => message.id === 102);
assert.equal(legacyCognitionResponse.result.structuredContent.version, 9);
assert.deepEqual(legacyCognitionResponse.result.structuredContent.effective_cognition_defaults.low, {
  provider: 'codex-subscription',
  model: 'gpt-5.6-luna',
  reasoning_effort: 'max',
  source: 'site_runtime_override',
  precedence: 'per_run_override > site_effective_cognition_default > explicit_provider_registry_default > global_provider_registry_default > generic_cognition_default',
});

async function waitForLines(read: () => string, count: number) {
  const started = Date.now();
  while (read().trim().split(/\r?\n/).filter(Boolean).length < count) {
    if (Date.now() - started > SMOKE_WAIT_MS) throw new Error(`timed out waiting for ${count} lines`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForResponseId(read: () => string, id: number) {
  const started = Date.now();
  while (Date.now() - started <= SMOKE_WAIT_MS) {
    const messages = read().trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    if (messages.some((message) => message.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for response id ${id}`);
}

function testTempRoot(): string {
  const root = join(process.cwd(), '.tmp-tests');
  mkdirSync(root, { recursive: true });
  return root;
}
