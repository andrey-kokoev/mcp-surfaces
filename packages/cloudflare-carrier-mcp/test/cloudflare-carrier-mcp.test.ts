#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServerState, handleRequest } from '../src/main.js';


const root = join(tmpdir(), `cloudflare-carrier-mcp-${randomUUID()}`);
mkdirSync(root, { recursive: true });
mkdirSync(join(root, '.narada', 'auth'), { recursive: true });
mkdirSync(join(root, '.narada', 'site-continuity', 'health'), { recursive: true });

writeFileSync(join(root, '.narada', 'auth', 'cloudflare-operator-session.json'), JSON.stringify({
  cookie: 'narada_operator_session=test_cookie_value_abc123',
  captured_at: new Date().toISOString(),
  worker_url: 'https://cloudflare.example.test',
}));

writeFileSync(join(root, '.narada', 'site-continuity', 'health', 'cloudflare-continuity-health-last.json'), JSON.stringify({
  schema: 'narada.cloudflare_carrier.site_continuity_scheduled_health_snapshot.v1',
  status: 'ok',
  generated_at: new Date().toISOString(),
  continuity_health: {
    local_sync_status: 'synced',
    local_sync_artifact_count: 2,
    local_inbound_status: 'synced',
    local_inbound_artifact_count: 2,
    reconciliation_execution_status: 'completed',
    reconciliation_execution_plan_status: 'ready',
  },
  cloudflare_product_posture: {
    state: 'loaded',
    status: 'ok',
    site_product_overview: {
      site_count: 2,
      health_counts: { ready: 2 },
      next_action: 'monitor_sites',
      next_reason: 'all_sites_monitoring',
    },
    site_posture_route: {
      next_action: 'monitor_sites',
    },
  },
  cloudflare_product_binding_alignment: {
    state: 'aligned',
    status: 'ok',
    reason: 'all_sites_monitoring',
    local_site_count: 2,
    cloudflare_product_next_action: 'monitor_sites',
  },
  scheduler_task_readback: {
    scheduled_task_state: 'Enabled',
    last_run_time: '6/11/2026 10:39:01 PM',
    last_result: '0',
    next_run_time: '6/11/2026 10:44:00 PM',
    cadence_status: 'matches_plan',
  },
}));

const state = createServerState({ repoRoot: root, workerUrl: 'https://cloudflare.example.test' });

const doctor = await handleRequest({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'cloudflare_doctor', arguments: {} },
}, state);
assert.equal(doctor.error, undefined);
const doctorContent = (doctor.result as any).structuredContent;
assert.equal(doctorContent.repo_root, root.replace(/\\/g, '/'));
assert.equal(doctorContent.worker_url, 'https://cloudflare.example.test');
assert.equal(doctorContent.health_file_exists, true);
assert.equal(doctorContent.health_status, 'ok');
assert.equal(doctorContent.operator_action, null);

const siteBoundState = createServerState({
  repoRoot: root,
  site_root: root,
  workerUrl: 'https://cloudflare.example.test',
});
const siteBoundDoctor = await handleRequest({
  jsonrpc: '2.0', id: 11, method: 'tools/call',
  params: { name: 'cloudflare_doctor', arguments: {} },
}, siteBoundState);
assert.equal(
  (siteBoundDoctor.result as any).structuredContent.projection_registry_root,
  join(root, '.narada', 'crew', 'nars-projections').replace(/\\/g, '/'),
);

const sessionStatus = await handleRequest({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'cloudflare_session_status', arguments: {} },
}, state);
assert.equal(sessionStatus.error, undefined);
const sessionContent = (sessionStatus.result as any).structuredContent;
assert.equal(sessionContent.status, 'present');
assert.equal(sessionContent.has_cookie, true);
assert.equal(sessionContent.age_minutes, 0);
assert.equal(sessionContent.is_fresh, true);

const missingSession = await handleRequest({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'cloudflare_session_status', arguments: { session_file: join(root, 'nonexistent.json') } },
}, state);
assert.equal((missingSession.result as any).structuredContent.status, 'missing');

const sessionFile = join(root, '.narada', 'auth', 'cloudflare-operator-session.json');
writeFileSync(sessionFile, JSON.stringify({
  cookie: 'narada_operator_session=old_cookie_value',
  captured_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  worker_url: 'https://cloudflare.example.test',
}));
const staleMtime = new Date(Date.now() - 2 * 60 * 60 * 1000);
utimesSync(sessionFile, staleMtime, staleMtime);
const staleDoctor = await handleRequest({
  jsonrpc: '2.0', id: 31, method: 'tools/call',
  params: { name: 'cloudflare_doctor', arguments: {} },
}, state);
assert.equal((staleDoctor.result as any).structuredContent.session_fresh, false);
assert.equal((staleDoctor.result as any).structuredContent.operator_action, 'run_pnpm_cloudflare_operator_login_then_cloudflare_operator_check_human');

