import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSiteLoopStore } from '../src/site-loop/site-loop-store.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-mcp-live-e2e-'));
const serverPath = fileURLToPath(new URL('../src/site-loop-mcp-server.js', import.meta.url));

mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });
writeFileSync(join(siteRoot, 'AGENTS.md'), '# Live E2E\n', 'utf8');
writeFileSync(join(siteRoot, 'README.md'), '# Live E2E\n', 'utf8');
writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v1',
  loop_id: 'live.e2e.loop',
  site_id: 'narada-live-e2e',
  display_name: 'Live E2E loop',
  resident: {
    agent_id: 'live.e2e.resident',
    role: 'resident',
  },
  refs: {
    ticket_projection: { kind: 'ticket_projection', ref: 'live-e2e' },
  },
  docs: [
    { path: 'AGENTS.md', description: 'Live E2E instructions.' },
    { path: 'README.md', description: 'Live E2E readme.' },
  ],
  tests: {
    smoke_echo: {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("live-e2e-ok")'],
    },
  },
}, null, 2), 'utf8');

const initializedLoopStore = openSiteLoopStore(siteRoot);
initializedLoopStore.close();

const proc = spawn(process.execPath, ['--no-warnings', serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');
proc.stdout.on('data', (chunk) => { stdout += chunk; });
proc.stderr.on('data', (chunk) => { stderr += chunk; });

function writeMessage(message) {
  const body = JSON.stringify(message);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\n\n${body}`);
}

function readOne() {
  const crlfHeaderEnd = stdout.indexOf('\r\n\r\n');
  const lfHeaderEnd = stdout.indexOf('\n\n');
  const headerEnd = crlfHeaderEnd >= 0 ? crlfHeaderEnd : lfHeaderEnd;
  if (headerEnd < 0) return null;
  const separatorLength = crlfHeaderEnd >= 0 ? 4 : 2;
  const header = stdout.slice(0, headerEnd);
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) throw new Error(`bad_header:${header}`);
  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + Number(match[1]);
  if (stdout.length < bodyEnd) return null;
  const body = stdout.slice(bodyStart, bodyEnd);
  stdout = stdout.slice(bodyEnd);
  return JSON.parse(body);
}

async function waitFor(id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const message = readOne();
    if (message?.id === id) return message;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout:${id}; stderr=${stderr}`);
}

function callTool(id, name, args = {}) {
  writeMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return waitFor(id);
}

function contentText(label, response) {
  assert.equal(Array.isArray(response.result?.content), true, `${label}: ${JSON.stringify(response)}`);
  assert.equal(response.result.content.length > 0, true, `${label}: ${JSON.stringify(response)}`);
  assert.equal(response.result.content[0].type, 'text', `${label}: ${JSON.stringify(response)}`);
  return JSON.parse(response.result.content[0].text);
}

try {
  writeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  const init = await waitFor(1);
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'narada-site-loop-mcp');

  writeMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await waitFor(2);
  assert.equal(tools.error, undefined);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('site_loop_doctor'), true);
  assert.equal(names.includes('site_ops_doctor'), true);
  assert.equal(names.includes('site_docs_list'), true);
  assert.equal(names.includes('site_docs_show'), true);
  assert.equal(names.includes('site_test_list'), true);
  assert.equal(names.includes('site_test_run'), true);
  assert.equal(names.includes('site_loop_config_validate'), true);
  assert.equal(names.includes('site_loop_status'), true);

  const configValidation = contentText('site_loop_config_validate', await callTool(3, 'site_loop_config_validate'));
  assert.equal(configValidation.status, 'ok');
  assert.equal(configValidation.loop_id, 'live.e2e.loop');
  assert.equal(configValidation.site_id, 'narada-live-e2e');

  const doctor = contentText('site_loop_doctor', await callTool(4, 'site_loop_doctor'));
  assert.equal(doctor.status, 'ok');
  assert.equal(doctor.site_loop_config.status, 'ok');
  assert.equal(doctor.site_loop_config.loop_id, 'live.e2e.loop');
  assert.deepEqual(doctor.approved_tests, ['smoke_echo']);

  const docsList = contentText('site_docs_list', await callTool(5, 'site_docs_list'));
  assert.equal(docsList.status, 'ok');
  assert.equal(docsList.docs.length, 2);
  assert.equal(docsList.docs.some((doc) => doc.path === 'AGENTS.md'), true);
  assert.equal(docsList.docs.some((doc) => doc.path === 'README.md'), true);

  const docShow = contentText('site_docs_show', await callTool(6, 'site_docs_show', { path: 'AGENTS.md' }));
  assert.equal(docShow.status, 'ok');
  assert.match(docShow.content, /Live E2E/);

  const testsList = contentText('site_test_list', await callTool(7, 'site_test_list'));
  assert.equal(testsList.status, 'ok');
  assert.equal(testsList.tests.length, 1);
  assert.equal(testsList.tests[0].selector, 'smoke_echo');

  const testRun = contentText('site_test_run', await callTool(8, 'site_test_run', { selector: 'smoke_echo' }));
  assert.equal(testRun.status, 'passed');
  assert.equal(testRun.selector, 'smoke_echo');
  assert.equal(testRun.exit_code, 0);
  assert.equal(testRun.stdout, 'live-e2e-ok');

  const status = contentText('site_loop_status', await callTool(9, 'site_loop_status'));
  assert.equal(status.loop_id, 'live.e2e.loop');
  assert.equal(status.schema, 'narada.site_operating_loop.status.v1');

  assert.equal(stderr.trim(), '');
} finally {
  proc.stdin?.destroy();
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.kill();
}

console.log('site-loop-mcp live e2e ok');
