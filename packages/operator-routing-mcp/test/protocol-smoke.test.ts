import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'operator-routing-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', root], { label: 'operator-routing-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'operator-routing-mcp' });
  assert.deepEqual(protocol.toolNames, ['operator_routing_guidance', 'operator_route_doctor', 'operator_route_request']);
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('operator-routing-mcp protocol smoke ok');
