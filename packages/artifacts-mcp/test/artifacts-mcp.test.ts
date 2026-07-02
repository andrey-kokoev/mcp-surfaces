import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactMessagePartCreate,
  artifactPresent,
  artifactRegisterFile,
  artifactRead,
  artifactsDoctor,
  createServerState,
  handleRequest,
  listTools
} from '../src/main.js';

const requests: Array<{ method: string; url: string; body: any }> = [];
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  const body = raw.trim() ? JSON.parse(raw) : null;
  requests.push({ method: request.method ?? '', url: request.url ?? '', body });
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.method === 'POST' && request.url === '/sessions/carrier_test/artifacts') {
    response.statusCode = 201;
    response.end(JSON.stringify({ schema: 'narada.nars.artifact_registered.v1', artifact: { artifact_id: 'art_html_1', kind: 'html', title: body.title, render_hint: body.render_hint } }));
    return;
  }
  if (request.method === 'POST' && request.url === '/sessions/carrier_test/artifacts/art_html_1/message') {
    response.statusCode = 201;
    response.end(JSON.stringify({
      schema: 'narada.nars.artifact_message_presented.v1',
      status: 'presented',
      artifact: { artifact_id: 'art_html_1', kind: 'html', title: 'HTML report', render_hint: 'inline' },
      message_part: { type: 'artifact_ref', artifact_id: 'art_html_1', kind: 'html', title: 'HTML report', render_hint: 'inline' },
      event: { event: 'assistant_message', content: [{ type: 'text', text: body.text }, { type: 'artifact_ref', artifact_id: 'art_html_1', kind: 'html' }] }
    }));
    return;
  }
  if (request.method === 'GET' && request.url === '/sessions/carrier_test/artifacts/art_html_1') {
    response.end(JSON.stringify({ schema: 'narada.nars.artifact_read.v1', artifact: { artifact_id: 'art_html_1', kind: 'html', title: 'HTML report', render_hint: 'inline' } }));
    return;
  }
  if (request.method === 'GET' && request.url === '/sessions/carrier_test/artifacts') {
    response.end(JSON.stringify({ schema: 'narada.nars.artifact_index.v1', artifacts: [{ artifact_id: 'art_html_1', kind: 'html' }] }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not_found', message: 'not found' }));
});

let siteRoot: string | null = null;
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const state = createServerState({ narsBaseUrl: `http://127.0.0.1:${address.port}/`, sessionId: 'carrier_test' });
  siteRoot = mkdtempSync(join(tmpdir(), 'artifacts-mcp-site-'));
  const sessionDir = join(siteRoot, '.narada', 'crew', 'nars-sessions', 'carrier_test');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session-index-record.json'), JSON.stringify({ health_endpoint: `http://127.0.0.1:${address.port}/health` }), 'utf8');

  assert.equal(artifactsDoctor(state).status, 'ok');
  assert.equal(artifactsDoctor(state).discovery && (artifactsDoctor(state).discovery as Record<string, unknown>).source, 'option:narsBaseUrl');
  assert.deepEqual(listTools().map((tool) => tool.name), ['artifacts_guidance', 'artifacts_doctor', 'artifact_register_file', 'artifact_list', 'artifact_read', 'artifact_present', 'artifact_message_part_create']);

  const registered = await artifactRegisterFile({ path: 'D:/code/site/.ai/report.html', kind: 'html', title: 'HTML report' }, state);
  assert.equal(registered.status, 'registered');
  assert.equal((registered.message_part as Record<string, unknown>).type, 'artifact_ref');
  assert.equal((registered.message_part as Record<string, unknown>).artifact_id, 'art_html_1');
  assert.equal((registered.message_part as Record<string, unknown>).kind, 'html');
  assert.deepEqual(registered.assistant_content_parts, [registered.message_part]);
  assert.equal(registered.operator_message, 'Artifact ready: HTML report');
  assert.equal(registered.content_url, `http://127.0.0.1:${address.port}/sessions/carrier_test/artifacts/art_html_1/content`);
  assert.equal(requests[0].url, '/sessions/carrier_test/artifacts');
  assert.deepEqual(requests[0].body, { source_path: 'D:/code/site/.ai/report.html', kind: 'html', title: 'HTML report', render_hint: 'inline' });

  const read = await artifactRead({ artifact_id: 'art_html_1' }, state);
  assert.equal((read.message_part as Record<string, unknown>).title, 'HTML report');
  assert.deepEqual(read.assistant_content_parts, [read.message_part]);

  const presented = await artifactPresent({ artifact_id: 'art_html_1', text: 'Here is the report.' }, state);
  assert.equal(presented.status, 'presented');
  assert.equal((presented.message_part as Record<string, unknown>).artifact_id, 'art_html_1');
  assert.equal((presented.event as Record<string, unknown>).event, 'assistant_message');

  const part = artifactMessagePartCreate({ artifact_id: 'art_html_1', kind: 'html', title: 'HTML report' });
  assert.deepEqual(part.message_part, { type: 'artifact_ref', artifact_id: 'art_html_1', kind: 'html', title: 'HTML report', render_hint: 'inline' });
  assert.equal(part.verification_status, 'unverified');
  assert.deepEqual(part.assistant_content_parts, [part.message_part]);

  const discoveredState = createServerState({ siteRoot, sessionId: 'carrier_test' });
  assert.equal(artifactsDoctor(discoveredState).registration_configured, true);
  assert.equal((artifactsDoctor(discoveredState).discovery as Record<string, unknown>).source, 'session_index');
  const discovered = await artifactRegisterFile({ path: 'D:/code/site/.ai/report.html', kind: 'html', title: 'Discovered report' }, discoveredState);
  assert.equal(discovered.content_url, `http://127.0.0.1:${address.port}/sessions/carrier_test/artifacts/art_html_1/content`);

  const envState = createServerState({ session_id: 'legacy', sessionId: 'canonical' });
  assert.equal(envState.sessionId, 'canonical');

  const doctor = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'artifacts_doctor', arguments: {} } }, state);
  assert.equal(doctor?.result.structuredContent.registration_configured, true);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (siteRoot) rmSync(siteRoot, { recursive: true, force: true });
}

console.log('artifacts-mcp tests passed');
