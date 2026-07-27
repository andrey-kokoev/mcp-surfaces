import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServerState } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'narada-delegated-task-provider-registry-'));
const databasePath = join(root, '.ai', 'intelligence-registry.db');
const environmentKeys = [
  'NARADA_INTELLIGENCE_CONTEXT_PATH',
  'NARADA_INTELLIGENCE_REGISTRY_DB',
  'NARADA_INTELLIGENCE_PROVIDER_METADATA_PATH',
  'NARADA_PROVIDER_REGISTRY_PATH',
  'NARADA_PROPER_ROOT',
];
const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

try {
  for (const key of environmentKeys) delete process.env[key];
  mkdirSync(join(root, '.ai'), { recursive: true });
  mkdirSync(join(root, '.narada'), { recursive: true });
  writeFileSync(join(root, '.narada', 'intelligence-launch-context.json'), JSON.stringify({
    schema: 'narada.intelligence.launch_context.v1',
    user_site_id: 'site:test-user',
    host_site_id: 'site:test-host',
    principal_id: 'principal:test',
    registry_db_path: '.ai/intelligence-registry.db',
    principal_binding: {
      schema: 'narada.intelligence.principal_binding.v1',
      actor: { principal_id: 'principal:test', auth_type: 'test' },
      memberships: [{ registry: 'site-roster', site_id: 'site:test-user', role: 'resident', evidence_ref: 'test:evidence' }],
    },
  }), 'utf8');

  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, schema TEXT NOT NULL, doc TEXT NOT NULL);
    CREATE TABLE policies (id TEXT PRIMARY KEY, locus TEXT NOT NULL, site_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, doc TEXT NOT NULL);
  `);
  const insertResource = db.prepare('INSERT INTO resources (id, kind, schema, doc) VALUES (?, ?, ?, ?)');
  const resource = (id: string, kind: string, doc: Record<string, unknown>) => insertResource.run(id, kind, String(doc.schema), JSON.stringify(doc));
  resource('inference-provider:canonical-test', 'inference-provider', {
    schema: 'narada.invokable-intelligence.inference-provider.v1',
    id: 'inference-provider:canonical-test',
    metadata: { meaning: 'Canonical test provider.' },
  });
  resource('adapter:canonical-test', 'adapter', {
    schema: 'narada.invokable-intelligence.adapter.v1',
    id: 'adapter:canonical-test',
  });
  resource('credential-locator:canonical-test', 'credential-locator', {
    schema: 'narada.invokable-intelligence.credential-locator.v1',
    id: 'credential-locator:canonical-test',
    store: 'none',
  });
  resource('inference-endpoint:canonical-test', 'inference-endpoint', {
    schema: 'narada.invokable-intelligence.inference-endpoint.v1',
    id: 'inference-endpoint:canonical-test',
    inference_provider: { kind: 'inference-provider', id: 'inference-provider:canonical-test' },
    adapter: { kind: 'adapter', id: 'adapter:canonical-test' },
    address: { kind: 'runtime-service', service: 'canonical-test' },
    credential: { kind: 'credential-locator', id: 'credential-locator:canonical-test' },
  });
  resource('model-offering:canonical-test-model', 'model-offering', {
    schema: 'narada.invokable-intelligence.model-offering.v1',
    id: 'model-offering:canonical-test-model',
    inference_provider: { kind: 'inference-provider', id: 'inference-provider:canonical-test' },
    invocation_model_key: 'canonical-test-model',
  });
  db.prepare('INSERT INTO policies (id, locus, site_id, kind, revision, doc) VALUES (?, ?, ?, ?, ?, ?)').run(
    'policy:canonical-test',
    'target-site',
    'site:test-user',
    'defaults',
    1,
    JSON.stringify({
      schema: 'narada.invokable-intelligence.policy.v1',
      rules: [{ option: 'route', value: 'route:canonical-test-canonical-test-model-local' }],
    }),
  );
  db.close();

  const state = createServerState({ siteRoot: root, taskRoot: root, allowedRoots: [root], workerPolicy: { defaultRuntime: 'codex' } });
  const metadata = state.workerState.providerRuntimeMetadata['canonical-test'];
  assert.ok(metadata);
  assert.equal(metadata.defaultModel, 'canonical-test-model');
  assert.equal(state.workerState.policy.defaultNaradaAgentRuntimeProvider, 'canonical-test');
} finally {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

console.log('provider-registry-resolution.test.ts: passed');
