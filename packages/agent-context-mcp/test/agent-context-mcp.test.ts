// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const siteRoot = mkdtempSync(join(tmpdir(), 'agent-context-mcp-'));
writeFileSync(join(siteRoot, 'AGENTS.md'), '# Fixture Site\n', 'utf8');
mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
writeFileSync(join(siteRoot, '.ai', 'agents', 'roster.json'), JSON.stringify({
  agents: [{ agent_id: 'sonar.architect', role: 'architect', capabilities: [] }],
}, null, 2), 'utf8');

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const proc = spawn(process.execPath, [serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  env: {
    ...process.env,
    NARADA_AGENT_ID: 'sonar.architect',
    NARADA_SITE_ROOT: siteRoot,
    NARADA_AGENT_CONTEXT_DB: join(siteRoot, '.ai', 'state', 'agent-context.sqlite'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');
proc.stdout.on('data', (chunk) => { stdout += chunk; });
proc.stderr.on('data', (chunk) => { stderr += chunk; });

function writeMessage(message, separator = '\r\n\r\n') {
  const body = JSON.stringify(message);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}${separator}${body}`);
}

function writeJsonLine(message) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function readOne() {
  if (stdout.startsWith('{')) {
    const lineEnd = stdout.indexOf('\n');
    if (lineEnd < 0) return null;
    const line = stdout.slice(0, lineEnd);
    stdout = stdout.slice(lineEnd + 1);
    return JSON.parse(line);
  }
  const headerEnd = stdout.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const header = stdout.slice(0, headerEnd);
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error(`bad_header:${header}`);
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  if (stdout.length < bodyStart + length) return null;
  const body = stdout.slice(bodyStart, bodyStart + length);
  stdout = stdout.slice(bodyStart + length);
  return JSON.parse(body);
}

async function waitFor(id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const message = readOne();
    if (message?.id === id) return message;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout:${id}; stderr=${stderr}`);
}

try {
  writeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-context-mcp-test', version: '0.1.0' } } });
  const init = await waitFor(1);
  assert.equal(init.error, undefined);
  writeMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  writeMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await waitFor(2);
  assert.equal(tools.error, undefined);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('agent_context_hydrate_current'), true);
  assert.equal(names.includes('startup_sequence'), true);
  writeMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, '\n\n');
  const lfTools = await waitFor(3);
  assert.equal(lfTools.error, undefined);
  writeJsonLine({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  const jsonLineTools = await waitFor(4);
  assert.equal(jsonLineTools.error, undefined);
  console.log('agent context MCP tests passed');
} finally {
  proc.stdin?.destroy();
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.kill();
}