const health = await handleRequest({
  jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'cloudflare_health', arguments: {} },
}, state);
assert.equal(health.error, undefined);
const healthContent = (health.result as any).structuredContent;
assert.equal(healthContent.status, 'ok');
assert.equal(healthContent.local.sync_status, 'synced');
assert.equal(healthContent.local.inbound_status, 'synced');
assert.equal(healthContent.scheduler.task_state, 'Enabled');
assert.equal(healthContent.cloudflare.next_action, 'monitor_sites');
assert.equal(healthContent.alignment.state, 'aligned');

const missingHealth = await handleRequest({
  jsonrpc: '2.0', id: 5, method: 'tools/call',
  params: { name: 'cloudflare_health', arguments: { health_file: join(root, 'nonexistent.json') } },
}, state);
assert.equal((missingHealth.result as any).structuredContent.status, 'missing');

writeFileSync(sessionFile, JSON.stringify({
  cookie: 'narada_operator_session=fresh_cookie_value',
  captured_at: new Date().toISOString(),
  worker_url: 'https://cloudflare.example.test',
}));

const projectionRegistryRoot = join(root, 'projection-registry');
const joinedProjectionDir = join(projectionRegistryRoot, 'proj_health');
mkdirSync(joinedProjectionDir, { recursive: true });
writeFileSync(join(joinedProjectionDir, 'intent.json'), JSON.stringify({
  projection_id: 'proj_health',
  site_id: 'sonar',
  nars_session_id: 'carrier_health_session',
  source_ref: { kind: 'cloudflare_carrier', carrier_session_id: 'carrier_health_session', operation_id: null },
  projection_api_base_url: 'https://projection.example.test',
  lifecycle_state: 'active',
}));
writeFileSync(join(joinedProjectionDir, 'remote-access.json'), JSON.stringify({
  projection_id: 'proj_health',
  site_id: 'sonar',
  nars_session_id: 'carrier_health_session',
  source_ref: { kind: 'cloudflare_carrier', carrier_session_id: 'carrier_health_session', operation_id: null },
  projection_api_base_url: 'https://projection.example.test',
  lifecycle_state: 'active',
  browser_access_tokens: [{ kind: 'browser', status: 'active', token_fingerprint: 'fingerprint:proj_health:browser' }],
}));

