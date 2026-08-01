import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada-core/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'browser-control-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', root], { label: 'browser-control-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'browser-control-mcp' });
  const tools = protocol.tools.tools as Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: Record<string, any> }>;
  assert.deepEqual(tools.map((tool) => tool.name), [
    'browser_control_guidance',
    'browser_control_session_inventory',
    'browser_control_attach',
    'browser_control_status',
    'browser_control_navigate',
    'browser_control_accessibility_snapshot',
    'browser_control_screenshot',
    'browser_control_click',
    'browser_control_fill',
    'browser_control_wait',
    'browser_control_assert',
    'browser_control_detach',
    'mcp_output_show',
  ]);
  for (const name of ['browser_control_guidance', 'browser_control_session_inventory', 'browser_control_status', 'browser_control_accessibility_snapshot', 'browser_control_screenshot', 'browser_control_assert', 'mcp_output_show']) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool?.annotations?.readOnlyHint, true, name);
  }
  for (const name of ['browser_control_attach', 'browser_control_navigate', 'browser_control_click', 'browser_control_fill', 'browser_control_wait', 'browser_control_detach']) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool?.annotations?.readOnlyHint, false, name);
  }
  const attach = tools.find((tool) => tool.name === 'browser_control_attach')!;
  assert.equal(attach.inputSchema.properties.allowed_origins.items.type, 'string');
  assert.equal(attach.inputSchema.additionalProperties, false);
  assert.equal(tools.some((tool) => tool.name === 'Runtime.evaluate'), false);
  console.log('browser-control-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
