import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada-core/mcp-e2e-harness';

const root = mkdtempSync(tmpdir());
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(
  process.execPath,
  [serverPath, '--narada-root', 'D:/code/narada'],
  { label: 'operator-console-overlay-mcp protocol smoke' },
);

try {
  const protocol = await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'operator-console-overlay-mcp',
  });
  const tools = protocol.tools.tools as Array<Record<string, any>>;
  assert.deepEqual(tools.map((tool) => tool.name), [
    'operator_console_overlay_guidance',
    'operator_console_overlay_status',
    'operator_console_overlay_open',
    'operator_console_overlay_refresh',
    'operator_console_overlay_close',
  ]);
  assert.equal(tools.find((tool) => tool.name === 'operator_console_overlay_status')?.annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'operator_console_overlay_open')?.annotations.idempotentHint, true);
  console.log('operator-console-overlay-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
