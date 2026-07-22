import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteLoopConfig, SITE_LOOP_CONFIG_SCHEMA } from '../src/site-loop/site-loop-config.js';
import { openSiteLoopStore } from '../src/site-loop/site-loop-store.js';
import { listSiteLoopRuns, siteLoopStatus } from '../src/site-loop/site-loop.js';

const serverPath = fileURLToPath(new URL('../src/site-loop-mcp-server.js', import.meta.url));

function writeFixtureSite(prefix, configPatch = {}) {
  const root = mkdtempSync(join(tmpdir(), `site-loop-${prefix}-`));
  mkdirSync(join(root, '.narada', 'capabilities'), { recursive: true });
  mkdirSync(join(root, '.ai', 'state'), { recursive: true });
  writeFileSync(join(root, 'README.md'), `# ${prefix}\n`, 'utf8');
  writeFileSync(join(root, 'AGENTS.md'), `# ${prefix} agents\n`, 'utf8');
  const config = {
    schema: SITE_LOOP_CONFIG_SCHEMA,
    loop_id: `${prefix}.loop`,
    site_id: `narada-${prefix}`,
    display_name: `${prefix} loop`,
    resident: {
      agent_id: `${prefix}.resident`,
      role: 'resident',
    },
    refs: {
      ticket_projection: { kind: 'ticket_projection', ref: prefix },
    },
    docs: [
      { path: 'README.md', description: `${prefix} readme.` },
      { path: 'AGENTS.md', description: `${prefix} agents.` },
    ],
    tests: {
      smoke_echo: {
        command: process.execPath,
        args: ['-e', `process.stdout.write("${prefix}-ok")`],
      },
    },
    schemas: {
      site_loop_runs: `narada.${prefix}.loop.runs.v1`,
    },
    ...configPatch,
  };
  writeFileSync(join(root, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify(config, null, 2), 'utf8');
  openSiteLoopStore(root).close();
  return { root, config };
}

for (const fixture of [writeFixtureSite('alpha'), writeFixtureSite('beta', {
  resident: { agent_id: 'beta.operator', role: 'operator' },
  refs: { ticket_projection: { kind: 'board_projection', ref: 'beta-board' } },
})]) {
  const loaded = loadSiteLoopConfig(fixture.root);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.config.loop_id, fixture.config.loop_id);
  assert.equal(loaded.config.site_id, fixture.config.site_id);
  const runs = listSiteLoopRuns(fixture.root, { limit: 1 });
  assert.equal(runs.loop_id, fixture.config.loop_id);
  assert.equal(runs.schema, fixture.config.schemas.site_loop_runs);
  const status = siteLoopStatus(fixture.root);
  assert.equal(status.loop_id, fixture.config.loop_id);
  assert.equal(status.schema, 'narada.site_operating_loop.status.v1');
}

const beta = writeFixtureSite('gamma', {
  display_name: 'Gamma non-sonar loop',
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'gamma-tickets' } },
});

const proc = spawn(process.execPath, ['--no-warnings', serverPath, '--site-root', beta.root], {
  cwd: beta.root,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
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
  assert.equal(response.error, undefined, `${label}: ${JSON.stringify(response)}`);
  assert.equal(Array.isArray(response.result?.content), true, `${label}: ${JSON.stringify(response)}`);
  return JSON.parse(response.result.content[0].text);
}

try {
  writeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  const init = await waitFor(1);
  assert.equal(init.error, undefined);

  writeMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await waitFor(2);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('site_loop_guidance'), true);
  assert.equal(names.includes('site_loop_doctor'), true);

  const configValidation = contentText('site_loop_config_validate', await callTool(3, 'site_loop_config_validate'));
  assert.equal(configValidation.status, 'ok');
  assert.equal(configValidation.loop_id, 'gamma.loop');

  const docsList = contentText('site_docs_list', await callTool(4, 'site_docs_list'));
  assert.equal(docsList.docs.length, 2);

  const testsList = contentText('site_test_list', await callTool(5, 'site_test_list'));
  assert.equal(testsList.tests[0].selector, 'smoke_echo');

  const testRun = contentText('site_test_run', await callTool(6, 'site_test_run', { selector: 'smoke_echo' }));
  assert.equal(testRun.status, 'passed');
  assert.equal(testRun.stdout, 'gamma-ok');

  const status = contentText('site_loop_status', await callTool(7, 'site_loop_status'));
  assert.equal(status.loop_id, 'gamma.loop');
  assert.equal(stderr.trim(), '');
} finally {
  proc.stdin?.destroy();
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.kill();
}

console.log('site-loop cross-site contract ok');
