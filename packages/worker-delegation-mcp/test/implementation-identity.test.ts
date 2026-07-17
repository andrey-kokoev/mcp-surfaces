import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerImplementationIdentityReader, writeWorkerImplementationBuildManifest } from '../src/implementation-identity.js';
import { workerImplementationGate } from '../src/policy.js';

function createCompiledFixture(name: string): { root: string; sourcePath: string; artifactPath: string; dependencyPath: string } {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const sourceRoot = join(root, 'src');
  const artifactRoot = join(root, 'dist', 'src');
  const dependencyRoot = join(root, 'node_modules', 'fixture-dependency');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(join(dependencyRoot, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'identity-fixture', dependencies: { 'fixture-dependency': '1.0.0' } }), 'utf8');
  writeFileSync(join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', main: './dist/index.js' }), 'utf8');
  const sourcePath = join(sourceRoot, 'policy.ts');
  const artifactPath = join(artifactRoot, 'policy.js');
  const dependencyPath = join(dependencyRoot, 'dist', 'index.js');
  writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
  writeFileSync(artifactPath, 'export const value = 1;\n', 'utf8');
  writeFileSync(dependencyPath, 'module.exports = { value: 1 };\n', 'utf8');
  writeWorkerImplementationBuildManifest({ packageRoot: root });
  return { root, sourcePath, artifactPath, dependencyPath };
}

const freshFixture = createCompiledFixture('worker-implementation-identity');
const readFreshIdentity = createWorkerImplementationIdentityReader({
  modulePath: freshFixture.artifactPath,
  now: () => new Date('2026-07-11T00:00:00.000Z'),
  revalidationIntervalMs: 0,
});
const fresh = readFreshIdentity();
assert.equal(fresh.schema, 'narada.worker.implementation_identity.v4');
assert.equal(fresh.identity_algorithm, 'sha256-tree-v1');
assert.equal(fresh.implementation_graph_scope, 'surface_artifact_plus_direct_runtime_dependencies');
assert.match(String(fresh.implementation_identity), /^sha256:[a-f0-9]{64}$/);
assert.equal(fresh.module_file, 'policy.js');
assert.equal(fresh.artifact_kind, 'compiled');
assert.equal(fresh.materialized_at, '2026-07-11T00:00:00.000Z');
assert.match(String(fresh.materialized_artifact_tree_sha256), /^[a-f0-9]{64}$/);
assert.equal((fresh.expected_build as Record<string, unknown>).status, 'matched');
assert.equal((fresh.runtime_dependencies as Record<string, unknown>).status, 'unchanged_since_materialization');
assert.equal((fresh.stale_server_risk as Record<string, unknown>).status, 'not_observed');
assert.equal(workerImplementationGate(fresh).status, 'admitted');

const blockedGate = workerImplementationGate({
  ...fresh,
  stale_server_risk: { status: 'source_changed_since_build', remediation: 'rebuild fixture' },
});
assert.equal(blockedGate.status, 'blocked');
assert.equal(blockedGate.admitted, false);
assert.equal(blockedGate.blocking_status, 'source_changed_since_build');
assert.equal(blockedGate.remediation, 'rebuild fixture');

writeFileSync(freshFixture.sourcePath, 'export const value = 2;\n', 'utf8');
const staleSource = readFreshIdentity();
assert.equal((staleSource.expected_build as Record<string, unknown>).status, 'source_changed_since_build');
assert.equal((staleSource.stale_server_risk as Record<string, unknown>).status, 'source_changed_since_build');

const mismatchedFixture = createCompiledFixture('worker-implementation-mismatch');
writeFileSync(mismatchedFixture.artifactPath, 'export const value = 2;\n', 'utf8');
const mismatched = createWorkerImplementationIdentityReader({ modulePath: mismatchedFixture.artifactPath, revalidationIntervalMs: 0 })();
assert.equal((mismatched.expected_build as Record<string, unknown>).status, 'artifact_mismatch');
assert.equal((mismatched.stale_server_risk as Record<string, unknown>).status, 'loaded_artifact_not_declared_build');

const dependencyDriftFixture = createCompiledFixture('worker-implementation-dependency-drift');
writeFileSync(dependencyDriftFixture.dependencyPath, 'module.exports = { value: 2 };\n', 'utf8');
const dependencyDrift = createWorkerImplementationIdentityReader({ modulePath: dependencyDriftFixture.artifactPath, revalidationIntervalMs: 0 })();
assert.equal((dependencyDrift.expected_build as Record<string, unknown>).status, 'runtime_dependency_changed_since_build');
assert.equal((dependencyDrift.stale_server_risk as Record<string, unknown>).status, 'runtime_dependency_changed_since_build');

const unavailableFixture = createCompiledFixture('worker-implementation-unavailable');
unlinkSync(join(unavailableFixture.root, 'dist', 'worker-delegation-build-identity.json'));
const unavailable = createWorkerImplementationIdentityReader({ modulePath: unavailableFixture.artifactPath, revalidationIntervalMs: 0 })();
assert.equal((unavailable.expected_build as Record<string, unknown>).status, 'unavailable');
assert.equal((unavailable.stale_server_risk as Record<string, unknown>).status, 'identity_unavailable');

const cacheFixture = createCompiledFixture('worker-implementation-cache');
let clock = Date.parse('2026-07-11T00:00:00.000Z');
const readCachedIdentity = createWorkerImplementationIdentityReader({
  modulePath: cacheFixture.artifactPath,
  now: () => new Date(clock),
  revalidationIntervalMs: 1_000,
});
assert.equal((readCachedIdentity().stale_server_risk as Record<string, unknown>).status, 'not_observed');
writeFileSync(cacheFixture.sourcePath, 'export const value = 2;\n', 'utf8');
assert.equal((readCachedIdentity().stale_server_risk as Record<string, unknown>).status, 'not_observed');
clock += 1_000;
assert.equal((readCachedIdentity().stale_server_risk as Record<string, unknown>).status, 'source_changed_since_build');
