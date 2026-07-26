import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  planConflictFreeWaves,
  runConflictFreeWave,
  typescriptBuildWriteSet,
} from './v3-artifact-build-scheduler.js';

const waves = planConflictFreeWaves([
  { value: 'registrar', write_roots: new Set(['registrar', 'task-lifecycle']) },
  { value: 'task-lifecycle', write_roots: new Set(['task-lifecycle']) },
  { value: 'independent', write_roots: new Set(['independent']) },
], 2);
assert.deepEqual(
  waves.map((wave) => wave.map((group) => group.value)),
  [['registrar', 'independent'], ['task-lifecycle']],
);
for (const wave of waves) {
  const roots = new Set<string>();
  for (const group of wave) {
    for (const root of group.write_roots) {
      assert.equal(roots.has(resolve(root)), false);
      roots.add(resolve(root));
    }
  }
}

const nestedRootWaves = planConflictFreeWaves([
  { value: 'parent', write_roots: new Set([join('workspace', 'packages')]) },
  { value: 'child', write_roots: new Set([join('workspace', 'packages', 'child')]) },
  { value: 'sibling', write_roots: new Set([join('workspace', 'other')]) },
], 2);
assert.deepEqual(
  nestedRootWaves.map((wave) => wave.map((group) => group.value)),
  [['parent', 'sibling'], ['child']],
);

let siblingSettled = false;
await assert.rejects(
  runConflictFreeWave([
    { value: 'failed', write_roots: new Set(['failed']) },
    { value: 'sibling', write_roots: new Set(['sibling']) },
  ], async (group) => {
    if (group.value === 'failed') throw new Error('expected wave failure');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    siblingSettled = true;
  }),
  /expected wave failure/u,
);
assert.equal(siblingSettled, true);

const fixture = mkdtempSync(join(tmpdir(), 'v3-artifact-scheduler-'));
try {
  const dependency = join(fixture, 'dependency');
  const consumer = join(fixture, 'consumer');
  mkdirSync(dependency, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(dependency, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { composite: true },
  }), 'utf8');
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { composite: true },
    references: [{ path: '../dependency' }],
  }), 'utf8');
  const writeSet = typescriptBuildWriteSet(consumer);
  const canonical = (path: string) => process.platform === 'win32'
    ? resolve(path).toLowerCase()
    : resolve(path);
  assert.equal(writeSet.has(canonical(consumer)), true);
  assert.equal(writeSet.has(canonical(dependency)), true);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('V3 artifact build scheduler tests passed');
