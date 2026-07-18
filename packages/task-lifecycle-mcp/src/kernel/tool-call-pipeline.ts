import { resolve } from 'path';
import { normalizeToolName, validateArgs, validationErrorResult } from './index.js';
import { normalizeTaskTags } from '@narada2/task-governance-core/task-tags';

export function createTaskLifecycleToolCaller({
  toolAliases,
  taskLifecycleTools,
  siteRoot,
  dispatchTool,
  refreshStore,
  jsonToolResult,
  resolveToolPayloadArgs,
  enforceInlinePayloadLimit,
  locusGuardedMutationTools,
  setActiveOutputToolName = (_name?: unknown) => {},
  env = process.env,
}) {
  return async function callTaskLifecycleTool(params) {
    const record = asRecord(params);
    const name = stringField(record, 'name');
    const args = asRecord(record.arguments);
    if (!name) throw new Error('tools_call_requires_name');

    const canonicalName = normalizeToolName(name, toolAliases);
    setActiveOutputToolName(canonicalName);
    if (canonicalName === 'task_lifecycle_create') {
      const createArgs = resolveTaskCreatePayloadArgs({ args, siteRoot, resolveToolPayloadArgs });
      const locusGuard = guardLifecycleTargetLocus({ canonicalName, args, siteRoot, env, locusGuardedMutationTools });
      if (locusGuard.status === 'refused') return jsonToolResult(locusGuard, true);
      const toolDef = taskLifecycleTools().find((tool) => tool.name === canonicalName);
      return await dispatchWithStoreRecovery({
        canonicalName,
        args: createArgs.args,
        payloadSource: createArgs.payloadSource,
        toolDef,
        dispatchTool,
        refreshStore,
      });
    }

    const tools = taskLifecycleTools();
    const registeredToolNames = tools.map((tool) => tool.name);
    const payloadResolution = resolveToolPayloadArgs({
      siteRoot,
      toolName: canonicalName,
      args,
      allowedTools: registeredToolNames,
      payloadRefMode: canonicalName === 'task_lifecycle_submit_work' ? 'merge_args_prefer_payload_placeholders' : 'merge_args',
    });
    const effectiveArgs = payloadResolution.args;

    const surfaceMismatch = detectReviewSurfaceMismatch(canonicalName, effectiveArgs);
    if (surfaceMismatch) return jsonToolResult(surfaceMismatch, true);

    const finishVerdictMismatch = detectFinishVerdictMismatch(canonicalName, effectiveArgs);
    if (finishVerdictMismatch) return jsonToolResult(finishVerdictMismatch, true);

    const toolDef = tools.find((tool) => tool.name === canonicalName);
    if (toolDef?.inputSchema) {
      const validationErrors = validateArgs(canonicalName, effectiveArgs, toolDef.inputSchema);
      if (validationErrors) return jsonToolResult(validationErrorResult(validationErrors), true);
    }
    const autoMaterializeSubmitWork = canonicalName === 'task_lifecycle_submit_work' && booleanField(effectiveArgs, 'auto_materialize_payload') === true;
    if (!payloadResolution.payloadSource && !autoMaterializeSubmitWork) {
      enforceInlinePayloadLimit({ toolName: canonicalName, args: effectiveArgs, allowPayloadCreation: true });
    }
    const locusGuard = guardLifecycleTargetLocus({ canonicalName, args: effectiveArgs, siteRoot, env, locusGuardedMutationTools });
    if (locusGuard.status === 'refused') return jsonToolResult(locusGuard, true);

    return await dispatchWithStoreRecovery({
      canonicalName,
      args: effectiveArgs,
      payloadSource: payloadResolution.payloadSource,
      toolDef,
      dispatchTool,
      refreshStore,
    });
  };
}

