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

const siteRoot = createTemporaryE2eRoot('site-coherence-site-fabric-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'site-coherence.site-fabric.local-cloudflare-comparison.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'site-coherence.site-fabric.local-cloudflare-comparison', authority: 'A0', external_authority: 'not_run' });
const healthFile = join(siteRoot, '.narada', 'site-continuity', 'health', 'cloudflare-continuity-health-last.json');
mkdirSync(join(siteRoot, '.narada', 'site-continuity', 'health'), { recursive: true });
mkdirSync(join(siteRoot, '.narada', 'auth'), { recursive: true });
writeFileSync(join(siteRoot, '.narada', 'auth', 'cloudflare-operator-session.json'), JSON.stringify({ cookie: 'fixture' }), 'utf8');
writeFileSync(join(siteRoot, '.narada', 'site-continuity', 'bindings.json'), JSON.stringify({ bindings: [{ site_id: 'fixture-site', relation_kind: 'same_site_embodiment' }] }), 'utf8');
writeFileSync(healthFile, JSON.stringify({
  status: 'ok',
  continuity_health: { local_sync_status: 'synced', local_inbound_status: 'synced' },
  cloudflare_product_posture: { site_product_overview: { next_action: 'monitor_sites' } },
  cloudflare_product_binding_alignment: { state: 'aligned' },
  scheduler_task_readback: {
    scheduled_task_state: 'Enabled',
    last_run_time: '2026-07-12T00:00:00.000Z',
    last_result: '0',
    next_run_time: '2026-07-12T00:05:00.000Z',
    cadence_status: 'matches_plan',
  },
}), 'utf8');

const worker = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    site: { site_id: 'fixture-site', status: 'ready' },
    site_product_status: { next_action: 'monitor_sites' },
  }));
});
await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
const address = worker.address();
assert.ok(address && typeof address === 'object');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--repo-root', siteRoot, '--worker-url', `http://127.0.0.1:${address.port}`], {
  cwd: siteRoot,
  label: 'site-coherence Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'site-coherence-mcp',
    requiredTools: ['site_coherence_doctor', 'site_coherence_check'],
  });

  const doctor = structured(await server.client.request(1, 'tools/call', { name: 'site_coherence_doctor', arguments: {} }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  const local = structured(await server.client.request(2, 'tools/call', {
    name: 'site_coherence_check',
    arguments: { site_id: 'fixture-site', fetch_cloudflare: false },
  }));
  assert.equal(local.status, 'ok', JSON.stringify(local));
  assert.equal((local.coherence as JsonRecord).state, 'local_only', JSON.stringify(local));

  const combined = structured(await server.client.request(3, 'tools/call', {
    name: 'site_coherence_check',
    arguments: { site_id: 'fixture-site', fetch_cloudflare: true },
  }));
  assert.equal(combined.status, 'ok', JSON.stringify(combined));
  assert.equal((combined.coherence as JsonRecord).state, 'coherent', JSON.stringify(combined));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'site-coherence.site-fabric.local-cloudflare-comparison',
    authority: 'A0',
    external_authority: 'not_run',
    cleanup: 'completed_after_finally',
  }));
  evidence.update({ status: 'passed' });
} finally {
  await server.close();
  await new Promise<void>((resolve) => worker.close(() => resolve()));
  const cleanupOk = removeTemporaryE2eRoot(siteRoot);
  evidence.finalize({ status: cleanupOk ? 'passed' : 'failed', cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}

