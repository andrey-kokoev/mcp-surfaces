import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SITE_LOOP_CONFIG, SITE_LOOP_CONFIG_SCHEMA } from '../src/site-loop/site-loop-config.js';
import { openSiteLoopStoreForLogicalLock } from '../src/site-loop/site-loop-store.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-write-lock-'));
mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  ...DEFAULT_SITE_LOOP_CONFIG,
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'site-loop-write-lock.test.loop',
  site_id: 'site-loop-write-lock-test',
  display_name: 'Site Loop write-lock test loop',
}, null, 2), 'utf8');
const disciplineModule = new URL('../src/task-lifecycle/sqlite-discipline.js', import.meta.url).href;
const childSource = `
  import { acquireTaskLifecycleWriteLock, releaseTaskLifecycleWriteLock } from ${JSON.stringify(disciplineModule)};
  const lock = acquireTaskLifecycleWriteLock(process.argv[1], { timeoutMs: 250, pollMs: 25 });
  releaseTaskLifecycleWriteLock(lock);
  process.stdout.write('acquired');
`;

function tryAcquireInChild(): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--input-type=module', '-e', childSource, siteRoot], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

try {
  const store = openSiteLoopStoreForLogicalLock(siteRoot, {
    write: true,
    storeMode: 'prepare',
  });
  store.acquireProcessWriteLock?.({ timeoutMs: 1_000, pollMs: 25 });

  const blocked = tryAcquireInChild();
  assert.notEqual(blocked.status, 0, `a second process acquired the Site Loop write lock: ${blocked.stdout}`);

  store.close();
  const released = tryAcquireInChild();
  assert.equal(released.status, 0, `${released.stdout}\n${released.stderr}`);
  assert.equal(released.stdout, 'acquired');

  console.log('site-loop delayed process write lock serializes mixed writers');
} finally {
  rmSync(siteRoot, { recursive: true, force: true });
}
