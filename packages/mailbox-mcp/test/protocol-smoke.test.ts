import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

type ToolSummary = { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { properties: Record<string, { default?: unknown }> } };
type JsonRpcTestResponse = {
  error?: { message: string };
  result: {
    serverInfo: { name: string };
    tools: ToolSummary[];
  };
};
const rpc = handleRequest as unknown as (...args: Parameters<typeof handleRequest>) => JsonRpcTestResponse;

const root = mkdtempSync(join(tmpdir(), 'mailbox-mcp-protocol-'));

try {
  const state = createServerState({ siteRoot: root });
  const init = rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }, state);
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'narada-mailbox-mcp');

  const tools = rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
  assert.equal(tools.error, undefined);
  const toolRows = tools.result.tools;
  assert.deepEqual(toolRows.map((tool) => tool.name), [
    'mailbox_guidance',
    'mailbox_doctor',
    'mailbox_accounts_list',
    'mailbox_messages_list',
    'mailbox_message_show',
    'mailbox_search',
    'mailbox_thread_show',
    'mailbox_output_show',
  ]);
  assert.equal(toolRows.every((tool) => tool.annotations.readOnlyHint), true);
  const list = toolRows.find((tool) => tool.name === 'mailbox_messages_list');
  assert.ok(list);
  assert.equal(list.inputSchema.properties.limit.default, 20);
  assert.equal(list.inputSchema.properties.include_body.default, false);
  const thread = toolRows.find((tool) => tool.name === 'mailbox_thread_show');
  assert.ok(thread);
  assert.equal(thread.inputSchema.properties.limit.default, 50);

  console.log('mailbox-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
