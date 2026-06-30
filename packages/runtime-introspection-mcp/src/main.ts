#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'runtime-introspection-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const FORMATS = ['generic-events', 'codex-jsonl', 'codex-transcript'] as const;
const TOP_DIMENSIONS = ['surface', 'tool', 'status', 'kind', 'adapter'] as const;
const SHOW_VIEWS = ['summary', 'timeline', 'surfaces', 'tools', 'errors', 'adapters'] as const;

type JsonRecord = Record<string, unknown>;
type RuntimeFormat = typeof FORMATS[number];
type TopDimension = typeof TOP_DIMENSIONS[number];
type ShowView = typeof SHOW_VIEWS[number];

type RuntimeEvent = {
  event_id: string;
  timestamp: string | null;
  input_adapter: string;
  kind: string;
  status: string;
  surface_id: string | null;
  tool_name: string | null;
  duration_ms: number | null;
  message: string | null;
};

type RuntimeAnalysis = {
  schema: 'narada.runtime_introspection.analysis.v0';
  status: 'analyzed';
  analysis_id: string;
  generated_at: string;
  format: RuntimeFormat;
  summary: {
    event_count: number;
    tool_call_count: number;
    error_count: number;
    refused_count: number;
    surface_count: number;
    tool_count: number;
    input_adapters: string[];
    total_duration_ms: number;
    total_bytes: number;
    total_chars: number;
    estimated_tokens: number;
  };
  counts: {
    by_surface: JsonRecord;
    by_tool: JsonRecord;
    by_status: JsonRecord;
    by_kind: JsonRecord;
    by_adapter: JsonRecord;
  };
  top: {
    surfaces: JsonRecord[];
    tools: JsonRecord[];
    errors: RuntimeEvent[];
  };
  timeline: RuntimeEvent[];
  largest_events: JsonRecord[];
  token_estimate_by_category: JsonRecord;
  notes: string[];
};

