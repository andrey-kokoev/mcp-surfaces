import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'git-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath, '--allowed-root', root], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'git_policy_inspect', arguments: {} } })}\n`);
child.stdin.end();

const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
assert.equal(exitCode, 0, stderr);

const responses = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.equal(responses[1].result.structuredContent.mode, 'read');
assert.match(responses[1].result.content[0].text, /git_policy: ok/);
