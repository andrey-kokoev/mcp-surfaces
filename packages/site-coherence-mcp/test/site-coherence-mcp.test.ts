#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServerState, handleRequest } from '../src/main.js';


const root = join(tmpdir(), `site-coherence-mcp-${randomUUID()}`);
mkdirSync(root, { recursive: true });
mkdirSync(join(root, '.ai'), { recursive: true });
mkdirSync(join(root, '.narada', 'site-continuity', 'health'), { recursive: true });
mkdirSync(join(root, '.narada', 'auth'), { recursive: true });

writeFileSync(join(root, '.narada', 'auth', 'cloudflare-operator-session.json'), JSON.stringify({
  cookie: 'narada_operator_session=test_session',
}));

writeFileSync(join(root, '.narada', 'site-continuity', 'bindings.json'), JSON.stringify({
  bindings: [
    { site_id: 'site_live_smoke', relation_kind: 'same_site_embodiment' },
  ],
}));

writeFileSync(join(root, '.narada', 'site-continuity', 'health', 'cloudflare-continuity-health-last.json'), JSON.stringify({
  schema: 'narada.cloudflare_carrier.site_continuity_scheduled_health_snapshot.v1',
  status: 'ok',
  generated_at: new Date().toISOString(),
  health_output_path: join(root, '.narada', 'site-continuity', 'health', 'cloudflare-continuity-health-last.json'),
  persisted_at: new Date().toISOString(),
  continuity_health: {
    local_sync_status: 'synced',
    local_sync_artifact_count: 2,
    local_inbound_status: 'synced',
    local_inbound_artifact_count: 1,
    reconciliation_execution_status: 'completed',
    reconciliation_execution_plan_status: 'ready',
  },
  cloudflare_product_posture: {
    state: 'loaded',
    site_product_overview: {
      site_count: 2,
      next_action: 'monitor_sites',
      next_reason: 'all_sites_monitoring',
    },
    site_posture_route: {
      next_action: 'monitor_sites',
    },
  },
  cloudflare_product_binding_alignment: {
    state: 'aligned',
    reason: 'ok',
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
  params: { name: 'site_coherence_doctor', arguments: {} },
}, state);
assert.equal(doctor.error, undefined);
const docContent = (doctor.result as any).structuredContent;
assert.equal(docContent.status, 'ok');
assert.equal(docContent.health_exists, true);
assert.equal(docContent.health_status, 'ok');
assert.equal(docContent.bindings_count, 1);
assert.equal(docContent.session_exists, true);
assert.equal(docContent.session_has_cookie, true);

const checkLocal = await handleRequest({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'site_coherence_check', arguments: { site_id: 'site_live_smoke', fetch_cloudflare: false } },
}, state);
assert.equal(checkLocal.error, undefined);
const checkLocalContent = (checkLocal.result as any).structuredContent;
assert.equal(checkLocalContent.status, 'ok');
assert.equal(checkLocalContent.site_id, 'site_live_smoke');
assert.equal(checkLocalContent.local.health_file_exists, true);
assert.equal(checkLocalContent.local.local_sync_status, 'synced');
assert.equal(checkLocalContent.local.overall_product_next_action, 'monitor_sites');
assert.equal(checkLocalContent.cloudflare, null);
assert.equal(checkLocalContent.coherence.state, 'local_only');
assert.equal(checkLocalContent.coherence.posture_agrees, null);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, code: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
const checkUnauthorized = await handleRequest({
  jsonrpc: '2.0', id: 21, method: 'tools/call',
  params: { name: 'site_coherence_check', arguments: { site_id: 'site_live_smoke', fetch_cloudflare: true } },
}, state);
globalThis.fetch = originalFetch;
const unauthorizedContent = (checkUnauthorized.result as any).structuredContent;
assert.equal(unauthorizedContent.coherence.state, 'degraded');
assert.equal(unauthorizedContent.coherence.operator_action, 'run_pnpm_cloudflare_operator_login_then_cloudflare_operator_check_human');
assert.ok(unauthorizedContent.coherence.attention.includes('cloudflare_error:site_read_failed:401:unauthorized'));

const checkMissing = await handleRequest({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'site_coherence_check', arguments: { site_id: 'nonexistent_site', fetch_cloudflare: false } },
}, state);
assert.equal((checkMissing.result as any).structuredContent.status, 'ok');
assert.equal((checkMissing.result as any).structuredContent.local.overall_product_next_action, 'monitor_sites');
assert.equal((checkMissing.result as any).structuredContent.local.has_site_sync, false);

const missingHealthState = createServerState({ repoRoot: join(root, 'nonexistent'), workerUrl: 'https://cloudflare.example.test' });

const checkNoHealth = await handleRequest({
  jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'site_coherence_check', arguments: { site_id: 'any', fetch_cloudflare: false } },
}, missingHealthState);
const noHealthContent = (checkNoHealth.result as any).structuredContent;
assert.equal(noHealthContent.status, 'missing_local');
assert.equal(noHealthContent.local, null);
assert.equal(noHealthContent.coherence.state, 'unknown');

writeFileSync(join(root, '.ai', 'mcp-telemetry.json'), JSON.stringify({
  enabled: true,
  level: 'all',
  surfaces: {
    'site-coherence': { enabled: true, level: 'all' },
  },
}, null, 2), 'utf8');

const telemetryCheck = await handleRequest({
  jsonrpc: '2.0', id: 5, method: 'tools/call',
  params: { name: 'site_coherence_check', arguments: { site_id: 'site_live_smoke', fetch_cloudflare: false } },
}, state);
assert.equal(telemetryCheck.error, undefined);
const telemetryPath = join(root, '.ai', 'telemetry', 'site-coherence.jsonl');
const telemetryLines = readFileSync(telemetryPath, 'utf8').trim().split('\n').filter(Boolean);
assert.ok(telemetryLines.length >= 1);
const telemetryEvent = JSON.parse(telemetryLines[telemetryLines.length - 1]);
assert.equal(telemetryEvent.surface_id, 'site-coherence');
assert.equal(telemetryEvent.tool_name, 'site_coherence_check');
assert.equal(JSON.stringify(telemetryEvent).includes('monitor_sites'), false);

rmSync(root, { recursive: true, force: true });
process.stderr.write('site-coherence-mcp behavior ok\n');
