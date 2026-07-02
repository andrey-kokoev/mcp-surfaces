import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TelemetryEventKind = 'tool_started' | 'tool_completed' | 'tool_refused' | 'tool_failed';
export type TelemetrySensitivity = 'low' | 'medium' | 'high';
export type TelemetryArgPolicy = 'none' | 'schema_safe' | 'redacted';
export type TelemetryResultPolicy = 'none' | 'summary' | 'redacted_summary';
export type TelemetryLevel = 'off' | 'errors_only' | 'all';
export type TelemetrySink = 'site-local-jsonl';
export type JsonRecord = Record<string, unknown>;

export type TelemetryDeclaration = {
  events: TelemetryEventKind[];
  sensitivity?: TelemetrySensitivity;
  args?: TelemetryArgPolicy;
  result?: TelemetryResultPolicy;
  timing?: boolean;
  policy_decision?: boolean;
  authority_locus?: boolean;
};

export type TelemetryPolicy = {
  enabled: boolean;
  sink: TelemetrySink;
  level: TelemetryLevel;
  include_args: boolean;
  include_results: boolean;
  retention_days: number | null;
  surfaces: Record<string, SurfaceTelemetryPolicy>;
};

export type SurfaceTelemetryPolicy = {
  enabled?: boolean;
  level?: TelemetryLevel;
  include_args?: boolean;
  include_results?: boolean;
};

export type TelemetryContext = {
  siteRoot: string;
  siteId?: string | null;
  surfaceId: string;
  agentId?: string | null;
  carrierSessionId?: string | null;
  authorityLocus?: JsonRecord | null;
};

export type TelemetryEventInput = {
  toolName: string;
  eventKind: TelemetryEventKind;
  status: string;
  startedAt?: number | Date | string | null;
  completedAt?: number | Date | string | null;
  durationMs?: number | null;
  correlationId?: string | null;
  policyDecision?: JsonRecord | null;
  errorCode?: string | null;
  refusalCode?: string | null;
};

export type TelemetryEmitResult = {
  status: 'disabled' | 'skipped' | 'emitted';
  reason?: string;
  path?: string;
  event?: JsonRecord;
};

export type TelemetryDeclarationPreset = {
  events?: TelemetryEventKind[];
  sensitivity?: TelemetrySensitivity;
  timing?: boolean;
  policyDecision?: boolean;
  authorityLocus?: boolean;
};

const POLICY_PATH = '.ai/mcp-telemetry.json';
const DEFAULT_POLICY: TelemetryPolicy = {
  enabled: false,
  sink: 'site-local-jsonl',
  level: 'errors_only',
  include_args: false,
  include_results: false,
  retention_days: null,
  surfaces: {},
};

export function loadTelemetryPolicy(siteRootInput: string): TelemetryPolicy {
  const siteRoot = resolve(siteRootInput);
  const path = join(siteRoot, POLICY_PATH);
  if (!existsSync(path)) return { ...DEFAULT_POLICY, surfaces: {} };
  const config = asRecord(JSON.parse(readFileSync(path, 'utf8')));
  return normalizeTelemetryPolicy(config);
}

export function buildMetadataOnlyTelemetryDeclaration(preset: TelemetryDeclarationPreset = {}): TelemetryDeclaration {
  return {
    events: preset.events ?? ['tool_completed', 'tool_refused', 'tool_failed'],
    sensitivity: preset.sensitivity ?? 'medium',
    args: 'none',
    result: 'none',
    timing: preset.timing ?? true,
    policy_decision: preset.policyDecision ?? false,
    authority_locus: preset.authorityLocus ?? false,
  };
}

export function buildReadOnlyTelemetryDeclaration(preset: Omit<TelemetryDeclarationPreset, 'sensitivity'> & { sensitivity?: Extract<TelemetrySensitivity, 'low' | 'medium'> } = {}): TelemetryDeclaration {
  return buildPathMetadataTelemetryDeclaration(preset);
}

export function buildWriteTelemetryDeclaration(preset: Omit<TelemetryDeclarationPreset, 'sensitivity' | 'policyDecision'> & { sensitivity?: Extract<TelemetrySensitivity, 'medium' | 'high'> } = {}): TelemetryDeclaration {
  return buildCommandMetadataTelemetryDeclaration(preset);
}

export function buildPathMetadataTelemetryDeclaration(preset: Omit<TelemetryDeclarationPreset, 'sensitivity'> & { sensitivity?: Extract<TelemetrySensitivity, 'low' | 'medium'> } = {}): TelemetryDeclaration {
  return buildMetadataOnlyTelemetryDeclaration({ ...preset, sensitivity: preset.sensitivity ?? 'low' });
}

