import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

type ToolSummary = { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; inputSchema: { properties: Record<string, { default?: unknown; minimum?: number }>; required?: string[] } };
type JsonRpcTestResponse = {
  error?: { message: string };
  result: {
    serverInfo: { name: string };
    tools: ToolSummary[];
  };
};
const rpc = handleRequest as unknown as (...args: Parameters<typeof handleRequest>) => Promise<JsonRpcTestResponse>;

const root = mkdtempSync(join(tmpdir(), 'graph-mail-mcp-protocol-'));

try {
  const state = createServerState({ siteRoot: root, accessToken: 'test-token', fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{}' }) });
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }, state);
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name, 'narada-graph-mail-mcp');

  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
  assert.equal(tools.error, undefined);
  const toolRows = tools.result.tools;
  assert.deepEqual(toolRows.map((tool) => tool.name), [
    'graph_mail_guidance',
    'graph_mail_doctor',
    'graph_mail_query',
    'graph_mail_message_show',
    'graph_mail_attachment_list',
    'graph_mail_attachment_get',
    'graph_mail_attachment_add',
    'graph_mail_attachment_upload_session_create',
    'graph_mail_attachment_upload_chunk',
    'graph_mail_attachment_upload_file',
    'graph_mail_attachment_delete',
    'graph_mail_draft_create',
    'graph_mail_reply_draft_create',
    'graph_mail_reply_all_draft_create',
    'graph_mail_forward_draft_create',
    'graph_mail_reply_all_to_last_in_thread_draft_create',
    'graph_mail_draft_update',
    'graph_mail_draft_discard',
    'graph_mail_draft_send',
  ]);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_query')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_list')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_delete')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_draft_create')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_draft_send')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_draft_send')?.inputSchema.properties.confirm_send.default, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_get')?.inputSchema.properties.include_content.default, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_list')?.inputSchema.properties.limit.default, 20);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_upload_session_create')?.inputSchema.properties.size.minimum, 1);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_upload_chunk')?.inputSchema.required.join(','), 'upload_url,content_base64,range_start,range_end,total_size');
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_upload_file')?.inputSchema.required.join(','), 'file_path');

  console.log('graph-mail-mcp protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