export function handleRequest(request: JsonRecord) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(String(request.method), asRecord(request.params));
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export async function runStdioServer(): Promise<void> {
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
      const response = handleRequest(request);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

function dispatchMethod(method: string, params: JsonRecord) {
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
      return callTool(params);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  const inputSchema = runtimeInputSchema();
  return [
    guidanceToolDefinition(),
    {
      name: 'runtime_introspection_formats',
      description: 'List the read-only inline input formats accepted by the runtime introspection surface.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnlyAnnotations('runtime_introspection_formats'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'runtime_introspection_top_events',
      description: 'Return the N largest normalized runtime trace events by serialized size.',
      inputSchema: {
        type: 'object',
        properties: {
          ...inputSchema.properties,
          analysis: { type: 'object', additionalProperties: true },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('runtime_introspection_top_events'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'runtime_introspection_analyze_trace',
      description: 'Analyze saved or inline runtime trace/session JSONL composition into Narada runtime introspection metrics.',
      inputSchema,
      annotations: readOnlyAnnotations('runtime_introspection_analyze_trace'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'runtime_introspection_analyze',
      description: 'Analyze inline runtime events or Codex adapter records into Narada runtime composition metrics.',
      inputSchema,
      annotations: readOnlyAnnotations('runtime_introspection_analyze'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'runtime_introspection_top',
      description: 'Return ranked runtime metrics from an existing analysis or inline input events.',
      inputSchema: {
        type: 'object',
        properties: {
          ...inputSchema.properties,
          analysis: { type: 'object', additionalProperties: true },
          dimension: { type: 'string', enum: TOP_DIMENSIONS },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          sort: { type: 'string', enum: ['count', 'duration_ms', 'errors'] },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('runtime_introspection_top'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'runtime_introspection_show',
      description: 'Show a focused read-only view from an existing analysis or inline input events.',
      inputSchema: {
        type: 'object',
        properties: {
          ...inputSchema.properties,
          analysis: { type: 'object', additionalProperties: true },
          view: { type: 'string', enum: SHOW_VIEWS },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('runtime_introspection_show'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'runtime_introspection_show_event',
      description: 'Show one normalized runtime trace event by event_id or zero-based index.',
      inputSchema: {
        type: 'object',
        properties: {
          ...inputSchema.properties,
          analysis: { type: 'object', additionalProperties: true },
          event_id: { type: 'string' },
          index: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('runtime_introspection_show_event'),
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

function runtimeInputSchema() {
  const runtimeEventSchema = {
    type: 'object',
    properties: {
      event_id: { type: 'string' },
      timestamp: { type: 'string' },
      input_adapter: { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string', enum: ['tool_call', 'tool_result', 'message', 'error', 'handoff', 'observation'] },
      status: { type: 'string', enum: ['ok', 'passed', 'failed', 'error', 'refused', 'pending', 'unknown'] },
      surface_id: { type: 'string' },
      tool_name: { type: 'string' },
      duration_ms: { type: 'number', minimum: 0 },
      message: { type: 'string' },
    },
    additionalProperties: false,
  };
  const transcriptRecordSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      timestamp: { type: 'string' },
      role: { type: 'string', enum: ['assistant', 'user', 'tool', 'system'] },
      type: { type: 'string' },
      event: { type: 'string' },
      status: { type: 'string' },
      tool_name: { type: 'string' },
      namespace: { type: 'string' },
      duration_ms: { type: 'number', minimum: 0 },
      content: { type: 'string' },
      text: { type: 'string' },
    },
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      analysis_id: { type: 'string' },
      format: { type: 'string', enum: FORMATS },
      events: { type: 'array', items: runtimeEventSchema },
      jsonl: { type: 'string' },
      transcript: { type: 'array', items: transcriptRecordSchema },
    },
    additionalProperties: false,
  };
}

function readOnlyAnnotations(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function callTool(params: JsonRecord) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'runtime_introspection_guidance':
      result = buildGuidanceResult(args);
      break;
    case 'runtime_introspection_formats':
      result = runtimeIntrospectionFormats();
      break;
    case 'runtime_introspection_analyze':
    case 'runtime_introspection_analyze_trace':
      result = runtimeIntrospectionAnalyze(args);
      break;
    case 'runtime_introspection_top':
      result = runtimeIntrospectionTop(args);
      break;
    case 'runtime_introspection_show':
      result = runtimeIntrospectionShow(args);
      break;
    case 'runtime_introspection_top_events':
      result = runtimeIntrospectionTopEvents(args);
      break;
    case 'runtime_introspection_show_event':
      result = runtimeIntrospectionShowEvent(args);
      break;
    default:
      throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

export function runtimeIntrospectionFormats() {
  return {
    schema: 'narada.runtime_introspection.formats.v1',
    status: 'ok',
    formats: [
      {
        format: 'generic-events',
        description: 'Array of normalized runtime events supplied inline.',
        input_field: 'events',
      },
      {
        format: 'codex-jsonl',
        description: 'JSON Lines records from a Codex transcript or tool event stream, consumed as an input adapter.',
        input_field: 'jsonl',
      },
      {
        format: 'codex-transcript',
        description: 'Array of Codex transcript-like records, consumed as an input adapter.',
        input_field: 'transcript',
      },
    ],
    adapter_model: {
      codex: 'input_adapter_only',
      narada_surface_identity: 'derived_from_mcp_tool_names_or_explicit_surface_id',
    },
  };
}

export function runtimeIntrospectionAnalyze(args: JsonRecord = {}): RuntimeAnalysis {
  const format = normalizeFormat(args.format);
  const events = normalizeEvents(args, format);
  const sortedEvents = [...events].sort(compareEvents);
  const bySurface = countBy(sortedEvents, (event) => event.surface_id);
  const byTool = countBy(sortedEvents, (event) => event.tool_name);
  const byStatus = countBy(sortedEvents, (event) => event.status);
  const byKind = countBy(sortedEvents, (event) => event.kind);
  const byAdapter = countBy(sortedEvents, (event) => event.input_adapter);
  const errors = sortedEvents.filter((event) => isErrorEvent(event));
  const refused = sortedEvents.filter((event) => event.status === 'refused');
  const totalDuration = sortedEvents.reduce((sum, event) => sum + (event.duration_ms ?? 0), 0);
  const eventSizes = sortedEvents.map((event, index) => eventSizeRecord(event, index));
  const totalBytes = eventSizes.reduce((sum, event) => sum + Number(event.bytes ?? 0), 0);
  const totalChars = eventSizes.reduce((sum, event) => sum + Number(event.chars ?? 0), 0);
  const analysisId = optionalString(args.analysis_id) ?? stableAnalysisId(format, sortedEvents);
  const notes = [
    'codex_records_are_treated_as_input_adapter_not_narada_surface',
    ...sortedEvents.some((event) => event.timestamp === null) ? ['some_events_missing_timestamp'] : [],
    ...sortedEvents.some((event) => event.surface_id === null && event.tool_name !== null) ? ['some_tools_do_not_map_to_narada_surface'] : [],
  ];
  return {
    schema: 'narada.runtime_introspection.analysis.v0',
    status: 'analyzed',
    analysis_id: analysisId,
    generated_at: new Date().toISOString(),
    format,
    summary: {
      event_count: sortedEvents.length,
      tool_call_count: sortedEvents.filter((event) => event.kind === 'tool_call').length,
      error_count: errors.length,
      refused_count: refused.length,
      surface_count: Object.keys(bySurface).length,
      tool_count: Object.keys(byTool).length,
      input_adapters: Object.keys(byAdapter).sort(),
      total_duration_ms: totalDuration,
      total_bytes: totalBytes,
      total_chars: totalChars,
      estimated_tokens: estimateTokens(totalChars),
    },
    counts: {
      by_surface: bySurface,
      by_tool: byTool,
      by_status: byStatus,
      by_kind: byKind,
      by_adapter: byAdapter,
    },
    top: {
      surfaces: rankedCounts(bySurface, sortedEvents, 'surface').slice(0, 10),
      tools: rankedCounts(byTool, sortedEvents, 'tool').slice(0, 10),
      errors: errors.slice(0, 10),
    },
    timeline: sortedEvents,
    largest_events: eventSizes.sort((left, right) => Number(right.bytes ?? 0) - Number(left.bytes ?? 0)).slice(0, 10),
    token_estimate_by_category: tokenEstimateByCategory(sortedEvents),
    notes,
  };
}

export function runtimeIntrospectionTopEvents(args: JsonRecord = {}) {
  const analysis = analysisFromArgs(args);
  const limit = boundedInteger(args.limit, 10, 1, 200);
  return {
    schema: 'narada.runtime_introspection.top_events.v0',
    status: 'ok',
    analysis_id: analysis.analysis_id,
    limit,
    events: analysis.timeline.map((event, index) => eventSizeRecord(event, index)).sort((left, right) => Number(right.bytes ?? 0) - Number(left.bytes ?? 0)).slice(0, limit),
  };
}

export function runtimeIntrospectionShowEvent(args: JsonRecord = {}) {
  const analysis = analysisFromArgs(args);
  const eventId = optionalString(args.event_id);
  const index = args.index === undefined ? null : boundedInteger(args.index, 0, 0, Math.max(0, analysis.timeline.length - 1));
  const event = eventId ? analysis.timeline.find((candidate) => candidate.event_id === eventId) : index === null ? null : analysis.timeline[index];
  if (!event) throw diagnosticError('runtime_introspection_event_not_found', 'runtime_introspection_event_not_found', { event_id: eventId, index });
  return {
    schema: 'narada.runtime_introspection.event.v0',
    status: 'ok',
    analysis_id: analysis.analysis_id,
    event,
    size: eventSizeRecord(event, analysis.timeline.indexOf(event)),
  };
}

export function runtimeIntrospectionTop(args: JsonRecord = {}) {
  const analysis = analysisFromArgs(args);
  const dimension = normalizeDimension(args.dimension);
  const limit = boundedInteger(args.limit, 10, 1, 50);
  const sort = String(args.sort ?? 'count');
  const counts = countsForDimension(analysis, dimension);
  const items = rankedCounts(counts, analysis.timeline, dimension)
    .sort((left, right) => compareRanked(left, right, sort))
    .slice(0, limit);
  return {
    schema: 'narada.runtime_introspection.top.v1',
    status: 'ok',
    analysis_id: analysis.analysis_id,
    dimension,
    sort,
    limit,
    items,
  };
}

export function runtimeIntrospectionShow(args: JsonRecord = {}) {
  const analysis = analysisFromArgs(args);
  const view = normalizeShowView(args.view);
  const limit = boundedInteger(args.limit, 50, 1, 200);
  return {
    schema: 'narada.runtime_introspection.show.v1',
    status: 'ok',
    analysis_id: analysis.analysis_id,
    view,
    limit,
    data: showData(analysis, view, limit),
  };
}

function normalizeEvents(args: JsonRecord, format: RuntimeFormat): RuntimeEvent[] {
  if (format === 'generic-events') {
    return arrayOfRecords(args.events).map((record, index) => normalizeRuntimeEvent(record, index, 'generic-events'));
  }
  if (format === 'codex-jsonl') {
    return parseJsonl(String(args.jsonl ?? '')).map((record, index) => normalizeCodexRecord(record, index));
  }
  return arrayOfRecords(args.transcript).map((record, index) => normalizeCodexRecord(record, index));
}

function normalizeRuntimeEvent(record: JsonRecord, index: number, inputAdapter: string): RuntimeEvent {
  const toolName = optionalString(record.tool_name);
  const explicitSurface = optionalString(record.surface_id);
  const derivedSurface = explicitSurface ?? surfaceFromToolName(toolName);
  return {
    event_id: optionalString(record.event_id) ?? `event_${index + 1}`,
    timestamp: optionalString(record.timestamp),
    input_adapter: optionalString(record.input_adapter) ?? optionalString(record.source) ?? inputAdapter,
    kind: normalizeKind(record.kind, toolName),
    status: normalizeStatus(record.status),
    surface_id: derivedSurface,
    tool_name: toolName,
    duration_ms: optionalNumber(record.duration_ms),
    message: optionalString(record.message),
  };
}

function normalizeCodexRecord(record: JsonRecord, index: number): RuntimeEvent {
  const toolName = optionalString(record.tool_name) ?? optionalString(record.name) ?? optionalString(record.namespace);
  const text = optionalString(record.content) ?? optionalString(record.text) ?? optionalString(record.message);
  return {
    event_id: optionalString(record.id) ?? optionalString(record.event_id) ?? `codex_event_${index + 1}`,
    timestamp: optionalString(record.timestamp),
    input_adapter: 'codex',
    kind: normalizeKind(record.kind ?? record.type ?? record.event ?? record.role, toolName),
    status: normalizeStatus(record.status ?? record.outcome),
    surface_id: surfaceFromToolName(toolName),
    tool_name: toolName,
    duration_ms: optionalNumber(record.duration_ms ?? record.elapsed_ms),
    message: text,
  };
}

function parseJsonl(jsonl: string): JsonRecord[] {
  return jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return asRecord(JSON.parse(line));
      } catch {
        throw diagnosticError('runtime_introspection_invalid_jsonl', `runtime_introspection_invalid_jsonl:${index + 1}`, { line: index + 1 });
      }
    });
}

function normalizeKind(value: unknown, toolName: string | null): string {
  const kind = String(value ?? '').toLowerCase();
  if (kind.includes('error')) return 'error';
  if (kind.includes('result')) return 'tool_result';
  if (kind.includes('tool') || kind.includes('function') || toolName) return 'tool_call';
  if (kind.includes('handoff')) return 'handoff';
  if (kind.includes('user') || kind.includes('assistant') || kind.includes('message')) return 'message';
  return 'observation';
}

function normalizeStatus(value: unknown): string {
  const status = String(value ?? '').toLowerCase();
  if (['ok', 'passed', 'success', 'succeeded', 'complete', 'completed'].includes(status)) return 'ok';
  if (['fail', 'failed', 'failure'].includes(status)) return 'failed';
  if (['error', 'errored'].includes(status)) return 'error';
  if (['refused', 'denied', 'blocked'].includes(status)) return 'refused';
  if (['pending', 'running'].includes(status)) return 'pending';
  return 'unknown';
}

function surfaceFromToolName(toolName: string | null): string | null {
  if (!toolName) return null;
  const match = /^mcp__narada_[^_]+_([a-z0-9_]+?)(?:[./]|$)/i.exec(toolName);
  if (!match) return null;
  const namespace = match[1];
  const mappings: Record<string, string> = {
    agent_context: 'agent-context',
    cloudflare_carrier: 'cloudflare-carrier',
    delegated_task: 'delegated-task',
    git: 'git',
    graph_mail: 'graph-mail',
    local_filesystem: 'local-filesystem',
    mailbox: 'mailbox',
    mcp_registrar: 'mcp-registrar',
    scheduler: 'scheduler',
    site_coherence: 'site-coherence',
    site_inbox: 'site-inbox',
    sop: 'sop',
    speech: 'speech',
    structured_command: 'structured-command',
    surface_feedback: 'surface-feedback',
    task_lifecycle: 'task-lifecycle',
    worker_delegation: 'worker-delegation',
  };
  return mappings[namespace] ?? namespace.replace(/_/g, '-');
}

function rankedCounts(counts: JsonRecord, events: RuntimeEvent[], dimension: string) {
  return Object.entries(counts).map(([name, count]) => {
    const related = events.filter((event) => dimensionValue(event, dimension) === name);
    return {
      name,
      count,
      duration_ms: related.reduce((sum, event) => sum + (event.duration_ms ?? 0), 0),
      errors: related.filter(isErrorEvent).length,
      refused: related.filter((event) => event.status === 'refused').length,
    };
  }).sort((left, right) => compareRanked(left, right, 'count'));
}

function countBy(events: RuntimeEvent[], selector: (event: RuntimeEvent) => string | null): JsonRecord {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const value = selector(event);
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function countsForDimension(analysis: RuntimeAnalysis, dimension: TopDimension): JsonRecord {
  if (dimension === 'surface') return analysis.counts.by_surface;
  if (dimension === 'tool') return analysis.counts.by_tool;
  if (dimension === 'status') return analysis.counts.by_status;
  if (dimension === 'kind') return analysis.counts.by_kind;
  return analysis.counts.by_adapter;
}

function dimensionValue(event: RuntimeEvent, dimension: string): string | null {
  if (dimension === 'surface') return event.surface_id;
  if (dimension === 'tool') return event.tool_name;
  if (dimension === 'status') return event.status;
  if (dimension === 'kind') return event.kind;
  if (dimension === 'adapter') return event.input_adapter;
  return null;
}

function showData(analysis: RuntimeAnalysis, view: ShowView, limit: number) {
  if (view === 'summary') return analysis.summary;
  if (view === 'timeline') return analysis.timeline.slice(0, limit);
  if (view === 'surfaces') return rankedCounts(analysis.counts.by_surface, analysis.timeline, 'surface').slice(0, limit);
  if (view === 'tools') return rankedCounts(analysis.counts.by_tool, analysis.timeline, 'tool').slice(0, limit);
  if (view === 'errors') return analysis.timeline.filter(isErrorEvent).slice(0, limit);
  return rankedCounts(analysis.counts.by_adapter, analysis.timeline, 'adapter').slice(0, limit);
}

function analysisFromArgs(args: JsonRecord): RuntimeAnalysis {
  const supplied = asRecord(args.analysis);
  if (supplied.schema === 'narada.runtime_introspection.analysis.v0' || supplied.schema === 'narada.runtime_introspection.analysis.v1') return supplied as RuntimeAnalysis;
  return runtimeIntrospectionAnalyze(args);
}

function eventSizeRecord(event: RuntimeEvent, index: number): JsonRecord {
  const serialized = JSON.stringify(event);
  return { index, event_id: event.event_id, kind: event.kind, status: event.status, surface_id: event.surface_id, tool_name: event.tool_name, bytes: Buffer.byteLength(serialized, 'utf8'), chars: serialized.length, estimated_tokens: estimateTokens(serialized.length) };
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function tokenEstimateByCategory(events: RuntimeEvent[]): JsonRecord {
  const categories: Record<string, number> = {};
  for (const event of events) {
    const category = event.kind === 'message' ? (event.tool_name ?? 'message') : event.surface_id ?? event.kind;
    categories[category] = (categories[category] ?? 0) + estimateTokens(JSON.stringify(event).length);
  }
  return categories;
}

function compareRanked(left: JsonRecord, right: JsonRecord, sort: string): number {
  const key = sort === 'duration_ms' || sort === 'errors' ? sort : 'count';
  const delta = Number(right[key] ?? 0) - Number(left[key] ?? 0);
  return delta || String(left.name ?? '').localeCompare(String(right.name ?? ''));
}

function compareEvents(left: RuntimeEvent, right: RuntimeEvent): number {
  if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) return left.timestamp.localeCompare(right.timestamp);
  return left.event_id.localeCompare(right.event_id);
}

function isErrorEvent(event: RuntimeEvent): boolean {
  return event.kind === 'error' || event.status === 'error' || event.status === 'failed' || event.status === 'refused';
}

function stableAnalysisId(format: string, events: RuntimeEvent[]): string {
  const hash = createHash('sha256').update(JSON.stringify({ format, events })).digest('hex').slice(0, 12);
  return `analysis_${hash}`;
}

function normalizeFormat(value: unknown): RuntimeFormat {
  const format = String(value ?? 'generic-events');
  if (!FORMATS.includes(format as RuntimeFormat)) {
    throw diagnosticError('runtime_introspection_format_unsupported', `runtime_introspection_format_unsupported:${format}`, { allowed: FORMATS });
  }
  return format as RuntimeFormat;
}

function normalizeDimension(value: unknown): TopDimension {
  const dimension = String(value ?? 'surface');
  if (!TOP_DIMENSIONS.includes(dimension as TopDimension)) {
    throw diagnosticError('runtime_introspection_top_dimension_unsupported', `runtime_introspection_top_dimension_unsupported:${dimension}`, { allowed: TOP_DIMENSIONS });
  }
  return dimension as TopDimension;
}

function normalizeShowView(value: unknown): ShowView {
  const view = String(value ?? 'summary');
  if (!SHOW_VIEWS.includes(view as ShowView)) {
    throw diagnosticError('runtime_introspection_show_view_unsupported', `runtime_introspection_show_view_unsupported:${view}`, { allowed: SHOW_VIEWS });
  }
  return view as ShowView;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const candidate = Number(value ?? fallback);
  if (!Number.isInteger(candidate)) return fallback;
  return Math.min(max, Math.max(min, candidate));
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((record) => Object.keys(record).length > 0) : [];
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
    schema: 'narada.runtime_introspection.error.v1',
    code: String(record.codeName ?? 'runtime_introspection_error'),
    message: error instanceof Error ? error.message : String(error),
    details: asRecord(record.details),
  };
}

function renderResult(record: JsonRecord): string {
  const schema = String(record.schema ?? 'narada.runtime_introspection.result.v1');
  if (schema.endsWith('.analysis.v0') || schema.endsWith('.analysis.v1')) {
    const summary = asRecord(record.summary);
    return [
      `runtime_introspection_analyze: ${record.status ?? 'ok'}`,
      `analysis_id: ${record.analysis_id ?? ''}`,
      `events: ${summary.event_count ?? 0}`,
      `surfaces: ${summary.surface_count ?? 0}`,
      `tools: ${summary.tool_count ?? 0}`,
      `errors: ${summary.error_count ?? 0}`,
      `input_adapters: ${Array.isArray(summary.input_adapters) ? summary.input_adapters.join(',') : ''}`,
    ].join('\n');
  }
  if (schema.endsWith('.top.v1')) {
    return `runtime_introspection_top: ${record.dimension ?? ''}\nitems: ${Array.isArray(record.items) ? record.items.length : 0}`;
  }
  if (schema.endsWith('.show.v1')) {
    return `runtime_introspection_show: ${record.view ?? ''}`;
  }
  if (schema.endsWith('.top_events.v0')) {
    return `runtime_introspection_top_events: ${Array.isArray(record.events) ? record.events.length : 0}`;
  }
  if (schema.endsWith('.event.v0')) {
    return `runtime_introspection_show_event: ${asRecord(record.event).event_id ?? ''}`;
  }
  if (schema.endsWith('.formats.v1')) {
    return 'runtime_introspection_formats: generic-events,codex-jsonl,codex-transcript';
  }
  return JSON.stringify(record);
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
    const crlfHeaderEnd = remaining.indexOf('\r\n\r\n');
    const lfHeaderEnd = remaining.indexOf('\n\n');
    const headerEnd = crlfHeaderEnd >= 0 ? crlfHeaderEnd : lfHeaderEnd;
    if (headerEnd < 0) break;
    const separatorLength = crlfHeaderEnd >= 0 ? 4 : 2;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + separatorLength;
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

if (isMainModule()) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
