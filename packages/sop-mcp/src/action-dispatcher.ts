#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  SiteFabricClient,
  isRecord,
  type JsonRecord,
  type SiteFabricToolCallOptions,
} from '@narada-core/mcp-runtime-client';

export interface SopActionFabricCaller {
  call(
    surfaceId: string,
    toolName: string,
    args?: JsonRecord,
    options?: SiteFabricToolCallOptions,
  ): Promise<JsonRecord>;
}

export interface SopActionDispatcherOptions {
  siteRoot: string;
  sopSurfaceId?: string;
  maxActions?: number;
  requestTimeoutMs?: number;
  loaderEntrypoint?: string;
}

export interface SopActionDispatcherReport extends JsonRecord {
  schema: 'narada.sop.action_dispatch_pass.v1';
  status: 'completed' | 'completed_with_errors';
  actions_seen: number;
  actions_resolved: number;
  errors: JsonRecord[];
}

export async function runSopActionDispatcher(
  input: SopActionDispatcherOptions,
  providedFabric?: SopActionFabricCaller,
): Promise<SopActionDispatcherReport> {
  const options = normalizeOptions(input);
  const ownedFabric = providedFabric ? null : await SiteFabricClient.open({
    siteRoot: options.siteRoot,
    loaderEntrypoint: options.loaderEntrypoint,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const fabric = providedFabric ?? ownedFabric!;
  const report: SopActionDispatcherReport = {
    schema: 'narada.sop.action_dispatch_pass.v1',
    status: 'completed',
    actions_seen: 0,
    actions_resolved: 0,
    errors: [],
  };

  try {
    const listed = await fabric.call(options.sopSurfaceId, 'sop_action_list', {
      status: 'pending',
      limit: options.maxActions,
    });
    for (const summary of recordArray(listed.items, 'sop_action_list_invalid')) {
      report.actions_seen += 1;
      const actionId = optionalString(summary.action_id);
      try {
        const shown = await fabric.call(options.sopSurfaceId, 'sop_action_show', {
          action_id: requiredString(summary.action_id, 'sop_action_id_missing'),
        });
        const action = parsePendingAction(shown);
        const domainResult = await fabric.call(
          action.surface_id,
          action.tool_name,
          action.arguments,
          { timeoutMs: options.requestTimeoutMs },
        );
        const operation = parseDomainOperation(domainResult);
        await fabric.call(options.sopSurfaceId, 'sop_action_resolve', {
          action_id: action.action_id,
          completion_key: operation.operation_ref,
          outcome: operation.outcome,
          operation_ref: operation.operation_ref,
          result: operation.result,
          ...(operation.result_ref ? { result_ref: operation.result_ref } : {}),
          ...(operation.outcome === 'failed' ? { error_message: operation.error_message } : {}),
        });
        report.actions_resolved += 1;
      } catch (error) {
        report.errors.push({
          stage: 'sop_action_dispatch',
          ...(actionId ? { action_id: actionId } : {}),
          error: boundedError(error),
        });
      }
    }
  } finally {
    if (ownedFabric) {
      try {
        await ownedFabric.close();
      } catch (error) {
        report.errors.push({ stage: 'site_fabric_close', error: boundedError(error) });
      }
    }
  }
  report.status = report.errors.length === 0 ? 'completed' : 'completed_with_errors';
  return report;
}

interface PendingAction {
  action_id: string;
  occurrence_key: string;
  surface_id: string;
  tool_name: string;
  arguments: JsonRecord;
}

function parsePendingAction(value: JsonRecord): PendingAction {
  if (value.schema !== 'narada.sop.action.v1') throw new Error('sop_action_schema_invalid');
  if (value.status !== 'pending') throw new Error(`sop_action_not_pending:${String(value.status)}`);
  return {
    action_id: requiredString(value.action_id, 'sop_action_id_missing'),
    occurrence_key: requiredString(value.occurrence_key, 'sop_action_occurrence_key_missing'),
    surface_id: requiredString(value.surface_id, 'sop_action_surface_id_missing'),
    tool_name: requiredString(value.tool_name, 'sop_action_tool_name_missing'),
    arguments: requireRecord(value.arguments, 'sop_action_arguments_invalid'),
  };
}

interface DomainOperation {
  operation_ref: string;
  outcome: 'completed' | 'failed';
  result: JsonRecord;
  result_ref: JsonRecord | null;
  error_message: string | null;
}

function parseDomainOperation(value: JsonRecord): DomainOperation {
  if (value.schema !== 'narada.domain_operation.v1') {
    throw new Error(`domain_operation_schema_invalid:${String(value.schema ?? 'missing')}`);
  }
  const outcome = requiredString(value.outcome, 'domain_operation_outcome_missing');
  if (outcome !== 'completed' && outcome !== 'failed') {
    throw new Error(`domain_operation_outcome_invalid:${outcome}`);
  }
  const errorMessage = optionalString(value.error_message);
  if (outcome === 'failed' && !errorMessage) throw new Error('domain_operation_failed_without_error_message');
  return {
    operation_ref: requiredString(value.operation_ref, 'domain_operation_ref_missing'),
    outcome,
    result: value.result === undefined ? {} : requireRecord(value.result, 'domain_operation_result_invalid'),
    result_ref: value.result_ref === undefined || value.result_ref === null
      ? null
      : requireRecord(value.result_ref, 'domain_operation_result_ref_invalid'),
    error_message: errorMessage,
  };
}

interface NormalizedOptions {
  siteRoot: string;
  sopSurfaceId: string;
  maxActions: number;
  requestTimeoutMs: number;
  loaderEntrypoint?: string;
}

function normalizeOptions(input: SopActionDispatcherOptions): NormalizedOptions {
  return {
    siteRoot: requiredString(input.siteRoot, 'siteRoot_required'),
    sopSurfaceId: optionalString(input.sopSurfaceId) ?? 'sop',
    maxActions: boundedInteger(input.maxActions, 100, 1, 100, 'maxActions'),
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, 30_000, 1_000, 300_000, 'requestTimeoutMs'),
    ...(input.loaderEntrypoint ? { loaderEntrypoint: input.loaderEntrypoint } : {}),
  };
}

function recordArray(value: unknown, code: string): JsonRecord[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) throw new Error(code);
  return value as JsonRecord[];
}

