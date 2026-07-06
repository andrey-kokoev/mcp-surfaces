export type JsonRecord = Record<string, unknown>;

export const NARADA_MCP_AFFORDANCES_SCHEMA = 'narada.mcp_affordances.v1' as const;

export type AffordanceAudience = 'operator' | 'agent' | 'maintainer';
export type AffordanceActionKind = 'tool_call' | 'resource_read' | 'prompt_get' | 'external_link';
export type AffordanceDangerLevel = 'none' | 'low' | 'medium' | 'high';
export type AffordanceIntent =
  | 'inspect'
  | 'refresh'
  | 'run'
  | 'pause'
  | 'resume'
  | 'acknowledge'
  | 'recover'
  | 'configure'
  | 'open';
export type AffordancePanelKind = 'status' | 'health' | 'attention' | 'runs' | 'controls' | 'diagnostics' | 'custom';
export type AffordanceRefreshMode = 'none' | 'manual' | 'poll';
export type AffordanceConditionState = 'available' | 'disabled' | 'hidden';

export type AffordanceToolTarget = {
  kind: 'tool';
  tool: string;
  arguments?: JsonRecord;
};

export type AffordanceResourceTarget = {
  kind: 'resource';
  uri: string;
};

export type AffordancePromptTarget = {
  kind: 'prompt';
  prompt: string;
  arguments?: JsonRecord;
};

export type AffordanceExternalTarget = {
  kind: 'external';
  uri: string;
};

export type AffordanceTarget =
  | AffordanceToolTarget
  | AffordanceResourceTarget
  | AffordancePromptTarget
  | AffordanceExternalTarget;

export type AffordanceCondition = {
  state: AffordanceConditionState;
  reason?: string;
  evidence?: JsonRecord;
};

export type AffordanceAction = {
  id: string;
  label: string;
  intent: AffordanceIntent;
  kind: AffordanceActionKind;
  target: AffordanceTarget;
  description?: string;
  audience?: AffordanceAudience[];
  danger_level?: AffordanceDangerLevel;
  read_only?: boolean;
  idempotent?: boolean;
  destructive?: boolean;
  confirmation?: {
    required: boolean;
    message?: string;
  };
  preconditions?: AffordanceCondition[];
  input_schema?: JsonRecord;
};

export type AffordanceMetric = {
  id: string;
  label: string;
  value: string | number | boolean | null;
  unit?: string;
  severity?: 'info' | 'ok' | 'warning' | 'error';
};

export type AffordancePanel = {
  id: string;
  title: string;
  kind: AffordancePanelKind;
  description?: string;
  audience?: AffordanceAudience[];
  priority?: number;
  metrics?: AffordanceMetric[];
  actions?: string[];
  refs?: string[];
  data?: JsonRecord;
};

export type AffordanceRef = {
  id: string;
  label: string;
  target: AffordanceTarget;
  description?: string;
  mime_type?: string;
};

export type AffordanceRefresh = {
  mode: AffordanceRefreshMode;
  interval_ms?: number;
  actions?: string[];
};

export type NaradaMcpAffordanceDocument = {
  schema: typeof NARADA_MCP_AFFORDANCES_SCHEMA;
  surface_id: string;
  generated_at: string;
  title?: string;
  audience: AffordanceAudience[];
  summary?: string;
  panels: AffordancePanel[];
  actions: AffordanceAction[];
  refs?: AffordanceRef[];
  refresh?: AffordanceRefresh;
  source?: {
    tool?: string;
    site_id?: string | null;
    site_root?: string | null;
  };
};

export type AffordanceValidationResult = {
  status: 'ok' | 'invalid';
  errors: string[];
};

export function createAffordanceDocument(input: Omit<NaradaMcpAffordanceDocument, 'schema' | 'generated_at'> & { generated_at?: string }): NaradaMcpAffordanceDocument {
  return {
    schema: NARADA_MCP_AFFORDANCES_SCHEMA,
    generated_at: input.generated_at ?? new Date().toISOString(),
    ...input,
  };
}

