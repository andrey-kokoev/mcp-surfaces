import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerState, handleRequest } from '../src/main.js';
import type { CatalogObservationPortRequest, CatalogObservationPortResponse } from '../src/port.js';

const observation = (request: CatalogObservationPortRequest): CatalogObservationPortResponse => ({
  schema: 'narada.invokable-intelligence.catalog-observation.v1',
  id: 'catalog-observation:kimi-code',
  observed_at: request.observed_at,
  inference_provider: { kind: 'inference-provider', id: request.provider_id },
  access_mode: request.access_mode,
  authority: { kind: 'provider-native', authority_ref: 'provider:kimi-code' },
  source: { kind: 'provider-api', reference: 'https://api.kimi.com/v1/models' },
  status: 'complete',
  models: [{ id: 'model:kimi-k3', model_key: 'kimi-k3', status: 'active', capabilities: [] }],
  diagnostics: [],
  digest: `sha256:${'1'.repeat(64)}`,
});

test('forwards only typed observation data and never credential material', async () => {
  const seen: CatalogObservationPortRequest[] = [];
  const state = createServerState({
    observationPort: {
      observe: async (request) => {
        seen.push(request);
        return observation(request);
      },
    },
  });
  const result = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'catalog_observation_observe',
      arguments: {
        provider_id: 'inference-provider:kimi-code',
        observed_at: '2026-07-28T12:00:00.000Z',
        access_mode: 'credentialed',
        api_key: 'must-not-cross-boundary',
      },
    },
  }, state);
  assert.deepEqual(seen, [{
    schema: 'narada.catalog-observation.port-request.v1',
    provider_id: 'inference-provider:kimi-code',
    observed_at: '2026-07-28T12:00:00.000Z',
    access_mode: 'credentialed',
  }]);
  assert.equal(JSON.stringify(result).includes('must-not-cross-boundary'), false);
  assert.equal(JSON.stringify(result).includes('api_key'), false);
});

test('returns an explicit unavailable observation when no Narada port is injected', async () => {
  const result = await handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'catalog_observation_observe',
      arguments: { provider_id: 'inference-provider:codex-subscription', observed_at: '2026-07-28T12:00:00.000Z' },
    },
  }, createServerState());
  const text = ((result?.result as { content: Array<{ text: string }> }).content[0]).text;
  const payload = JSON.parse(text) as { status: string; diagnostics: Array<{ code: string }> };
  assert.equal(payload.status, 'unavailable');
  assert.equal(payload.diagnostics[0]?.code, 'provider-authority-unavailable');
});
