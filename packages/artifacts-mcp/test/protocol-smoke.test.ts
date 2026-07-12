import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'artifacts-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', root, '--session-id', 'carrier_test'], { label: 'artifacts-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'artifacts-mcp' });
  assert.deepEqual(protocol.toolNames, ['artifacts_guidance', 'artifacts_doctor', 'artifact_register_file', 'artifact_list', 'artifact_read', 'artifact_present', 'artifact_message_part_create']);
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('artifacts-mcp protocol smoke ok');
