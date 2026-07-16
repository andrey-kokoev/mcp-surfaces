import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerState } from '../src/main.js';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--allowed-site-root', root], { label: 'mcp-loader-mcp protocol smoke' });

try {
  const defaultState = createServerState();
  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (userProfile) {
    assert.ok(defaultState.policy.allowedSiteRoots.includes(resolve(userProfile, 'Narada').replace(/\\/g, '/')));
    assert.ok(defaultState.policy.allowedEntrypointPrefixes.includes(resolve(userProfile, 'Narada', 'tools').replace(/\\/g, '/')));
  }

  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'mcp-loader-mcp' });
  const tools = protocol.tools.tools as { name: string; description: string; annotations: Record<string, unknown>; inputSchema: Record<string, any>; outputSchema: Record<string, any> }[];
  assert.deepEqual(tools.map((t) => t.name), [
    'mcp_loader_guidance',
    'mcp_loader_runtime_status',
    'mcp_loader_policy_inspect',
    'mcp_loader_connection_inventory',
    'mcp_loader_list_site_surfaces',
    'mcp_loader_site_fabric_diagnostics',
    'mcp_loader_site_tool_inventory_check',
    'mcp_loader_attach_surface',
    'mcp_loader_list_tools',
    'mcp_loader_surface_status',
    'mcp_loader_tool_discovery_manifest',
    'mcp_loader_call_tool',
    'mcp_loader_detach',
    'mcp_loader_surface_restart',
  ]);

  const guidanceTool = tools.find((t) => t.name === 'mcp_loader_guidance');
  assert.equal(guidanceTool?.description, 'Show model-facing operating guidance for mcp-loader MCP workflows.');
  assert.equal(guidanceTool?.annotations.readOnlyHint, true);
  assert.equal(guidanceTool?.annotations.idempotentHint, true);
  assert.equal(guidanceTool?.annotations.openWorldHint, false);
  assert.deepEqual(guidanceTool?.inputSchema.properties, {
    workflow: { type: 'string', description: 'Optional workflow name or area to focus guidance on.' },
    tool: { type: 'string', description: 'Optional tool name for tool-specific guidance.' },
  });

  const listTool = tools.find((t) => t.name === 'mcp_loader_list_site_surfaces');
  assert.equal(listTool?.annotations.readOnlyHint, true);

  const connectionInventoryTool = tools.find((t) => t.name === 'mcp_loader_connection_inventory');
  assert.equal(connectionInventoryTool?.annotations.readOnlyHint, true);

  const runtimeStatusTool = tools.find((t) => t.name === 'mcp_loader_runtime_status');
  assert.equal(runtimeStatusTool?.annotations.readOnlyHint, true);

  const diagnosticsTool = tools.find((t) => t.name === 'mcp_loader_site_fabric_diagnostics');
  assert.equal(diagnosticsTool?.annotations.readOnlyHint, true);

  const inventoryTool = tools.find((t) => t.name === 'mcp_loader_site_tool_inventory_check');
  assert.equal(inventoryTool?.annotations.readOnlyHint, true);

  const attachTool = tools.find((t) => t.name === 'mcp_loader_attach_surface');
  assert.equal(attachTool?.annotations.readOnlyHint, false);

  const statusTool = tools.find((t) => t.name === 'mcp_loader_surface_status');
  assert.equal(statusTool?.annotations.readOnlyHint, true);

  const restartTool = tools.find((t) => t.name === 'mcp_loader_surface_restart');
  assert.equal(restartTool?.annotations.readOnlyHint, false);
  assert.equal((restartTool?.annotations as Record<string, unknown>).destructiveHint, true);

  console.log('mcp-loader-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
