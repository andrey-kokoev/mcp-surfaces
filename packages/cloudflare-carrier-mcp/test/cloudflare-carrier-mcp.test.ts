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

rmSync(root, { recursive: true, force: true });
process.stderr.write('cloudflare-carrier-mcp behavior ok\n');
