import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/site-loop-mcp-server.js', import.meta.url));
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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const message = readOne();
    if (message?.id === id) return message;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout:${id}; stderr=${stderr}`);
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
  assert.equal(names.includes('site_loop_guidance'), true);
  assert.equal(names.includes('site_loop_doctor'), true);
  assert.equal(names.includes('site_ops_guidance'), true);
  assert.equal(names.includes('site_ops_doctor'), true);
  assert.equal(names.includes('site_loop_config_validate'), true);
  assert.equal(names.includes('site_loop_status'), true);

  const configDir = join(siteRoot, '.narada', 'capabilities');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });
  writeFileSync(join(configDir, 'site-loop-config.json'), JSON.stringify({
    schema: 'narada.site_loop.config.v1',
    loop_id: 'protocol.loop',
    site_id: 'narada-protocol',
    display_name: 'Protocol loop',
    resident: { agent_id: 'protocol.resident', role: 'resident' },
    refs: { ticket_projection: { kind: 'ticket_projection', ref: 'protocol' } },
  }, null, 2), 'utf8');
  writeMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'site_loop_doctor', arguments: {} } });
  const doctor = await waitFor(3);
  assert.equal(doctor.error, undefined);
  const doctorPayload = JSON.parse(doctor.result.content[0].text);
  assert.equal(doctorPayload.site_loop_config.status, 'ok');
  assert.equal(doctorPayload.site_loop_config.loop_id, 'protocol.loop');
  assert.equal(doctorPayload.site_loop_config.display_name, 'Protocol loop');
  assert.equal(doctorPayload.compatibility_aliases.tools.includes('site_ops_doctor'), true);
  assert.equal(doctorPayload.compatibility_aliases.prompts.includes('site_ops_workflow'), true);
  assert.equal(doctorPayload.dependency_boundaries.some((item: { surface: string }) => item.surface === 'task-lifecycle'), true);

  writeMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'site_loop_config_validate', arguments: {} } });
  const configValidation = await waitFor(6);
  assert.equal(configValidation.error, undefined);
  const configValidationPayload = JSON.parse(configValidation.result.content[0].text);
  assert.equal(configValidationPayload.status, 'ok');
  assert.equal(configValidationPayload.schema_id, 'narada:site-loop-config.v1.schema.json');
  assert.equal(configValidationPayload.loop_id, 'protocol.loop');

  writeMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'site_loop_run_once', arguments: { drain: true } } });
  const runOnce = await waitFor(4);
  assert.equal(runOnce.error, undefined);
  const runOncePayload = JSON.parse(runOnce.result.content[0].text);
  assert.equal(runOncePayload.loop_id, 'protocol.loop');

  writeMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'site_loop_status', arguments: {} } });
  const status = await waitFor(5);
  assert.equal(status.error, undefined);
  const statusPayload = JSON.parse(status.result.content[0].text);
  assert.equal(statusPayload.loop_id, 'protocol.loop');
  assert.equal(stderr.trim(), '');
} finally {
  proc.stdin?.destroy();
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.kill();
}

console.log('site-loop-mcp protocol smoke ok');
