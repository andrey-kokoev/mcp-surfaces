import { createHash } from 'node:crypto';

export const MAX_INLINE_VALUE_BYTES = 16 * 1024;
export const MAX_RUN_STATE_BYTES = 128 * 1024;
export const MAX_TEMPLATE_DEFINITION_BYTES = 128 * 1024;
export const MAX_STEPS = 128;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ValueRef = {
  ref: string;
  sha256: string;
  byte_length: number | null;
  media_type: string | null;
};

export type StepValueView = {
  step_id: string;
  status: string;
  result: JsonValue;
  result_ref: ValueRef | null;
};

export type ValueContext = {
  input: JsonValue;
  input_ref: ValueRef | null;
  steps: StepValueView[];
};

export type Condition =
  | { ref: string; op: 'equals' | 'not_equals' | 'exists' | 'not_exists' | 'truthy' | 'falsy' | 'in' | 'contains'; value?: JsonValue }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export class SopContractError extends Error {
  readonly codeName: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.codeName = code;
    this.details = details;
  }
}

function assertReferenceSyntax(ref: string): void {
  if (ref === 'input' || ref === 'input_ref') return;
  if (/^(input|input_ref)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(ref)) return;
  if (/^steps\.[A-Za-z0-9][A-Za-z0-9_-]*\.(status|result|result_ref)(?:\.[A-Za-z0-9_-]+)*$/.test(ref)) return;
  throw new SopContractError('sop_reference_invalid', { ref, allowed_roots: ['input', 'input_ref', 'steps.<dependency>.status', 'steps.<dependency>.result', 'steps.<dependency>.result_ref'] });
}

export function validateMappingReferences(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isJsonObject(candidate)) return;
    const keys = Object.keys(candidate);
    if (keys.length === 1 && keys[0] === '$ref') {
      const ref = requiredBoundedString(candidate.$ref, '$ref', 512);
      assertReferenceSyntax(ref);
      return;
    }
    for (const entry of Object.values(candidate)) visit(entry);
  };
  visit(value);
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value, 'sop_json_value_invalid');
  return JSON.stringify(canonicalize(value as JsonValue));
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function deterministicId(prefix: string, value: string, hexLength = 24): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, hexLength);
  return `${prefix}${digest}`;
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function assertInlineValue(value: unknown, field: string, maxBytes = MAX_INLINE_VALUE_BYTES): asserts value is JsonValue {
  assertJsonValue(value, `${field}_invalid`);
  const byteLength = jsonByteLength(value);
  if (byteLength > maxBytes) {
    throw new SopContractError(`${field}_too_large`, { field, byte_length: byteLength, max_bytes: maxBytes, remediation: `Store the payload with its owning surface and provide a bounded immutable ${field}_ref.` });
  }
}

export function assertSerializedBound(value: unknown, field: string, maxBytes: number): void {
  const byteLength = jsonByteLength(value);
  if (byteLength > maxBytes) throw new SopContractError(`${field}_too_large`, { field, byte_length: byteLength, max_bytes: maxBytes });
}

export function normalizeValueRef(value: unknown, field: string): ValueRef | null {
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) throw new SopContractError(`${field}_invalid`, { field, reason: 'must_be_object' });
  rejectUnknownKeys(value, new Set(['ref', 'sha256', 'byte_length', 'media_type']), `${field}_invalid`);
  const ref = requiredBoundedString(value.ref, `${field}.ref`, 2048);
  const sha256 = requiredBoundedString(value.sha256, `${field}.sha256`, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new SopContractError(`${field}_invalid`, { field, reason: 'sha256_must_be_64_lowercase_hex' });
  let byteLength: number | null = null;
  if (value.byte_length !== undefined && value.byte_length !== null) {
    if (!Number.isSafeInteger(value.byte_length) || Number(value.byte_length) < 0) throw new SopContractError(`${field}_invalid`, { field, reason: 'byte_length_must_be_nonnegative_safe_integer' });
    byteLength = Number(value.byte_length);
  }
  const mediaType = value.media_type === undefined || value.media_type === null
    ? null
    : requiredBoundedString(value.media_type, `${field}.media_type`, 200);
  return { ref, sha256, byte_length: byteLength, media_type: mediaType };
}

