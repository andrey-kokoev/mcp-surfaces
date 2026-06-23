import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_PAYLOAD_DIR = '.ai/tmp/mcp-payloads';
const DEFAULT_OUTPUT_DIR = '.ai/tmp/mcp-outputs';
const DEFAULT_WORKSPACE_DIR = 'workspace';
export const DEFAULT_INLINE_PAYLOAD_CHAR_LIMIT = 200;
export const DEFAULT_INLINE_OUTPUT_CHAR_LIMIT = 200;
export const DEFAULT_OUTPUT_SHOW_CHAR_LIMIT = 10_000;
const REF_PATTERN = /^mcp_payload:([A-Za-z0-9][A-Za-z0-9_-]{2,63})@v([1-9][0-9]*)$/;
const OUTPUT_REF_PATTERN = /^mcp_output:([A-Za-z0-9][A-Za-z0-9_-]{2,63})$/;
const DEFAULT_INLINE_PAYLOAD_EXEMPT_FIELDS = new Set([
  'payload_ref',
  'payload_path',
  'payload_file',
  'ref',
  'source_ref',
  'workflow_ref',
  'operation_id',
  'task_id',
  'task_number',
  'agent_id',
  'identity',
  'identity_name',
  'surface_id',
  'hwnd',
  'target_site_root',
]);
const DEFAULT_INLINE_OBJECT_PAYLOAD_FIELDS = new Set([
  'payload',
  'content',
  'evidence',
  'verification',
  'self_certification',
  'recovery_truthfulness',
  'authority_basis',
  'active_task',
  'worktree_state',
  'scope',
]);