async function dispatchWithStoreRecovery({ canonicalName, args, payloadSource, toolDef, dispatchTool, refreshStore }) {
  try {
    return await dispatchTool(canonicalName, args, { payloadSource });
  } catch (error) {
    if (!isStoreError(error)) throw error;
    if (!isStoreRetrySafe({ canonicalName, args, toolDef })) {
      throw new Error(`store_unavailable_after_attempt: mutation_not_retried; tool=${canonicalName}; retry_safe=false; inspect operation state before retrying`);
    }
    const refreshed = refreshStore();
    if (!refreshed) throw new Error(`store_unavailable: ${error instanceof Error ? error.message : String(error)}`);
    try {
      return await dispatchTool(canonicalName, args, { payloadSource });
    } catch (retryError) {
      if (isStoreError(retryError)) throw new Error(`store_unavailable: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      throw retryError;
    }
  }
}

export function isStoreRetrySafe({ canonicalName, args, toolDef }) {
  const annotations = toolDef?.annotations ?? {};
  if (annotations.readOnlyHint === true || annotations.idempotentHint === true) return true;
  const input = asRecord(args);
  return typeof input.idempotency_key === 'string' && input.idempotency_key.trim().length > 0
    || canonicalName === 'task_lifecycle_create' && typeof input.payload_ref === 'string' && input.payload_ref.trim().length > 0;
}

export function isStoreError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return /database|sqlite|SQLITE|disk I\/O|malformed|not a database/i.test(msg);
}
function detectReviewSurfaceMismatch(_canonicalName, _args) {
  return null;
}

function detectFinishVerdictMismatch(canonicalName, args) {
  if (canonicalName !== 'task_lifecycle_finish') return null;
  const verdict = stringField(args, 'verdict');
  if (!verdict) return null;
  const taskNumber = asRecord(args).task_number;
  const agentId = stringField(args, 'agent_id');
  const summary = stringField(args, 'summary');
  const findings = Array.isArray(asRecord(args).findings) ? asRecord(args).findings : [];
  return {
    status: 'blocked',
    error: 'finish_verdict_disallowed',
    schema: 'narada.task.mcp.finish.review_compatibility_gate.v0',
    task_number: taskNumber,
    completion_mode: 'blocked',
    invalid_field: 'verdict',
    remediation: 'task_lifecycle_finish is generic task completion. For outcome-contract tasks, use outcome. For legacy review compatibility, call task_lifecycle_review so the MCP can migrate the review into dependency/outcome authority.',
    example_outcome_args: {
      task_number: taskNumber,
      agent_id: agentId,
      outcome: verdict,
      summary: summary ?? '<review outcome summary>',
      findings,
    },
    compatibility_tool: 'task_lifecycle_review',
    example_compatibility_args: {
      task_number: taskNumber,
      agent_id: agentId,
      verdict,
    },
  };
}

export function buildLifecycleTargetLocusStatus({ siteRoot, env = process.env }) {
  const operatorStatedRoot = env.NARADA_OPERATOR_STATED_SITE_ROOT
    || env.NARADA_REQUESTED_WORK_ROOT
    || env.NARADA_TARGET_SITE_ROOT
    || null;
  const resolvedOperatorRoot = operatorStatedRoot ? resolve(String(operatorStatedRoot)) : null;
  const mismatch = resolvedOperatorRoot && resolve(String(resolvedOperatorRoot)).toLowerCase() !== resolve(siteRoot).toLowerCase();
  return {
    schema: 'narada.task_lifecycle.target_locus_guard.v0',
    default_target_site_root: siteRoot,
    operator_stated_locus_root: resolvedOperatorRoot,
    status: mismatch ? 'operator_stated_locus_mismatch' : 'clear',
    explicit_target_site_root_supported: false,
    rule: 'Task lifecycle MCP is bound to its --site-root. Startup/control-surface identity does not authorize mutating a different requested work substrate.',
  };
}

export function guardLifecycleTargetLocus({ canonicalName, args, siteRoot, env = process.env, locusGuardedMutationTools }) {
  if (!locusGuardedMutationTools.has(canonicalName)) return { status: 'clear' };
  if ((canonicalName === 'task_lifecycle_bridge_poll' || canonicalName === 'task_lifecycle_inbox_target') && booleanField(args, 'dry_run') === true) {
    return { status: 'clear' };
  }
  const status = buildLifecycleTargetLocusStatus({ siteRoot, env });
  if (status.status === 'clear') return status;
  return {
    status: 'refused',
    refusal_code: 'target_locus_preflight_required',
    tool_name: canonicalName,
    ...status,
    remediation: 'Relaunch the task lifecycle MCP for the intended Site, clear the operator-stated locus after explicit correction, or use a mutation surface that accepts explicit target_site_root.',
  };
}

export function resolveTaskCreatePayloadArgs({ args, siteRoot, resolveToolPayloadArgs }) {
  const input = asRecord(args);
  const inlineTaskFields = [
    'title',
    'goal',
    'context',
    'required_work',
    'non_goals',
    'acceptance_criteria',
    'tags',
    'preferred_role',
    'target_role',
    'idempotency_key',
    'execution_binding',
  ];
  const inlineFields = inlineTaskFields.filter((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (inlineFields.length > 0) {
    throw new Error(`task_lifecycle_create_inline_definition_refused: task definition fields must be supplied by immutable payload_ref, not inline tool arguments; fields=${inlineFields.join(',')}`);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'payload_path')) {
    throw new Error('task_lifecycle_create_payload_path_refused: task_lifecycle_create requires immutable payload_ref, not payload_path');
  }
  if (!stringField(input, 'payload_ref')) throw new Error('task_lifecycle_create_requires_payload_ref');

  const payloadResolution = resolveToolPayloadArgs({
    siteRoot,
    toolName: 'task_lifecycle_create',
    args: input,
    allowedTools: ['task_lifecycle_create'],
  });
  if (!payloadResolution.payloadSource?.ref) throw new Error('task_lifecycle_create_requires_payload_ref');
  const normalizedArgs = normalizeTaskCreatePayload(payloadResolution.args);
  validateTaskCreatePayload(normalizedArgs);
  return {
    ...payloadResolution,
    args: {
      ...normalizedArgs,
      tags: normalizedArgs.tags === undefined ? undefined : normalizeTaskTags(normalizedArgs.tags),
    },
  };
}

export function normalizeTaskCreatePayload(args) {
  const input = asRecord(args);
  return {
    ...input,
    required_work: normalizeOptionalMarkdownField(input, 'required_work'),
    non_goals: normalizeOptionalMarkdownField(input, 'non_goals'),
    // Keep raw tags through validation so malformed payloads receive the
    // stable task_lifecycle_create_payload_tags_invalid wrapper.
    tags: input.tags,
  };
}

export function validateTaskCreatePayload(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length === 0) {
    throw new Error('task_lifecycle_create_payload_empty_object_refused');
  }
  const title = stringField(args, 'title');
  if (!title) throw new Error('task_lifecycle_create_payload_title_required');
  if (args.acceptance_criteria !== undefined && (!Array.isArray(args.acceptance_criteria) || args.acceptance_criteria.some((item) => typeof item !== 'string'))) {
    throw new Error('task_lifecycle_create_payload_acceptance_criteria_must_be_string_array');
  }
  if (args.tags !== undefined) {
    try {
      if (!Array.isArray(args.tags)) throw new Error('task_tags_must_be_array');
      normalizeTaskTags(args.tags);
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : 'invalid_tags';
      throw new Error(`task_lifecycle_create_payload_tags_invalid:${diagnostic}`);
    }
  }
  for (const field of ['goal', 'context', 'required_work', 'non_goals', 'preferred_role', 'target_role', 'idempotency_key']) {
    if (args[field] !== undefined && args[field] !== null && typeof args[field] !== 'string') {
      throw new Error(`task_lifecycle_create_payload_${field}_must_be_string`);
    }
  }
  if (args.execution_binding !== undefined && (args.execution_binding === null || typeof args.execution_binding !== 'object' || Array.isArray(args.execution_binding))) {
    throw new Error('task_lifecycle_create_payload_execution_binding_must_be_object');
  }
}

function normalizeOptionalMarkdownField(record, key) {
  const value = asRecord(record)[key];
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const lines = value.map((item) => item.trim()).filter(Boolean);
    return lines.length > 0 ? lines.join('\n') : '';
  }
  return value;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringField(record, key) {
  const value = asRecord(record)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanField(record, key) {
  const value = asRecord(record)[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return undefined;
}
