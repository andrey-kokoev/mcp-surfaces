import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cognitionDefaultsPaths,
  EffectiveCognitionDefaultSchema,
  loadCognitionDefaultsState,
  publicCognitionDefaults,
  updateCognitionDefault,
  type EffectiveCognitionDefault,
  type ProviderCognitionDefaults,
} from '../src/cognition-defaults.js';
import { WorkerMcpError } from '../src/errors.js';

const root = mkdtempSync(join(tmpdir(), 'worker-cognition-defaults-'));
const providerModels = {
  alpha: ['alpha-low', 'alpha-medium', 'alpha-high'],
  beta: ['beta-low', 'beta-medium', 'beta-high'],
};
const registryDefaults: ProviderCognitionDefaults = {
  alpha: {
    low: { model: 'alpha-low', reasoningEffort: 'low' },
    medium: { model: 'alpha-medium', reasoningEffort: 'medium' },
    high: { model: 'alpha-high', reasoningEffort: 'high' },
  },
  beta: {
    low: { model: 'beta-low', reasoningEffort: 'low' },
    medium: { model: 'beta-medium', reasoningEffort: 'medium' },
    high: { model: 'beta-high', reasoningEffort: 'high' },
  },
};

const typedTuple: EffectiveCognitionDefault = {
  provider: 'alpha',
  model: 'alpha-low',
  reasoningEffort: 'low',
  source: 'provider_registry_default',
};
void typedTuple;
// @ts-expect-error Effective cognition tuples require a provider field.
const missingProviderTuple: EffectiveCognitionDefault = {
  model: 'alpha-low',
  reasoningEffort: 'low',
  source: 'provider_registry_default',
};
void missingProviderTuple;

assert.equal(EffectiveCognitionDefaultSchema.safeParse(typedTuple).success, true);
assert.equal(EffectiveCognitionDefaultSchema.safeParse({ ...typedTuple, unexpected: true }).success, false);
assert.equal(EffectiveCognitionDefaultSchema.safeParse({ ...typedTuple, provider: '' }).success, false);

const emptyRoot = siteRoot('empty-registry');
const empty = loadCognitionDefaultsState({ siteRoot: emptyRoot, providerModels: {}, registryDefaults: {}, defaultProvider: null });
for (const cognition of ['low', 'medium', 'high'] as const) {
  assert.deepEqual(empty.state.effectiveDefaults[cognition], {
    provider: null,
    model: null,
    reasoningEffort: null,
    source: 'provider_registry_default',
  });
}

const invalidJsonRoot = siteRoot('invalid-json');
writeDocument(invalidJsonRoot, '{');
expectWorkerError(
  () => loadDefaults(invalidJsonRoot),
  'worker_cognition_defaults_invalid_json',
);

for (const invalidCase of [
  {
    name: 'wrong-schema',
    document: baseDocument({ schema: 'narada.worker.cognition_defaults.v2' }),
    issuePath: 'schema',
  },
  {
    name: 'invalid-version',
    document: baseDocument({ version: 0 }),
    issuePath: 'version',
  },
  {
    name: 'strict-effective-tuple',
    document: baseDocument({
      effective_cognition_defaults: {
        low: { provider: 'alpha', model: 'alpha-low', reasoning_effort: 'max', unexpected: true },
      },
    }),
    issuePath: 'effective_cognition_defaults.low',
  },
] as const) {
  const caseRoot = siteRoot(invalidCase.name);
  writeDocument(caseRoot, invalidCase.document);
  expectWorkerError(
    () => loadDefaults(caseRoot),
    'worker_cognition_defaults_invalid',
    invalidCase.issuePath,
  );
}

const driftRoot = siteRoot('catalog-drift');
writeDocument(driftRoot, baseDocument({
  version: 4,
  provider_cognition_defaults: {
    alpha: { low: { model: 'alpha-missing', reasoning_effort: 'max' } },
    ghost: { low: { model: 'ghost-model', reasoning_effort: 'max' } },
  },
  effective_cognition_defaults: {
    low: { provider: 'beta', model: 'beta-low', reasoning_effort: 'max' },
    medium: { provider: 'ghost', model: 'ghost-model', reasoning_effort: 'max' },
    high: { provider: 'alpha', model: 'alpha-missing', reasoning_effort: 'max' },
  },
}));
const drift = loadDefaults(driftRoot);
const driftView = view(drift);
assert.equal(driftView.version, 4);
assert.equal(driftView.provider_cognition_defaults.alpha.low.source, 'provider_registry');
assert.deepEqual(tupleSummary(driftView.effective_cognition_defaults.low), ['beta', 'beta-low', 'max', 'site_runtime_override']);
assert.deepEqual(tupleSummary(driftView.effective_cognition_defaults.medium), ['alpha', 'alpha-medium', 'medium', 'provider_registry_default']);
assert.deepEqual(tupleSummary(driftView.effective_cognition_defaults.high), ['alpha', 'alpha-high', 'high', 'provider_registry_default']);

