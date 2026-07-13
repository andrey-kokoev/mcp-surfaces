import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('nars-session-site-fabric-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'nars-session.site-fabric.discovery-health-refusal.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'nars-session.site-fabric.discovery-health-refusal', authority: 'A0' });
const healthServer = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'healthy', authority_epoch: 3 }));
});
await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
const address = healthServer.address();
assert.ok(address && typeof address === 'object');

const sessionsRoot = `${siteRoot}/.narada/crew/nars-sessions`;
mkdirSync(`${sessionsRoot}/carrier_fixture`, { recursive: true });
writeFileSync(`${sessionsRoot}/index.json`, JSON.stringify({ sessions: [{ session_id: 'carrier_fixture', site_id: 'fixture-site' }] }), 'utf8');
writeFileSync(`${sessionsRoot}/carrier_fixture/session-index-record.json`, JSON.stringify({
  session_id: 'carrier_fixture',
  site_id: 'fixture-site',
  site_root: siteRoot,
  runtime_kind: 'nars',
  authority_epoch: 3,
  authority_runtime_id: 'authority_fixture',
  source_write_admission: 'active',
  health_endpoint: `http://127.0.0.1:${address.port}/health`,
}), 'utf8');

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath], {
  cwd: siteRoot,
  env: {
    ...process.env,
    NARADA_SITE_ROOT: siteRoot,
    NARADA_SITE_ID: 'fixture-site',
    NARADA_AGENT_ID: 'fixture-agent',
    NARADA_CARRIER_SESSION_ID: 'carrier_fixture',
  },
  label: 'nars-session Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'nars-session-mcp',
    requiredTools: ['nars_session_list', 'nars_session_show', 'nars_session_input_deliver', 'nars_session_input_status'],
  });

  const listed = structured(await server.client.request(1, 'tools/call', {
    name: 'nars_session_list',
    arguments: { include_health: true, limit: 5 },
  }));
  assert.equal(listed.status, 'ok', JSON.stringify(listed));
  assert.equal(listed.count, 1, JSON.stringify(listed));
  assert.equal(((listed.sessions as JsonRecord[])[0].health as JsonRecord).status, 'healthy', JSON.stringify(listed));

  const shown = structured(await server.client.request(2, 'tools/call', {
    name: 'nars_session_show',
    arguments: { session_id: 'carrier_fixture', include_health: true },
  }));
  assert.equal(shown.status, 'ok', JSON.stringify(shown));
  assert.equal((shown.session as JsonRecord).session_id, 'carrier_fixture', JSON.stringify(shown));
  assert.equal((shown.authority as JsonRecord).authority_epoch, 3, JSON.stringify(shown));

  const refused = await server.client.request(3, 'tools/call', {
    name: 'nars_session_input_deliver',
    arguments: { session_id: 'carrier_fixture', delivery: 'enqueue', content: 'fixture', idempotency_key: 'fixture-key' },
  });
  assert.equal((refused.error?.data as JsonRecord)?.code, 'session_event_endpoint_missing', JSON.stringify(refused));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'nars-session.site-fabric.discovery-health-refusal',
    authority: 'A0',
    mutation_performed: false,
    cleanup: 'completed_after_finally',
  }));
  evidence.update({ status: 'passed' });
} finally {
  await server.close();
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  const cleanupOk = removeTemporaryE2eRoot(siteRoot);
  evidence.finalize({ status: cleanupOk ? 'passed' : 'failed', cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}

