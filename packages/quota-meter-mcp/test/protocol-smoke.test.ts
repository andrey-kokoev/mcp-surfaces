import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'quota-meter-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--quota-meter-root', 'D:\\code\\quota-meter', '--state-root', root], { label: 'quota-meter-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'quota-meter-mcp' });
  const tools = protocol.tools.tools as Array<Record<string, any>>;
  assert.deepEqual(tools.map((tool) => tool.name), [
    'quota_meter_guidance',
    'quota_meter_glide_status',
    'quota_meter_overlay_status',
    'quota_meter_overlay_start',
    'quota_meter_overlay_stop',
  ]);
  assert.equal(tools.find((tool) => tool.name === 'quota_meter_overlay_status')?.annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'quota_meter_overlay_start')?.annotations.readOnlyHint, false);
  console.log('quota-meter-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