const providerOnlyRoot = siteRoot('provider-only-legacy');
writeDocument(providerOnlyRoot, baseDocument({
  version: 7,
  provider_cognition_defaults: {
    beta: { high: { model: 'beta-high', reasoning_effort: 'max' } },
  },
}));
const providerOnly = loadDefaults(providerOnlyRoot);
const providerOnlyBefore = view(providerOnly);
assert.equal(providerOnlyBefore.version, 7);
assert.equal(providerOnlyBefore.provider_cognition_defaults.beta.high.source, 'site_runtime_override');
assert.equal(providerOnlyBefore.provider_cognition_defaults.beta.high.reasoning_effort, 'max');
for (const cognition of ['low', 'medium', 'high'] as const) {
  assert.equal(providerOnlyBefore.effective_cognition_defaults[cognition].provider, 'alpha');
  assert.equal(providerOnlyBefore.effective_cognition_defaults[cognition].source, 'provider_registry_default');
}
updateCognitionDefault({
  state: providerOnly.state,
  defaults: providerOnly.defaults,
  provider: 'alpha',
  cognition: 'low',
  model: 'alpha-low',
  reasoningEffort: 'max',
});
const providerOnlyDocument = JSON.parse(readFileSync(cognitionDefaultsPaths(providerOnlyRoot).path, 'utf8'));
assert.deepEqual(providerOnlyDocument.provider_cognition_defaults, {
  alpha: { low: { model: 'alpha-low', reasoning_effort: 'max' } },
  beta: { high: { model: 'beta-high', reasoning_effort: 'max' } },
});
assert.deepEqual(providerOnlyDocument.effective_cognition_defaults, {
  low: { provider: 'alpha', model: 'alpha-low', reasoning_effort: 'max' },
});
const providerOnlyReloaded = view(loadDefaults(providerOnlyRoot));
assert.equal(providerOnlyReloaded.version, 8);
assert.equal(providerOnlyReloaded.provider_cognition_defaults.beta.high.source, 'site_runtime_override');
assert.deepEqual(tupleSummary(providerOnlyReloaded.effective_cognition_defaults.low), ['alpha', 'alpha-low', 'max', 'site_runtime_override']);

const migrationRoot = siteRoot('legacy-migration');
writeDocument(migrationRoot, baseDocument({
  version: 9,
  provider_cognition_defaults: {
    alpha: {
      low: { model: 'alpha-low', reasoning_effort: null },
      medium: { model: 'alpha-medium' },
      high: { model: 42, reasoning_effort: 'high' },
    },
  },
  effective_cognition_defaults: {
    low: { provider: 'beta', model: 'beta-low', reasoning_effort: 'max' },
  },
}));
const migration = loadDefaults(migrationRoot);
const migrationBefore = view(migration);
assert.equal(migrationBefore.version, 9);
assert.equal(migrationBefore.provider_cognition_defaults.alpha.low.source, 'provider_registry');
assert.equal(migrationBefore.provider_cognition_defaults.alpha.medium.source, 'provider_registry');
assert.equal(migrationBefore.provider_cognition_defaults.alpha.high.source, 'provider_registry');
assert.deepEqual(tupleSummary(migrationBefore.effective_cognition_defaults.low), ['beta', 'beta-low', 'max', 'site_runtime_override']);

