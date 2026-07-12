import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'launcher-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--narada-root', root], { label: 'launcher-mcp protocol smoke' });

try {
const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'launcher-mcp' });
const tools = protocol.tools.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
assert.deepEqual(tools.map((tool) => tool.name), [
  'launcher_guidance',
  'launcher_doctor',
  'launcher_options_list',
  'launcher_registry_list',
  'launcher_plan',
  'launcher_option_matrix',
  'launcher_coherence_check',
]);
assert.equal(tools.every((tool) => tool.annotations.readOnlyHint), true);
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('launcher-mcp protocol smoke ok');