export function buildCommandMetadataTelemetryDeclaration(preset: Omit<TelemetryDeclarationPreset, 'sensitivity'> & { sensitivity?: Extract<TelemetrySensitivity, 'medium' | 'high'> } = {}): TelemetryDeclaration {
  return buildMetadataOnlyTelemetryDeclaration({ ...preset, sensitivity: preset.sensitivity ?? 'high', policyDecision: preset.policyDecision ?? true });
}

export function buildGraphMailTelemetryDeclaration(preset: TelemetryDeclarationPreset = {}): TelemetryDeclaration {
  return buildMetadataOnlyTelemetryDeclaration({ ...preset, sensitivity: preset.sensitivity ?? 'medium' });
}

export function buildCalendarTelemetryDeclaration(preset: TelemetryDeclarationPreset = {}): TelemetryDeclaration {
  return buildMetadataOnlyTelemetryDeclaration({ ...preset, sensitivity: preset.sensitivity ?? 'medium' });
}

export function buildTaskTransitionTelemetryDeclaration(preset: TelemetryDeclarationPreset = {}): TelemetryDeclaration {
  return buildMetadataOnlyTelemetryDeclaration({ ...preset, sensitivity: preset.sensitivity ?? 'high' });
}

export function buildArtifactTelemetryDeclaration(preset: TelemetryDeclarationPreset = {}): TelemetryDeclaration {
  return buildMetadataOnlyTelemetryDeclaration({ ...preset, sensitivity: preset.sensitivity ?? 'low' });
}

export function normalizeTelemetryPolicy(config: JsonRecord): TelemetryPolicy {
  const surfaces = asRecord(config.surfaces);
  const normalizedSurfaces: Record<string, SurfaceTelemetryPolicy> = {};
  for (const [surfaceId, raw] of Object.entries(surfaces)) {
    const record = asRecord(raw);
    normalizedSurfaces[surfaceId] = {
      enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
      level: normalizeLevel(record.level),
      include_args: typeof record.include_args === 'boolean' ? record.include_args : typeof record.includeArgs === 'boolean' ? record.includeArgs : undefined,
      include_results: typeof record.include_results === 'boolean' ? record.include_results : typeof record.includeResults === 'boolean' ? record.includeResults : undefined,
    };
  }
  return {
    enabled: config.enabled === true,
    sink: config.sink === 'site-local-jsonl' ? 'site-local-jsonl' : 'site-local-jsonl',
    level: normalizeLevel(config.level) ?? DEFAULT_POLICY.level,
    include_args: config.include_args === true || config.includeArgs === true,
    include_results: config.include_results === true || config.includeResults === true,
    retention_days: positiveIntegerOrNull(config.retention_days ?? config.retentionDays),
    surfaces: normalizedSurfaces,
  };
}