export function resolveToolPayloadArgs({
  siteRoot,
  toolName,
  args,
  allowedTools,
  maxBytes = DEFAULT_MAX_BYTES,
  payloadDir = DEFAULT_PAYLOAD_DIR,
  payloadRefMode = 'replace_args',
}) {
  const input = asRecord(args);
  const payloadPath = typeof input.payload_path === 'string' && input.payload_path.trim().length > 0
    ? input.payload_path.trim()
    : null;
  const payloadRef = typeof input.payload_ref === 'string' && input.payload_ref.trim().length > 0
    ? input.payload_ref.trim()
    : null;
  if (payloadPath && payloadRef) throw new Error('payload_transport_must_choose_one_of_payload_path_or_payload_ref');
  if (!payloadPath && !payloadRef) return { args: input, payloadSource: null };
  if (!allowedTools.includes(toolName)) {
    throw new Error(`${payloadPath ? 'payload_path' : 'payload_ref'}_not_supported_for_tool: ${toolName}`);
  }

  if (payloadRef) {
    const revision = readPayloadRevision({ siteRoot, ref: payloadRef, maxBytes, payloadDir });
    const resolvedArgs = resolvePayloadRefArgs({ input, payload: revision.payload, payloadRefMode });
    return {
      args: resolvedArgs,
      payloadSource: {
        kind: 'ref',
        ref: revision.ref,
        payload_id: revision.payload_id,
        revision: revision.revision,
        byte_size: revision.byte_size,
        sha256: revision.sha256,
        max_bytes: maxBytes,
        transient_not_authority: true,
      },
    };
  }

  const root = resolve(siteRoot);
  const allowedRoot = resolve(root, payloadDir);
  const absolutePath = resolve(root, payloadPath);
  if (!isPathInside(absolutePath, allowedRoot)) {
    throw new Error(`payload_path_outside_allowed_staging: ${normalizePath(relative(root, absolutePath))}`);
  }

  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    throw new Error(`payload_path_not_found: ${normalizePath(relative(root, absolutePath))}`);
  }
  if (!stat.isFile()) throw new Error(`payload_path_not_file: ${normalizePath(relative(root, absolutePath))}`);
  if (stat.size > maxBytes) throw new Error(`payload_path_too_large: ${stat.size} > ${maxBytes}`);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`payload_path_invalid_json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('payload_path_json_must_be_object');
  }

  return {
    args: parsed,
    payloadSource: {
      kind: 'file',
      path: normalizePath(relative(root, absolutePath)),
      byte_size: stat.size,
      max_bytes: maxBytes,
      transient_not_authority: true,
    },
  };
}

function resolvePayloadRefArgs({ input, payload, payloadRefMode }) {
  if (payloadRefMode === 'merge_args') return { ...asRecord(payload), ...withoutPayloadTransport(input) };
  if (payloadRefMode === 'payload_field' && hasPayloadRefCompanionArgs(input)) return { ...withoutPayloadTransport(input), payload };
  return payload;
}

function hasPayloadRefCompanionArgs(input) {
  return Object.keys(withoutPayloadTransport(input)).length > 0;
}

function withoutPayloadTransport(input) {
  const { payload_ref, payload_path, payload, payload_file, ...rest } = input;
  return rest;
}

export function attachPayloadSource(result, payloadSource) {
  if (!payloadSource || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  return { ...result, payload_source: payloadSource };
}

export function enforceInlinePayloadLimit({
  toolName,
  args,
  limit = DEFAULT_INLINE_PAYLOAD_CHAR_LIMIT,
  exemptFields = DEFAULT_INLINE_PAYLOAD_EXEMPT_FIELDS,
  objectPayloadFields = DEFAULT_INLINE_OBJECT_PAYLOAD_FIELDS,
  allowPayloadCreation = false,
}: Record<string, unknown> = {}) {
  const input = asRecord(args);
  const currentToolName = typeof toolName === 'string' ? toolName : '';
  const inlineLimit = typeof limit === 'number' ? limit : DEFAULT_INLINE_PAYLOAD_CHAR_LIMIT;
  const exemptFieldSet = exemptFields instanceof Set ? exemptFields : DEFAULT_INLINE_PAYLOAD_EXEMPT_FIELDS;
  const objectPayloadFieldSet = objectPayloadFields instanceof Set ? objectPayloadFields : DEFAULT_INLINE_OBJECT_PAYLOAD_FIELDS;
  if (allowPayloadCreation === true && isPayloadWorkspaceTool(currentToolName)) return;
  const violations = [];
  visitInlinePayload(input, [], { limit: inlineLimit, exemptFields: exemptFieldSet, objectPayloadFields: objectPayloadFieldSet, violations });
  const first = violations[0];
  if (!first) return;
  const createArgs = buildPayloadCreateTemplate(violations);
  const retryArgs = buildPayloadRetryTemplate(currentToolName);
  throw new Error(
    `inline_payload_too_long: field=${first.field} length=${first.length} threshold=${inlineLimit} remediation=call mcp_payload_create then retry_with_payload_ref mcp_payload_create_args=${JSON.stringify(createArgs)} retry_args=${JSON.stringify(retryArgs)}`
  );
}

function buildPayloadCreateTemplate(violations) {
  const payload = {};
  for (const violation of violations.slice(0, 10)) {
    assignPath(payload, String(violation.field).split('.'), `<move original ${violation.field} here>`);
  }
  return { payload, created_by: '<agent_id_or_principal>' };
}

function buildPayloadRetryTemplate(toolName) {
  return { tool: toolName || '<original_tool>', args: { payload_ref: 'mcp_payload:<id>@v1' } };
}

function assignPath(target, path, value) {
  let current = target;
  for (let index = 0; index < path.length; index++) {
    const key = path[index];
    if (index === path.length - 1) {
      current[containerKey(key)] = value;
      return;
    }
    const targetKey = containerKey(key);
    const nextContainer = /^\d+$/.test(path[index + 1] ?? '') ? [] : {};
    current[targetKey] = isPlainObject(current[targetKey]) || Array.isArray(current[targetKey]) ? current[targetKey] : nextContainer;
    current = current[targetKey];
  }
}

function containerKey(key) {
  return /^\d+$/.test(String(key)) ? Number(key) : key;
}

function visitInlinePayload(value, path, context) {
  if (typeof value === 'string') {
    const field = path[path.length - 1] ?? '<root>';
    if (!context.exemptFields.has(field) && value.length > context.limit) {
      context.violations.push({ field: pathToField(path), length: value.length, threshold: context.limit });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitInlinePayload(item, [...path, String(index)], context));
    return;
  }
  if (!isPlainObject(value)) return;

  const field = path[path.length - 1];
  if (field && context.objectPayloadFields.has(field)) {
    const length = stableJson(value).length;
    if (length > context.limit) {
      context.violations.push({ field: pathToField(path), length, threshold: context.limit });
    }
  }
  for (const [key, child] of Object.entries(value)) {
    visitInlinePayload(child, [...path, key], context);
  }
}

function pathToField(path) {
  return path.length > 0 ? path.join('.') : '<root>';
}

function isPayloadWorkspaceTool(toolName) {
  return ['mcp_payload_create', 'mcp_payload_derive'].includes(toolName);
}

export function payloadCreate({ siteRoot, args, maxBytes = DEFAULT_MAX_BYTES, payloadDir = DEFAULT_PAYLOAD_DIR }) {
  const input = asRecord(args);
  const payload = asPayloadObject(input.payload, 'payload_create_payload_must_be_object');
  if (Object.keys(payload).length === 0 && input.allow_empty !== true) {
    throw new Error('payload_create_empty_payload_requires_allow_empty: payload object is empty; pass allow_empty=true only when an empty immutable payload is intentional. Common mistake: put domain fields under payload, e.g. {"payload":{"summary":"..."}}, not alongside it.');
  }
  const payloadId = input.payload_id ? validatePayloadId(String(input.payload_id)) : randomPayloadId();
  const createdAt = new Date().toISOString();
  const ref = buildPayloadRef(payloadId, 1);
  const revision = buildRevisionRecord({
    payloadId,
    revision: 1,
    payload,
    createdAt,
    createdBy: stringOrNull(input.created_by),
    source: { kind: 'create' },
    maxBytes,
  });
  writeRevision({ siteRoot, payloadDir, record: revision, overwrite: false });
  return publicRevisionResult({ status: 'created', record: revision, ref });
}

export function payloadShow({ siteRoot, args, maxBytes = DEFAULT_MAX_BYTES, payloadDir = DEFAULT_PAYLOAD_DIR }) {
  const revision = readPayloadRevision({ siteRoot, ref: requireRef(args, 'payload_show_requires_ref'), maxBytes, payloadDir });
  return publicRevisionResult({ status: 'ok', record: revision.record, includePayload: true });
}

export function payloadValidate({ siteRoot, args, maxBytes = DEFAULT_MAX_BYTES, payloadDir = DEFAULT_PAYLOAD_DIR }) {
  const revision = readPayloadRevision({ siteRoot, ref: requireRef(args, 'payload_validate_requires_ref'), maxBytes, payloadDir });
  return publicRevisionResult({ status: 'valid', record: revision.record });
}

export function payloadDerive({ siteRoot, args, maxBytes = DEFAULT_MAX_BYTES, payloadDir = DEFAULT_PAYLOAD_DIR }) {
  const input = asRecord(args);
  const source = readPayloadRevision({ siteRoot, ref: requireRef(input, 'payload_derive_requires_source_ref', 'source_ref'), maxBytes, payloadDir });
  const overlay = asPayloadObject(input.overlay, 'payload_derive_overlay_must_be_object');
  const payload = overlayObject(source.payload, overlay);
  const revision = source.revision + 1;
  const ref = buildPayloadRef(source.payload_id, revision);
  const createdAt = new Date().toISOString();
  const record = buildRevisionRecord({
    payloadId: source.payload_id,
    revision,
    payload,
    createdAt,
    createdBy: stringOrNull(input.created_by),
    source: { kind: 'derive', source_ref: source.ref, overlay_sha256: sha256(stableJson(overlay)) },
    maxBytes,
  });
  writeRevision({ siteRoot, payloadDir, record, overwrite: false });
  return publicRevisionResult({ status: 'derived', record, ref, sourceRef: source.ref });
}

export function buildOutputRefToolContent({
  siteRoot,
  toolName,
  value,
  isError = false,
  limit = DEFAULT_INLINE_OUTPUT_CHAR_LIMIT,
  createdBy = process.env.NARADA_AGENT_ID || null,
  readerTool = 'mcp_output_show',
}: Record<string, unknown> = {}) {
  const outputSiteRoot = typeof siteRoot === 'string' ? siteRoot : process.cwd();
  const outputToolName = typeof toolName === 'string' ? toolName : 'unknown_tool';
  const inlineLimit = typeof limit === 'number' ? limit : DEFAULT_INLINE_OUTPUT_CHAR_LIMIT;
  const outputCreatedBy = typeof createdBy === 'string' ? createdBy : null;
  const valueRecord = isPlainObject(value) ? value as Record<string, unknown> : {};
  if (isOutputLocator(value)) {
    return { content: [assistantTextContent(JSON.stringify(value))], ...(isError ? { isError: true } : {}) };
  }
  if (isOutputShowResult(value)) {
    return { content: [assistantTextContent(JSON.stringify(value, null, 2))], structuredContent: value, ...(isError ? { isError: true } : {}) };
  }

  const fullText = JSON.stringify(value, null, 2);
  if (fullText.length <= inlineLimit) {
    return { content: [assistantTextContent(fullText)], ...(isError ? { isError: true } : {}) };
  }

  const payloadRef = typeof valueRecord.ref === 'string' && valueRecord.ref.startsWith('mcp_payload:') ? valueRecord.ref : null;
  const materialized = outputCreate({ siteRoot: outputSiteRoot, toolName: outputToolName, value, fullText, inlineLimit, createdBy: outputCreatedBy });
  const outputRef = String(materialized.ref ?? '');
  const outputReaderTool = typeof readerTool === 'string' && readerTool.trim().length > 0 ? readerTool.trim() : null;
  const outputText = fullText.slice(0, inlineLimit);
  const nextOffset = outputText.length < fullText.length ? outputText.length : null;
  const envelope = {
    schema: 'narada.producer_output_page.v1',
    status: outputStatus(value, isError),
    truncated: true,
    ...(payloadRef ? { payload_ref: payloadRef } : {}),
    output_ref: outputRef,
    ref: outputRef,
    result_materialized: true,
    tool_name: outputToolName,
    offset: 0,
    limit: inlineLimit,
    next_offset: nextOffset,
    transport_offset: 0,
    transport_limit: inlineLimit,
    transport_next_offset: nextOffset,
    output_text: outputText,
    output_truncated: nextOffset !== null,
    reader_tool: outputReaderTool,
    site_root: outputSiteRoot,
    read_command: outputReaderTool ? `${outputReaderTool}({ "ref": "${outputRef}", "offset": 0, "limit": ${DEFAULT_OUTPUT_SHOW_CHAR_LIMIT} })` : null,
    remediation: outputReaderTool
      ? `Use ${outputReaderTool} with output_ref/ref=${outputRef} to read the full produced JSON output; use transport_next_offset only for transport-envelope text, and use the original tool's own next_offset for domain paging after reading the materialized result.`
      : 'Use the output_ref resource to read the full produced JSON output; separate reader tools are not exposed for this surface.',
    inline_limit: inlineLimit,
    full_output_char_length: fullText.length,
  };
  return {
    content: [
      assistantTextContent(fitInlineJson(envelope, inlineLimit)),
    ],
    structuredContent: envelope,
    ...(isError ? { isError: true } : {}),
  };
}

