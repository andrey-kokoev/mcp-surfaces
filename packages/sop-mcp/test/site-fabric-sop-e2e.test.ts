import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('sop-site-fabric-e2e');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--sop-root', siteRoot], {
  cwd: siteRoot,
  env: siteFabricChildEnv(siteRoot, { NARADA_SITE_ID: 'fixture-site' }),
  label: 'sop Site-fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'sop-mcp',
    requiredTools: ['sop_template_create', 'sop_run_start', 'sop_run_status', 'sop_run_advance', 'sop_run_events'],
  });
  const created = structured(await server.client.request(1, 'tools/call', {
    name: 'sop_template_create',
    arguments: {
      sop_id: 'site-fabric-sop',
      title: 'Site Fabric SOP',
      description: 'Durability fixture for a Site-bound SOP run.',
      steps: [
        { id: 'operator_gate', executor: 'operator', blocking: true, title: 'Operator gate', instructions: 'Confirm the controlled fixture.', depends_on: [] },
        { id: 'record_result', executor: 'engine', blocking: false, title: 'Record result', instructions: 'Record the completed fixture.', depends_on: ['operator_gate'] },
      ],
      trigger_kind: 'manual',
      acceptance_criteria: ['The run completes after the operator gate.'],
      evidence_requirements: ['MCP child result'],
    },
  }));
  assert.equal(created.status, 'created', JSON.stringify(created));

  const started = structured(await server.client.request(2, 'tools/call', {
    name: 'sop_run_start',
    arguments: { sop_id: 'site-fabric-sop', triggered_by: 'fixture-agent' },
  }));
  const runId = String(started.run_id);
  assert.match(runId, /^sop_run_/);
  assert.equal(started.status, 'awaiting_confirmation', JSON.stringify(started));

  const beforeRestart = structured(await server.client.request(3, 'tools/call', { name: 'sop_run_status', arguments: { run_id: runId } }));
  assert.equal(beforeRestart.status, 'awaiting_confirmation', JSON.stringify(beforeRestart));
  await server.close();

  const resumedServer = spawnJsonlMcpServer(process.execPath, [serverPath, '--sop-root', siteRoot], {
    cwd: siteRoot,
    env: siteFabricChildEnv(siteRoot, { NARADA_SITE_ID: 'fixture-site' }),
    label: 'sop Site-fabric resume e2e',
  });
  try {
    await runMcpProtocolSmoke(resumedServer.client, { expectedServerName: 'sop-mcp', requiredTools: ['sop_run_status', 'sop_run_advance', 'sop_run_events'] });
    const resumed = structured(await resumedServer.client.request(4, 'tools/call', { name: 'sop_run_status', arguments: { run_id: runId } }));
    assert.equal(resumed.status, 'awaiting_confirmation', JSON.stringify(resumed));
    const advanced = structured(await resumedServer.client.request(5, 'tools/call', {
      name: 'sop_run_advance',
      arguments: { run_id: runId, step_id: 'operator_gate', result: { confirmed: true } },
    }));
    assert.equal(advanced.status, 'completed', JSON.stringify(advanced));
    const events = structured(await resumedServer.client.request(6, 'tools/call', { name: 'sop_run_events', arguments: { run_id: runId, limit: 20 } }));
    assert.ok(Number(events.count ?? (events.items as unknown[]).length) >= 2, JSON.stringify(events));
  } finally {
    await resumedServer.close();
  }

  console.log(JSON.stringify({ status: 'passed', test_id: 'sop.site-fabric.durable-run-resume', site_root: siteRoot, run_id: runId, cleanup: 'pending_until_finally' }));
} finally {
  await server.close().catch(() => undefined);
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('sop Site fabric e2e ok');