export function normalizeCondition(value: unknown, field = 'when'): Condition | null {
  if (value === undefined || value === null) return null;
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): Condition => {
    nodes += 1;
    if (depth > 12 || nodes > 64) throw new SopContractError('sop_condition_too_complex', { field, max_depth: 12, max_nodes: 64 });
    if (!isJsonObject(candidate)) throw new SopContractError('sop_condition_invalid', { field, reason: 'condition_must_be_object' });
    const keys = Object.keys(candidate);
    if (keys.length === 1 && keys[0] === 'all') {
      if (!Array.isArray(candidate.all) || candidate.all.length === 0) throw new SopContractError('sop_condition_invalid', { field, reason: 'all_requires_nonempty_array' });
      return { all: candidate.all.map((entry) => visit(entry, depth + 1)) };
    }
    if (keys.length === 1 && keys[0] === 'any') {
      if (!Array.isArray(candidate.any) || candidate.any.length === 0) throw new SopContractError('sop_condition_invalid', { field, reason: 'any_requires_nonempty_array' });
      return { any: candidate.any.map((entry) => visit(entry, depth + 1)) };
    }
    if (keys.length === 1 && keys[0] === 'not') return { not: visit(candidate.not, depth + 1) };
    rejectUnknownKeys(candidate, new Set(['ref', 'op', 'value']), 'sop_condition_invalid');
    const ref = requiredBoundedString(candidate.ref, `${field}.ref`, 512);
    assertReferenceSyntax(ref);
    const op = requiredBoundedString(candidate.op, `${field}.op`, 32);
    const allowed = ['equals', 'not_equals', 'exists', 'not_exists', 'truthy', 'falsy', 'in', 'contains'] as const;
    if (!allowed.includes(op as typeof allowed[number])) throw new SopContractError('sop_condition_invalid', { field, reason: 'unsupported_operator', op, allowed });
    if (!['exists', 'not_exists', 'truthy', 'falsy'].includes(op) && !Object.hasOwn(candidate, 'value')) {
      throw new SopContractError('sop_condition_invalid', { field, reason: 'operator_requires_value', op });
    }
    if (Object.hasOwn(candidate, 'value')) assertInlineValue(candidate.value, 'sop_condition_value');
    if (op === 'in' && !Array.isArray(candidate.value)) throw new SopContractError('sop_condition_invalid', { field, reason: 'in_value_must_be_array' });
    return Object.hasOwn(candidate, 'value')
      ? { ref, op: op as Extract<Condition, { ref: string }>['op'], value: candidate.value as JsonValue }
      : { ref, op: op as Extract<Condition, { ref: string }>['op'] };
  };
  return visit(value, 0);
}

export function evaluateCondition(condition: Condition | null, context: ValueContext): boolean {
  if (!condition) return true;
  if ('all' in condition) return condition.all.every((entry) => evaluateCondition(entry, context));
  if ('any' in condition) return condition.any.some((entry) => evaluateCondition(entry, context));
  if ('not' in condition) return !evaluateCondition(condition.not, context);
  const resolved = readValueRef(condition.ref, context);
  switch (condition.op) {
    case 'exists': return resolved.found;
    case 'not_exists': return !resolved.found;
    case 'truthy': return resolved.found && Boolean(resolved.value);
    case 'falsy': return resolved.found && !Boolean(resolved.value);
    case 'equals': return resolved.found && jsonEquals(resolved.value, condition.value);
    case 'not_equals': return !resolved.found || !jsonEquals(resolved.value, condition.value);
    case 'in': return resolved.found && Array.isArray(condition.value) && condition.value.some((entry) => jsonEquals(entry, resolved.value));
    case 'contains': return resolved.found && Array.isArray(resolved.value) && resolved.value.some((entry) => jsonEquals(entry, condition.value));
  }
}

export function resolveMapping(mapping: JsonValue, context: ValueContext): JsonValue {
  if (Array.isArray(mapping)) return mapping.map((entry) => resolveMapping(entry, context));
  if (!isJsonObject(mapping)) return mapping;
  const keys = Object.keys(mapping);
  if (keys.length === 1 && keys[0] === '$ref') {
    const ref = requiredBoundedString(mapping.$ref, '$ref', 512);
    assertReferenceSyntax(ref);
    const resolved = readValueRef(ref, context);
    if (!resolved.found) throw new SopContractError('sop_mapping_reference_missing', { ref });
    return cloneJson(resolved.value as JsonValue);
  }
  return Object.fromEntries(Object.entries(mapping).map(([key, entry]) => [key, resolveMapping(entry, context)]));
}

export function collectStepReferences(value: unknown): Set<string> {
  const references = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isJsonObject(candidate)) return;
    const keys = Object.keys(candidate);
    if (typeof candidate.ref === 'string') addStepReference(candidate.ref, references);
    if (keys.length === 1 && typeof candidate.$ref === 'string') addStepReference(candidate.$ref, references);
    for (const entry of Object.values(candidate)) visit(entry);
  };
  visit(value);
  return references;
}

