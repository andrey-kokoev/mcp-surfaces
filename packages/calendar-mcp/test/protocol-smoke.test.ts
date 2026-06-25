import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

type ToolSummary = {
  name: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  inputSchema: { properties: Record<string, { default?: unknown; minimum?: number }>; required?: string[] };
};
type JsonRpcTestResponse = {
  error?: { message: string };
  result: {
    serverInfo: { name: string };
    tools: ToolSummary[];
  };
};

const rpc = handleRequest as unknown as (...args: Parameters<typeof handleRequest>) => Promise<JsonRpcTestResponse>;
const root = mkdtempSync(join(tmpdir(), 'calendar-mcp-protocol-'));

try {
  const state = createServerState({ siteRoot: root, accessToken: 'test-token', fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{}' }) });
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, state);
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'narada-calendar-mcp');

  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
  assert.equal(tools.error, undefined);
  const toolRows = tools.result.tools;
  assert.deepEqual(toolRows.map((tool) => tool.name), [
    'calendar_doctor',
    'calendar_list',
    'calendar_event_query',
    'calendar_event_show',
    'calendar_event_create',
    'calendar_event_update',
    'calendar_event_delete',
  ]);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_query')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_create')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_delete')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_query')?.inputSchema.properties.limit.default, 20);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_create')?.inputSchema.properties.confirm_write.default, false);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_query')?.inputSchema.required?.join(','), 'start_datetime,end_datetime');

  console.log('calendar-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
