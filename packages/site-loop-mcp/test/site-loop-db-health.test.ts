import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskLifecycleDbHealth, openTaskLifecycleStoreWithDiscipline } from '../src/task-lifecycle/sqlite-discipline.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-db-health-'));
mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v1',
  loop_id: 'db-health.test.loop',
  site_id: 'narada-db-health-test',
  display_name: 'DB health test loop',
  resident: {
    agent_id: 'resident',
    role: 'resident',
  },
  refs: {
    ticket_projection: { kind: 'ticket_projection', ref: 'db-health-test' },
  },
}, null, 2), 'utf8');

try {
  const store = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: true });
  store.db.close();

  const staleLockDir = join(siteRoot, '.ai', 'task-lifecycle.write.lock');
  mkdirSync(staleLockDir, { recursive: true });
  writeFileSync(join(staleLockDir, 'owner.json'), JSON.stringify({
    schema: 'narada.site_loop.task_lifecycle_write_lock.v1',
    pid: process.pid,
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
  }), 'utf8');
  const recoveredStore = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: true });
  recoveredStore.db.close();
  assert.equal(existsSync(staleLockDir), false);

  const fast = taskLifecycleDbHealth(siteRoot);
  assert.equal(fast.status, 'ok');
  assert.equal(fast.health_mode, 'fast');
  assert.equal(fast.integrity_check, null);
  assert.equal(fast.integrity_check_status, 'deferred');
  assert.equal(fast.task_lifecycle_table_present, true);

  const deep = taskLifecycleDbHealth(siteRoot, { mode: 'deep' });
  assert.equal(deep.status, 'ok');
  assert.equal(deep.health_mode, 'deep');
  assert.equal(deep.integrity_check, 'ok');
  assert.equal(deep.integrity_check_status, 'ok');

  console.log('site-loop DB health fast/deep modes ok');
} finally {
  rmSync(siteRoot, { recursive: true, force: true });
}
