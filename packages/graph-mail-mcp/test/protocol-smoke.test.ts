import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

type ToolSummary = { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; inputSchema: { properties: Record<string, { default?: unknown; minimum?: number }>; required?: string[] } };
const root = mkdtempSync(join(tmpdir(), 'graph-mail-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', root], { label: 'graph-mail-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'narada-graph-mail-mcp' });
  const toolRows = protocol.tools.tools as ToolSummary[];
  assert.deepEqual(toolRows.map((tool) => tool.name), [
    'graph_mail_guidance',
    'graph_mail_doctor',
    'graph_mail_auth_device_code_start',
    'graph_mail_auth_device_code_poll',
    'graph_mail_auth_status',
    'graph_mail_auth_clear',
    'graph_mail_query',
    'graph_mail_message_show',
    'graph_mail_folder_list',
    'graph_mail_folder_create',
    'graph_mail_message_move',
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
    'graph_mail_output_show',
  ]);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_query')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_auth_device_code_start')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_auth_status')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_auth_clear')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_folder_list')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_folder_create')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_message_move')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_list')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_delete')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_draft_create')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_draft_send')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_draft_send')?.inputSchema.properties.confirm_send.default, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_folder_list')?.inputSchema.properties.limit.default, 50);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_folder_create')?.inputSchema.properties.confirm_write.default, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_message_move')?.inputSchema.properties.confirm_write.default, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_auth_clear')?.inputSchema.properties.confirm_clear.default, false);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_folder_create')?.inputSchema.required.join(','), 'display_name');
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_message_move')?.inputSchema.required.join(','), 'message_id,destination_folder_id');
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_get')?.inputSchema.properties.include_content.default, true);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_list')?.inputSchema.properties.limit.default, 20);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_upload_session_create')?.inputSchema.properties.size.minimum, 1);
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_upload_chunk')?.inputSchema.required.join(','), 'upload_url,content_base64,range_start,range_end,total_size');
  assert.equal(toolRows.find((tool) => tool.name === 'graph_mail_attachment_upload_file')?.inputSchema.required.join(','), 'file_path');

  console.log('graph-mail-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