export function validateAffordanceDocument(value: unknown): AffordanceValidationResult {
  const errors: string[] = [];
  const document = asRecord(value);
  requireExact(errors, document.schema, NARADA_MCP_AFFORDANCES_SCHEMA, 'schema');
  requireNonEmptyString(errors, document.surface_id, 'surface_id');
  requireIsoLikeString(errors, document.generated_at, 'generated_at');
  requireStringArray(errors, document.audience, 'audience', ALLOWED_AUDIENCES);
  requireArray(errors, document.panels, 'panels');
  requireArray(errors, document.actions, 'actions');

  const actionIds = new Set<string>();
  for (const [index, rawAction] of arrayItems(document.actions).entries()) {
    const action = asRecord(rawAction);
    const path = `actions[${index}]`;
    const id = requireNonEmptyString(errors, action.id, `${path}.id`);
    if (id) {
      if (actionIds.has(id)) errors.push(`${path}.id_duplicate:${id}`);
      actionIds.add(id);
    }
    requireNonEmptyString(errors, action.label, `${path}.label`);
    requireEnum(errors, action.intent, ALLOWED_INTENTS, `${path}.intent`);
    requireEnum(errors, action.kind, ALLOWED_ACTION_KINDS, `${path}.kind`);
    validateTarget(errors, action.target, `${path}.target`);
    if (action.audience !== undefined) requireStringArray(errors, action.audience, `${path}.audience`, ALLOWED_AUDIENCES);
    if (action.danger_level !== undefined) requireEnum(errors, action.danger_level, ALLOWED_DANGER_LEVELS, `${path}.danger_level`);
    if (action.input_schema !== undefined && !isRecord(action.input_schema)) errors.push(`${path}.input_schema_object_required`);
  }

  const refIds = new Set<string>();
  for (const [index, rawRef] of arrayItems(document.refs).entries()) {
    const ref = asRecord(rawRef);
    const path = `refs[${index}]`;
    const id = requireNonEmptyString(errors, ref.id, `${path}.id`);
    if (id) {
      if (refIds.has(id)) errors.push(`${path}.id_duplicate:${id}`);
      refIds.add(id);
    }
    requireNonEmptyString(errors, ref.label, `${path}.label`);
    validateTarget(errors, ref.target, `${path}.target`);
  }

  for (const [index, rawPanel] of arrayItems(document.panels).entries()) {
    const panel = asRecord(rawPanel);
    const path = `panels[${index}]`;
    requireNonEmptyString(errors, panel.id, `${path}.id`);
    requireNonEmptyString(errors, panel.title, `${path}.title`);
    requireEnum(errors, panel.kind, ALLOWED_PANEL_KINDS, `${path}.kind`);
    if (panel.audience !== undefined) requireStringArray(errors, panel.audience, `${path}.audience`, ALLOWED_AUDIENCES);
    for (const actionId of arrayItems(panel.actions)) {
      if (typeof actionId !== 'string' || !actionIds.has(actionId)) errors.push(`${path}.actions_unknown:${String(actionId)}`);
    }
    for (const refId of arrayItems(panel.refs)) {
      if (typeof refId !== 'string' || !refIds.has(refId)) errors.push(`${path}.refs_unknown:${String(refId)}`);
    }
  }

  if (document.refresh !== undefined) {
    const refresh = asRecord(document.refresh);
    requireEnum(errors, refresh.mode, ALLOWED_REFRESH_MODES, 'refresh.mode');
    if (refresh.interval_ms !== undefined && (!Number.isInteger(refresh.interval_ms) || Number(refresh.interval_ms) <= 0)) {
      errors.push('refresh.interval_ms_positive_integer_required');
    }
    for (const actionId of arrayItems(refresh.actions)) {
      if (typeof actionId !== 'string' || !actionIds.has(actionId)) errors.push(`refresh.actions_unknown:${String(actionId)}`);
    }
  }

  return { status: errors.length === 0 ? 'ok' : 'invalid', errors };
}

