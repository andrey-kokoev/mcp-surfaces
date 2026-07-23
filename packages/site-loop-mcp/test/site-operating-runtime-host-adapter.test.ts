import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSiteLoopStore } from '../src/site-loop/site-loop-store.js';
import {
  openSiteOperatingRuntimeHost,
  runSiteLoopWithCanonicalRuntimeHost,
  runSiteLoopSupervisorWithCanonicalRuntimeHost,
} from '../src/site-loop/site-operating-runtime-host.js';

function makeSiteRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.narada', 'capabilities'), { recursive: true });
  writeFileSync(join(root, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
    schema: 'narada.site_loop.config.v1',
    loop_id: 'canonical-host.test.loop',
    site_id: 'canonical-host-test',
    display_name: 'Canonical host test loop',
    resident: { agent_id: 'resident', role: 'resident' },
    refs: { ticket_projection: { kind: 'ticket_projection', ref: 'test' } },
  }, null, 2), 'utf8');
  return root;
}

const siteRoot = makeSiteRoot('site-loop-canonical-host-');
try {
  const first = openSiteOperatingRuntimeHost(siteRoot, { owner_id: 'first-supervisor', runtime_lease_ttl_ms: 30_000 });
  const claim = first.claim();
  assert.equal(claim.schema, 'narada.site_operating_loop.runtime_host_claim.v1');
  assert.equal(typeof claim.event.event_id, 'string');
  assert.equal(claim.host.runtime_host_state, 'created');
  assert.equal(claim.host.authority_epoch, 1);

  const second = openSiteOperatingRuntimeHost(siteRoot, { owner_id: 'second-supervisor', runtime_lease_ttl_ms: 30_000 });
  assert.throws(() => second.claim(), /site_operating_loop_runtime_host_already_owned/);
  second.close();

  first.transition('binding');
  first.transition('ready');
  first.transition('serving');
  first.assertAuthority();
  first.heartbeat();
  first.transition('closing');
  first.transition('stopped');
  assert.equal(first.snapshot()?.runtime_host_state, 'stopped');
  first.close();

  const result = await runSiteLoopWithCanonicalRuntimeHost(siteRoot, async () => ({
    status: 'ok',
    synthetic: true,
  }), { owner_id: 'bounded-operation' }) as Record<string, any>;
  assert.equal(result.status, 'ok');
  assert.equal(result.synthetic, true);
  assert.equal(result.runtime_host.runtime_host_state, 'stopped');
  assert.deepEqual(result.runtime_host.lifecycle_history, ['created', 'binding', 'ready', 'serving', 'closing', 'stopped']);
  assert.equal(result.runtime_host_events.length, 6);

  await assert.rejects(
    runSiteLoopWithCanonicalRuntimeHost(siteRoot, async () => {
      throw new Error('synthetic-runtime-host-failure');
    }, { owner_id: 'failed-operation' }),
    /synthetic-runtime-host-failure/,
  );

  const statusStore = openSiteLoopStore(siteRoot, { write: false });
  try {
    const row = statusStore.db.prepare('SELECT runtime_host_state, lifecycle_json FROM site_loop_runtime_hosts WHERE loop_id = ?').get('canonical-host.test.loop');
    assert.equal(row.runtime_host_state, 'stopped');
    assert.deepEqual(JSON.parse(row.lifecycle_json).lifecycle_history, ['created', 'binding', 'ready', 'serving', 'failed', 'stopped']);
  } finally {
    statusStore.close();
  }

  const supervisorResult = await runSiteLoopSupervisorWithCanonicalRuntimeHost(siteRoot, async () => ({
    status: 'stopped',
    health_status: 'healthy',
    cycles_completed: 1,
  }), { owner_id: 'long-running-supervisor' }) as Record<string, any>;
  assert.equal(supervisorResult.status, 'stopped');
  assert.equal(supervisorResult.runtime_host.runtime_host_state, 'stopped');
  assert.deepEqual(supervisorResult.runtime_host.lifecycle_history, ['created', 'binding', 'ready', 'serving', 'closing', 'stopped']);
  assert.deepEqual(
    supervisorResult.runtime_host_events.slice(1).map((event: any) => event.details?.reason),
    [
      'site_loop_supervisor_runtime_host_binding_started',
      'site_loop_supervisor_runtime_host_binding_ready',
      'long_running_site_loop_supervisor_started',
      'site_loop_supervisor_completed',
      'site_loop_supervisor_stopped',
    ],
  );
  console.log('site-loop canonical runtime host adapter ok');
} finally {
  rmSync(siteRoot, { recursive: true, force: true });
}
