#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'completion-audit-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const VERDICTS = ['proved', 'contradicted', 'incomplete', 'missing'] as const;

type JsonRecord = Record<string, unknown>;

export type CompletionAuditState = {
  auditRoot: string;
  allowedRoots: string[];
};

export function createServerState(options: JsonRecord = {}): CompletionAuditState {
  const auditRoot = resolve(String(options.auditRoot ?? options.outputRoot ?? process.cwd()));
  const allowedRoots = normalizeAllowedRoots([...optionList(options.allowedRoot), ...optionList(options.allowedRoots)]);
  const effectiveAllowedRoots = allowedRoots.length > 0 ? allowedRoots : [auditRoot];
  if (!effectiveAllowedRoots.some((root) => auditRoot === root || isPathInside(auditRoot, root))) {
    throw diagnosticError('completion_audit_root_outside_allowed_roots', 'completion_audit_root_outside_allowed_roots', { audit_root: auditRoot, allowed_roots: effectiveAllowedRoots });
  }
  return {
    auditRoot,
    allowedRoots: effectiveAllowedRoots,
  };
}

export function handleRequest(request: JsonRecord, state: CompletionAuditState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:')
      ? drainJsonRpcFrames(buffer)
      : drainJsonLines(buffer);
    sawFramedInput ||= drained.framed;
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

function dispatchMethod(method: string, params: JsonRecord, state: CompletionAuditState) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    guidanceToolDefinition(),
    {
      name: 'completion_audit_record',
      description: 'Record a requirement/evidence/verdict completion audit as durable JSONL.',
      inputSchema: {
        type: 'object',
        properties: {
          audit_id: { type: 'string' },
          objective: { type: 'string' },
          scope_label: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                requirement: { type: 'string' },
                evidence: { type: 'string' },
                verdict: { type: 'string', enum: VERDICTS },
                residual_risk: { type: 'string' },
              },
              required: ['requirement', 'evidence', 'verdict'],
              additionalProperties: false,
            },
          },
          summary: { type: 'string' },
        },
        required: ['objective', 'items'],
        additionalProperties: false,
      },
      annotations: {
        title: 'completion_audit_record',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

function callTool(params: JsonRecord, state: CompletionAuditState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  if (name === 'completion_audit_guidance') {
    const result = buildGuidanceResult(args);
    return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
  }
  if (name !== 'completion_audit_record') throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  const result = completionAuditRecord(args, state);
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

export function completionAuditRecord(args: JsonRecord, state: CompletionAuditState) {
  const objective = requiredString(args.objective, 'completion_audit_requires_objective');
  const items = arrayOfRecords(args.items).map((item, index) => normalizeAuditItem(item, index));
  if (items.length === 0) throw diagnosticError('completion_audit_requires_items');
  const verdictCounts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, items.filter((item) => item.verdict === verdict).length]));
  const record = {
    schema: 'narada.completion_audit.record.v1',
    status: 'recorded',
    audit_id: optionalString(args.audit_id) ?? `audit_${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`,
    recorded_at: new Date().toISOString(),
    objective,
    scope_label: optionalString(args.scope_label),
    summary: optionalString(args.summary),
    item_count: items.length,
    verdict_counts: verdictCounts,
    completion_proved: items.every((item) => item.verdict === 'proved'),
    items,
  };
  const auditPath = resolve(state.auditRoot, 'completion-audits.jsonl');
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { ...record, audit_path: auditPath };
}

function normalizeAuditItem(item: JsonRecord, index: number) {
  const requirement = requiredString(item.requirement, 'completion_audit_item_requires_requirement', { index });
  const evidence = requiredString(item.evidence, 'completion_audit_item_requires_evidence', { index });
  const verdict = requiredString(item.verdict, 'completion_audit_item_requires_verdict', { index });
  if (!VERDICTS.includes(verdict as typeof VERDICTS[number])) {
    throw diagnosticError('completion_audit_item_verdict_unsupported', `completion_audit_item_verdict_unsupported:${verdict}`, { index, verdict, allowed: VERDICTS });
  }
  return {
    requirement,
    evidence,
    verdict,
    residual_risk: optionalString(item.residual_risk),
  };
}

function renderResult(record: JsonRecord): string {
  const counts = asRecord(record.verdict_counts);
  return [
    `completion_audit_record: ${record.status ?? 'recorded'}`,
    `audit_id: ${record.audit_id ?? ''}`,
    `objective: ${record.objective ?? ''}`,
    `items: ${record.item_count ?? 0}`,
    `completion_proved: ${record.completion_proved ?? false}`,
    `proved: ${counts.proved ?? 0}`,
    `contradicted: ${counts.contradicted ?? 0}`,
    `incomplete: ${counts.incomplete ?? 0}`,
    `missing: ${counts.missing ?? 0}`,
    `audit_path: ${record.audit_path ?? ''}`,
  ].join('\n');
}

function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  const allowedRoots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--audit-root') options.auditRoot = argv[++index];
    else if (arg === '--output-root') options.outputRoot = argv[++index];
    else if (arg === '--allowed-root') allowedRoots.push(argv[++index]);
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (allowedRoots.length > 0) options.allowedRoots = allowedRoots;
  return options;
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return {
    framed: false,
    remaining,
    requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))),
  };
}

function drainJsonRpcFrames(buffer: string) {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd))));
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (framed) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function requiredString(value: unknown, code: string, details: JsonRecord = {}): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code, details);
  return text;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((record) => Object.keys(record).length > 0) : [];
}

function optionList(value: unknown): string[] {
  if (value === undefined || value === null || value === true) return [];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [String(value)].filter(Boolean);
}

function normalizeAllowedRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const root of roots) {
    const resolved = resolve(root);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function diagnosticError(code: string, message: string = code, details: JsonRecord = {}) {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

function errorDiagnostic(error: unknown) {
  const record = asRecord(error);
  return {
    schema: 'narada.completion_audit.error.v1',
    code: String(record.codeName ?? 'completion_audit_error'),
    message: error instanceof Error ? error.message : String(error),
    details: asRecord(record.details),
  };
}

export { parseArgs };

if (isMainModule()) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
