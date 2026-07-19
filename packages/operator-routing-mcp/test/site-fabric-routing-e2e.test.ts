import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('operator-routing-site-fabric-e2e');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  env: siteFabricChildEnv(siteRoot, { NARADA_SITE_ID: 'fixture-user-site' }),
  label: 'operator-routing Site-fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'operator-routing-mcp',
    requiredTools: ['operator_route_doctor', 'operator_route_request'],
  });
  const doctor = structured(await server.client.request(1, 'tools/call', { name: 'operator_route_doctor', arguments: {} }));
  assert.equal(doctor.direct_delivery_supported, false, JSON.stringify(doctor));
  const routed = structured(await server.client.request(2, 'tools/call', {
    name: 'operator_route_request',
    arguments: {
      transcript: 'Please inspect the pending task.',
      target_runtime: 'codex',
      target_identity: 'fixture.builder',
      speaker_agent_id: 'fixture.operator',
      allow_inbox_fallback: true,
      request_id: 'route_site_fabric_fixture',
    },
  }));
  assert.equal(routed.status, 'drafted_for_site_inbox', JSON.stringify(routed));
  assert.equal((routed.inbox_envelope as JsonRecord).kind, 'command_request');
  assert.equal((routed.spoken_acknowledgement as JsonRecord).model, 'tts-1');
  assert.equal((routed.spoken_acknowledgement as JsonRecord).voice, 'nova');
  const logPath = String(routed.log_path);
  assert.equal(existsSync(logPath), true);
  const log = JSON.parse(readFileSync(logPath, 'utf8').trim()) as JsonRecord;
  assert.equal(log.request_id, 'route_site_fabric_fixture');
  assert.equal(log.direct_delivery_attempted, false);

  console.log(JSON.stringify({ status: 'passed', test_id: 'operator-routing.site-fabric.fallback-and-durable-log', site_root: siteRoot, cleanup: 'pending_until_finally' }));
} finally {
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('operator-routing Site fabric e2e ok');