function assistantTextContent(text: string): any {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
}

export function outputShow({ siteRoot, args, maxBytes = DEFAULT_OUTPUT_MAX_BYTES, outputDir = DEFAULT_OUTPUT_DIR }) {
  const input = asRecord(args);
  const effectiveSiteRoot = typeof input.target_site_root === 'string' && input.target_site_root.trim().length > 0
    ? resolve(input.target_site_root.trim())
    : siteRoot;
  const record = readOutputRecord({ siteRoot: effectiveSiteRoot, ref: requireOutputRef(input, 'output_show_requires_ref'), maxBytes, outputDir });
  return publicOutputShowRecord(record, {
    outputLimit: normalizeOutputShowLimit(input.limit ?? input.output_limit),
    offset: normalizeOutputShowOffset(input.offset),
  });
}

export function listOutputResources({ siteRoot, outputDir = DEFAULT_OUTPUT_DIR }: any = {}) {
  const root = typeof siteRoot === 'string' ? siteRoot : process.cwd();
  const dir = resolve(root, outputDir, DEFAULT_WORKSPACE_DIR);
  if (!existsSync(dir)) return { resources: [] };
  const resources = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const outputId = name.replace(/\.json$/, '');
      const ref = buildOutputRef(outputId);
      return {
        uri: outputResourceUri(ref),
        name: ref,
        title: ref,
        description: 'Materialized MCP output ref.',
        mimeType: 'application/json',
      };
    });
  return { resources };
}

