import { createHash } from 'node:crypto';
import { diagnosticError } from './errors.js';

export const PROVIDER_RUNTIME_BINDING_SCHEMA = 'narada.carrier.provider_runtime_binding.v1' as const;
export const PROVIDER_REGISTRY_SCHEMA = 'narada.carrier.provider_registry.v1' as const;
export const SUPPORTED_WORKER_PROVIDER_ADAPTERS = Object.freeze(['openai-compatible-chat-completions']);

export type WorkerProviderRuntimeMetadata = {
  baseUrl: string;
  defaultModel: string;
  defaultThinking: string;
  credentialRequirementKind: string;
  credentialSecretRef: string | null;
  credentialEnvNames: string[];
  baseUrlEnvNames: string[];
  modelEnvNames: string[];
};

export type WorkerProviderRuntimeBinding = {
  schema: typeof PROVIDER_RUNTIME_BINDING_SCHEMA;
  provider_id: string;
  base_url: string;
  model: string;
  reasoning_effort: string;
  api_key: string | null;
  credential_requirement_kind: string;
  credential_secret_ref: string | null;
  credential_env_names: string[];
  base_url_env_names: string[];
  model_env_names: string[];
  credential_source: 'explicit_override' | 'canonical_environment' | 'provider_environment' | 'not_required';
  credential_fingerprint: string | null;
};

export type WorkerProviderRuntimeBindingResolution = {
  schema: 'narada.carrier.provider_runtime_binding_resolution.v1';
  provider: string;
  provider_source: 'test_override' | 'canonical_environment' | 'registry_default';
  adapter_kind: string;
  model_source: 'test_override' | 'provider_registry_cognition_default' | 'provider_registry_default';
  base_url_source: 'test_override' | 'canonical_environment' | 'provider_environment' | 'provider_registry_default';
  reasoning_effort_source: 'test_override' | 'canonical_environment' | 'provider_registry_default';
  binding: WorkerProviderRuntimeBinding;
  redacted_binding: Omit<WorkerProviderRuntimeBinding, 'api_key'>;
};

const CANONICAL_PROVIDER_ENV_KEYS = [
  'NARADA_INTELLIGENCE_PROVIDER',
  'NARADA_AI_API_KEY',
  'NARADA_AI_BASE_URL',
  'NARADA_AI_MODEL',
  'NARADA_AI_THINKING',
] as const;

export function providerRuntimeMetadataFromRegistry(registry: Record<string, unknown>): Record<string, WorkerProviderRuntimeMetadata> {
  const providers = asRecord(registry.providers);
  return Object.fromEntries(Object.entries(providers).map(([provider, rawMetadata]) => {
    const metadata = asRecord(rawMetadata);
    const requirement = asRecord(metadata.credential_requirement);
    const baseUrl = requiredString(metadata.base_url, provider, 'base_url');
    const defaultModel = requiredString(metadata.default_model, provider, 'default_model');
    return [provider, {
      baseUrl,
      defaultModel,
      defaultThinking: optionalString(metadata.default_thinking) ?? 'medium',
      credentialRequirementKind: optionalString(requirement.kind) ?? 'none',
      credentialSecretRef: optionalString(requirement.secret_ref) ?? optionalString(metadata.credential_secret_ref),
      credentialEnvNames: stringList(requirement.env_names ?? metadata.credential_env_names),
      baseUrlEnvNames: stringList(metadata.base_url_env_names),
      modelEnvNames: stringList(metadata.model_env_names),
    } satisfies WorkerProviderRuntimeMetadata];
  }));
}

