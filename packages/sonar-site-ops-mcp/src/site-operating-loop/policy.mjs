import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SITE_OPERATING_LOOP_POLICY_SCHEMA = 'narada.site_operating_loop.policy.v1';

export const DEFAULT_SITE_OPERATING_LOOP_POLICY = {
  schema: SITE_OPERATING_LOOP_POLICY_SCHEMA,
  loop_id: 'site.operating-loop',
  cadence: {
    supervise_interval_ms: 60_000,
    lock_ttl_ms: 5 * 60_000,
    busy_turn_timeout_ms: 10 * 60_000,
  },
  carrier: {
    preferred: 'interactive_agent_cli',
    fallback: 'agent-runtime-server',
    fallback_enabled: true,
    require_policy_current: true,
  },
  source_sync: {
    daemon_default_enabled: true,
    max_batch_size: 25,
  },
  rate_limits: {
    max_directives_per_cycle: 25,
    max_restarts_per_window: 3,
    restart_window_ms: 10 * 60_000,
  },
  quiet_hours: {
    enabled: false,
    timezone: 'America/Chicago',
    start: null,
    end: null,
  },
  attention: {},
};

export function operatingLoopPolicyPath(cwd) {
  return join(resolve(cwd), '.narada', 'capabilities', 'operating-loop-policy.json');
}

export function loadSiteOperatingLoopPolicy(cwd, options = {}) {
  const path = options.path ?? operatingLoopPolicyPath(cwd);
  const defaults = options.defaults ?? DEFAULT_SITE_OPERATING_LOOP_POLICY;
  const loaded = existsSync(path) ? readPolicy(path, defaults.schema) : {};
  if (loaded?.load_error) {
    const policy = mergeSiteOperatingLoopPolicy(defaults, loaded);
    return {
      schema: 'narada.site_operating_loop.policy_load.v1',
      status: 'invalid',
      path,
      source: 'site_policy_file',
      policy,
      validation: {
        schema: 'narada.site_operating_loop.policy_validation.v1',
        status: 'invalid',
        errors: ['policy_parse_error'],
        load_error: loaded.load_error,
      },
    };
  }
  const policy = mergeSiteOperatingLoopPolicy(defaults, loaded);
  const validation = validateSiteOperatingLoopPolicy(policy, options.validation ?? {});
  return {
    schema: 'narada.site_operating_loop.policy_load.v1',
    status: validation.status,
    path,
    source: existsSync(path) ? 'site_policy_file' : 'defaults',
    policy,
    validation,
  };
}

export function validateSiteOperatingLoopPolicy(policy, options = {}) {
  const errors = [];
  const expectedSchema = options.expectedSchema ?? SITE_OPERATING_LOOP_POLICY_SCHEMA;
  if (policy?.schema !== expectedSchema) errors.push('schema_mismatch');
  if (options.expectedLoopId && policy?.loop_id !== options.expectedLoopId) errors.push('unsupported_loop_id');
  for (const [key, min] of [
    ['supervise_interval_ms', 1_000],
    ['lock_ttl_ms', 30_000],
    ['busy_turn_timeout_ms', 30_000],
  ]) {
    const value = Number(policy?.cadence?.[key]);
    if (!Number.isFinite(value) || value < min) errors.push(`invalid_cadence:${key}`);
  }
  if (options.allowedPreferredCarriers && !options.allowedPreferredCarriers.includes(policy?.carrier?.preferred)) {
    errors.push('invalid_preferred_carrier');
  }
  if (options.allowedFallbackCarriers && !options.allowedFallbackCarriers.includes(policy?.carrier?.fallback)) {
    errors.push('invalid_fallback_carrier');
  }
  if (typeof policy?.carrier?.fallback_enabled !== 'boolean') errors.push('invalid_fallback_enabled');
  for (const [path, min] of [
    ['source_sync.max_batch_size', 1],
    ['rate_limits.max_directives_per_cycle', 1],
    ['rate_limits.max_restarts_per_window', 0],
    ['rate_limits.restart_window_ms', 60_000],
  ]) {
    const value = path.split('.').reduce((cursor, key) => cursor?.[key], policy);
    if (!Number.isFinite(Number(value)) || Number(value) < min) errors.push(`invalid_policy_number:${path}`);
  }
  if (typeof policy?.quiet_hours?.enabled !== 'boolean') errors.push('invalid_quiet_hours:enabled');
  if (policy?.quiet_hours?.enabled) {
    if (!policy.quiet_hours.start || !policy.quiet_hours.end) errors.push('invalid_quiet_hours:window_required');
    if (!policy.quiet_hours.timezone) errors.push('invalid_quiet_hours:timezone_required');
  }
  return {
    schema: 'narada.site_operating_loop.policy_validation.v1',
    status: errors.length === 0 ? 'ok' : 'invalid',
    errors,
  };
}

export function currentQuietHoursState(policy, options = {}) {
  const quiet = policy?.quiet_hours ?? {};
  if (quiet.enabled !== true) {
    return {
      schema: 'narada.site_operating_loop.quiet_hours_state.v1',
      active: false,
      reason: 'disabled',
    };
  }
  const start = parseClockMinutes(quiet.start);
  const end = parseClockMinutes(quiet.end);
  if (start == null || end == null) {
    return {
      schema: 'narada.site_operating_loop.quiet_hours_state.v1',
      active: false,
      reason: 'invalid_window',
      start: quiet.start ?? null,
      end: quiet.end ?? null,
    };
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const nowMinutes = localClockMinutes(now, quiet.timezone);
  const active = start === end
    ? true
    : start < end
      ? nowMinutes >= start && nowMinutes < end
      : nowMinutes >= start || nowMinutes < end;
  return {
    schema: 'narada.site_operating_loop.quiet_hours_state.v1',
    active,
    reason: active ? 'within_quiet_hours' : 'outside_quiet_hours',
    timezone: quiet.timezone,
    start: quiet.start,
    end: quiet.end,
    local_minutes: nowMinutes,
  };
}

export function mergeSiteOperatingLoopPolicy(base, override) {
  return {
    ...base,
    ...override,
    cadence: {
      ...base.cadence,
      ...(override?.cadence ?? {}),
    },
    carrier: {
      ...base.carrier,
      ...(override?.carrier ?? {}),
    },
    source_sync: {
      ...base.source_sync,
      ...(override?.source_sync ?? {}),
    },
    rate_limits: {
      ...base.rate_limits,
      ...(override?.rate_limits ?? {}),
    },
    quiet_hours: {
      ...base.quiet_hours,
      ...(override?.quiet_hours ?? {}),
    },
    attention: {
      ...base.attention,
      ...(override?.attention ?? {}),
    },
  };
}

function readPolicy(path, fallbackSchema) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      schema: fallbackSchema,
      load_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseClockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function localClockMinutes(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
    return (hour % 24) * 60 + minute;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}
