import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('site-inbox-site-fabric-e2e');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  env: siteFabricChildEnv(siteRoot, { NARADA_SITE_ID: 'fixture-site' }),
  label: 'site-inbox site-fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  return (response.result as JsonRecord)?.structuredContent as JsonRecord ?? response.result as JsonRecord;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'narada-site-inbox-mcp',
    requiredTools: ['inbox_submit', 'inbox_list', 'inbox_show', 'inbox_acknowledge', 'inbox_output_show'],
  });

  const submitted = structured(await server.client.request(1, 'tools/call', {
    name: 'inbox_submit',
    arguments: {
      kind: 'incident',
      title: 'Site fabric inbox fixture',
      summary: 'Prove the child owns the selected Site inbox.',
      principal: 'fixture-agent',
      target_role: 'architect',
      payload: { fixture: true, detail: 'bounded site-owned payload' },
    },
  }));
  assert.equal(submitted.status, 'admitted', JSON.stringify(submitted));
  const envelopeId = String(submitted.envelope_id);
  assert.match(envelopeId, /^env_/);
  assert.equal(existsSync(String(submitted.envelope_path)), true);

  const listed = structured(await server.client.request(2, 'tools/call', {
    name: 'inbox_list',
    arguments: { kind: 'incident', target_role: 'architect', limit: 10 },
  }));
  assert.equal(listed.count, 1, JSON.stringify(listed));
  assert.equal((listed.envelopes as JsonRecord[])[0]?.envelope_id, envelopeId);

  const shown = structured(await server.client.request(3, 'tools/call', {
    name: 'inbox_show',
    arguments: { envelope_id: envelopeId },
  }));
  assert.equal((shown.envelope as JsonRecord).status, 'received', JSON.stringify(shown));
  const shownPayload = (shown.envelope as JsonRecord).payload as JsonRecord;
  assert.equal((shownPayload.payload as JsonRecord).fixture, true, JSON.stringify(shown));

  const acknowledged = structured(await server.client.request(4, 'tools/call', {
    name: 'inbox_acknowledge',
    arguments: { envelope_id: envelopeId, principal: 'fixture-operator', reason: 'Controlled Site-fabric acknowledgment.' },
  }));
  assert.equal(acknowledged.status, 'acknowledged', JSON.stringify(acknowledged));

  const duplicateAcknowledged = structured(await server.client.request(5, 'tools/call', {
    name: 'inbox_acknowledge',
    arguments: { envelope_id: envelopeId, principal: 'fixture-operator', reason: 'Repeat acknowledgment is idempotent for the fixture.' },
  }));
  assert.equal(duplicateAcknowledged.status, 'acknowledged', JSON.stringify(duplicateAcknowledged));

  const final = structured(await server.client.request(6, 'tools/call', {
    name: 'inbox_show',
    arguments: { envelope_id: envelopeId },
  }));
  assert.equal((final.envelope as JsonRecord).status, 'acknowledged', JSON.stringify(final));

  const audit = structured(await server.client.request(7, 'tools/call', {
    name: 'inbox_audit',
    arguments: { envelope_id: envelopeId, limit: 10 },
  }));
  assert.ok(Number(audit.count) >= 2, JSON.stringify(audit));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'site-inbox.site-fabric.admission-and-acknowledgment',
    site_root: siteRoot,
    envelope_id: envelopeId,
    cleanup: 'pending_until_finally',
  }));
} finally {
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('site-inbox Site fabric e2e ok');
