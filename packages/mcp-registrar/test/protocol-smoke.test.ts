import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'mcp-registrar-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);

  const responses = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const init = responses.find((m) => m.id === 1);
  assert.equal((init.result as Record<string, any>).serverInfo.name, 'mcp-registrar');

  const tools = (responses.find((m) => m.id === 2).result as Record<string, any>).tools;
  const expected = ['registrar_guidance', 'registrar_surface_list', 'registrar_site_list', 'registrar_site_surfaces', 'registrar_site_bind', 'registrar_site_unbind', 'registrar_carrier_list', 'registrar_carrier_bind', 'registrar_carrier_unbind', 'registrar_sync', 'registrar_carrier_materialize', 'registrar_carrier_apply', 'registrar_carrier_validate', 'registrar_carrier_diff', 'registrar_surface_usage', 'registrar_site_mcp_fabric_validate', 'registrar_site_surface_registry_sync', 'registrar_surface_tool_inventory_check', 'registrar_site_registry_conformance_check', 'registrar_site_output_reader_closure_check'];
  assert.deepEqual(tools.map((t: { name: string }) => t.name), expected);

  const bindTool = tools.find((t: { name: string }) => t.name === 'registrar_site_bind');
  assert.equal(bindTool.annotations.readOnlyHint, false);

  const unbindTool = tools.find((t: { name: string }) => t.name === 'registrar_site_unbind');
  assert.equal(unbindTool.annotations.destructiveHint, true);

  console.log('mcp-registrar protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