export function readOutputResource({ siteRoot, uri, maxBytes = DEFAULT_OUTPUT_MAX_BYTES, outputDir = DEFAULT_OUTPUT_DIR }: any = {}) {
  const ref = outputRefFromResourceUri(String(uri ?? ''));
  const record = readOutputRecord({ siteRoot, ref, maxBytes, outputDir });
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(record.full_output, null, 2),
      },
    ],
  };
}

function outputResourceUri(ref) {
  return `mcp-output:${encodeURIComponent(ref)}`;
}

function outputRefFromResourceUri(uri) {
  if (!uri.startsWith('mcp-output:')) throw new Error(`output_resource_uri_invalid: ${uri}`);
  return decodeURIComponent(uri.slice('mcp-output:'.length));
}

export function listOutputTools() {
  return [
    {
      name: 'mcp_output_show',
      description: 'Read a materialized MCP output ref with offset/limit paging.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Materialized output ref, e.g. mcp_output:<id>. Alias: output_ref.' },
          output_ref: { type: 'string', description: 'Alias for ref.' },
          target_site_root: { type: 'string', description: 'Optional target site root for cross-site materialized output readback.' },
          offset: { type: 'integer', default: 0, description: 'Character offset into the materialized JSON output.' },
          limit: { type: 'integer', default: DEFAULT_OUTPUT_SHOW_CHAR_LIMIT, description: 'Maximum output characters to return.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  ];
}

function outputCreate({ siteRoot, toolName, value, fullText, inlineLimit, createdBy, maxBytes = DEFAULT_OUTPUT_MAX_BYTES, outputDir = DEFAULT_OUTPUT_DIR }) {
  const outputId = randomOutputId();
  const createdAt = new Date().toISOString();
  const ref = buildOutputRef(outputId);
  const record = {
    schema: 'narada.mcp_output_ref.v1',
    ref,
    output_id: outputId,
    tool_name: typeof toolName === 'string' && toolName.trim().length > 0 ? toolName.trim() : null,
    created_at: createdAt,
    created_by: createdBy,
    content_type: 'application/json',
    inline_char_limit: inlineLimit,
    full_output_char_length: fullText.length,
    truncated: true,
    sha256: sha256(fullText),
    max_bytes: maxBytes,
    full_output: value,
  };
  const serialized = `${stableJson(record)}\n`;
  const byteSize = Buffer.byteLength(serialized, 'utf8');
  if (byteSize > maxBytes) throw new Error(`mcp_output_too_large: ${byteSize} > ${maxBytes}`);
  const path = outputPath({ siteRoot, outputDir, outputId });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialized, 'utf8');
  return { ...publicOutputRecord(record), byte_size: byteSize };
}

function readOutputRecord({ siteRoot, ref, maxBytes = DEFAULT_OUTPUT_MAX_BYTES, outputDir = DEFAULT_OUTPUT_DIR }) {
  const parsed = parseOutputRef(ref);
  const path = outputPath({ siteRoot, outputDir, outputId: parsed.outputId });
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`output_ref_not_found: ${ref}`);
  }
  if (!stat.isFile()) throw new Error(`output_ref_not_file: ${ref}`);
  if (stat.size > maxBytes) throw new Error(`output_ref_too_large: ${stat.size} > ${maxBytes}`);
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`output_ref_invalid_json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`output_ref_record_must_be_object: ${ref}`);
  if (record.schema !== 'narada.mcp_output_ref.v1') throw new Error(`output_ref_schema_unsupported: ${record.schema}`);
  if (record.ref !== ref || record.output_id !== parsed.outputId) throw new Error(`output_ref_metadata_mismatch: ${ref}`);
  return { ...record, byte_size: stat.size, output_path: normalizePath(relative(resolve(siteRoot), path)) };
}

function publicOutputRecord(record) {
  return {
    schema: 'narada.mcp_output_locator.v1',
    status: 'ok',
    ref: record.ref,
    tool_name: record.tool_name ?? null,
    full_output_char_length: record.full_output_char_length ?? null,
    byte_size: record.byte_size ?? null,
    truncated: record.truncated === true,
    path: record.output_path ?? normalizePath(`${DEFAULT_OUTPUT_DIR}/${DEFAULT_WORKSPACE_DIR}/${record.output_id}.json`),
  };
}

function publicOutputShowRecord(record, { outputLimit = DEFAULT_OUTPUT_SHOW_CHAR_LIMIT, offset = 0 } = {}) {
  const outputText = JSON.stringify(record.full_output, null, 2);
  const chunk = outputText.slice(offset, offset + outputLimit);
  const outputTruncated = outputLimit > 0 && offset + chunk.length < outputText.length;
  return {
    schema: 'narada.mcp_output_page.v1',
    status: 'ok',
    ref: record.ref,
    tool_name: record.tool_name ?? null,
    full_output_char_length: record.full_output_char_length ?? outputText.length,
    byte_size: record.byte_size ?? null,
    original_truncated: record.truncated === true,
    path: record.output_path ?? normalizePath(`${DEFAULT_OUTPUT_DIR}/${DEFAULT_WORKSPACE_DIR}/${record.output_id}.json`),
    offset,
    limit: outputLimit,
    next_offset: outputTruncated ? offset + chunk.length : null,
    output_limit: outputLimit,
    output_truncated: outputTruncated,
    output_text: chunk,
  };
}

function isOutputLocator(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.schema === 'narada.mcp_output_locator.v1'
      && typeof value.ref === 'string'
  );
}

function isOutputShowResult(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.schema === 'narada.mcp_output_page.v1'
      && typeof value.ref === 'string'
      && typeof value.output_text === 'string'
  );
}

function normalizeOutputShowLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_OUTPUT_SHOW_CHAR_LIMIT;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error('output_limit_must_be_non_negative_integer');
  }
  return Math.min(numeric, DEFAULT_OUTPUT_MAX_BYTES);
}

function normalizeOutputShowOffset(value) {
  if (value === undefined || value === null || value === '') return 0;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error('offset_must_be_non_negative_integer');
  }
  return numeric;
}

function parseOutputRef(ref) {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (REF_PATTERN.test(value)) {
    throw new Error('wrong_ref_family: got=mcp_payload expected=mcp_output reader_tool=mcp_payload_show remediation=use mcp_payload_show');
  }
  const match = value.match(OUTPUT_REF_PATTERN);
  if (!match) throw new Error(`output_ref_invalid: ${value}`);
  return { ref: value, outputId: match[1], output_id: match[1] };
}

function requireOutputRef(args, message, field = 'ref') {
  const record = asRecord(args);
  if (field === 'ref' && typeof record.ref === 'string' && typeof record.output_ref === 'string' && record.ref.trim() !== record.output_ref.trim()) {
    throw new Error('output_show_ref_alias_conflict: provide either ref or output_ref, or provide matching values');
  }
  const value = record[field] ?? (field === 'ref' ? record.output_ref : undefined);
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message);
  return value.trim();
}

function outputPath({ siteRoot, outputDir, outputId }) {
  return resolve(siteRoot, outputDir, DEFAULT_WORKSPACE_DIR, `${outputId}.json`);
}

function buildOutputRef(outputId) {
  return `mcp_output:${outputId}`;
}

function randomOutputId() {
  return `o_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function outputStatus(value, isError) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.status === 'string' && value.status.length <= 32) {
    return value.status;
  }
  return isError ? 'error' : 'ok';
}

