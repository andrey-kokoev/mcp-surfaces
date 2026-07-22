import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readCanonicalProviderRegistry } from '../src/canonical-provider-registry.js';
import { createServerState, handleRequest } from '../src/mcp-server.js';

const root = mkdtempSync(join(tmpdir(), 'narada-worker-canonical-registry-'));
const databasePath = join(root, '.ai', 'intelligence-registry.db');
mkdirSync(join(root, '.ai'), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  CREATE TABLE resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, schema TEXT NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE policies (id TEXT PRIMARY KEY, locus TEXT NOT NULL, site_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, doc TEXT NOT NULL);
`);
const insertResource = db.prepare('INSERT INTO resources (id, kind, schema, doc) VALUES (?, ?, ?, ?)');
const resource = (id: string, kind: string, doc: Record<string, unknown>) => insertResource.run(id, kind, String(doc.schema), JSON.stringify(doc));

resource('inference-provider:codex-subscription', 'inference-provider', {
  schema: 'narada.invokable-intelligence.inference-provider.v1',
  id: 'inference-provider:codex-subscription',
  metadata: { meaning: 'Local Codex subscription.' },
});
resource('adapter:codex-mcp-server', 'adapter', {
  schema: 'narada.invokable-intelligence.adapter.v1',
  id: 'adapter:codex-mcp-server',
  runtime_family: 'node',
  protocol: { family: 'codex-subscription', operation: 'responses', version: '1' },
});
resource('credential-locator:codex-subscription', 'credential-locator', {
  schema: 'narada.invokable-intelligence.credential-locator.v1',
  id: 'credential-locator:codex-subscription',
  store: 'none',
  reference: 'codex-local-subscription',
});
resource('inference-endpoint:codex-subscription', 'inference-endpoint', {
  schema: 'narada.invokable-intelligence.inference-endpoint.v1',
  id: 'inference-endpoint:codex-subscription',
  inference_provider: { kind: 'inference-provider', id: 'inference-provider:codex-subscription' },
  adapter: { kind: 'adapter', id: 'adapter:codex-mcp-server' },
  address: { kind: 'runtime-service', service: 'codex-subscription' },
  credential: { kind: 'credential-locator', id: 'credential-locator:codex-subscription' },
});
for (const model of ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']) {
  resource(`model-offering:codex-subscription-${model}`, 'model-offering', {
    schema: 'narada.invokable-intelligence.model-offering.v1',
    id: `model-offering:codex-subscription-${model}`,
    inference_provider: { kind: 'inference-provider', id: 'inference-provider:codex-subscription' },
    invocation_model_key: model,
  });
}
db.prepare('INSERT INTO policies (id, locus, site_id, kind, revision, doc) VALUES (?, ?, ?, ?, ?, ?)').run(
  'policy:test-defaults',
  'target-site',
  'site:andrey-user',
  'defaults',
  1,
  JSON.stringify({
    schema: 'narada.invokable-intelligence.policy.v1',
    id: 'policy:test-defaults',
    rules: [
      { option: 'route', value: 'route:codex-subscription-gpt-5.6-luna-local' },
      { option: 'cognition.low.route', value: 'route:codex-subscription-gpt-5.6-luna-local' },
      { option: 'cognition.low.reasoning_effort', value: 'low' },
      { option: 'cognition.medium.route', value: 'route:codex-subscription-gpt-5.6-terra-local' },
      { option: 'cognition.medium.reasoning_effort', value: 'medium' },
      { option: 'cognition.high.route', value: 'route:codex-subscription-gpt-5.6-sol-local' },
      { option: 'cognition.high.reasoning_effort', value: 'high' },
    ],
  }),
);
db.close();

const projection = readCanonicalProviderRegistry(databasePath);
const codex = (projection.providers as Record<string, Record<string, unknown>>)['codex-subscription'];
assert.equal(projection.schema, 'narada.carrier.provider_registry.v1');
assert.equal(projection.default_provider, 'codex-subscription');
assert.deepEqual(codex.available_models, ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
assert.equal((codex.cognition_defaults as Record<string, Record<string, string>>).low.model, 'gpt-5.6-luna');
assert.equal(codex.base_url, 'codex://local-subscription');

mkdirSync(join(root, '.narada'), { recursive: true });
writeFileSync(join(root, '.narada', 'worker-cognition-defaults.json'), `${JSON.stringify({
  schema: 'narada.worker.cognition_defaults.v1',
  version: 1,
  updated_at: '2026-07-21T23:00:00.000Z',
  provider_cognition_defaults: {
    'codex-subscription': {
      low: { model: 'gpt-5.6-luna', reasoning_effort: 'max' },
      medium: { model: 'gpt-5.6-terra', reasoning_effort: 'max' },
      high: { model: 'gpt-5.6-sol', reasoning_effort: 'max' },
    },
  },
  effective_cognition_defaults: {
    low: { provider: 'codex-subscription', model: 'gpt-5.6-luna', reasoning_effort: 'max' },
  },
}, null, 2)}\n`, 'utf8');

const state = createServerState({ siteRoot: root, allowedRoot: root, defaultRuntime: 'codex', codexCommand: process.execPath }, { PATH: process.env.PATH, NARADA_PROVIDER_SECRET_STORE: 'disabled' });
assert.equal(state.providerRegistryDiagnostics.status, 'available');
assert.equal(state.providerRegistryDiagnostics.source, 'canonical_sqlite');
assert.equal(state.providerRegistryDiagnostics.path, databasePath);
assert.equal(state.cognitionDefaults.effectiveDefaults.low.provider, 'codex-subscription');
assert.equal(state.cognitionDefaults.effectiveDefaults.low.model, 'gpt-5.6-luna');
assert.equal(state.cognitionDefaults.effectiveDefaults.low.reasoningEffort, 'max');
const resolved = await handleRequest({
  jsonrpc: '2.0',
  id: 'canonical-default',
  method: 'tools/call',
  params: {
    name: 'worker_config_resolve',
    arguments: {
      intent: { instruction: 'resolve the default worker model' },
      constraints: { cwd: root, authority: 'read', cognition: 'low', overrides: { runtime: 'codex' } },
    },
  },
}, state) as { result?: { structuredContent?: Record<string, any> }; error?: unknown };
assert.equal(resolved.error, undefined);
assert.match(String((resolved.result as any)?.content?.[0]?.text ?? ''), /gpt-5\.6-luna/);

rmSync(root, { recursive: true, force: true });
console.log('canonical-provider-registry.test.ts: passed');
