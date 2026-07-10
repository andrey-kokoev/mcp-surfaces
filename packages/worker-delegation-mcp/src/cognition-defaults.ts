import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { diagnosticError } from './errors.js';
import type { WorkerCognition, WorkerCognitionDefaults } from './policy.js';

export type ProviderCognitionDefaults = Record<string, Record<WorkerCognition, WorkerCognitionDefaults>>;

export type CognitionDefaultsState = {
  path: string;
  auditPath: string;
  version: number;
  updatedAt: string | null;
  providerModels: Record<string, string[]>;
  sources: Record<string, Record<WorkerCognition, 'provider_registry' | 'site_runtime_override'>>;
};

type StoredDefaults = {
  schema: 'narada.worker.cognition_defaults.v1';
  version: number;
  updated_at: string;
  provider_cognition_defaults: Record<string, Record<string, { model?: unknown; reasoning_effort?: unknown }>>;
};

const COGNITIONS: WorkerCognition[] = ['low', 'medium', 'high'];

export function cognitionDefaultsPaths(siteRoot: string): { path: string; auditPath: string } {
  const controlRoot = resolve(join(siteRoot, '.narada'));
  return {
    path: join(controlRoot, 'worker-cognition-defaults.json'),
    auditPath: join(controlRoot, 'worker-cognition-defaults.audit.jsonl'),
  };
}

export function loadCognitionDefaultsState(options: {
  siteRoot: string;
  providerModels: Record<string, string[]>;
  registryDefaults: ProviderCognitionDefaults;
}): { state: CognitionDefaultsState; defaults: ProviderCognitionDefaults } {
  const { path, auditPath } = cognitionDefaultsPaths(options.siteRoot);
  const defaults = cloneDefaults(options.registryDefaults);
  const sources = sourceMap(defaults, 'provider_registry');
  let version = 0;
  let updatedAt: string | null = null;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredDefaults;
    if (stored.schema !== 'narada.worker.cognition_defaults.v1' || !Number.isInteger(stored.version) || stored.version < 1) throw new Error('invalid');
    version = stored.version;
    updatedAt = typeof stored.updated_at === 'string' ? stored.updated_at : null;
    for (const [provider, byCognition] of Object.entries(stored.provider_cognition_defaults ?? {})) {
      if (!defaults[provider] || !options.providerModels[provider]) continue;
      for (const cognition of COGNITIONS) {
        const candidate = byCognition?.[cognition];
        const model = stringOrNull(candidate?.model);
        const reasoningEffort = stringOrNull(candidate?.reasoning_effort);
        if (!model || !reasoningEffort || !options.providerModels[provider].includes(model)) continue;
        defaults[provider][cognition] = { model, reasoningEffort };
        sources[provider][cognition] = 'site_runtime_override';
      }
    }
  } catch (error) {
    if (existsSync(path)) throw diagnosticError('worker_cognition_defaults_invalid', 'worker_cognition_defaults_invalid', { path });
  }
  return { state: { path, auditPath, version, updatedAt, providerModels: cloneModels(options.providerModels), sources }, defaults };
}

