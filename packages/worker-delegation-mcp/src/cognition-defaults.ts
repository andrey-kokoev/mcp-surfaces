import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { diagnosticError } from './errors.js';
import type { WorkerCognition, WorkerCognitionDefaults } from './policy.js';

export type ProviderCognitionDefaults = Record<string, Record<WorkerCognition, WorkerCognitionDefaults>>;
export type CognitionDefaultsPersistence = {
  writeState: (path: string, content: string) => void;
  appendAudit: (path: string, line: string) => void;
};
export const EffectiveCognitionDefaultSchema = z.object({
  provider: z.string().trim().min(1).nullable(),
  model: z.string().trim().min(1).nullable(),
  reasoningEffort: z.string().trim().min(1).nullable(),
  source: z.enum(['provider_registry_default', 'site_runtime_override']),
}).strict();
export type EffectiveCognitionDefault = Required<z.infer<typeof EffectiveCognitionDefaultSchema>>;

export type CognitionDefaultsState = {
  path: string;
  auditPath: string;
  version: number;
  updatedAt: string | null;
  providerModels: Record<string, string[]>;
  sources: Record<string, Record<WorkerCognition, 'provider_registry' | 'site_runtime_override'>>;
  effectiveDefaults: Record<WorkerCognition, EffectiveCognitionDefault>;
};

const CognitionSchema = z.enum(['low', 'medium', 'high']);
// v1 historically persisted partial/nullable provider tiers and skipped any non-string pair on load.
const StoredTierSchema = z.object({ model: z.unknown().optional(), reasoning_effort: z.unknown().optional() }).strict();
const StoredProviderDefaultsSchema = z.object({ low: StoredTierSchema.optional(), medium: StoredTierSchema.optional(), high: StoredTierSchema.optional() }).strict();
const WritableStoredTierSchema = z.object({ model: z.string().trim().min(1), reasoning_effort: z.string().trim().min(1) }).strict();
const WritableStoredProviderDefaultsSchema = z.object({ low: WritableStoredTierSchema.optional(), medium: WritableStoredTierSchema.optional(), high: WritableStoredTierSchema.optional() }).strict();
const StoredEffectiveTupleSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoning_effort: z.string().trim().min(1) }).strict();
const StoredDefaultsSchema = z.object({
  schema: z.literal('narada.worker.cognition_defaults.v1'),
  version: z.number().int().positive(),
  updated_at: z.string().min(1),
  provider_cognition_defaults: z.record(z.string().min(1), StoredProviderDefaultsSchema),
  effective_cognition_defaults: z.object({ low: StoredEffectiveTupleSchema.optional(), medium: StoredEffectiveTupleSchema.optional(), high: StoredEffectiveTupleSchema.optional() }).strict().optional(),
}).strict();
const WritableStoredDefaultsSchema = StoredDefaultsSchema.extend({
  provider_cognition_defaults: z.record(z.string().min(1), WritableStoredProviderDefaultsSchema),
});
type StoredDefaults = z.infer<typeof StoredDefaultsSchema>;

const CognitionUpdateSchema = z.object({
  provider: z.string().trim().min(1),
  cognition: CognitionSchema,
  model: z.string().trim().min(1),
  reasoning_effort: z.string().trim().min(1),
  actor: z.preprocess(
    (value) => typeof value === 'string' && value.trim() ? value : undefined,
    z.string().trim().min(1).optional(),
  ),
}).strict();