function requireRecord(value: unknown, code: string): JsonRecord {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function requiredString(value: unknown, code: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(code);
  return normalized;
}

function optionalString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${name}_invalid`);
  return resolved;
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 2_048 ? text : text.slice(0, 2_048);
}

function parseCliArgs(argv: string[]): SopActionDispatcherOptions {
  const values = parseFlagValues(argv, new Set([
    '--site-root', '--sop-surface-id', '--max-actions', '--request-timeout-ms', '--loader-entrypoint',
  ]));
  return {
    siteRoot: requiredString(values.get('--site-root'), 'site_root_required'),
    ...(values.has('--sop-surface-id') ? { sopSurfaceId: values.get('--sop-surface-id') } : {}),
    ...(values.has('--max-actions') ? { maxActions: Number(values.get('--max-actions')) } : {}),
    ...(values.has('--request-timeout-ms') ? { requestTimeoutMs: Number(values.get('--request-timeout-ms')) } : {}),
    ...(values.has('--loader-entrypoint') ? { loaderEntrypoint: values.get('--loader-entrypoint') } : {}),
  };
}

function parseFlagValues(argv: string[], known: ReadonlySet<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!known.has(flag)) throw new Error(`unknown_argument:${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing_argument_value:${flag}`);
    if (values.has(flag)) throw new Error(`duplicate_argument:${flag}`);
    values.set(flag, value);
    index += 1;
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runSopActionDispatcher(parseCliArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'completed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ schema: 'narada.sop.action_dispatch_pass.v1', status: 'error', error: boundedError(error) })}\n`);
    process.exitCode = 1;
  }
}
