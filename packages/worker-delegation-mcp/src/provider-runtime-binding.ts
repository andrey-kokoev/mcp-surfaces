import { createHash } from 'node:crypto';
import { diagnosticError } from './errors.js';

export const PROVIDER_RUNTIME_BINDING_SCHEMA = 'narada.carrier.provider_runtime_binding.v1' as const;

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
  credential_source: 'canonical_environment' | 'provider_environment' | 'not_required';
  credential_fingerprint: string | null;
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

export function resolveWorkerProviderRuntimeBinding(options: {
  provider: string;
  metadataByProvider: Record<string, WorkerProviderRuntimeMetadata>;
  env: NodeJS.ProcessEnv;
  model: string | null;
  reasoningEffort: string | null;
}): WorkerProviderRuntimeBinding {
  const metadata = options.metadataByProvider[options.provider];
  if (!metadata) throw diagnosticError('worker_provider_metadata_missing', 'worker_provider_metadata_missing', { provider: options.provider });
  const parentProvider = optionalString(options.env.NARADA_INTELLIGENCE_PROVIDER);
  const canonicalCredential = parentProvider === options.provider ? optionalString(options.env.NARADA_AI_API_KEY) : null;
  const providerCredential = firstEnvironmentValue(metadata.credentialEnvNames, options.env);
  const apiKey = canonicalCredential ?? providerCredential;
  if (metadata.credentialRequirementKind === 'api_key_secret' && !apiKey) {
    throw diagnosticError('worker_provider_credential_missing', 'worker_provider_credential_missing', {
      provider: options.provider,
      credential_secret_ref: metadata.credentialSecretRef,
      credential_env_names: metadata.credentialEnvNames,
    });
  }
  const baseUrl = (parentProvider === options.provider ? optionalString(options.env.NARADA_AI_BASE_URL) : null)
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
    credential_source: canonicalCredential ? 'canonical_environment' : providerCredential ? 'provider_environment' : 'not_required',
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