const COGNITIONS: WorkerCognition[] = CognitionSchema.options;

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
  defaultProvider: string | null;
}): { state: CognitionDefaultsState; defaults: ProviderCognitionDefaults } {
  const { path, auditPath } = cognitionDefaultsPaths(options.siteRoot);
  const defaults = cloneDefaults(options.registryDefaults);
  const sources = sourceMap(defaults, 'provider_registry');
  const effectiveDefaults = initialEffectiveDefaults(options.defaultProvider, defaults);
  let version = 0;
  let updatedAt: string | null = null;
  try {
    const stored = parseStoredDefaults(path);
    version = stored.version;
    updatedAt = typeof stored.updated_at === 'string' ? stored.updated_at : null;
    applyStoredDefaults(stored, options.providerModels, defaults, sources, effectiveDefaults);
  } catch (error) {
    if (existsSync(path)) {
      if (error && typeof error === 'object' && 'codeName' in error) throw error;
      throw diagnosticError('worker_cognition_defaults_invalid', 'worker_cognition_defaults_invalid', { path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { state: { path, auditPath, version, updatedAt, providerModels: cloneModels(options.providerModels), sources, effectiveDefaults }, defaults };
}

export function updateCognitionDefault(options: {
  state: CognitionDefaultsState;
  defaults: ProviderCognitionDefaults;
  provider: unknown;
  cognition: unknown;
  model: unknown;
  reasoningEffort: unknown;
  actor?: unknown;
  persistence?: Partial<CognitionDefaultsPersistence>;
  lockTimeoutMs?: number;
}): Record<string, unknown> {
  const parsed = CognitionUpdateSchema.safeParse({
    provider: options.provider,
    cognition: options.cognition,
    model: options.model,
    reasoning_effort: options.reasoningEffort,
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
  if (!parsed.success) throw updateSchemaDiagnostic(parsed.error, options.cognition);
  const { provider, cognition, model, reasoning_effort: reasoningEffort, actor } = parsed.data;
  const availableModels = options.state.providerModels[provider];
  if (!availableModels) throw diagnosticError('worker_cognition_provider_not_allowed', 'worker_cognition_provider_not_allowed', { provider, allowed_providers: Object.keys(options.state.providerModels).sort() });
  if (!availableModels.includes(model)) throw diagnosticError('worker_cognition_model_not_allowed', 'worker_cognition_model_not_allowed', { provider, model, available_models: availableModels });
  if (!options.defaults[provider]) throw diagnosticError('worker_cognition_defaults_missing', 'worker_cognition_defaults_missing', { provider });
  const releaseLock = acquireCognitionDefaultsLock(options.state.path, options.lockTimeoutMs);
  try {
    const staged = stageCognitionDefaults(options.state, options.defaults);
    const previous = staged.defaults[provider][cognition];
    const previousEffective = staged.effectiveDefaults[cognition];
    staged.defaults[provider][cognition] = { model, reasoningEffort };
    staged.sources[provider] ??= {} as Record<WorkerCognition, 'provider_registry' | 'site_runtime_override'>;
    staged.sources[provider][cognition] = 'site_runtime_override';
    staged.effectiveDefaults[cognition] = parseEffectiveCognitionDefault({ provider, model, reasoningEffort, source: 'site_runtime_override' });
    staged.version += 1;
    staged.updatedAt = new Date().toISOString();
    const event = {
      schema: 'narada.worker.cognition_defaults.audit.v1',
      event: 'cognition_default_updated',
      at: staged.updatedAt,
      version: staged.version,
      actor: actor ?? 'mcp_client',
      provider,
      cognition,
      previous: { provider: previousEffective?.provider ?? null, model: previousEffective?.model ?? previous?.model ?? null, reasoning_effort: previousEffective?.reasoningEffort ?? previous?.reasoningEffort ?? null },
      current: { provider, model, reasoning_effort: reasoningEffort },
      applicability: 'future_new_runs_only; existing_and_resumed_sessions_keep_their_resolved_settings_unless_explicitly_overridden',
    };
    const stored = WritableStoredDefaultsSchema.safeParse({
      schema: 'narada.worker.cognition_defaults.v1',
      version: staged.version,
      updated_at: staged.updatedAt,
      provider_cognition_defaults: serializeDefaults(staged.defaults, staged.sources),
      effective_cognition_defaults: serializeEffectiveDefaults(staged.effectiveDefaults),
    });
    if (!stored.success) throw schemaDiagnostic('worker_cognition_defaults_write_invalid', stored.error, { path: options.state.path });
    mkdirSync(dirname(options.state.path), { recursive: true });
    persistCognitionDefaults(
      options.state.path,
      options.state.auditPath,
      `${JSON.stringify(stored.data, null, 2)}\n`,
      `${JSON.stringify(event)}\n`,
      options.persistence,
    );
    commitCognitionDefaults(options.state, options.defaults, staged);
    return { schema: 'narada.worker.cognition_defaults.update.v1', status: 'updated', ...event, persistence: { path: options.state.path, audit_path: options.state.auditPath } };
  } finally {
    releaseLock();
  }
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
    effective_cognition_defaults: Object.fromEntries(COGNITIONS.map((cognition) => [cognition, {
      provider: state.effectiveDefaults[cognition]?.provider ?? null,
      model: state.effectiveDefaults[cognition]?.model ?? null,
      reasoning_effort: state.effectiveDefaults[cognition]?.reasoningEffort ?? null,
      source: state.effectiveDefaults[cognition]?.source ?? 'provider_registry_default',
      precedence: 'per_run_override > site_effective_cognition_default > explicit_provider_registry_default > global_provider_registry_default > generic_cognition_default',
    }])),
    provider_models: cloneModels(state.providerModels),
    applicability: 'updates affect future new runs only; existing and resumed sessions retain their resolved settings unless explicitly overridden',
    persistence: { path: state.path, audit_path: state.auditPath },
  };
}

type StagedCognitionDefaults = {
  defaults: ProviderCognitionDefaults;
  sources: CognitionDefaultsState['sources'];
  effectiveDefaults: CognitionDefaultsState['effectiveDefaults'];
  version: number;
  updatedAt: string | null;
};

type FileSnapshot = { existed: boolean; content: string | null };

const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function stageCognitionDefaults(state: CognitionDefaultsState, defaults: ProviderCognitionDefaults): StagedCognitionDefaults {
  const staged: StagedCognitionDefaults = {
    defaults: cloneDefaults(defaults),
    sources: cloneSources(state.sources),
    effectiveDefaults: cloneEffectiveDefaults(state.effectiveDefaults),
    version: state.version,
    updatedAt: state.updatedAt,
  };
  if (!existsSync(state.path)) return staged;
  const stored = parseStoredDefaults(state.path);
  staged.version = Math.max(staged.version, stored.version);
  staged.updatedAt = stored.updated_at;
  applyStoredDefaults(stored, state.providerModels, staged.defaults, staged.sources, staged.effectiveDefaults);
  return staged;
}

function applyStoredDefaults(
  stored: StoredDefaults,
  providerModels: Record<string, string[]>,
  defaults: ProviderCognitionDefaults,
  sources: CognitionDefaultsState['sources'],
  effectiveDefaults: CognitionDefaultsState['effectiveDefaults'],
): void {
  for (const [provider, byCognition] of Object.entries(stored.provider_cognition_defaults ?? {})) {
    if (!defaults[provider] || !providerModels[provider]) continue;
    for (const cognition of COGNITIONS) {
      const candidate = byCognition?.[cognition];
      const model = stringOrNull(candidate?.model);
      const reasoningEffort = stringOrNull(candidate?.reasoning_effort);
      if (!model || !reasoningEffort || !providerModels[provider].includes(model)) continue;
      defaults[provider][cognition] = { model, reasoningEffort };
      sources[provider] ??= {} as Record<WorkerCognition, 'provider_registry' | 'site_runtime_override'>;
      sources[provider][cognition] = 'site_runtime_override';
    }
  }
  for (const cognition of COGNITIONS) {
    const candidate = stored.effective_cognition_defaults?.[cognition];
    const provider = stringOrNull(candidate?.provider);
    const model = stringOrNull(candidate?.model);
    const reasoningEffort = stringOrNull(candidate?.reasoning_effort);
    if (!provider || !model || !reasoningEffort || !providerModels[provider]?.includes(model)) continue;
    effectiveDefaults[cognition] = parseEffectiveCognitionDefault({ provider, model, reasoningEffort, source: 'site_runtime_override' });
  }
}

function commitCognitionDefaults(state: CognitionDefaultsState, defaults: ProviderCognitionDefaults, staged: StagedCognitionDefaults): void {
  for (const [provider, byCognition] of Object.entries(staged.defaults)) defaults[provider] = byCognition;
  state.sources = staged.sources;
  state.effectiveDefaults = staged.effectiveDefaults;
  state.version = staged.version;
  state.updatedAt = staged.updatedAt;
}

function acquireCognitionDefaultsLock(statePath: string, timeoutMs = 5_000): () => void {
  const lockPath = `${statePath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(lockPath, 'wx');
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, 'utf8');
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { closeSync(descriptor!); } finally { rmSync(lockPath, { force: true }); }
      };
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* best effort */ }
        try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
      }
      const errorCode = (error as NodeJS.ErrnoException)?.code;
      // Windows can report EPERM/EACCES instead of EEXIST while another process
      // creates or removes the lock, including a window where an existence probe
      // already returns false. Treat those codes as bounded contention on Windows.
      const lockContended = errorCode === 'EEXIST'
        || (process.platform === 'win32' && (errorCode === 'EPERM' || errorCode === 'EACCES'));
      if (!lockContended) {
        throw diagnosticError('worker_cognition_defaults_lock_failed', 'worker_cognition_defaults_lock_failed', { path: lockPath, reason: error instanceof Error ? error.message : String(error) });
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* lock changed between inspection and retry */ }
      if (Date.now() - startedAt >= timeoutMs) {
        throw diagnosticError('worker_cognition_defaults_lock_timeout', 'worker_cognition_defaults_lock_timeout', { path: lockPath, timeout_ms: timeoutMs });
      }
      Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
    }
  }
}

function persistCognitionDefaults(
  statePath: string,
  auditPath: string,
  stateContent: string,
  auditLine: string,
  persistence: Partial<CognitionDefaultsPersistence> | undefined,
): void {
  const stateBefore = snapshotFile(statePath);
  const auditBefore = snapshotFile(auditPath);
  const writeState = persistence?.writeState ?? ((path: string, content: string) => writeFileSync(path, content, 'utf8'));
  const appendAudit = persistence?.appendAudit ?? ((path: string, line: string) => appendFileSync(path, line, 'utf8'));
  let phase = 'state_write';
  try {
    writeState(statePath, stateContent);
    phase = 'audit_append';
    appendAudit(auditPath, auditLine);
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const [path, snapshot] of [[statePath, stateBefore], [auditPath, auditBefore]] as const) {
      try { restoreFile(path, snapshot); } catch (rollbackError) { rollbackErrors.push(`${path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    }
    throw diagnosticError('worker_cognition_defaults_persistence_failed', 'worker_cognition_defaults_persistence_failed', {
      phase,
      reason: error instanceof Error ? error.message : String(error),
      rollback_status: rollbackErrors.length === 0 ? 'restored' : 'restore_failed',
      rollback_errors: rollbackErrors,
    });
  }
}

function snapshotFile(path: string): FileSnapshot {
  return existsSync(path) ? { existed: true, content: readFileSync(path, 'utf8') } : { existed: false, content: null };
}

function restoreFile(path: string, snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, snapshot.content ?? '', 'utf8');
}

function initialEffectiveDefaults(defaultProvider: string | null, defaults: ProviderCognitionDefaults): Record<WorkerCognition, EffectiveCognitionDefault> {
  const provider = defaultProvider && defaults[defaultProvider] ? defaultProvider : Object.keys(defaults)[0] ?? null;
  return Object.fromEntries(COGNITIONS.map((cognition) => [cognition, parseEffectiveCognitionDefault({
    provider,
    model: provider ? defaults[provider]?.[cognition]?.model ?? null : null,
    reasoningEffort: provider ? defaults[provider]?.[cognition]?.reasoningEffort ?? null : null,
    source: 'provider_registry_default',
  })])) as Record<WorkerCognition, EffectiveCognitionDefault>;
}

function serializeEffectiveDefaults(defaults: Record<WorkerCognition, EffectiveCognitionDefault>) {
  return Object.fromEntries(COGNITIONS.filter((cognition) => defaults[cognition]?.source === 'site_runtime_override').map((cognition) => [cognition, {
    provider: defaults[cognition].provider,
    model: defaults[cognition].model,
    reasoning_effort: defaults[cognition].reasoningEffort,
  }]));
}

function parseStoredDefaults(path: string): StoredDefaults {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw diagnosticError('worker_cognition_defaults_invalid_json', 'worker_cognition_defaults_invalid_json', { path, reason: error instanceof Error ? error.message : String(error) });
  }
  const parsed = StoredDefaultsSchema.safeParse(value);
  if (!parsed.success) throw schemaDiagnostic('worker_cognition_defaults_invalid', parsed.error, { path });
  return parsed.data;
}

function parseEffectiveCognitionDefault(value: unknown): EffectiveCognitionDefault {
  const parsed = EffectiveCognitionDefaultSchema.safeParse(value);
  if (!parsed.success) throw schemaDiagnostic('worker_cognition_default_invalid', parsed.error);
  return parsed.data as EffectiveCognitionDefault;
}

function updateSchemaDiagnostic(error: z.ZodError, cognition: unknown) {
  const field = String(error.issues[0]?.path[0] ?? '');
  const code = field === 'provider'
    ? 'worker_cognition_provider_required'
    : field === 'cognition'
      ? 'worker_invalid_cognition'
      : field === 'model'
        ? 'worker_cognition_model_required'
        : field === 'reasoning_effort'
          ? 'worker_cognition_reasoning_effort_required'
          : 'worker_cognition_defaults_update_invalid';
  return schemaDiagnostic(code, error, field === 'cognition' ? { cognition, allowed_cognition: COGNITIONS } : {});
}

function schemaDiagnostic(code: string, error: z.ZodError, details: Record<string, unknown> = {}) {
  return diagnosticError(code, code, {
    ...details,
    validation_issues: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })),
  });
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

function cloneSources(value: CognitionDefaultsState['sources']): CognitionDefaultsState['sources'] {
  return Object.fromEntries(Object.entries(value).map(([provider, byCognition]) => [provider, { ...byCognition }])) as CognitionDefaultsState['sources'];
}

function cloneEffectiveDefaults(value: CognitionDefaultsState['effectiveDefaults']): CognitionDefaultsState['effectiveDefaults'] {
  return Object.fromEntries(COGNITIONS.map((cognition) => [cognition, { ...value[cognition] }])) as CognitionDefaultsState['effectiveDefaults'];
}

function sourceMap(defaults: ProviderCognitionDefaults, source: 'provider_registry' | 'site_runtime_override'): CognitionDefaultsState['sources'] {
  return Object.fromEntries(Object.keys(defaults).map((provider) => [provider, Object.fromEntries(COGNITIONS.map((cognition) => [cognition, source]))])) as CognitionDefaultsState['sources'];
}

function cloneModels(value: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value).map(([provider, models]) => [provider, [...models]]));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