let carrierMode: 'unauthorized' | 'ok' = 'unauthorized';
const carrierCalls: Array<{ body: any; cookie: string | null }> = [];
const fetchImpl: typeof fetch = async (input, init: RequestInit = {}) => {
  const url = String(input);
  if (url.endsWith('/health')) {
    return new Response(JSON.stringify({
      schema: 'narada.cloudflare_nars_projection.health.v1',
      status: 'healthy',
      projection_id: 'proj_health',
      last_event_sequence: 68,
      last_projected_at: '2026-07-15T18:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/events?')) {
    return new Response(JSON.stringify({ status: 'ok', cursor: { last_sequence: 68 }, events: [] }), { status: 200 });
  }
  if (url.endsWith('/api/carrier')) {
    const headers = new Headers(init.headers);
    carrierCalls.push({ body: JSON.parse(String(init.body ?? '{}')), cookie: headers.get('cookie') });
    if (carrierMode === 'unauthorized') return new Response(JSON.stringify({ code: 'operator_session_unauthorized' }), { status: 401 });
    return new Response(JSON.stringify({ ok: true, site_product_status: { health: 'ready', next_action: 'monitor_sites' } }), { status: 200 });
  }
  return new Response(JSON.stringify({ status: 'not_found' }), { status: 404 });
};

const joinedState = createServerState({
  repoRoot: root,
  workerUrl: 'https://cloudflare.example.test',
  projectionRegistryRoot,
  fetch_impl: fetchImpl,
});
const joinedUnauthorized = await handleRequest({
  jsonrpc: '2.0', id: 6, method: 'tools/call',
  params: { name: 'cloudflare_carrier_health', arguments: { projection_id: 'proj_health' } },
}, joinedState);
const joinedUnauthorizedContent = (joinedUnauthorized.result as any).structuredContent;
assert.equal(joinedUnauthorizedContent.status, 'degraded');
assert.equal(joinedUnauthorizedContent.code, 'carrier_api_unauthorized_projection_available');
assert.equal(joinedUnauthorizedContent.projection.status, 'healthy');
assert.equal(joinedUnauthorizedContent.projection.lineage_status, 'matched');
assert.equal(joinedUnauthorizedContent.carrier_api.status, 'unauthorized');
assert.equal(joinedUnauthorizedContent.carrier_api.auth_source, 'operator_session_file');
assert.equal(JSON.stringify(joinedUnauthorizedContent).includes('fingerprint:proj_health:browser'), false);

writeFileSync(sessionFile, JSON.stringify({
  cookie: 'narada_operator_session=rotated_cookie_value',
  captured_at: new Date().toISOString(),
  worker_url: 'https://cloudflare.example.test',
}));
carrierMode = 'ok';
const joinedHealthy = await handleRequest({
  jsonrpc: '2.0', id: 7, method: 'tools/call',
  params: { name: 'cloudflare_carrier_health', arguments: { projection_id: 'proj_health' } },
}, joinedState);
const joinedHealthyContent = (joinedHealthy.result as any).structuredContent;
assert.equal(joinedHealthyContent.status, 'healthy');
assert.equal(joinedHealthyContent.carrier_api.status, 'ok');
assert.equal(carrierCalls.at(-1)?.cookie, 'narada_operator_session=rotated_cookie_value');

const unknownProjectionDir = join(projectionRegistryRoot, 'proj_unknown');
mkdirSync(unknownProjectionDir, { recursive: true });
writeFileSync(join(unknownProjectionDir, 'intent.json'), JSON.stringify({
  projection_id: 'proj_unknown',
  site_id: 'sonar',
  nars_session_id: 'unrelated_session_name',
  projection_api_base_url: 'https://projection.example.test',
  lifecycle_state: 'active',
}));
writeFileSync(join(unknownProjectionDir, 'remote-access.json'), JSON.stringify({
  projection_id: 'proj_unknown',
  site_id: 'sonar',
  browser_access_tokens: [{ kind: 'browser', status: 'active', token_fingerprint: 'fingerprint:proj_unknown:browser' }],
}));
const carrierCallCountBeforeUnknown = carrierCalls.length;
const unknownLineage = await handleRequest({
  jsonrpc: '2.0', id: 8, method: 'tools/call',
  params: { name: 'cloudflare_carrier_health', arguments: { projection_id: 'proj_unknown' } },
}, joinedState);
const unknownLineageContent = (unknownLineage.result as any).structuredContent;
assert.equal(unknownLineageContent.status, 'unverified');
assert.equal(unknownLineageContent.code, 'projection_lineage_unknown');
assert.equal(unknownLineageContent.projection.status, 'healthy');
assert.equal(unknownLineageContent.carrier_api.status, 'not_checked');
assert.equal(carrierCalls.length, carrierCallCountBeforeUnknown);

const legacyProjectionDir = join(projectionRegistryRoot, 'proj_legacy_registration');
mkdirSync(legacyProjectionDir, { recursive: true });
writeFileSync(join(legacyProjectionDir, 'intent.json'), JSON.stringify({
  projection_id: 'proj_legacy_registration',
  site_id: 'sonar',
  nars_session_id: 'carrier_health_session',
  remote_registration: { endpoint: 'https://projection.example.test/api/nars/projections/register' },
  lifecycle_state: 'active',
}));
writeFileSync(join(legacyProjectionDir, 'remote-access.json'), JSON.stringify({
  projection_id: 'proj_legacy_registration',
  site_id: 'sonar',
  browser_access_tokens: [{ kind: 'browser', status: 'active', token_fingerprint: 'fingerprint:proj_legacy_registration:browser' }],
}));
const legacyRead = await handleRequest({
  jsonrpc: '2.0', id: 9, method: 'tools/call',
  params: { name: 'cloudflare_carrier_health', arguments: { projection_id: 'proj_legacy_registration' } },
}, joinedState);
const legacyReadContent = (legacyRead.result as any).structuredContent;
assert.equal(legacyReadContent.status, 'unverified');
assert.equal(legacyReadContent.code, 'projection_lineage_unknown');
assert.equal(legacyReadContent.projection.status, 'healthy');
assert.equal(carrierCalls.length, carrierCallCountBeforeUnknown);

rmSync(root, { recursive: true, force: true });
process.stderr.write('cloudflare-carrier-mcp behavior ok\n');
