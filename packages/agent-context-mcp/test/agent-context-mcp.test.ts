// @ts-nocheck
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const siteRoot = mkdtempSync(join(tmpdir(), 'agent-context-mcp-'));
writeFileSync(join(siteRoot, 'AGENTS.md'), '# Fixture Site\n', 'utf8');
mkdirSync(join(siteRoot, '.ai', 'agents'), { recursive: true });
writeFileSync(join(siteRoot, '.ai', 'agents', 'roster.json'), JSON.stringify({
  agents: [
    { agent_id: 'sonar.architect', role: 'architect', capabilities: [] },
    { agent_id: 'narada-revolution.resident', role: 'resident', capabilities: [] },
  ],
}, null, 2), 'utf8');

const dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite');
mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE agent_start_events (
    event_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    runtime TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    resume_command TEXT,
    bootstrap_artifact_uri TEXT
  );
  CREATE TABLE agent_events (
    event_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
`);
db.close();

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const proc = spawn(process.execPath, [serverPath, '--site-root', siteRoot, '--site-id', 'narada-revolution'], {
  cwd: siteRoot,
  env: {
    ...process.env,
    NARADA_AGENT_ID: 'narada-revolution.resident',
    NARADA_SITE_ROOT: siteRoot,
    NARADA_AGENT_CONTEXT_DB: dbPath,
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
  assert.equal(names.includes('agent_context_startup_sequence'), true);
  assert.equal(names.includes('startup_sequence'), false);
  const checkpointTool = tools.result.tools.find((tool) => tool.name === 'agent_context_checkpoint');
  assert.equal(checkpointTool.inputSchema.properties.continuation_ref.properties.path.type, 'string');
  assert.equal(checkpointTool.inputSchema.properties.continuation.properties.schema.const, 'narada.continuation.v1');
  writeMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, '\n\n');
  const lfTools = await waitFor(3);
  assert.equal(lfTools.error, undefined);
  writeJsonLine({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  const jsonLineTools = await waitFor(4);
  assert.equal(jsonLineTools.error, undefined);
  writeMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_context_whoami', arguments: {} } });
  const whoami = await waitFor(5);
  assert.equal(whoami.error, undefined);
  const identity = JSON.parse(whoami.result.content[0].text);
  assert.equal(identity.identity, 'narada-revolution.resident');
  assert.equal(identity.role, 'resident');
  const continuationContent = '# Agent-context continuation test\n';
  const continuationPath = join(siteRoot, '.ai', 'continuations', 'agent-context-test.md');
  mkdirSync(join(siteRoot, '.ai', 'continuations'), { recursive: true });
  writeFileSync(continuationPath, continuationContent, 'utf8');
  const continuationRef = {
    schema: 'narada.continuation.handoff.v1',
    path: '.ai/continuations/agent-context-test.md',
    sha256: createHash('sha256').update(continuationContent, 'utf8').digest('hex'),
    created_at: '2026-07-13T00:00:00.000Z',
  };
  const continuation = {
    schema: 'narada.continuation.v1',
    continuation_id: 'continuation-test-1',
    objective: 'Verify canonical continuation state survives checkpoint rehydration.',
    current_state: 'The checkpoint contains one portable, bounded continuation envelope.',
    completed_work: ['Added the first continuation envelope fixture.'],
    decisions: ['Keep continuation state in checkpoint payload_json.'],
    evidence_refs: ['test:agent-context-mcp'],
    open_blockers: [],
    next_action: 'Read the checkpoint back and verify its content hash.',
    canonical_sources: ['AGENTS.md', 'packages/agent-context-mcp/src/main.ts'],
    constraints: ['Do not create a second persistence table.'],
    resume_mode: 'fresh_session',
    created_at: '2026-07-13T00:00:00.000Z',
  };
  writeMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'agent_context_checkpoint', arguments: { agent_id: 'narada-revolution.resident', key_decisions: ['site-local checkpoint regression'], continuation, continuation_ref: continuationRef } } });
  const checkpoint = await waitFor(6);
  assert.equal(checkpoint.error, undefined);
  const checkpointBody = JSON.parse(checkpoint.result.content[0].text);
  assert.equal(checkpointBody.status, 'checkpointed');
  assert.equal(checkpointBody.site_root, siteRoot);
  assert.deepEqual(checkpointBody.continuation_ref, { ...continuationRef, sha256: continuationRef.sha256.toLowerCase() });
  assert.equal(checkpointBody.continuation.schema, 'narada.continuation.v1');
  assert.equal(checkpointBody.continuation.continuation_id, continuation.continuation_id);
  assert.equal(checkpointBody.continuation.source_checkpoint_ref.startsWith('agent_context_checkpoint:chk_'), true);
  const continuationForHash = { ...checkpointBody.continuation };
  delete continuationForHash.content_hash;
  delete continuationForHash.source_checkpoint_ref;
  assert.equal(
    checkpointBody.continuation.content_hash,
    createHash('sha256').update(JSON.stringify(continuationForHash), 'utf8').digest('hex'),
  );
  writeMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'agent_context_checkpoint', arguments: { agent_id: 'narada-revolution.resident', continuation_ref: { ...continuationRef, sha256: 'B'.repeat(64) } } } });
  const invalidContinuationRef = await waitFor(7);
  assert.equal(invalidContinuationRef.error.code, -32000);
  assert.match(invalidContinuationRef.error.message, /continuation_ref_sha256_mismatch/);
  writeMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'agent_context_checkpoint', arguments: { agent_id: 'narada-revolution.resident', continuation_ref: { ...continuationRef, path: 'C:/outside.md' } } } });
  const outsideContinuation = await waitFor(8);
  assert.equal(outsideContinuation.error.code, -32000);
  assert.match(outsideContinuation.error.message, /continuation_ref_path_must_be_site_relative/);
  writeMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'agent_context_checkpoint', arguments: { agent_id: 'narada-revolution.resident', continuation: { ...continuation, objective: '' } } } });
  const invalidContinuation = await waitFor(9);
  assert.equal(invalidContinuation.error.code, -32000);
  assert.match(invalidContinuation.error.message, /continuation_objective_invalid/);
  writeMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'agent_context_rehydrate', arguments: { agent_id: 'narada-revolution.resident' } } });
  const rehydrate = await waitFor(10);
  assert.equal(rehydrate.error, undefined);
  const rehydrateBody = JSON.parse(rehydrate.result.content[0].text);
  assert.equal(rehydrateBody.payload.site_id, 'narada.revolution');
  assert.deepEqual(rehydrateBody.continuation_ref, { ...continuationRef, sha256: continuationRef.sha256.toLowerCase() });
  assert.deepEqual(rehydrateBody.continuation, checkpointBody.continuation);
  writeMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'agent_context_checkpoint', arguments: { agent_id: 'narada-revolution.resident', continuation: { ...continuation, current_state: 'A later checkpoint keeps the same canonical continuation contract.' } } } });
  const updatedCheckpoint = await waitFor(11);
  assert.equal(updatedCheckpoint.error, undefined);
  writeMessage({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'agent_context_rehydrate', arguments: { agent_id: 'narada-revolution.resident', history: true, limit: 1 } } });
  const history = await waitFor(12);
  assert.equal(history.error, undefined);
  const historyBody = JSON.parse(history.result.content[0].text);
  assert.equal(historyBody.status, 'ok');
  assert.deepEqual(historyBody.checkpoints[0].continuation, checkpointBody.continuation);
  console.log('agent context MCP tests passed');
} finally {
  proc.stdin?.destroy();
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.kill();
}

const boundSiteRoot = mkdtempSync(join(tmpdir(), 'agent-context-bound-'));
const foreignSiteRoot = mkdtempSync(join(tmpdir(), 'agent-context-foreign-'));
for (const root of [boundSiteRoot, foreignSiteRoot]) {
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture Site\n', 'utf8');
  mkdirSync(join(root, '.ai', 'agents'), { recursive: true });
  writeFileSync(join(root, '.ai', 'agents', 'roster.json'), JSON.stringify({
    agents: [{ agent_id: 'narada-revolution.resident', role: 'resident', capabilities: [] }],
  }, null, 2), 'utf8');
}

const mismatchProc = spawn(process.execPath, [serverPath, '--site-root', boundSiteRoot, '--site-id', 'narada-bound'], {
  cwd: foreignSiteRoot,
  env: {
    ...process.env,
    NARADA_AGENT_ID: 'narada-revolution.resident',
    NARADA_SITE_ROOT: foreignSiteRoot,
    NARADA_AGENT_CONTEXT_DB: join(boundSiteRoot, '.ai', 'state', 'agent-context.sqlite'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let mismatchStderr = '';
mismatchProc.stderr.setEncoding('utf8');
mismatchProc.stderr.on('data', (chunk) => { mismatchStderr += chunk; });
const mismatchExit = await waitForExit(mismatchProc);
assert.notEqual(mismatchExit.code, 0);
assert.match(mismatchStderr, /agent_context_site_root_mismatch/);

const foreignDbProc = spawn(process.execPath, [serverPath, '--site-root', boundSiteRoot, '--site-id', 'narada-bound'], {
  cwd: boundSiteRoot,
  env: {
    ...process.env,
    NARADA_AGENT_ID: 'narada-revolution.resident',
    NARADA_SITE_ROOT: boundSiteRoot,
    NARADA_AGENT_CONTEXT_DB: join(foreignSiteRoot, '.ai', 'state', 'agent-context.sqlite'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let foreignDbStderr = '';
foreignDbProc.stderr.setEncoding('utf8');
foreignDbProc.stderr.on('data', (chunk) => { foreignDbStderr += chunk; });
const foreignDbExit = await waitForExit(foreignDbProc);
assert.notEqual(foreignDbExit.code, 0);
assert.match(foreignDbStderr, /agent_context_db_path_outside_site_root/);

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}



