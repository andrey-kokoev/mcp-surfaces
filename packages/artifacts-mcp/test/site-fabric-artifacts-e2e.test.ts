import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const requests: Array<{ method: string; url: string; body: JsonRecord | null }> = [];
const nars = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  const body = raw.trim() ? JSON.parse(raw) as JsonRecord : null;
  requests.push({ method: request.method ?? '', url: request.url ?? '', body });
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.method === 'POST' && request.url === '/sessions/carrier_fixture/artifacts') {
    response.statusCode = 201;
    response.end(JSON.stringify({ artifact: { artifact_id: 'art_fixture', kind: body?.kind, title: body?.title, render_hint: body?.render_hint } }));
    return;
  }
  if (request.method === 'GET' && request.url === '/sessions/carrier_fixture/artifacts') {
    response.end(JSON.stringify({ artifacts: [{ artifact_id: 'art_fixture', kind: 'html' }] }));
    return;
  }
  if (request.method === 'GET' && request.url === '/sessions/carrier_fixture/artifacts/art_fixture') {
    response.end(JSON.stringify({ artifact: { artifact_id: 'art_fixture', kind: 'html', title: 'Fixture report', render_hint: 'inline' } }));
    return;
  }
  if (request.method === 'POST' && request.url === '/sessions/carrier_fixture/artifacts/art_fixture/message') {
    response.statusCode = 201;
    response.end(JSON.stringify({ artifact: { artifact_id: 'art_fixture' }, message_part: { type: 'artifact_ref', artifact_id: 'art_fixture' }, event: { event: 'assistant_message' } }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not_found' }));
});
await new Promise<void>((resolve) => nars.listen(0, '127.0.0.1', resolve));
const address = nars.address();
assert.ok(address && typeof address === 'object');

const siteRoot = createTemporaryE2eRoot('artifacts-site-fabric-e2e');
const artifactPath = `${siteRoot}/report.html`;
writeFileSync(artifactPath, '<h1>Controlled artifact</h1>', 'utf8');
mkdirSync(`${siteRoot}/.narada/crew/nars-sessions/carrier_fixture`, { recursive: true });
writeFileSync(`${siteRoot}/.narada/crew/nars-sessions/carrier_fixture/session-index-record.json`, JSON.stringify({ health_endpoint: `http://127.0.0.1:${address.port}/health` }), 'utf8');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot, '--session-id', 'carrier_fixture', '--nars-base-url', `http://127.0.0.1:${address.port}/`], {
  cwd: siteRoot,
  env: { ...process.env, NARADA_SITE_ROOT: siteRoot },
  label: 'artifacts Site-fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, { expectedServerName: 'artifacts-mcp', requiredTools: ['artifacts_doctor', 'artifact_register_file', 'artifact_list', 'artifact_read', 'artifact_present'] });
  const doctor = structured(await server.client.request(1, 'tools/call', { name: 'artifacts_doctor', arguments: {} }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  const registered = structured(await server.client.request(2, 'tools/call', { name: 'artifact_register_file', arguments: { path: artifactPath, kind: 'html', title: 'Fixture report' } }));
  assert.equal(registered.status, 'registered', JSON.stringify(registered));
  assert.equal((registered.message_part as JsonRecord).artifact_id, 'art_fixture');
  const listed = structured(await server.client.request(3, 'tools/call', { name: 'artifact_list', arguments: {} }));
  assert.equal((listed.index as JsonRecord).artifacts instanceof Array, true, JSON.stringify(listed));
  const read = structured(await server.client.request(4, 'tools/call', { name: 'artifact_read', arguments: { artifact_id: 'art_fixture' } }));
  assert.equal((read.message_part as JsonRecord).artifact_id, 'art_fixture');
  const presented = structured(await server.client.request(5, 'tools/call', { name: 'artifact_present', arguments: { artifact_id: 'art_fixture', text: 'Controlled artifact.' } }));
  assert.equal(presented.status, 'presented', JSON.stringify(presented));
  assert.equal((presented.event as JsonRecord).event, 'assistant_message');
  assert.equal(requests.length, 4);
  console.log(JSON.stringify({ status: 'passed', test_id: 'artifacts.site-fabric.register-read-present', site_root: siteRoot, cleanup: 'pending_until_finally' }));
} finally {
  await server.close();
  await new Promise<void>((resolve) => nars.close(() => resolve()));
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('artifacts Site fabric e2e ok');
