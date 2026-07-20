import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectWorkerProviderRuntimeEnvironment,
  providerRuntimeMetadataFromRegistry,
  redactWorkerProviderRuntimeBinding,
  resolveWorkerProviderRuntimeBinding,
  resolveWorkerProviderRuntimeBindingFromRegistry,
} from '../src/provider-runtime-binding.js';

const metadata = providerRuntimeMetadataFromRegistry({
  providers: {
    'kimi-code-api': {
      base_url: 'https://api.kimi.com/coding/',
      default_model: 'kimi-k2.7',
      base_url_env_names: ['KIMI_CODE_API_BASE_URL'],
      model_env_names: ['KIMI_CODE_MODEL'],
      credential_requirement: {
        kind: 'api_key_secret',
        secret_ref: 'narada/provider/kimi-code-api/api-key',
        env_names: ['KIMI_CODE_API_KEY'],
      },
    },
    'openai-api': {
      base_url: 'https://api.openai.com',
      default_model: 'gpt-test',
      base_url_env_names: ['OPENAI_BASE_URL'],
      model_env_names: ['OPENAI_MODEL'],
      credential_requirement: {
        kind: 'api_key_secret',
        secret_ref: 'narada/provider/openai-api/api-key',
        env_names: ['OPENAI_API_KEY'],
      },
    },
  },
});

test('worker provider binding ignores unrelated canonical and provider-specific decoys', () => {
  const selected = {
    NARADA_INTELLIGENCE_PROVIDER: 'openai-api',
    NARADA_AI_API_KEY: 'canonical-openai-decoy',
    NARADA_AI_BASE_URL: 'https://canonical-decoy.invalid',
    KIMI_CODE_API_KEY: 'selected-kimi-key',
    OPENAI_API_KEY: 'openai-decoy-one',
    OPENAI_BASE_URL: 'https://openai-decoy.invalid',
  };
  const first = resolveWorkerProviderRuntimeBinding({
    provider: 'kimi-code-api',
    metadataByProvider: metadata,
    env: selected,
    model: 'kimi-k2.7',
    reasoningEffort: 'low',
  });
  const second = resolveWorkerProviderRuntimeBinding({
    provider: 'kimi-code-api',
    metadataByProvider: metadata,
    env: { ...selected, NARADA_AI_API_KEY: 'changed-canonical-decoy', OPENAI_API_KEY: 'openai-decoy-two' },
    model: 'kimi-k2.7',
    reasoningEffort: 'low',
  });
  assert.deepEqual(redactWorkerProviderRuntimeBinding(second), redactWorkerProviderRuntimeBinding(first));
  assert.equal(first.base_url, 'https://api.kimi.com/coding/');
  assert.equal(first.api_key, 'selected-kimi-key');

  const environment = { ...selected } as Record<string, string>;
  projectWorkerProviderRuntimeEnvironment(environment, first, metadata);
  assert.equal(environment.NARADA_AI_API_KEY, 'selected-kimi-key');
  assert.equal(environment.KIMI_CODE_API_KEY, 'selected-kimi-key');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENAI_BASE_URL, undefined);
  assert.equal(JSON.stringify(redactWorkerProviderRuntimeBinding(first)).includes('selected-kimi-key'), false);
});

test('worker provider binding fails closed when the selected credential is absent', () => {
  assert.throws(() => resolveWorkerProviderRuntimeBinding({
    provider: 'kimi-code-api',
    metadataByProvider: metadata,
    env: { OPENAI_API_KEY: 'unrelated-only' },
    model: null,
    reasoningEffort: null,
  }), (error: unknown) => {
    assert.equal((error as { codeName?: string }).codeName, 'worker_provider_credential_missing');
    return true;
  });
});

const authorityRegistry = {
  schema: 'narada.carrier.provider_registry.v1',
  default_provider: 'kimi-code-api',
  providers: {
    'kimi-code-api': {
      adapter_kind: 'openai-compatible-chat-completions',
      base_url: 'https://registry.example/kimi',
      default_model: 'kimi-default',
      available_models: ['kimi-low', 'kimi-override'],
      cognition_defaults: { low: { model: 'kimi-low', reasoning_effort: 'low' } },
      credential_requirement: { kind: 'api_key_secret', env_names: ['KIMI_CODE_API_KEY'] },
    },
  },
};

test('provider registry facade exposes override precedence and worker binding authority', () => {
  const resolved = resolveWorkerProviderRuntimeBindingFromRegistry({
    registry: authorityRegistry,
    env: {
      NARADA_INTELLIGENCE_PROVIDER: 'unrelated-provider',
      NARADA_AI_API_KEY: 'canonical-decoy',
      NARADA_AI_BASE_URL: 'https://canonical-decoy.invalid',
      NARADA_AI_MODEL: 'canonical-decoy-model',
      KIMI_CODE_API_KEY: 'provider-decoy',
    },
    providerOverride: 'kimi-code-api',
    modelOverride: 'kimi-override',
    baseUrlOverride: 'https://override.example/kimi',
    apiKeyOverride: 'explicit-secret',
    reasoningEffortOverride: 'high',
  });
  assert.equal(resolved.provider_source, 'test_override');
  assert.equal(resolved.model_source, 'test_override');
  assert.equal(resolved.base_url_source, 'test_override');
  assert.equal(resolved.reasoning_effort_source, 'test_override');
  assert.equal(resolved.binding.provider_id, 'kimi-code-api');
  assert.equal(resolved.binding.model, 'kimi-override');
  assert.equal(resolved.binding.base_url, 'https://override.example/kimi');
  assert.equal(resolved.binding.reasoning_effort, 'high');
  assert.equal(resolved.binding.credential_source, 'explicit_override');
  assert.equal(JSON.stringify(resolved.redacted_binding).includes('explicit-secret'), false);
});

test('provider registry facade rejects malformed, unsupported-adapter, and missing-model registries', () => {
  assert.throws(() => resolveWorkerProviderRuntimeBindingFromRegistry({ registry: {}, env: {} }), (error: unknown) => {
    assert.equal((error as { codeName?: string }).codeName, 'worker_provider_registry_malformed');
    return true;
  });

  const unsupported = structuredClone(authorityRegistry) as Record<string, unknown>;
  (unsupported.providers as Record<string, Record<string, unknown>>)['kimi-code-api'].adapter_kind = 'unsupported-adapter';
  assert.throws(() => resolveWorkerProviderRuntimeBindingFromRegistry({ registry: unsupported, env: { KIMI_CODE_API_KEY: 'key' } }), (error: unknown) => {
    assert.equal((error as { codeName?: string }).codeName, 'worker_provider_adapter_unsupported');
    return true;
  });

  const missingModel = structuredClone(authorityRegistry) as Record<string, unknown>;
  const missingMetadata = (missingModel.providers as Record<string, Record<string, unknown>>)['kimi-code-api'];
  missingMetadata.default_model = '';
  missingMetadata.cognition_defaults = {};
  assert.throws(() => resolveWorkerProviderRuntimeBindingFromRegistry({ registry: missingModel, env: { KIMI_CODE_API_KEY: 'key' } }), (error: unknown) => {
    assert.equal((error as { codeName?: string }).codeName, 'worker_provider_model_missing');
    return true;
  });
});
