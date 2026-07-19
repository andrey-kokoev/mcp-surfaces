import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  removeTemporaryE2eRoot,
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('runtime-introspection-site-fabric-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'runtime-introspection.site-fabric.child-analysis-readback.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'runtime-introspection.site-fabric.child-analysis-readback', authority: 'A0', external_authority: 'not_run', runtime_boundary: 'controlled_fixture_event_log' });
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath], {
  cwd: siteRoot,
  env: siteFabricChildEnv(siteRoot, { NARADA_SITE_ROOT: siteRoot }),
  label: 'runtime-introspection Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

const events = [
  {
    event_id: 'evt_fixture_1',
    timestamp: '2026-07-12T00:00:00.000Z',
    input_adapter: 'narada-agent-cli-mcp-client',
    kind: 'tool_call',
    status: 'ok',
    surface_id: 'local-filesystem',
    tool_name: 'fs_stat',
    duration_ms: 12,
    message: 'bounded stat',
  },
  {
    event_id: 'evt_fixture_2',
    timestamp: '2026-07-12T00:00:00.100Z',
    input_adapter: 'narada-agent-cli-mcp-client',
    kind: 'tool_result',
    status: 'ok',
    surface_id: 'local-filesystem',
    tool_name: 'fs_stat',
    duration_ms: 18,
    message: 'returned metadata',
  },
  {
    event_id: 'evt_fixture_3',
    timestamp: '2026-07-12T00:00:00.200Z',
    input_adapter: 'narada-agent-cli-mcp-client',
    kind: 'error',
    status: 'refused',
    surface_id: 'structured-command',
    tool_name: 'structured_command_execute',
    duration_ms: 4,
    message: 'command not admitted',
  },
];

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'runtime-introspection-mcp',
    requiredTools: ['runtime_introspection_formats', 'runtime_introspection_analyze_trace', 'runtime_introspection_top', 'runtime_introspection_show', 'runtime_introspection_show_event'],
  });

  const formats = structured(await server.client.request(1, 'tools/call', {
    name: 'runtime_introspection_formats',
    arguments: {},
  }));
  assert.equal(formats.status, 'ok', JSON.stringify(formats));

  const analyzed = structured(await server.client.request(2, 'tools/call', {
    name: 'runtime_introspection_analyze_trace',
    arguments: { format: 'generic-events', events },
  }));
  assert.equal(analyzed.status, 'analyzed', JSON.stringify(analyzed));
  assert.equal((analyzed.summary as JsonRecord).event_count, 3, JSON.stringify(analyzed));
  assert.equal((analyzed.summary as JsonRecord).refused_count, 1, JSON.stringify(analyzed));

  const top = structured(await server.client.request(3, 'tools/call', {
    name: 'runtime_introspection_top',
    arguments: { analysis: analyzed, dimension: 'surface', limit: 5 },
  }));
  assert.equal(top.status, 'ok', JSON.stringify(top));
  assert.ok(Array.isArray(top.items), JSON.stringify(top));

  const shown = structured(await server.client.request(4, 'tools/call', {
    name: 'runtime_introspection_show',
    arguments: { analysis: analyzed, view: 'errors', limit: 5 },
  }));
  assert.equal(shown.status, 'ok', JSON.stringify(shown));
  assert.ok(Array.isArray(shown.data), JSON.stringify(shown));

  const event = structured(await server.client.request(5, 'tools/call', {
    name: 'runtime_introspection_show_event',
    arguments: { analysis: analyzed, event_id: 'evt_fixture_3' },
  }));
  assert.equal(event.status, 'ok', JSON.stringify(event));
  assert.equal((event.event as JsonRecord).event_id, 'evt_fixture_3', JSON.stringify(event));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'runtime-introspection.site-fabric.child-analysis-readback',
    authority: 'A0',
    external_authority: 'not_run',
    runtime_boundary: 'controlled_fixture_event_log',
    cleanup: 'completed_after_finally',
  }));
  evidence.update({ status: 'passed' });
} finally {
  await server.close();
  const cleanupOk = removeTemporaryE2eRoot(siteRoot);
  evidence.finalize({ status: cleanupOk ? 'passed' : 'failed', cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}