export function resolveWorkerProviderRuntimeBindingFromRegistry(options: {
  registry: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  providerOverride?: string | null;
  modelOverride?: string | null;
  baseUrlOverride?: string | null;
  apiKeyOverride?: string | null;
  reasoningEffortOverride?: string | null;
  cognition?: 'low' | 'medium' | 'high';
}): WorkerProviderRuntimeBindingResolution {
  const registry = validateWorkerProviderRegistry(options.registry, { validateRuntimeMetadata: false });
  const providerFromEnvironment = optionalString(options.env.NARADA_INTELLIGENCE_PROVIDER);
  const provider = optionalString(options.providerOverride) ?? providerFromEnvironment ?? optionalString(registry.default_provider);
  if (!provider) {
    throw diagnosticError('worker_provider_registry_default_missing', 'worker_provider_registry_default_missing');
  }
  const rawMetadata = asRecord(asRecord(registry.providers)[provider]);
  if (Object.keys(rawMetadata).length === 0) {
    throw diagnosticError('worker_provider_not_registered', 'worker_provider_not_registered', { provider });
  }
  const adapterKind = optionalString(rawMetadata.adapter_kind);
  if (!adapterKind || !SUPPORTED_WORKER_PROVIDER_ADAPTERS.includes(adapterKind)) {
    throw diagnosticError('worker_provider_adapter_unsupported', 'worker_provider_adapter_unsupported', {
      provider,
      adapter_kind: adapterKind,
      supported_adapter_kinds: [...SUPPORTED_WORKER_PROVIDER_ADAPTERS],
    });
  }

  const providerCognition = asRecord(asRecord(rawMetadata.cognition_defaults)[options.cognition ?? 'low']);
  const registryCognitionModel = optionalString(providerCognition.model);
  const registryDefaultModel = optionalString(rawMetadata.default_model);
  const availableModels = stringList(rawMetadata.available_models);
  const modelOverride = optionalString(options.modelOverride);
  const model = modelOverride ?? registryCognitionModel ?? registryDefaultModel;
  if (!model) {
    throw diagnosticError('worker_provider_model_missing', 'worker_provider_model_missing', { provider, cognition: options.cognition ?? 'low' });
  }
  if (availableModels.length > 0 && !availableModels.includes(model)) {
    throw diagnosticError('worker_provider_model_not_available', 'worker_provider_model_not_available', {
      provider,
      model,
      available_models: availableModels,
    });
  }

  const metadataByProvider = providerRuntimeMetadataFromRegistry(options.registry);
  const binding = resolveWorkerProviderRuntimeBinding({
    provider,
    metadataByProvider,
    env: options.env,
    model,
    reasoningEffort: optionalString(options.reasoningEffortOverride) ?? optionalString(providerCognition.reasoning_effort),
    apiKey: options.apiKeyOverride,
    baseUrl: options.baseUrlOverride,
  });
  return {
    schema: 'narada.carrier.provider_runtime_binding_resolution.v1',
    provider,
    provider_source: optionalString(options.providerOverride)
      ? 'test_override'
      : providerFromEnvironment === provider ? 'canonical_environment' : 'registry_default',
    adapter_kind: adapterKind,
    model_source: modelOverride ? 'test_override' : registryCognitionModel ? 'provider_registry_cognition_default' : 'provider_registry_default',
    base_url_source: optionalString(options.baseUrlOverride)
      ? 'test_override'
      : options.env.NARADA_INTELLIGENCE_PROVIDER === provider && optionalString(options.env.NARADA_AI_BASE_URL)
        ? 'canonical_environment'
        : metadataByProvider[provider].baseUrlEnvNames.some((name) => optionalString(options.env[name]))
          ? 'provider_environment'
          : 'provider_registry_default',
    reasoning_effort_source: optionalString(options.reasoningEffortOverride)
      ? 'test_override'
      : options.env.NARADA_INTELLIGENCE_PROVIDER === provider && optionalString(options.env.NARADA_AI_THINKING)
        ? 'canonical_environment'
        : 'provider_registry_default',
    binding,
    redacted_binding: redactWorkerProviderRuntimeBinding(binding),
  };
}

export function validateWorkerProviderRegistry(
  registry: Record<string, unknown>,
  options: { validateRuntimeMetadata?: boolean } = {},
): Record<string, unknown> {
  if (registry.schema !== PROVIDER_REGISTRY_SCHEMA) {
    throw diagnosticError('worker_provider_registry_malformed', 'worker_provider_registry_malformed', {
      expected_schema: PROVIDER_REGISTRY_SCHEMA,
      actual_schema: registry.schema ?? null,
    });
  }
  const providers = asRecord(registry.providers);
  if (Object.keys(providers).length === 0) {
    throw diagnosticError('worker_provider_registry_malformed', 'worker_provider_registry_malformed', { field: 'providers' });
  }
  for (const [provider, metadata] of Object.entries(providers)) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw diagnosticError('worker_provider_registry_malformed', 'worker_provider_registry_malformed', { provider, field: 'metadata' });
    }
  }
  // This is the only registry-to-runtime metadata interpretation used by the
  // worker. It intentionally fails closed for missing base/model fields. The
  // resolver can defer this check until after provider/model selection so a
  // missing selected model retains its precise diagnostic.
  if (options.validateRuntimeMetadata !== false) providerRuntimeMetadataFromRegistry(registry);
  return registry;
}