export function affordanceToolAction(input: Omit<AffordanceAction, 'kind' | 'target'> & { tool: string; arguments?: JsonRecord }): AffordanceAction {
  return {
    ...input,
    kind: 'tool_call',
    target: { kind: 'tool', tool: input.tool, arguments: input.arguments },
  };
}

export function affordanceResourceRef(input: Omit<AffordanceRef, 'target'> & { uri: string }): AffordanceRef {
  return {
    ...input,
    target: { kind: 'resource', uri: input.uri },
  };
}

const ALLOWED_AUDIENCES = ['operator', 'agent', 'maintainer'] as const;
const ALLOWED_ACTION_KINDS = ['tool_call', 'resource_read', 'prompt_get', 'external_link'] as const;
const ALLOWED_DANGER_LEVELS = ['none', 'low', 'medium', 'high'] as const;
const ALLOWED_INTENTS = ['inspect', 'refresh', 'run', 'pause', 'resume', 'acknowledge', 'recover', 'configure', 'open'] as const;
const ALLOWED_PANEL_KINDS = ['status', 'health', 'attention', 'runs', 'controls', 'diagnostics', 'custom'] as const;
const ALLOWED_REFRESH_MODES = ['none', 'manual', 'poll'] as const;

export const affordanceDocumentJsonSchema = {
  $id: 'narada:mcp-affordances.v1.schema.json',
  title: 'Narada MCP Affordances',
  description: 'UI-neutral operator and agent affordance document emitted by MCP surfaces.',
  type: 'object',
  additionalProperties: true,
  required: ['schema', 'surface_id', 'generated_at', 'audience', 'panels', 'actions'],
  properties: {
    schema: { const: NARADA_MCP_AFFORDANCES_SCHEMA },
    surface_id: { type: 'string', minLength: 1 },
    generated_at: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    audience: { type: 'array', items: { enum: ALLOWED_AUDIENCES } },
    summary: { type: 'string' },
    panels: { type: 'array', items: { type: 'object' } },
    actions: { type: 'array', items: { type: 'object' } },
    refs: { type: 'array', items: { type: 'object' } },
    refresh: { type: 'object' },
    source: { type: 'object' },
  },
} as const;

function validateTarget(errors: string[], value: unknown, path: string): void {
  const target = asRecord(value);
  const kind = target.kind;
  if (!requireEnum(errors, kind, ['tool', 'resource', 'prompt', 'external'] as const, `${path}.kind`)) return;
  if (kind === 'tool') requireNonEmptyString(errors, target.tool, `${path}.tool`);
  if (kind === 'resource') requireNonEmptyString(errors, target.uri, `${path}.uri`);
  if (kind === 'prompt') requireNonEmptyString(errors, target.prompt, `${path}.prompt`);
  if (kind === 'external') requireNonEmptyString(errors, target.uri, `${path}.uri`);
}

function requireExact(errors: string[], value: unknown, expected: string, path: string): void {
  if (value !== expected) errors.push(`${path}_mismatch:${String(value)}`);
}

function requireNonEmptyString(errors: string[], value: unknown, path: string): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  errors.push(`${path}_non_empty_string_required`);
  return null;
}

function requireIsoLikeString(errors: string[], value: unknown, path: string): void {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return;
  errors.push(`${path}_iso_datetime_required`);
}

function requireArray(errors: string[], value: unknown, path: string): void {
  if (!Array.isArray(value)) errors.push(`${path}_array_required`);
}

function requireStringArray<T extends readonly string[]>(errors: string[], value: unknown, path: string, allowed: T): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}_array_required`);
    return;
  }
  for (const item of value) requireEnum(errors, item, allowed, `${path}[]`);
}

function requireEnum<T extends readonly string[]>(errors: string[], value: unknown, allowed: T, path: string): value is T[number] {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return true;
  errors.push(`${path}_invalid:${String(value)}`);
  return false;
}

function arrayItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