export function updateCognitionDefault(options: {
  state: CognitionDefaultsState;
  defaults: ProviderCognitionDefaults;
  provider: unknown;
  cognition: unknown;
  model: unknown;
  reasoningEffort: unknown;
  actor?: unknown;
}): Record<string, unknown> {
  const provider = requiredString(options.provider, 'worker_cognition_provider_required');
  const cognition = requiredCognition(options.cognition);
  const model = requiredString(options.model, 'worker_cognition_model_required');
  const reasoningEffort = requiredString(options.reasoningEffort, 'worker_cognition_reasoning_effort_required');
  const availableModels = options.state.providerModels[provider];
  if (!availableModels) throw diagnosticError('worker_cognition_provider_not_allowed', 'worker_cognition_provider_not_allowed', { provider, allowed_providers: Object.keys(options.state.providerModels).sort() });
  if (!availableModels.includes(model)) throw diagnosticError('worker_cognition_model_not_allowed', 'worker_cognition_model_not_allowed', { provider, model, available_models: availableModels });
  if (!options.defaults[provider]) throw diagnosticError('worker_cognition_defaults_missing', 'worker_cognition_defaults_missing', { provider });
  const previous = options.defaults[provider][cognition];
  const next = { model, reasoningEffort };
  options.defaults[provider][cognition] = next;
  options.state.sources[provider] ??= {} as Record<WorkerCognition, 'provider_registry' | 'site_runtime_override'>;
  options.state.sources[provider][cognition] = 'site_runtime_override';
  options.state.version += 1;
  options.state.updatedAt = new Date().toISOString();
  const event = {
    schema: 'narada.worker.cognition_defaults.audit.v1',
    event: 'cognition_default_updated',
    at: options.state.updatedAt,
    version: options.state.version,
    actor: typeof options.actor === 'string' && options.actor.trim() ? options.actor.trim() : 'mcp_client',
    provider,
    cognition,
    previous: { model: previous?.model ?? null, reasoning_effort: previous?.reasoningEffort ?? null },
    current: { model, reasoning_effort: reasoningEffort },
    applicability: 'future_new_runs_only; existing_and_resumed_sessions_keep_their_resolved_settings_unless_explicitly_overridden',
  };
  mkdirSync(dirname(options.state.path), { recursive: true });
  writeFileSync(options.state.path, `${JSON.stringify({
    schema: 'narada.worker.cognition_defaults.v1',
    version: options.state.version,
    updated_at: options.state.updatedAt,
    provider_cognition_defaults: serializeDefaults(options.defaults, options.state.sources),
  }, null, 2)}\n`, 'utf8');
  appendFileSync(options.state.auditPath, `${JSON.stringify(event)}\n`, 'utf8');
  return { schema: 'narada.worker.cognition_defaults.update.v1', status: 'updated', ...event, persistence: { path: options.state.path, audit_path: options.state.auditPath } };
}

export function publicCognitionDefaults(state: CognitionDefaultsState, defaults: ProviderCognitionDefaults): Record<string, unknown> {
  return {
    schema: 'narada.worker.cognition_defaults.v1',
    status: 'ok',
    version: state.version,
    updated_at: state.updatedAt,
    provider_cognition_defaults: Object.fromEntries(Object.entries(defaults).map(([provider, byCognition]) => [provider, Object.fromEntries(COGNITIONS.map((cognition) => [cognition, {
      model: byCognition[cognition]?.model ?? null,
      reasoning_effort: byCognition[cognition]?.reasoningEffort ?? null,
      source: state.sources[provider]?.[cognition] ?? 'provider_registry',
      precedence: 'per_run_override > site_runtime_override > provider_registry > generic_cognition_default',
    }]))])),
    provider_models: cloneModels(state.providerModels),
    applicability: 'updates affect future new runs only; existing and resumed sessions retain their resolved settings unless explicitly overridden',
    persistence: { path: state.path, audit_path: state.auditPath },
  };
}

function serializeDefaults(defaults: ProviderCognitionDefaults, sources: CognitionDefaultsState['sources']) {
  const stored: Record<string, Record<string, { model: string | null; reasoning_effort: string | null }>> = {};
  for (const [provider, byCognition] of Object.entries(defaults)) {
    const overrides: Record<string, { model: string | null; reasoning_effort: string | null }> = {};
    for (const cognition of COGNITIONS) {
      if (sources[provider]?.[cognition] !== 'site_runtime_override') continue;
      overrides[cognition] = {
        model: byCognition[cognition].model,
        reasoning_effort: byCognition[cognition].reasoningEffort,
      };
    }
    if (Object.keys(overrides).length > 0) stored[provider] = overrides;
  }
  return stored;
}

function cloneDefaults(value: ProviderCognitionDefaults): ProviderCognitionDefaults {
  return Object.fromEntries(Object.entries(value).map(([provider, byCognition]) => [provider, Object.fromEntries(COGNITIONS.map((cognition) => [cognition, { ...byCognition[cognition] }]))])) as ProviderCognitionDefaults;
}

function sourceMap(defaults: ProviderCognitionDefaults, source: 'provider_registry' | 'site_runtime_override'): CognitionDefaultsState['sources'] {
  return Object.fromEntries(Object.keys(defaults).map((provider) => [provider, Object.fromEntries(COGNITIONS.map((cognition) => [cognition, source]))])) as CognitionDefaultsState['sources'];
}

function cloneModels(value: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value).map(([provider, models]) => [provider, [...models]]));
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw diagnosticError(code, code);
  return value.trim();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredCognition(value: unknown): WorkerCognition {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw diagnosticError('worker_invalid_cognition', 'worker_invalid_cognition', { cognition: value, allowed_cognition: COGNITIONS });
}