function fitInlineJson(value, limit) {
  let text = JSON.stringify(value);
  if (text.length <= limit) return text;
  if (value.schema === 'narada.producer_output_page.v1') {
    const minimalPage = {
      schema: value.schema,
      status: value.status,
      truncated: true,
      tool_name: value.tool_name,
      offset: value.offset,
      limit: value.limit,
      next_offset: value.next_offset,
      output_truncated: value.output_truncated,
      output_text: value.output_text,
      full_output_char_length: value.full_output_char_length,
      reader_tool: null,
    };
    text = JSON.stringify(minimalPage);
    if (text.length <= limit) return text;
    return JSON.stringify({ ...minimalPage, output_text: String(value.output_text ?? '').slice(0, Math.max(0, limit - 400)) });
  }
  const outputRef = value.output_ref ?? value.ref;
  const payloadRef = value.payload_ref ?? (typeof value.ref === 'string' && value.ref.startsWith('mcp_payload:') ? value.ref : undefined);
  const minimal = {
    truncated: true,
    output_ref: outputRef,
    reader_tool: value.reader_tool,
    site_root: value.site_root,
    ...(payloadRef ? { payload_ref: payloadRef } : {}),
  };
  text = JSON.stringify(minimal);
  if (text.length <= limit) return text;
  if (payloadRef) {
    return JSON.stringify({ output_ref: outputRef, payload_ref: payloadRef, truncated: true });
  }
  return JSON.stringify({ output_ref: outputRef, site_root: value.site_root, truncated: true });
}

