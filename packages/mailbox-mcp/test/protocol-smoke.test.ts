import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

type ToolSummary = { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { properties: Record<string, { default?: unknown }> } };
const root = mkdtempSync(join(tmpdir(), 'mailbox-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', root], { label: 'mailbox-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'narada-mailbox-mcp' });
  const toolRows = protocol.tools.tools as ToolSummary[];
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
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
