#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServerState } from './state.js';
import { dispatchWithError } from './dispatch.js';
import { listTools } from './tool-definitions.js';
import type { JsonRecord } from './tool-definitions.js';

const SERVER_NAME = 'browser-control-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

export { createServerState } from './state.js';
export { listTools } from './tool-definitions.js';
export type { BrowserControlState } from './state.js';

export async function handleRequest(request: JsonRecord, state: ReturnType<typeof createServerState>): Promise<JsonRecord | null> {
  if (request.id === undefined && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } },
    };
  }
  if (request.method === 'tools/list') return { jsonrpc: '2.0', id: request.id ?? null, result: { tools: listTools() } };
  if (request.method === 'resources/list') return { jsonrpc: '2.0', id: request.id ?? null, result: { resources: [] } };
  if (request.method !== 'tools/call') {
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: `Method not found: ${String(request.method)}` } };
  }
  const params = request.params && typeof request.params === 'object' ? request.params as JsonRecord : {};
  const toolName = typeof params.name === 'string' ? params.name : '';
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as JsonRecord : {};
  return { jsonrpc: '2.0', id: request.id ?? null, result: await dispatchWithError(state, toolName, args) };
}

type ParsedInput = { body: string; consumed: number; framed: boolean };

function nextInput(buffer: string): ParsedInput | null {
  const leading = buffer.match(/^\s*/)?.[0].length ?? 0;
  const input = buffer.slice(leading);
  if (!input) return null;
  if (/^Content-Length:/i.test(input)) {
    const separator = input.indexOf('\r\n\r\n');
    if (separator < 0) return null;
    const header = input.slice(0, separator);
    const line = header.split('\r\n').find((item) => /^Content-Length:/i.test(item));
    const length = Number(line?.slice(line.indexOf(':') + 1).trim());
    if (!Number.isInteger(length) || length < 0) throw new Error('invalid_content_length');
    const start = separator + 4;
    const bytes = Buffer.from(input.slice(start), 'utf8');
    if (bytes.length < length) return null;
    const body = bytes.subarray(0, length).toString('utf8');
    return { body, consumed: leading + start + Buffer.byteLength(body, 'utf8'), framed: true };
  }
  const newline = input.indexOf('\n');
  if (newline < 0) return null;
  return { body: input.slice(0, newline).replace(/\r$/, '').trim(), consumed: leading + newline + 1, framed: false };
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let framed = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let parsed: ParsedInput | null;
    while ((parsed = nextInput(buffer))) {
      buffer = buffer.slice(parsed.consumed);
      framed ||= parsed.framed;
      if (!parsed.body) continue;
      let request: JsonRecord;
      try { request = JSON.parse(parsed.body); } catch { continue; }
      const response = await handleRequest(request, state);
      if (response) {
        const text = JSON.stringify(response);
        if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(text, 'utf8')}\r\n\r\n${text}`);
        else process.stdout.write(`${text}\n`);
      }
    }
  }
}

function parseArgs(argv: string[]): JsonRecord {
  const options: JsonRecord = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--site-root' && argv[index + 1]) options.site_root = argv[++index];
  }
  return options;
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
