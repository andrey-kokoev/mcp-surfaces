import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const PROVIDER_REGISTRY_SCHEMA = 'narada.provider_registry.v2' as const;
export const PROVIDER_REGISTRY_VERSION = 2 as const;

export const CAPABILITIES = ['llm', 'tts', 'transcription'] as const;
export type Capability = typeof CAPABILITIES[number];

export const ADAPTER_IDS = ['sapi', 'openai-tts', 'openai-transcription', 'llm-runtime'] as const;
export type AdapterId = typeof ADAPTER_IDS[number];

export const MODEL_STATUSES = ['active', 'deprecated', 'disabled'] as const;
export type ModelStatus = typeof MODEL_STATUSES[number];

const adapterSchema = z.enum(ADAPTER_IDS);
const modelStatusSchema = z.enum(MODEL_STATUSES);

const voiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
}).strict();

const modelCapabilitySchema = z.object({
  adapter: adapterSchema,
  voices: z.array(voiceSchema).optional(),
  default_voice: z.string().min(1).nullable().optional(),
}).strict();

const modelSchema = z.object({
  id: z.string().min(1),
  status: modelStatusSchema,
  capabilities: z.object({
    llm: modelCapabilitySchema.optional(),
    tts: modelCapabilitySchema.optional(),
    transcription: modelCapabilitySchema.optional(),
  }).strict(),
}).strict();

const providerCapabilitySchema = z.object({
  default_model: z.string().min(1),
}).strict();

const credentialRequirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('api_key_secret'),
    secret_ref: z.string().min(1),
    env_names: z.array(z.string().min(1)).optional(),
  }).strict(),
]);

const providerSchema = z.object({
  id: z.string().min(1).optional(),
  models: z.record(z.string().min(1), modelSchema),
  capabilities: z.object({
    llm: providerCapabilitySchema.optional(),
    tts: providerCapabilitySchema.optional(),
    transcription: providerCapabilitySchema.optional(),
  }).strict(),
  credential_requirement: credentialRequirementSchema,
  base_url: z.string().url().optional(),
}).strict();

const selectionSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  voice: z.string().min(1).optional(),
}).strict();

const registryDefaultSchema = selectionSchema.extend({
  provider: z.string().min(1),
}).strict();

const registrySchema = z.object({
  schema: z.literal(PROVIDER_REGISTRY_SCHEMA),
  version: z.literal(PROVIDER_REGISTRY_VERSION),
  defaults: z.object({
    llm: registryDefaultSchema.optional(),
    tts: registryDefaultSchema.optional(),
    transcription: registryDefaultSchema.optional(),
  }).strict(),
  providers: z.record(z.string().min(1), providerSchema),
}).strict();

export type ProviderRegistry = z.infer<typeof registrySchema>;
export type ProviderRecord = ProviderRegistry['providers'][string];
export type ProviderModel = ProviderRecord['models'][string];
export type CapabilitySelection = z.infer<typeof selectionSchema>;
export type CapabilityPolicy = Partial<Record<Capability, CapabilitySelection>>;
export type ResolvedCapabilitySelection = {
  provider: string;
  model: string;
  capability: Capability;
  adapter: AdapterId;
  voice?: string;
  status: Exclude<ModelStatus, 'disabled'>;
  source: 'request' | 'site_policy' | 'registry';
  warnings: string[];
};

export class ProviderRegistryError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProviderRegistryError';
    this.code = code;
    this.details = details;
  }
}

export function loadProviderRegistrySync(path: string): ProviderRegistry {
  const registryPath = String(path ?? '').trim();
  if (!registryPath) throw new ProviderRegistryError('provider_registry_path_required', 'provider_registry_path_required');
  let content: string;
  try {
    content = readFileSync(registryPath, 'utf8');
  } catch (error) {
    throw new ProviderRegistryError('provider_registry_missing', `provider_registry_missing:${registryPath}`, { path: registryPath, cause: error instanceof Error ? error.message : String(error) });
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ProviderRegistryError('provider_registry_invalid_json', `provider_registry_invalid_json:${registryPath}`, { path: registryPath, cause: error instanceof Error ? error.message : String(error) });
  }
  try {
    return parseProviderRegistry(value);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      error.details.path = registryPath;
      throw error;
    }
    throw new ProviderRegistryError('provider_registry_invalid', `provider_registry_invalid:${registryPath}`, { path: registryPath, cause: error instanceof Error ? error.message : String(error) });
  }
}

