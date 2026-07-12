import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('surface-feedback-site-fabric-e2e');
mkdirSync(`${siteRoot}/.ai`, { recursive: true });
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [
  serverPath,
  '--feedback-root', siteRoot,
  '--canonical-feedback-root', siteRoot,
  '--task-lifecycle-root', siteRoot,
  '--site-id', 'fixture-site',
  '--owned-surface-id', 'surface-feedback',
], {
  cwd: siteRoot,
  env: { ...process.env, NARADA_AGENT_ID: 'fixture.architect', NARADA_SITE_ROOT: siteRoot },
  label: 'surface-feedback Site-fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'surface-feedback-mcp',
    requiredTools: ['surface_feedback_doctor', 'surface_feedback_submit', 'surface_feedback_convert_to_task', 'surface_feedback_list'],
  });

  const doctor = structured(await server.client.request(1, 'tools/call', { name: 'surface_feedback_doctor', arguments: {} }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  assert.equal((doctor.authority as JsonRecord).site_id, 'fixture-site');

  const submitted = structured(await server.client.request(2, 'tools/call', {
    name: 'surface_feedback_submit',
    arguments: {
      surface_id: 'surface-feedback',
      submitter_site_id: 'fixture-site',
      submitter_principal: 'fixture.architect',
      kind: 'bug',
      summary: 'Nested child conversion fixture',
      details: 'The feedback child must hand off to its actual task-lifecycle child.',
    },
  }));
  assert.match(String(submitted.feedback_id), /^sfb_/);

  const converted = structured(await server.client.request(3, 'tools/call', {
    name: 'surface_feedback_convert_to_task',
    arguments: { feedback_id: submitted.feedback_id },
  }));
  assert.equal(converted.status, 'converted', JSON.stringify(converted));
  assert.ok(Number(converted.task_number) > 0, JSON.stringify(converted));

  const duplicate = structured(await server.client.request(4, 'tools/call', {
    name: 'surface_feedback_convert_to_task',
    arguments: { feedback_id: submitted.feedback_id },
  }));
  assert.equal(duplicate.status, 'already_linked', JSON.stringify(duplicate));
  assert.equal(duplicate.task_number, converted.task_number);

  const listed = structured(await server.client.request(5, 'tools/call', {
    name: 'surface_feedback_list',
    arguments: { status: 'converted_to_task', limit: 10 },
  }));
  assert.equal(listed.count, 1, JSON.stringify(listed));

  console.log(JSON.stringify({ status: 'passed', test_id: 'surface-feedback.site-fabric.feedback-to-task', site_root: siteRoot, task_number: converted.task_number, cleanup: 'pending_until_finally' }));
} finally {
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('surface-feedback Site fabric e2e ok');