export function emitTelemetryEvent(input: {
  policy?: TelemetryPolicy | null;
  context: TelemetryContext;
  declaration: TelemetryDeclaration;
  event: TelemetryEventInput;
}): TelemetryEmitResult {
  const policy = input.policy ?? loadTelemetryPolicy(input.context.siteRoot);
  const decision = decideTelemetryEmission(policy, input.context.surfaceId, input.declaration, input.event);
  if (!decision.emit) return { status: decision.disabled ? 'disabled' : 'skipped', reason: decision.reason };
  const event = buildTelemetryEvent(input.context, input.declaration, input.event, decision);
  const path = telemetryPath(input.context.siteRoot, input.context.surfaceId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
  return { status: 'emitted', path, event };
}

export function buildTelemetryEvent(
  context: TelemetryContext,
  declaration: TelemetryDeclaration,
  event: TelemetryEventInput,
  decision: { includePolicyDecision: boolean; includeAuthorityLocus: boolean; includeTiming: boolean }
): JsonRecord {
  const completedAt = event.completedAt ?? Date.now();
  const envelope: JsonRecord = {
    schema: 'narada.mcp_telemetry.event.v1',
    recorded_at: dateIso(completedAt),
    site_id: context.siteId ?? null,
    site_root: resolve(context.siteRoot),
    surface_id: context.surfaceId,
    tool_name: event.toolName,
    event_kind: event.eventKind,
    status: event.status,
    agent_id: context.agentId ?? process.env.NARADA_AGENT_ID ?? null,
    carrier_session_id: context.carrierSessionId ?? process.env.NARADA_CARRIER_SESSION_ID ?? null,
    correlation_id: event.correlationId ?? randomUUID(),
  };
  if (decision.includeTiming) {
    envelope.duration_ms = typeof event.durationMs === 'number'
      ? Math.max(0, Math.round(event.durationMs))
      : durationMs(event.startedAt, completedAt);
  }
  if (event.errorCode) envelope.error_code = event.errorCode;
  if (event.refusalCode) envelope.refusal_code = event.refusalCode;
  if (decision.includeAuthorityLocus && context.authorityLocus) envelope.authority_locus = context.authorityLocus;
  if (decision.includePolicyDecision && event.policyDecision) envelope.policy_decision = sanitizePolicyDecision(event.policyDecision);

  // V1 intentionally ignores declaration.args/result beyond gating; raw args/results are never accepted here.
  void declaration;
  return envelope;
}

export function decideTelemetryEmission(
  policy: TelemetryPolicy,
  surfaceId: string,
  declaration: TelemetryDeclaration,
  event: TelemetryEventInput
): { emit: boolean; disabled: boolean; reason?: string; includePolicyDecision: boolean; includeAuthorityLocus: boolean; includeTiming: boolean } {
  const base = { includePolicyDecision: false, includeAuthorityLocus: false, includeTiming: false };
  if (!policy.enabled) return { emit: false, disabled: true, reason: 'telemetry_disabled_by_site_policy', ...base };
  if (!declaration.events.includes(event.eventKind)) return { emit: false, disabled: false, reason: 'event_not_declared_for_tool', ...base };
  const surface = policy.surfaces[surfaceId] ?? {};
  if (surface.enabled === false) return { emit: false, disabled: true, reason: 'telemetry_disabled_for_surface', ...base };
  const level = surface.level ?? policy.level;
  if (level === 'off') return { emit: false, disabled: true, reason: 'telemetry_level_off', ...base };
  if (level === 'errors_only' && !isErrorLike(event)) return { emit: false, disabled: false, reason: 'telemetry_level_errors_only_skipped_success', ...base };
  if ((surface.include_args ?? policy.include_args) && declaration.args && declaration.args !== 'none') {
    return { emit: false, disabled: false, reason: 'args_persistence_not_supported_in_v1', ...base };
  }
  if ((surface.include_results ?? policy.include_results) && declaration.result && declaration.result !== 'none') {
    return { emit: false, disabled: false, reason: 'result_persistence_not_supported_in_v1', ...base };
  }
  return {
    emit: true,
    disabled: false,
    includePolicyDecision: declaration.policy_decision === true,
    includeAuthorityLocus: declaration.authority_locus === true,
    includeTiming: declaration.timing === true,
  };
}

export function telemetryPath(siteRootInput: string, surfaceId: string): string {
  return join(resolve(siteRootInput), '.ai', 'telemetry', `${safeFileSegment(surfaceId)}.jsonl`);
}

export function telemetryErrorCodeFromUnknown(error: unknown, fallback = 'tool_failed'): string {
  const record = asRecord(error);
  const candidate = typeof record.codeName === 'string' && record.codeName
    ? record.codeName
    : typeof record.code === 'string' && record.code
      ? record.code
      : error instanceof Error
        ? error.message
        : String(error);
  return telemetryCodeFromString(candidate, fallback);
}

export function telemetryRefusalCodeFromResult(result: JsonRecord, fallback = 'tool_refused'): string {
  const record = asRecord(result);
  const decision = asRecord(record.decision);
  const reasons = Array.isArray(decision.reasons) ? decision.reasons.filter((reason) => typeof reason === 'string' && reason.trim()) : [];
  const candidate = typeof record.refusal_code === 'string' && record.refusal_code
    ? record.refusal_code
    : typeof record.reason === 'string' && record.reason
      ? record.reason
      : typeof decision.code === 'string' && decision.code
        ? decision.code
        : typeof decision.reason === 'string' && decision.reason
          ? decision.reason
          : reasons.length > 0
            ? reasons[0]
            : typeof record.status === 'string'
              ? record.status
              : '';
  return telemetryCodeFromString(candidate, fallback);
}

function sanitizePolicyDecision(value: JsonRecord): JsonRecord {
  const status = typeof value.status === 'string' ? value.status : null;
  const code = typeof value.code === 'string'
    ? value.code
    : typeof value.reason === 'string'
      ? value.reason
      : null;
  const result: JsonRecord = {};
  if (status) result.status = status;
  if (code) result.code = code;
  return result;
}

function isErrorLike(event: TelemetryEventInput): boolean {
  return event.eventKind === 'tool_failed' || event.eventKind === 'tool_refused' || event.status === 'error' || event.status === 'failed' || event.status === 'refused' || !!event.errorCode || !!event.refusalCode;
}

function dateIso(value: number | Date | string | null | undefined): string {
  const date = value instanceof Date ? value : typeof value === 'number' || typeof value === 'string' ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function durationMs(startedAt: number | Date | string | null | undefined, completedAt: number | Date | string | null | undefined): number | null {
  if (startedAt == null || completedAt == null) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round(end - start));
}

function normalizeLevel(value: unknown): TelemetryLevel | undefined {
  return value === 'off' || value === 'errors_only' || value === 'all' ? value : undefined;
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function telemetryCodeFromString(value: string, fallback: string): string {
  const candidate = String(value ?? '').trim().split(/[:\s]/)[0]?.trim() ?? '';
  return /^[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : fallback;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
