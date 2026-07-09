import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerState } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath, '--allowed-site-root', root], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

function rpc(method: string, params: Record<string, unknown>, id: number) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

try {
  const defaultState = createServerState();
  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (userProfile) {
    assert.ok(defaultState.policy.allowedSiteRoots.includes(resolve(userProfile, 'Narada').replace(/\\/g, '/')));
    assert.ok(defaultState.policy.allowedEntrypointPrefixes.includes(resolve(userProfile, 'Narada', 'tools').replace(/\\/g, '/')));
  }

  child.stdin.write(rpc('initialize', { protocolVersion: '2024-11-05' }, 1));
  child.stdin.write(rpc('tools/list', {}, 2));
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);

  const responses = stdout.trim().split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line));
  const init = responses.find((m: { id: number }) => m.id === 1);
  const serverInfo = ((init as { result: Record<string, unknown> }).result as Record<string, unknown>).serverInfo as Record<string, unknown>;
  assert.equal(serverInfo.name, 'mcp-loader-mcp');

  const toolsResponse = responses.find((m: { id: number }) => m.id === 2) as { result: Record<string, unknown> };
  const tools = toolsResponse.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
  assert.deepEqual(tools.map((t) => t.name), [
    'mcp_loader_policy_inspect',
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

  const listTool = tools.find((t) => t.name === 'mcp_loader_list_site_surfaces');
  assert.equal(listTool?.annotations.readOnlyHint, true);

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
  rmSync(root, { recursive: true, force: true });
}
