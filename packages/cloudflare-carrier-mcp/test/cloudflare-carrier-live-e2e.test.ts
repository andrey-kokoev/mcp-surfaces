import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asRecord,
  installE2eArtifactRecorder,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  structured,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const TEST_ID = 'cloudflare-carrier.live-e2e';
const DEFAULT_WORKER_URL = 'https://narada-cloudflare-carrier.andrei-kokoev.workers.dev';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const naradaRoot = resolve(process.env.NARADA_E2E_NARADA_ROOT ?? 'D:/code/narada');
const workerUrl = (process.env.CLOUDFLARE_CARRIER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, '');
const sessionFile = process.env.CLOUDFLARE_CARRIER_OPERATOR_SESSION_FILE
  ?? join(naradaRoot, '.narada', 'auth', 'cloudflare-operator-session.json');
const healthFile = process.env.CLOUDFLARE_CARRIER_HEALTH_FILE
  ?? join(naradaRoot, '.narada', 'site-continuity', 'health', 'cloudflare-continuity-health-last.json');
const siteIdOverride = process.env.CLOUDFLARE_CARRIER_SITE_ID ?? null;
const liveRequested = process.env.NARADA_E2E_CLOUDFLARE_CARRIER_LIVE === '1';
const resultPath = join(packageRoot, '.tmp', 'e2e-results', `${TEST_ID}.json`);
const evidence = installE2eArtifactRecorder(resultPath, {
  test_id: TEST_ID,
  authority: 'A2',
  external_authority: liveRequested ? 'requested' : 'not_run',
});

type OutcomeStatus = 'passed' | 'failed' | 'not_run';

let outcomeStatus: OutcomeStatus = 'failed';
let outcomeDetails: JsonRecord = {};
let primaryServer: ReturnType<typeof spawnJsonlMcpServer> | null = null;
let unauthorizedServer: ReturnType<typeof spawnJsonlMcpServer> | null = null;

function callResult(response: Awaited<ReturnType<ReturnType<typeof spawnJsonlMcpServer>['client']['request']>>, label: string): JsonRecord {
  assert.equal(response.error, undefined, `${label}: ${JSON.stringify(response)}`);
  return structured(response);
}

function siteIdFromProduct(product: JsonRecord): string | null {
  if (siteIdOverride) return siteIdOverride;
  const response = asRecord(product.response);
  const overview = asRecord(response.site_product_overview);
  const candidates = [response.sites, response.site_records, overview.sites];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const first = candidate
      .map((value) => asRecord(value))
      .map((value) => value.site_id ?? value.id)
      .find((value) => typeof value === 'string' && value.length > 0);
    if (typeof first === 'string') return first;
  }
  return null;
}

function emit(status: OutcomeStatus, details: JsonRecord = {}): void {
  outcomeStatus = status;
  outcomeDetails = details;
  evidence.update({ status, ...details });
  console.log(JSON.stringify({
    status,
    test_id: TEST_ID,
    authority: 'A2',
    worker_url: workerUrl,
    ...details,
  }));
}

async function closeServer(handle: ReturnType<typeof spawnJsonlMcpServer> | null): Promise<boolean> {
  if (!handle) return true;
  try {
    await handle.close();
    return handle.child.exitCode !== null || handle.child.signalCode !== null;
  } catch (error) {
    console.error(JSON.stringify({ test_id: TEST_ID, cleanup_error: String(error) }));
    return false;
  }
}