const migrationUpdate = updateCognitionDefault({
  state: migration.state,
  defaults: migration.defaults,
  provider: 'beta',
  cognition: 'medium',
  model: 'beta-medium',
  reasoningEffort: 'max',
  actor: 'coverage-test',
}) as any;
assert.equal(migrationUpdate.version, 10);
const migrationPaths = cognitionDefaultsPaths(migrationRoot);
const canonicalDocument = JSON.parse(readFileSync(migrationPaths.path, 'utf8'));
assert.deepEqual(canonicalDocument.provider_cognition_defaults, {
  beta: { medium: { model: 'beta-medium', reasoning_effort: 'max' } },
});
assert.deepEqual(canonicalDocument.effective_cognition_defaults, {
  low: { provider: 'beta', model: 'beta-low', reasoning_effort: 'max' },
  medium: { provider: 'beta', model: 'beta-medium', reasoning_effort: 'max' },
});
const migrationAudit = readFileSync(migrationPaths.auditPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(migrationAudit.length, 1);
assert.equal(migrationAudit[0].actor, 'coverage-test');
assert.deepEqual(migrationAudit[0].current, { provider: 'beta', model: 'beta-medium', reasoning_effort: 'max' });

const migrationReloaded = loadDefaults(migrationRoot);
const migrationReloadedView = view(migrationReloaded);
assert.equal(migrationReloadedView.version, 10);
assert.deepEqual(tupleSummary(migrationReloadedView.effective_cognition_defaults.low), ['beta', 'beta-low', 'max', 'site_runtime_override']);
assert.deepEqual(tupleSummary(migrationReloadedView.effective_cognition_defaults.medium), ['beta', 'beta-medium', 'max', 'site_runtime_override']);
assert.equal(migrationReloadedView.provider_cognition_defaults.alpha.low.source, 'provider_registry');

const rejectionRoot = siteRoot('rejection-atomicity');
const rejection = loadDefaults(rejectionRoot);
updateCognitionDefault({
  state: rejection.state,
  defaults: rejection.defaults,
  provider: 'alpha',
  cognition: 'low',
  model: 'alpha-low',
  reasoningEffort: 'max',
  actor: 'seed',
});
const rejectionPaths = cognitionDefaultsPaths(rejectionRoot);
const rejectionSnapshot = () => ({
  view: JSON.stringify(view(rejection)),
  persisted: readFileSync(rejectionPaths.path, 'utf8'),
  audit: readFileSync(rejectionPaths.auditPath, 'utf8'),
});
const beforeRejections = rejectionSnapshot();
const validUpdate = {
  state: rejection.state,
  defaults: rejection.defaults,
  provider: 'alpha' as unknown,
  cognition: 'medium' as unknown,
  model: 'alpha-medium' as unknown,
  reasoningEffort: 'max' as unknown,
};
for (const rejected of [
  { input: { provider: '' }, code: 'worker_cognition_provider_required', issuePath: 'provider' },
  { input: { cognition: 'extreme' }, code: 'worker_invalid_cognition', issuePath: 'cognition' },
  { input: { model: '' }, code: 'worker_cognition_model_required', issuePath: 'model' },
  { input: { reasoningEffort: 42 }, code: 'worker_cognition_reasoning_effort_required', issuePath: 'reasoning_effort' },
  { input: { provider: 'ghost', model: 'ghost-model' }, code: 'worker_cognition_provider_not_allowed' },
  { input: { model: 'alpha-missing' }, code: 'worker_cognition_model_not_allowed' },
] as const) {
  expectWorkerError(
    () => updateCognitionDefault({ ...validUpdate, ...rejected.input }),
    rejected.code,
    'issuePath' in rejected ? rejected.issuePath : undefined,
  );
  assert.deepEqual(rejectionSnapshot(), beforeRejections);
}

const actorRoot = siteRoot('actor-fallback');
const actorDefaults = loadDefaults(actorRoot);
for (const [cognition, actor] of [['low', ''], ['medium', 42]] as const) {
  updateCognitionDefault({
    state: actorDefaults.state,
    defaults: actorDefaults.defaults,
    provider: 'alpha',
    cognition,
    model: cognition === 'low' ? 'alpha-low' : 'alpha-medium',
    reasoningEffort: 'max',
    actor,
  });
}
const actorAudit = readFileSync(cognitionDefaultsPaths(actorRoot).auditPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.deepEqual(actorAudit.map((event) => event.actor), ['mcp_client', 'mcp_client']);

const failureRoot = siteRoot('persistence-failures');
const failureDefaults = loadDefaults(failureRoot);
updateCognitionDefault({
  state: failureDefaults.state,
  defaults: failureDefaults.defaults,
  provider: 'alpha',
  cognition: 'low',
  model: 'alpha-low',
  reasoningEffort: 'max',
  actor: 'failure-seed',
});
const failurePaths = cognitionDefaultsPaths(failureRoot);
const failureSnapshot = () => ({
  view: JSON.stringify(view(failureDefaults)),
  persisted: readFileSync(failurePaths.path, 'utf8'),
  audit: readFileSync(failurePaths.auditPath, 'utf8'),
});
const beforeFailures = failureSnapshot();
const stateWriteFailure = expectWorkerError(() => updateCognitionDefault({
  state: failureDefaults.state,
  defaults: failureDefaults.defaults,
  provider: 'alpha',
  cognition: 'medium',
  model: 'alpha-medium',
  reasoningEffort: 'max',
  persistence: { writeState: () => { throw new Error('simulated state write failure'); } },
}), 'worker_cognition_defaults_persistence_failed');
assert.equal(stateWriteFailure.details.phase, 'state_write');
assert.equal(stateWriteFailure.details.rollback_status, 'restored');
assert.deepEqual(failureSnapshot(), beforeFailures);
assert.equal(existsSync(`${failurePaths.path}.lock`), false);
const auditWriteFailure = expectWorkerError(() => updateCognitionDefault({
  state: failureDefaults.state,
  defaults: failureDefaults.defaults,
  provider: 'alpha',
  cognition: 'high',
  model: 'alpha-high',
  reasoningEffort: 'max',
  persistence: { appendAudit: () => { throw new Error('simulated audit append failure'); } },
}), 'worker_cognition_defaults_persistence_failed');
assert.equal(auditWriteFailure.details.phase, 'audit_append');
assert.equal(auditWriteFailure.details.rollback_status, 'restored');
assert.deepEqual(failureSnapshot(), beforeFailures);
assert.equal(existsSync(`${failurePaths.path}.lock`), false);

const concurrencyRoot = siteRoot('multi-process-concurrency');
const barrierRoot = join(root, 'concurrency-barrier');
mkdirSync(barrierRoot, { recursive: true });
const goPath = join(barrierRoot, 'go');
const childScript = fileURLToPath(new URL('./fixtures/cognition-update-child.js', import.meta.url));
const concurrentUpdates = [
  { provider: 'alpha', cognition: 'low', model: 'alpha-low' },
  { provider: 'alpha', cognition: 'medium', model: 'alpha-medium' },
  { provider: 'alpha', cognition: 'high', model: 'alpha-high' },
  { provider: 'beta', cognition: 'low', model: 'beta-low' },
  { provider: 'beta', cognition: 'medium', model: 'beta-medium' },
  { provider: 'beta', cognition: 'high', model: 'beta-high' },
] as const;
const concurrentResults = concurrentUpdates.map((update, index) => runCognitionChild(childScript, [
  concurrencyRoot,
  join(barrierRoot, `${index}.ready`),
  goPath,
  update.provider,
  update.cognition,
  update.model,
]));
await waitForCondition(() => readdirSync(barrierRoot).filter((name) => name.endsWith('.ready')).length === concurrentUpdates.length, 15_000);
writeFileSync(goPath, 'go\n', 'utf8');
const completedConcurrentUpdates = await Promise.all(concurrentResults);
assert.deepEqual(completedConcurrentUpdates.map((result) => result.version).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
const concurrencyPaths = cognitionDefaultsPaths(concurrencyRoot);
const concurrentDocument = JSON.parse(readFileSync(concurrencyPaths.path, 'utf8'));
assert.equal(concurrentDocument.version, 6);
for (const update of concurrentUpdates) {
  assert.deepEqual(concurrentDocument.provider_cognition_defaults[update.provider][update.cognition], {
    model: update.model,
    reasoning_effort: 'max',
  });
}
const concurrentAudit = readFileSync(concurrencyPaths.auditPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.deepEqual(concurrentAudit.map((event) => event.version).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
assert.equal(existsSync(`${concurrencyPaths.path}.lock`), false);

function siteRoot(name: string): string {
  const value = join(root, name);
  mkdirSync(join(value, '.narada'), { recursive: true });
  return value;
}

function baseDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'narada.worker.cognition_defaults.v1',
    version: 1,
    updated_at: '2026-07-10T00:00:00.000Z',
    provider_cognition_defaults: {},
    ...overrides,
  };
}

function writeDocument(siteRootValue: string, document: unknown): void {
  const content = typeof document === 'string' ? document : JSON.stringify(document, null, 2);
  writeFileSync(cognitionDefaultsPaths(siteRootValue).path, content, 'utf8');
}

function loadDefaults(siteRootValue: string) {
  return loadCognitionDefaultsState({
    siteRoot: siteRootValue,
    providerModels,
    registryDefaults,
    defaultProvider: 'alpha',
  });
}

function view(loaded: ReturnType<typeof loadDefaults>): any {
  return publicCognitionDefaults(loaded.state, loaded.defaults) as any;
}

function tupleSummary(tuple: any): unknown[] {
  return [tuple.provider, tuple.model, tuple.reasoning_effort, tuple.source];
}

function expectWorkerError(action: () => unknown, code: string, issuePath?: string): WorkerMcpError {
  let captured: WorkerMcpError | null = null;
  assert.throws(action, (error: unknown) => {
    assert.equal(error instanceof WorkerMcpError, true);
    const diagnostic = error as WorkerMcpError;
    captured = diagnostic;
    assert.equal(diagnostic.codeName, code);
    if (issuePath !== undefined) {
      const issues = diagnostic.details.validation_issues as Array<{ path: string }>;
      assert.equal(issues.some((issue) => issue.path === issuePath), true, JSON.stringify(issues));
    }
    return true;
  });
  return captured!;
}

function runCognitionChild(script: string, args: string[]): Promise<any> {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`cognition update child failed (${code}): ${stderr || stdout}`));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
  });
}

async function waitForCondition(check: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

