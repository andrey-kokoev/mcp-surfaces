import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
