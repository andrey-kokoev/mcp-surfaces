import { resolve } from 'path';
import { normalizeToolName, validateArgs, validationErrorResult } from './index.mjs';

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
  setActiveOutputToolName = () => {},
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
      return await dispatchTool(canonicalName, createArgs.args, { payloadSource: createArgs.payloadSource });
    }

    const tools = taskLifecycleTools();
    const registeredToolNames = tools.map((tool) => tool.name);
    const payloadResolution = resolveToolPayloadArgs({
      siteRoot,
      toolName: canonicalName,
      args,
      allowedTools: registeredToolNames,
      payloadRefMode: 'merge_args',
    });
    const effectiveArgs = payloadResolution.args;

    const surfaceMismatch = detectReviewSurfaceMismatch(canonicalName, effectiveArgs);
    if (surfaceMismatch) return jsonToolResult(surfaceMismatch, true);

    const toolDef = tools.find((tool) => tool.name === canonicalName);
    if (toolDef?.inputSchema) {
      const validationErrors = validateArgs(canonicalName, effectiveArgs, toolDef.inputSchema);
      if (validationErrors) return jsonToolResult(validationErrorResult(validationErrors), true);
    }
    if (!payloadResolution.payloadSource) {
      enforceInlinePayloadLimit({ toolName: canonicalName, args: effectiveArgs, allowPayloadCreation: true });
    }
    const locusGuard = guardLifecycleTargetLocus({ canonicalName, args: effectiveArgs, siteRoot, env, locusGuardedMutationTools });
    if (locusGuard.status === 'refused') return jsonToolResult(locusGuard, true);

    try {
      return await dispatchTool(canonicalName, effectiveArgs, { payloadSource: payloadResolution.payloadSource });
    } catch (error) {
      if (!isStoreError(error)) throw error;
      const refreshed = refreshStore();
      if (!refreshed) throw new Error(`store_unavailable: ${error instanceof Error ? error.message : String(error)}`);
      try {
        return await dispatchTool(canonicalName, effectiveArgs, { payloadSource: payloadResolution.payloadSource });
      } catch (retryError) {
        if (isStoreError(retryError)) throw new Error(`store_unavailable: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        throw retryError;
      }
    }
  };
}

export function isStoreError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return /database|sqlite|SQLITE|disk I\/O|malformed|not a database/i.test(msg);
}

function detectReviewSurfaceMismatch(canonicalName, args) {
  if (canonicalName !== 'task_lifecycle_finish') return null;
  const verdict = stringField(args, 'verdict');
  if (!['accepted', 'accepted_with_notes', 'rejected'].includes(verdict)) return null;
  const hasFindings = Object.prototype.hasOwnProperty.call(asRecord(args), 'findings');
  const changedFiles = Array.isArray(args.changed_files) && args.changed_files.length > 0;
  const noFilesChanged = booleanField(args, 'no_files_changed') === true;
  const hasFinishEvidence = Boolean(stringField(args, 'summary')) && (changedFiles || noFilesChanged);
  if (!hasFindings && hasFinishEvidence) return null;
  return {
    status: 'error',
    error: 'wrong_task_lifecycle_surface_for_review',
    schema: 'narada.task.mcp.surface_mismatch.v0',
    attempted_tool: 'task_lifecycle_finish',
    correct_tool: 'task_lifecycle_review',
    remediation: 'Call task_lifecycle_review with task_number, agent_id, verdict, and optional findings. Use task_lifecycle_finish or task_lifecycle_submit_report only for finish/report evidence.',
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
    'preferred_role',
    'target_role',
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
  validateTaskCreatePayload(payloadResolution.args);
  return payloadResolution;
}

export function validateTaskCreatePayload(args) {
  const title = stringField(args, 'title');
  if (!title) throw new Error('task_lifecycle_create_payload_title_required');
  if (args.acceptance_criteria !== undefined && (!Array.isArray(args.acceptance_criteria) || args.acceptance_criteria.some((item) => typeof item !== 'string'))) {
    throw new Error('task_lifecycle_create_payload_acceptance_criteria_must_be_string_array');
  }
  for (const field of ['goal', 'context', 'required_work', 'non_goals', 'preferred_role', 'target_role']) {
    if (args[field] !== undefined && args[field] !== null && typeof args[field] !== 'string') {
      throw new Error(`task_lifecycle_create_payload_${field}_must_be_string`);
    }
  }
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