export function listPayloadTools() {
  return [
    toolDefinition({
      name: 'mcp_payload_create',
      description: 'Create immutable transient MCP payload revision v1 under .ai/tmp/mcp-payloads/workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          payload_id: { type: 'string', description: 'Optional stable id segment. Defaults to a generated id.' },
          payload: { type: 'object', description: 'Required nested domain object to store as v1. Put tool arguments inside this field, e.g. {"payload":{"summary":"..."}}. Empty objects require allow_empty=true.' },
          allow_empty: { type: 'boolean', description: 'Set true only when intentionally creating an empty payload object.' },
          created_by: { type: 'string', description: 'Optional agent/principal for audit metadata.' },
        },
        required: ['payload'],
      },
    }),
    toolDefinition({
      name: 'mcp_payload_show',
      description: 'Show an immutable transient MCP payload revision by ref.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { ref: { type: 'string', description: 'Payload ref, e.g. mcp_payload:<id>@v1.' } },
        required: ['ref'],
      },
    }),
    toolDefinition({
      name: 'mcp_payload_derive',
      description: 'Derive a new immutable payload revision by applying a constrained object overlay.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source_ref: { type: 'string', description: 'Source payload ref, e.g. mcp_payload:<id>@v1.' },
          overlay: { type: 'object', description: 'Recursive object overlay. No deletion semantics.' },
          created_by: { type: 'string', description: 'Optional agent/principal for audit metadata.' },
        },
        required: ['source_ref', 'overlay'],
      },
    }),
    toolDefinition({
      name: 'mcp_payload_validate',
      description: 'Validate that a payload ref exists, is well-formed, and is within size limits.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { ref: { type: 'string', description: 'Payload ref, e.g. mcp_payload:<id>@v1.' } },
        required: ['ref'],
      },
    }),
  ];
}

