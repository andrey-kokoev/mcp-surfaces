import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-behavior-'));
mkdirSync(join(root, '.ai', 'mcp'), { recursive: true });
const externalRoot = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-external-'));
const externalAgentContextEntrypoint = join(externalRoot, 'packages', 'agent-context-tools', 'src', 'agent-context-mcp-server.mjs');
mkdirSync(dirname(externalAgentContextEntrypoint), { recursive: true });
writeFileSync(externalAgentContextEntrypoint, 'export {};\n', 'utf8');
writeFileSync(join(root, '.ai', 'mcp', 'config.json'), JSON.stringify({
  mcpServers: {
    'test-echo': {
      command: 'node',
      args: ['--version'],
    },
    'missing-shared': {
      command: 'node',
      args: [join(root, 'missing-server.mjs')],
    },
    'agent-context': {
      command: 'node',
      args: [externalAgentContextEntrypoint],
    },
  },
}), 'utf8');

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath, '--allowed-site-root', root, '--allowed-entrypoint-prefix', join(dirname(serverPath), 'echo-server.mjs'), '--allowed-entrypoint-prefix', 'D:/code/mcp-surfaces/packages/'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

function rpc(method: string, params: Record<string, unknown>, id: number) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

async function call(method: string, params: Record<string, unknown>, id: number): Promise<Record<string, any> | undefined> {
  child.stdin.write(rpc(method, params, id));
  await new Promise((r) => setTimeout(r, 150));
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const response = lines.map((line) => JSON.parse(line)).find((m) => m.id === id);
  return (response?.result ?? response?.error) as Record<string, any> | undefined;
}

try {
  child.stdin.write(rpc('initialize', { protocolVersion: '2024-11-05' }, 1));
  child.stdin.write(rpc('tools/list', {}, 2));

  const listResult = await call('tools/call', { name: 'mcp_loader_list_site_surfaces', arguments: { site_root: root } }, 3);
  assert.equal(listResult?.schema, 'narada.mcp_loader.site_surfaces.v1');
  const surfaces = listResult?.surfaces as { surface_id: string }[];
  assert.ok(surfaces.some((s) => s.surface_id === 'test-echo'), `expected test-echo in ${JSON.stringify(surfaces)}`);

  const diagnosticsResult = await call('tools/call', { name: 'mcp_loader_site_fabric_diagnostics', arguments: { site_root: root } }, 4);
  assert.equal(diagnosticsResult?.schema, 'narada.mcp_loader.site_fabric_diagnostics.v1');
  const diagnostics = diagnosticsResult?.diagnostics as { surface_id: string; classification: string; provenance: { tracking_state: string }; durability: { local_repair_durable: string } }[];
  const missing = diagnostics.find((entry) => entry.surface_id === 'missing-shared');
  assert.equal(missing?.classification, 'stale_entrypoint');
  const agentContext = diagnostics.find((entry) => entry.surface_id === 'agent-context');
  assert.equal(agentContext?.classification, 'external_entrypoint_override');
  assert.equal(agentContext?.provenance.tracking_state, 'unknown');
  assert.equal(agentContext?.durability.local_repair_durable, 'unknown');

  const policyResult = await call('tools/call', { name: 'mcp_loader_policy_inspect', arguments: {} }, 5);
  assert.equal(policyResult?.schema, 'narada.mcp_loader.policy.v1');
  const policy = policyResult?.policy as { allowedSiteRoots: string[] };
  assert.ok(policy.allowedSiteRoots.some((p: string) => root.replace(/\\/g, '/').startsWith(p)));

  const badAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'unknown-surface' } }, 6);
  assert.equal(badAttach?.schema, undefined);

  const feedbackAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'surface-feedback' } }, 7);
  assert.equal(feedbackAttach?.code, undefined, JSON.stringify(feedbackAttach));
  assert.equal(feedbackAttach?.schema, 'narada.mcp_loader.surface_attached.v1');
  const feedbackArgs = feedbackAttach?.args as string[];
  assert.equal(feedbackArgs[feedbackArgs.indexOf('--feedback-root') + 1], 'D:/code/mcp-surfaces');
  assert.equal(feedbackArgs.includes(root), false);
  await call('tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: feedbackAttach?.connection_id } }, 8);

  console.log('mcp-loader-mcp behavior ok');
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  rmSync(root, { recursive: true, force: true });
  rmSync(externalRoot, { recursive: true, force: true });
}