export function parseProviderRegistry(value: unknown): ProviderRegistry {
  const parsed = registrySchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderRegistryError('provider_registry_invalid', 'provider_registry_invalid', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }

  const registry = parsed.data;
  for (const [providerId, provider] of Object.entries(registry.providers)) {
    if (provider.id !== undefined && provider.id !== providerId) {
      throw new ProviderRegistryError('provider_registry_provider_id_mismatch', `provider_registry_provider_id_mismatch:${providerId}`, { provider: providerId, id: provider.id });
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.id !== modelId) {
        throw new ProviderRegistryError('provider_registry_model_id_mismatch', `provider_registry_model_id_mismatch:${providerId}/${modelId}`, { provider: providerId, model: modelId, id: model.id });
      }
      validateModelRecord(providerId, modelId, model);
    }
    for (const capability of CAPABILITIES) {
      const providerCapability = provider.capabilities[capability];
      if (!providerCapability) continue;
      const defaultModel = provider.models[providerCapability.default_model];
      if (!defaultModel) {
        throw new ProviderRegistryError('provider_registry_default_model_missing', `provider_registry_default_model_missing:${providerId}/${capability}`, { provider: providerId, capability, model: providerCapability.default_model });
      }
      if (!defaultModel.capabilities[capability]) {
        throw new ProviderRegistryError('provider_registry_default_model_capability_missing', `provider_registry_default_model_capability_missing:${providerId}/${capability}`, { provider: providerId, capability, model: providerCapability.default_model });
      }
    }
  }

  for (const capability of CAPABILITIES) {
    const selection = registry.defaults[capability];
    if (!selection) continue;
    validateProviderRootedSelection(registry, capability, selection, `defaults.${capability}`);
  }
  return registry;
}

export async function loadProviderRegistry(path: string): Promise<ProviderRegistry> {
  const registryPath = String(path ?? '').trim();
  if (!registryPath) throw new ProviderRegistryError('provider_registry_path_required', 'provider_registry_path_required');
  let content: string;
  try {
    content = await readFile(registryPath, 'utf8');
  } catch (error) {
    throw new ProviderRegistryError('provider_registry_missing', `provider_registry_missing:${registryPath}`, { path: registryPath, cause: error instanceof Error ? error.message : String(error) });
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ProviderRegistryError('provider_registry_invalid_json', `provider_registry_invalid_json:${registryPath}`, { path: registryPath, cause: error instanceof Error ? error.message : String(error) });
  }
  try {
    return parseProviderRegistry(value);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      error.details.path = registryPath;
      throw error;
    }
    throw new ProviderRegistryError('provider_registry_invalid', `provider_registry_invalid:${registryPath}`, { path: registryPath, cause: error instanceof Error ? error.message : String(error) });
  }
}

export function resolveCapabilitySelection(input: {
  registry: ProviderRegistry;
  capability: Capability;
  selection?: unknown;
  sitePolicy?: unknown;
}): ResolvedCapabilitySelection {
  const { registry, capability } = input;
  const request = parseSelection(input.selection, 'request');
  const policy = parsePolicySelection(input.sitePolicy, capability);
  const chosen = request ?? policy ?? registry.defaults[capability];
  const source = request ? 'request' : policy ? 'site_policy' : 'registry';
  if (!chosen) {
    throw new ProviderRegistryError('provider_capability_default_missing', `provider_capability_default_missing:${capability}`, { capability, source });
  }
  if (chosen.model && !chosen.provider) {
    throw new ProviderRegistryError('provider_root_required_for_model', `provider_root_required_for_model:${capability}`, { capability, model: chosen.model, source });
  }
  const providerId = chosen.provider;
  if (!providerId) {
    throw new ProviderRegistryError('provider_required', `provider_required:${capability}`, { capability, source });
  }
  const provider = registry.providers[providerId];
  if (!provider) {
    throw new ProviderRegistryError('provider_not_registered', `provider_not_registered:${providerId}`, { provider: providerId, capability, source });
  }
  const providerCapability = provider.capabilities[capability];
  if (!providerCapability) {
    throw new ProviderRegistryError('provider_capability_unavailable', `provider_capability_unavailable:${providerId}/${capability}`, { provider: providerId, capability, source });
  }
  const modelId = chosen.model ?? providerCapability.default_model;
  const model = provider.models[modelId];
  if (!model) {
    throw new ProviderRegistryError('model_not_registered', `model_not_registered:${providerId}/${modelId}`, { provider: providerId, model: modelId, capability, source });
  }
  const modelCapability = model.capabilities[capability];
  if (!modelCapability) {
    throw new ProviderRegistryError('model_capability_unavailable', `model_capability_unavailable:${providerId}/${modelId}/${capability}`, { provider: providerId, model: modelId, capability, source });
  }
  if (model.status === 'disabled') {
    throw new ProviderRegistryError('model_disabled', `model_disabled:${providerId}/${modelId}`, { provider: providerId, model: modelId, capability, source });
  }
  const warnings = model.status === 'deprecated' ? [`model_deprecated:${providerId}/${modelId}`] : [];
  const voice = resolveVoice(chosen.voice, modelCapability, providerId, modelId);
  return {
    provider: providerId,
    model: modelId,
    capability,
    adapter: modelCapability.adapter,
    ...(voice ? { voice } : {}),
    status: model.status,
    source,
    warnings,
  };
}