function toolDefinition(definition) {
  return {
    ...definition,
    annotations: toolAnnotations(definition.name),
    outputSchema: genericToolOutputSchema(),
  };
}

function toolAnnotations(name) {
  const destructive = /delete|remove|write|replace|move|rename|apply|create|derive|validate/.test(String(name));
  return {
    title: String(name),
    readOnlyHint: !destructive,
    destructiveHint: /delete|remove|replace|move|rename|apply/.test(String(name)),
    idempotentHint: /show|inspect|list|read|validate/.test(String(name)),
    openWorldHint: false,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asPayloadObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function readPayloadRevision({ siteRoot, ref, maxBytes = DEFAULT_MAX_BYTES, payloadDir = DEFAULT_PAYLOAD_DIR }) {
  const parsed = parsePayloadRef(ref);
  const path = revisionPath({ siteRoot, payloadDir, payloadId: parsed.payloadId, revision: parsed.revision });
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`payload_ref_not_found: ${ref}`);
  }
  if (!stat.isFile()) throw new Error(`payload_ref_not_file: ${ref}`);
  if (stat.size > maxBytes) throw new Error(`payload_ref_too_large: ${stat.size} > ${maxBytes}`);
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`payload_ref_invalid_json: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateRevisionRecord(record, parsed, stat.size, maxBytes);
  return {
    ...parsed,
    ref,
    payload: record.payload,
    record,
    byte_size: stat.size,
    sha256: record.sha256,
  };
}

function writeRevision({ siteRoot, payloadDir, record, overwrite }) {
  const path = revisionPath({ siteRoot, payloadDir, payloadId: record.payload_id, revision: record.revision });
  if (!overwrite && existsSync(path)) throw new Error(`payload_revision_already_exists: ${record.ref}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJson(record)}\n`, 'utf8');
}

function buildRevisionRecord({ payloadId, revision, payload, createdAt, createdBy, source, maxBytes }) {
  const payloadJson = stableJson(payload);
  const byteSize = Buffer.byteLength(payloadJson, 'utf8');
  if (byteSize > maxBytes) throw new Error(`payload_too_large: ${byteSize} > ${maxBytes}`);
  return {
    schema: 'narada.mcp_payload.revision.v1',
    ref: buildPayloadRef(payloadId, revision),
    payload_id: payloadId,
    revision,
    created_at: createdAt,
    created_by: createdBy,
    source,
    sha256: sha256(payloadJson),
    byte_size: byteSize,
    max_bytes: maxBytes,
    transient_not_authority: true,
    immutable_revision: true,
    payload,
  };
}

function validateRevisionRecord(record, parsed, statSize, maxBytes) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`payload_ref_record_must_be_object: ${parsed.ref}`);
  if (record.schema !== 'narada.mcp_payload.revision.v1') throw new Error(`payload_ref_schema_unsupported: ${record.schema}`);
  if (record.ref !== parsed.ref || record.payload_id !== parsed.payloadId || record.revision !== parsed.revision) {
    throw new Error(`payload_ref_metadata_mismatch: ${parsed.ref}`);
  }
  asPayloadObject(record.payload, 'payload_ref_payload_must_be_object');
  if (statSize > maxBytes || record.byte_size > maxBytes) throw new Error(`payload_ref_too_large: ${statSize} > ${maxBytes}`);
  const payloadJson = stableJson(record.payload);
  if (sha256(payloadJson) !== record.sha256) throw new Error(`payload_ref_sha256_mismatch: ${parsed.ref}`);
}

function parsePayloadRef(ref) {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (OUTPUT_REF_PATTERN.test(value)) {
    throw new Error('wrong_ref_family: got=mcp_output expected=mcp_payload remediation=re-call_original_producing_tool_with_paging_args');
  }
  const match = value.match(REF_PATTERN);
  if (!match) throw new Error(`payload_ref_invalid: ${value}`);
  return { ref: value, payloadId: match[1], payload_id: match[1], revision: Number(match[2]) };
}

function requireRef(args, message, field = 'ref') {
  const value = asRecord(args)[field];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message);
  return value.trim();
}

function revisionPath({ siteRoot, payloadDir, payloadId, revision }) {
  return resolve(siteRoot, payloadDir, DEFAULT_WORKSPACE_DIR, payloadId, `v${revision}.json`);
}

function buildPayloadRef(payloadId, revision) {
  return `mcp_payload:${payloadId}@v${revision}`;
}

function validatePayloadId(value) {
  const match = value.trim().match(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/);
  if (!match) throw new Error(`payload_id_invalid: ${value}`);
  return value.trim();
}

function randomPayloadId() {
  return `p_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function overlayObject(base, overlay) {
  const output = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = overlayObject(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function publicRevisionResult({ status, record, includePayload = false, ref = record.ref, sourceRef = null }) {
  return {
    status,
    ref,
    payload_id: record.payload_id,
    revision: record.revision,
    source_ref: sourceRef ?? record.source?.source_ref ?? null,
    byte_size: record.byte_size,
    sha256: record.sha256,
    created_at: record.created_at,
    created_by: record.created_by,
    transient_not_authority: true,
    immutable_revision: true,
    payload: includePayload ? record.payload : undefined,
  };
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isPathInside(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}