export function validateDag(steps: Array<{ id: string; depends_on: string[] }>): void {
  if (steps.length < 1 || steps.length > MAX_STEPS) throw new SopContractError('sop_step_count_invalid', { count: steps.length, min: 1, max: MAX_STEPS });
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) {
    const seen = new Set<string>();
    const duplicate = steps.find((step) => seen.has(step.id) || !seen.add(step.id))?.id;
    throw new SopContractError('sop_duplicate_step_id', { step_id: duplicate ?? null });
  }
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (!ids.has(dependency)) throw new SopContractError('sop_unknown_dependency', { step_id: step.id, dependency });
      if (dependency === step.id) throw new SopContractError('sop_dependency_cycle', { cycle: [step.id, step.id] });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      throw new SopContractError('sop_dependency_cycle', { cycle: [...stack.slice(start), id] });
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}

export function validateStepReferences(steps: Array<{ id: string; depends_on: string[]; instructions: string; when: Condition | null; input: JsonValue | null; input_ref: JsonValue | null; action: { arguments: JsonValue } | null }>): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ancestors = (stepId: string): Set<string> => {
    const found = new Set<string>();
    const walk = (id: string): void => {
      for (const dependency of byId.get(id)?.depends_on ?? []) {
        if (found.has(dependency)) continue;
        found.add(dependency);
        walk(dependency);
      }
    };
    walk(stepId);
    return found;
  };
  for (const step of steps) {
    const allowed = ancestors(step.id);
    const referenced = new Set<string>([
      ...collectStepReferences(step.when),
      ...collectStepReferences(step.input),
      ...collectStepReferences(step.input_ref),
      ...collectStepReferences(step.action?.arguments),
    ]);
    for (const match of step.instructions.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const reference = String(match[1]).trim();
      assertReferenceSyntax(reference);
      addStepReference(reference, referenced);
    }
    for (const referencedStep of referenced) {
      if (!byId.has(referencedStep)) throw new SopContractError('sop_step_reference_unknown', { step_id: step.id, referenced_step_id: referencedStep });
      if (!allowed.has(referencedStep)) throw new SopContractError('sop_step_reference_not_dependency', { step_id: step.id, referenced_step_id: referencedStep });
    }
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertJsonValue(value: unknown, code: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SopContractError(code, { reason: 'number_must_be_finite' });
    return;
  }
  if (!value || typeof value !== 'object') throw new SopContractError(code, { reason: `unsupported_type:${typeof value}` });
  if (seen.has(value)) throw new SopContractError(code, { reason: 'circular_value' });
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, code, seen);
  } else {
    if (!isJsonObject(value)) throw new SopContractError(code, { reason: 'object_must_be_plain' });
    for (const [key, entry] of Object.entries(value)) {
      if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') throw new SopContractError(code, { reason: 'unsafe_or_empty_key', key });
      assertJsonValue(entry, code, seen);
    }
  }
  seen.delete(value);
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, canonicalize(entry)]));
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function readValueRef(ref: string, context: ValueContext): { found: boolean; value?: JsonValue } {
  const segments = ref.split('.');
  if (segments.some((segment) => !segment || segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return { found: false };
  let current: unknown;
  if (segments[0] === 'input') {
    current = context.input;
    segments.shift();
  } else if (segments[0] === 'input_ref') {
    current = context.input_ref;
    segments.shift();
  } else if (segments[0] === 'steps' && segments.length >= 3) {
    const step = context.steps.find((entry) => entry.step_id === segments[1]);
    if (!step) return { found: false };
    current = step;
    segments.splice(0, 2);
  } else {
    return { found: false };
  }
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (isJsonObject(current) || (current && typeof current === 'object')) {
      if (!Object.hasOwn(current as object, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  if (current === undefined) return { found: false };
  assertJsonValue(current, 'sop_reference_value_invalid');
  return { found: true, value: current as JsonValue };
}

function addStepReference(ref: string, output: Set<string>): void {
  const match = /^steps\.([^.]+)\./.exec(ref);
  if (match) output.add(match[1]);
}

function rejectUnknownKeys(value: JsonObject, allowed: Set<string>, code: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new SopContractError(code, { reason: 'unknown_fields', fields: unknown });
}

function requiredBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new SopContractError('sop_string_required', { field });
  const text = value.trim();
  if (text.length > maxLength) throw new SopContractError('sop_string_too_long', { field, length: text.length, max_length: maxLength });
  return text;
}
