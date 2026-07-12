import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

type ToolSummary = {
  name: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  inputSchema: { properties: Record<string, { default?: unknown; minimum?: number }>; required?: string[] };
};
const root = mkdtempSync(join(tmpdir(), 'calendar-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', root], { label: 'calendar-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'narada-calendar-mcp' });
  const toolRows = protocol.tools.tools as ToolSummary[];
  assert.deepEqual(toolRows.map((tool) => tool.name), [
    'calendar_guidance',
    'calendar_doctor',
    'calendar_list',
    'calendar_event_query',
    'calendar_event_show',
    'calendar_event_create',
    'calendar_event_update',
    'calendar_event_delete',
    'calendar_output_show',
  ]);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_query')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_create')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_delete')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_query')?.inputSchema.properties.limit.default, 20);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_create')?.inputSchema.properties.confirm_write.default, false);
  assert.equal(toolRows.find((tool) => tool.name === 'calendar_event_query')?.inputSchema.required?.join(','), 'start_datetime,end_datetime');

  console.log('calendar-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
