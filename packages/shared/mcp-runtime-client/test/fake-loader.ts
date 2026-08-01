#!/usr/bin/env node
import { createInterface } from 'node:readline';

type JsonRecord = Record<string, unknown>;

let attachCount = 0;
let responseCount = 0;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line) as JsonRecord;
  if (typeof request.id !== 'number') continue;
  const method = String(request.method ?? '');
  const params = record(request.params);
  if (method === 'initialize') {
    respond(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-loader', version: '1' } });
    continue;
  }
  if (method !== 'tools/call') {
    respond(request.id, {}, { code: -32601, message: `unknown_method:${method}` });
    continue;
  }
  const name = String(params.name ?? '');
  const args = record(params.arguments);
  if (name === 'mcp_loader_attach_surface') {
    attachCount += 1;
    respond(request.id, toolResult({
      schema: 'narada.mcp_loader.surface_attached.v1',
      connection_id: `connection-${String(args.surface_id)}`,
      surface_id: args.surface_id,
      attach_count: attachCount,
    }));
    continue;
  }
  if (name === 'mcp_loader_detach') {
    respond(request.id, toolResult({ schema: 'narada.mcp_loader.detached.v1', status: 'detached' }));
    continue;
  }
  if (name !== 'mcp_loader_call_tool') {
    respond(request.id, toolResult({ schema: 'fake.unknown.v1' }, true));
    continue;
  }
  const childTool = String(args.tool_name ?? '');
  if (childTool === 'hang') continue;
  if (childTool === 'materialized') {
    respond(request.id, toolResult({
      schema: 'narada.mcp_loader.tool_result.v1',
      result_bounded: true,
      details_ref: 'mcp_output:fake',
      result: { schema: 'narada.producer_output_page.v1' },
    }));
    continue;
  }
  const childResult = childTool === 'fail'
    ? toolResult({ schema: 'fake.failure.v1', status: 'error' }, true)
    : toolResult({ schema: 'fake.echo.v1', arguments: args.arguments, attach_count: attachCount });
  respond(request.id, toolResult({
    schema: 'narada.mcp_loader.tool_result.v1',
    result_bounded: false,
    result: childResult,
  }));
}

function toolResult(structuredContent: JsonRecord, isError = false): JsonRecord {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function respond(id: unknown, result: JsonRecord, error?: JsonRecord): void {
  const body = JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
  responseCount += 1;
  if (responseCount % 2 === 0) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}
