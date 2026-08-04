#!/usr/bin/env node
import { createInterface } from 'node:readline';

const tools = [{
  name: 'fixture_stdio_read',
  description: 'Read from the stdio compatibility fixture.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}];

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
  if (request.id === undefined) return;
  let result: Record<string, unknown>;
  if (request.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stdio-fixture', version: '1' } };
  } else if (request.method === 'tools/list') {
    result = { tools };
  } else if (request.method === 'tools/call') {
    result = { structuredContent: { status: 'ok', pid: process.pid } };
  } else {
    result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
