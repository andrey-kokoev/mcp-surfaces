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

const siteRoot = createTemporaryE2eRoot('cloudflare-carrier-site-fabric-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'cloudflare-carrier.site-fabric.child-health-product-read.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'cloudflare-carrier.site-fabric.child-health-product-read', authority: 'A0', external_authority: 'not_run' });
const sessionFile = join(siteRoot, '.narada', 'auth', 'cloudflare-operator-session.json');
const healthFile = join(siteRoot, '.narada', 'site-continuity', 'health', 'cloudflare-continuity-health-last.json');
mkdirSync(join(siteRoot, '.narada', 'auth'), { recursive: true });
mkdirSync(join(siteRoot, '.narada', 'site-continuity', 'health'), { recursive: true });
writeFileSync(sessionFile, JSON.stringify({ cookie: 'narada_operator_session=fixture', captured_at: new Date().toISOString() }), 'utf8');
writeFileSync(healthFile, JSON.stringify({
  status: 'ok',
  continuity_health: { local_sync_status: 'synced', local_inbound_status: 'synced' },
  cloudflare_product_posture: { site_product_overview: { next_action: 'monitor_sites' } },
  scheduler_task_readback: { scheduled_task_state: 'Enabled', last_result: '0' },
}), 'utf8');

const requests: JsonRecord[] = [];
const worker = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  const body = raw ? JSON.parse(raw) as JsonRecord : {};
  requests.push(body);
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    status: 'ok',
    operation: body.operation,
    sites: [{ site_id: 'fixture-site', status: 'ready' }],
    site: { site_id: 'fixture-site', status: 'ready' },
  }));
});
await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
const address = worker.address();
assert.ok(address && typeof address === 'object');
const workerUrl = `http://127.0.0.1:${address.port}`;

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [
  serverPath,
  '--repo-root', siteRoot,
  '--worker-url', workerUrl,
  '--session-file', sessionFile,
  '--health-file', healthFile,
], { cwd: siteRoot, label: 'cloudflare-carrier Site fabric e2e' });

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'cloudflare-carrier-mcp',
    requiredTools: ['cloudflare_doctor', 'cloudflare_session_status', 'cloudflare_health', 'cloudflare_product_read'],
  });

  const doctor = structured(await server.client.request(1, 'tools/call', { name: 'cloudflare_doctor', arguments: {} }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  assert.equal(doctor.session_status, 'present', JSON.stringify(doctor));
  assert.equal(doctor.health_status, 'ok', JSON.stringify(doctor));

  const health = structured(await server.client.request(2, 'tools/call', { name: 'cloudflare_health', arguments: {} }));
  assert.equal(health.status, 'ok', JSON.stringify(health));
  assert.equal((health.local as JsonRecord).sync_status, 'synced', JSON.stringify(health));

  const product = structured(await server.client.request(3, 'tools/call', {
    name: 'cloudflare_product_read',
    arguments: { operation: 'site.list', format: 'summary', limit: 5 },
  }));
  assert.equal(product.status, 'ok', JSON.stringify(product));
  assert.equal(requests.length, 1, JSON.stringify(requests));
  assert.equal(requests[0].operation, 'site.list', JSON.stringify(requests));

  const missing = structured(await server.client.request(4, 'tools/call', {
    name: 'cloudflare_session_status',
    arguments: { session_file: join(siteRoot, 'missing-session.json') },
  }));
  assert.equal(missing.status, 'missing', JSON.stringify(missing));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'cloudflare-carrier.site-fabric.child-health-product-read',
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