export function listCapabilityCatalog(registry: ProviderRegistry, capability: Capability): Array<Record<string, unknown>> {
  return Object.entries(registry.providers).flatMap(([provider, providerRecord]) => {
    const providerCapability = providerRecord.capabilities[capability];
    if (!providerCapability) return [];
    return Object.entries(providerRecord.models)
      .filter(([, model]) => Boolean(model.capabilities[capability]))
      .map(([model, modelRecord]) => {
        const capabilityRecord = modelRecord.capabilities[capability];
        return {
          provider,
          model,
          adapter: capabilityRecord?.adapter ?? null,
          status: modelRecord.status,
          default: model === providerCapability.default_model,
          ...(capabilityRecord?.voices ? { voices: capabilityRecord.voices } : {}),
          ...(capabilityRecord?.default_voice ? { default_voice: capabilityRecord.default_voice } : {}),
        };
      });
  });
}

function validateModelRecord(providerId: string, modelId: string, model: ProviderModel): void {
  for (const capability of CAPABILITIES) {
    const record = model.capabilities[capability];
    if (!record?.voices) continue;
    const voiceIds = new Set<string>();
    for (const voice of record.voices) {
      if (voiceIds.has(voice.id)) {
        throw new ProviderRegistryError('provider_registry_duplicate_voice', `provider_registry_duplicate_voice:${providerId}/${modelId}/${voice.id}`, { provider: providerId, model: modelId, capability, voice: voice.id });
      }
      voiceIds.add(voice.id);
    }
    if (record.default_voice && !voiceIds.has(record.default_voice)) {
      throw new ProviderRegistryError('provider_registry_default_voice_missing', `provider_registry_default_voice_missing:${providerId}/${modelId}/${record.default_voice}`, { provider: providerId, model: modelId, capability, voice: record.default_voice });
    }
  }
}

function validateProviderRootedSelection(registry: ProviderRegistry, capability: Capability, selection: CapabilitySelection, path: string): void {
  if (selection.model && !selection.provider) {
    throw new ProviderRegistryError('provider_root_required_for_model', `provider_root_required_for_model:${path}`, { path, capability, model: selection.model });
  }
  if (!selection.provider) return;
  const provider = registry.providers[selection.provider];
  if (!provider) throw new ProviderRegistryError('provider_not_registered', `provider_not_registered:${selection.provider}`, { path, provider: selection.provider, capability });
  const providerCapability = provider.capabilities[capability];
  if (!providerCapability) throw new ProviderRegistryError('provider_capability_unavailable', `provider_capability_unavailable:${selection.provider}/${capability}`, { path, provider: selection.provider, capability });
  const model = selection.model ?? providerCapability.default_model;
  if (!provider.models[model]) throw new ProviderRegistryError('model_not_registered', `model_not_registered:${selection.provider}/${model}`, { path, provider: selection.provider, model, capability });
  if (!provider.models[model].capabilities[capability]) throw new ProviderRegistryError('model_capability_unavailable', `model_capability_unavailable:${selection.provider}/${model}/${capability}`, { path, provider: selection.provider, model, capability });
}

function parseSelection(value: unknown, source: string): CapabilitySelection | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = selectionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderRegistryError('provider_selection_invalid', `provider_selection_invalid:${source}`, { source, issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  }
  if (!parsed.data.provider && !parsed.data.model && !parsed.data.voice) return undefined;
  return parsed.data;
}

function parsePolicySelection(value: unknown, capability: Capability): CapabilitySelection | undefined {
  if (value === undefined || value === null) return undefined;
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const candidate = record[capability] ?? value;
  return parseSelection(candidate, 'site_policy');
}

function resolveVoice(voice: string | undefined, capabilityRecord: z.infer<typeof modelCapabilitySchema>, provider: string, model: string): string | undefined {
  const selected = voice ?? capabilityRecord.default_voice ?? undefined;
  if (!selected) return undefined;
  if (capabilityRecord.voices && !capabilityRecord.voices.some((item) => item.id === selected)) {
    throw new ProviderRegistryError('voice_not_registered', `voice_not_registered:${provider}/${model}/${selected}`, { provider, model, voice: selected });
  }
  return selected;
}