async function main(): Promise<void> {
  const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
  if (!existsSync(serverPath)) {
    emit('not_run', { reason_code: 'built_entrypoint_missing', missing_path: serverPath });
    process.exitCode = 2;
    return;
  }

  try {
    primaryServer = spawnJsonlMcpServer(process.execPath, [
      serverPath,
      '--repo-root', naradaRoot,
      '--worker-url', workerUrl,
      '--session-file', sessionFile,
      '--health-file', healthFile,
    ], {
      cwd: naradaRoot,
      timeoutMs: 30_000,
      label: TEST_ID,
    });

    await runMcpProtocolSmoke(primaryServer.client, {
      expectedServerName: 'cloudflare-carrier-mcp',
      requiredTools: ['cloudflare_doctor', 'cloudflare_session_status', 'cloudflare_health', 'cloudflare_product_read'],
    });

    const doctor = callResult(await primaryServer.client.request(3, 'tools/call', {
      name: 'cloudflare_doctor',
      arguments: {},
    }), 'cloudflare_doctor');
    const session = callResult(await primaryServer.client.request(4, 'tools/call', {
      name: 'cloudflare_session_status',
      arguments: {},
    }), 'cloudflare_session_status');
    const health = callResult(await primaryServer.client.request(5, 'tools/call', {
      name: 'cloudflare_health',
      arguments: {},
    }), 'cloudflare_health');

    const readiness = {
      doctor_status: doctor.status,
      worker_url: doctor.worker_url,
      session_status: session.status,
      session_fresh: session.is_fresh,
      health_status: doctor.health_status,
      health_snapshot_status: health.status,
    };

    if (!liveRequested) {
      emit('not_run', {
        reason_code: 'live_authority_not_enabled',
        missing_prerequisites: ['NARADA_E2E_CLOUDFLARE_CARRIER_LIVE=1'],
        readiness,
      });
      process.exitCode = 2;
      return;
    }

    const missingPrerequisites = [
      ['operator_session_missing', session.status === 'present'],
      ['operator_session_stale', session.is_fresh === true],
      ['worker_url_missing', typeof workerUrl === 'string' && workerUrl.length > 0],
    ].filter(([, satisfied]) => !satisfied).map(([reason]) => reason);
    if (missingPrerequisites.length > 0) {
      emit('not_run', {
        reason_code: 'live_cloudflare_prerequisite_unavailable',
        missing_prerequisites: missingPrerequisites,
        readiness,
      });
      process.exitCode = 2;
      return;
    }

    const product = callResult(await primaryServer.client.request(6, 'tools/call', {
      name: 'cloudflare_product_read',
      arguments: { operation: 'site.list', format: 'json', limit: 10 },
    }), 'cloudflare_product_read.site.list');
    assert.equal(product.status, 'ok', JSON.stringify(product));
    assert.equal(product.operation, 'site.list', JSON.stringify(product));
    assert.equal(product.has_session, true, JSON.stringify(product));

    const siteId = siteIdFromProduct(product);
    assert.ok(siteId, JSON.stringify({ product, reason: 'site_id_not_discoverable' }));
    const site = callResult(await primaryServer.client.request(7, 'tools/call', {
      name: 'cloudflare_product_read',
      arguments: { operation: 'site.read', site_id: siteId, format: 'summary' },
    }), 'cloudflare_product_read.site.read');
    assert.equal(site.status, 'ok', JSON.stringify(site));
    assert.equal(site.operation, 'site.read', JSON.stringify(site));

    const operations = callResult(await primaryServer.client.request(8, 'tools/call', {
      name: 'cloudflare_product_read',
      arguments: { operation: 'operation.list', site_id: siteId, format: 'summary', limit: 10 },
    }), 'cloudflare_product_read.operation.list');
    assert.equal(operations.status, 'ok', JSON.stringify(operations));
    assert.equal(operations.operation, 'operation.list', JSON.stringify(operations));

    const missingSessionFile = join(tmpdir(), `${TEST_ID.replace(/[^A-Za-z0-9._-]/g, '-')}-${process.pid}-missing-session.json`);
    unauthorizedServer = spawnJsonlMcpServer(process.execPath, [
      serverPath,
      '--repo-root', naradaRoot,
      '--worker-url', workerUrl,
      '--session-file', missingSessionFile,
      '--health-file', healthFile,
    ], {
      cwd: naradaRoot,
      timeoutMs: 30_000,
      label: `${TEST_ID}.unauthorized`,
    });
    await runMcpProtocolSmoke(unauthorizedServer.client, {
      expectedServerName: 'cloudflare-carrier-mcp',
      requiredTools: ['cloudflare_product_read'],
      initializeId: 20,
      toolsListId: 21,
    });
    const unauthorized = await unauthorizedServer.client.request(22, 'tools/call', {
      name: 'cloudflare_product_read',
      arguments: { operation: 'site.list', format: 'summary', limit: 1 },
    });
    assert.ok(unauthorized.error, JSON.stringify(unauthorized));
    assert.match(String(unauthorized.error?.message), /401|unauthorized/i, JSON.stringify(unauthorized));

    emit('passed', {
      site_id: siteId,
      checks: ['protocol_child', 'health_read', 'authenticated_site_list', 'authenticated_site_read', 'authenticated_operation_list', 'unauthorized_refusal'],
      readiness,
      cleanup: 'pending_finally',
    });
  } finally {
    const unauthorizedCleanup = await closeServer(unauthorizedServer);
    const primaryCleanup = await closeServer(primaryServer);
    const cleanupOk = unauthorizedCleanup && primaryCleanup;
    const finalStatus: OutcomeStatus = cleanupOk ? outcomeStatus : 'failed';
    evidence.finalize({
      status: finalStatus,
      ...outcomeDetails,
      cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed', primary_server: primaryCleanup, unauthorized_server: unauthorizedCleanup },
    });
    if (!cleanupOk) process.exitCode = 1;
  }
}

await main();