export function resolveWorkerProviderRuntimeBinding(options: {
  provider: string;
  metadataByProvider: Record<string, WorkerProviderRuntimeMetadata>;
  env: NodeJS.ProcessEnv;
  model: string | null;
  reasoningEffort: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
}): WorkerProviderRuntimeBinding {
  const metadata = options.metadataByProvider[options.provider];
  if (!metadata) throw diagnosticError('worker_provider_metadata_missing', 'worker_provider_metadata_missing', { provider: options.provider });
  const parentProvider = optionalString(options.env.NARADA_INTELLIGENCE_PROVIDER);
  const explicitCredential = optionalString(options.apiKey);
  const canonicalCredential = parentProvider === options.provider ? optionalString(options.env.NARADA_AI_API_KEY) : null;
  const providerCredential = firstEnvironmentValue(metadata.credentialEnvNames, options.env);
  const apiKey = explicitCredential ?? canonicalCredential ?? providerCredential;
  if (metadata.credentialRequirementKind === 'api_key_secret' && !apiKey) {
    throw diagnosticError('worker_provider_credential_missing', 'worker_provider_credential_missing', {
      provider: options.provider,
      credential_secret_ref: metadata.credentialSecretRef,
      credential_env_names: metadata.credentialEnvNames,
    });
  }
  const baseUrl = optionalString(options.baseUrl)
    ?? (parentProvider === options.provider ? optionalString(options.env.NARADA_AI_BASE_URL) : null)
    ?? firstEnvironmentValue(metadata.baseUrlEnvNames, options.env)
    ?? metadata.baseUrl;
  const model = optionalString(options.model)
    ?? (parentProvider === options.provider ? optionalString(options.env.NARADA_AI_MODEL) : null)
    ?? firstEnvironmentValue(metadata.modelEnvNames, options.env)
    ?? metadata.defaultModel;
  const reasoningEffort = optionalString(options.reasoningEffort)
    ?? (parentProvider === options.provider ? optionalString(options.env.NARADA_AI_THINKING) : null)
    ?? metadata.defaultThinking;
  return {
    schema: PROVIDER_RUNTIME_BINDING_SCHEMA,
    provider_id: options.provider,
    base_url: baseUrl,
    model,
    reasoning_effort: reasoningEffort,
    api_key: apiKey,
    credential_requirement_kind: metadata.credentialRequirementKind,
    credential_secret_ref: metadata.credentialSecretRef,
    credential_env_names: [...metadata.credentialEnvNames],
    base_url_env_names: [...metadata.baseUrlEnvNames],
    model_env_names: [...metadata.modelEnvNames],
    credential_source: explicitCredential ? 'explicit_override' : canonicalCredential ? 'canonical_environment' : providerCredential ? 'provider_environment' : 'not_required',
    credential_fingerprint: apiKey ? `sha256:${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}` : null,
  };
}

export function projectWorkerProviderRuntimeEnvironment(
  environment: Record<string, string>,
  binding: WorkerProviderRuntimeBinding,
  metadataByProvider: Record<string, WorkerProviderRuntimeMetadata>,
): void {
  for (const key of providerEnvironmentKeys(metadataByProvider)) delete environment[key];
  environment.NARADA_INTELLIGENCE_PROVIDER = binding.provider_id;
  environment.NARADA_AI_BASE_URL = binding.base_url;
  environment.NARADA_AI_MODEL = binding.model;
  environment.NARADA_AI_THINKING = binding.reasoning_effort;
  if (binding.api_key) environment.NARADA_AI_API_KEY = binding.api_key;
  if (binding.api_key && binding.credential_env_names[0]) environment[binding.credential_env_names[0]] = binding.api_key;
  if (binding.base_url_env_names[0]) environment[binding.base_url_env_names[0]] = binding.base_url;
  if (binding.model_env_names[0]) environment[binding.model_env_names[0]] = binding.model;
}

export function redactWorkerProviderRuntimeBinding(binding: WorkerProviderRuntimeBinding): Omit<WorkerProviderRuntimeBinding, 'api_key'> {
  const { api_key: _apiKey, ...redacted } = binding;
  return redacted;
}

export function providerEnvironmentKeys(metadataByProvider: Record<string, WorkerProviderRuntimeMetadata>): string[] {
  const keys = new Set<string>(CANONICAL_PROVIDER_ENV_KEYS);
  for (const metadata of Object.values(metadataByProvider)) {
    for (const key of [...metadata.credentialEnvNames, ...metadata.baseUrlEnvNames, ...metadata.modelEnvNames]) keys.add(key);
  }
  return [...keys];
}

function requiredString(value: unknown, provider: string, field: string): string {
  const result = optionalString(value);
  if (result) return result;
  throw diagnosticError('worker_provider_metadata_invalid', 'worker_provider_metadata_invalid', { provider, field });
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstEnvironmentValue(names: string[], env: NodeJS.ProcessEnv): string | null {
  for (const name of names) {
    const value = optionalString(env[name]);
    if (value) return value;
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(optionalString).filter((item): item is string => item !== null) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
