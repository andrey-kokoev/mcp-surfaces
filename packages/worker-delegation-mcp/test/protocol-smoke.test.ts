import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'worker-delegation-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
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

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worker_policy_inspect', arguments: {} } })}\n`);
child.stdin.end();

const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
assert.equal(exitCode, 0, diagnosticText);
const responses = outputText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.equal(responses[0].result.serverInfo.name, 'worker-delegation-mcp');
assert.equal(responses[1].result.structuredContent.schema, 'narada.worker.policy.v1');
assert.match(responses[1].result.content[0].text, /worker_policy: ok/);
