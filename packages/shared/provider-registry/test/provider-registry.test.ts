import assert from 'node:assert/strict';
import { parseProviderRegistry, ProviderRegistryError, resolveCapabilitySelection } from '../src/main.js';

const registry = parseProviderRegistry({
  schema: 'narada.provider_registry.v2',
  version: 2,
  defaults: {
    tts: { provider: 'sapi', model: 'default' },
    transcription: { provider: 'sapi', model: 'default' },
  },
  providers: {
    sapi: {
      id: 'sapi',
      credential_requirement: { kind: 'none' },
      models: {
        default: { id: 'default', status: 'active', capabilities: { tts: { adapter: 'sapi' }, transcription: { adapter: 'sapi' } } },
      },
      capabilities: { tts: { default_model: 'default' }, transcription: { default_model: 'default' } },
    },
    'test-api': {
      id: 'test-api',
      credential_requirement: { kind: 'api_key_secret', secret_ref: 'test/provider/key', env_names: ['TEST_API_KEY'] },
      models: {
        'test-tts': { id: 'test-tts', status: 'deprecated', capabilities: { tts: { adapter: 'openai-tts', voices: [{ id: 'one' }], default_voice: 'one' } } },
        'disabled-tts': { id: 'disabled-tts', status: 'disabled', capabilities: { tts: { adapter: 'openai-tts', voices: [{ id: 'one' }], default_voice: 'one' } } },
      },
      capabilities: { tts: { default_model: 'test-tts' } },
    },
  },
});

assert.deepEqual(resolveCapabilitySelection({ registry, capability: 'tts' }), {
  provider: 'sapi', model: 'default', capability: 'tts', adapter: 'sapi', status: 'active', source: 'registry', warnings: [],
});
assert.deepEqual(resolveCapabilitySelection({ registry, capability: 'tts', sitePolicy: { tts: { provider: 'test-api' } } }), {
  provider: 'test-api', model: 'test-tts', capability: 'tts', adapter: 'openai-tts', voice: 'one', status: 'deprecated', source: 'site_policy', warnings: ['model_deprecated:test-api/test-tts'],
});
assert.equal(resolveCapabilitySelection({ registry, capability: 'tts', selection: { provider: 'test-api', model: 'test-tts', voice: 'one' } }).source, 'request');
assert.throws(() => resolveCapabilitySelection({ registry, capability: 'tts', selection: { model: 'test-tts' } }), (error: unknown) => error instanceof ProviderRegistryError && error.code === 'provider_root_required_for_model');
assert.throws(() => resolveCapabilitySelection({ registry, capability: 'tts', selection: { provider: 'test-api', model: 'disabled-tts' } }), (error: unknown) => error instanceof ProviderRegistryError && error.code === 'model_disabled');
assert.throws(() => parseProviderRegistry({ ...registry, schema: 'narada.provider_registry.v1' }), (error: unknown) => error instanceof ProviderRegistryError && error.code === 'provider_registry_invalid');
console.log('provider-registry behavior ok');
