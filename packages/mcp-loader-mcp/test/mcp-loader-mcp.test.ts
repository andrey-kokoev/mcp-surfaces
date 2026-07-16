import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payloadShow } from '@narada2/mcp-transport';
import { resolveToolCallTimeoutMs } from '../src/tool-timeout.js';

assert.deepEqual(resolveToolCallTimeoutMs(undefined), { status: 'ok', timeoutMs: 120000, source: 'policy_default' });
assert.deepEqual(resolveToolCallTimeoutMs(240000), { status: 'ok', timeoutMs: 240000, source: 'tool_request' });
assert.deepEqual(resolveToolCallTimeoutMs(1000), { status: 'ok', timeoutMs: 1000, source: 'tool_request' });
assert.equal(resolveToolCallTimeoutMs(600001).status, 'refused');
assert.equal(resolveToolCallTimeoutMs('not-a-number').status, 'refused');

const root = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-behavior-'));
mkdirSync(join(root, '.ai', 'mcp'), { recursive: true });
const aggregateRoot = join(mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-aggregate-parent-')), 'narada.sonar');
mkdirSync(join(aggregateRoot, '.ai', 'mcp'), { recursive: true });
const fragmentedRoot = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-fragmented-'));
mkdirSync(join(fragmentedRoot, '.ai', 'mcp'), { recursive: true });
const duplicateRoot = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-duplicate-'));
mkdirSync(join(duplicateRoot, '.ai', 'mcp'), { recursive: true });
const legacyAndreyRoot = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-legacy-andrey-'));
mkdirSync(join(legacyAndreyRoot, '.ai', 'mcp'), { recursive: true });
const legacyUserSiteRoot = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-legacy-user-site-'));
mkdirSync(join(legacyUserSiteRoot, '.ai', 'mcp'), { recursive: true });
const externalRoot = mkdtempSync(join(tmpdir(), 'mcp-loader-mcp-external-'));
const externalAgentContextEntrypoint = join(externalRoot, 'packages', 'agent-context-tools', 'src', 'agent-context-mcp-server.mjs');
mkdirSync(dirname(externalAgentContextEntrypoint), { recursive: true });
writeFileSync(externalAgentContextEntrypoint, 'export {};\n', 'utf8');
  const failingEntrypoint = join(root, 'failing-child.mjs');
  writeFileSync(failingEntrypoint, "process.stderr.write('loader child import failed\\n'); process.exit(42);\n", 'utf8');
  const restartableEntrypoint = join(root, 'restartable-child.mjs');
  writeFileSync(restartableEntrypoint, `
process.stdin.setEncoding('utf8');
let buffer = '';
function write(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') write({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'restartable-child', pid: process.pid } } });
    else if (request.method === 'tools/list') {
      const guidanceTools = process.argv.includes('--guidance')
        ? [{ name: 'guidance-surface_guidance', inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true } }]
        : [];
      write({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', additionalProperties: true }, ...(process.argv.includes('--unclassified') ? {} : { annotations: { readOnlyHint: false } }) }, ...guidanceTools] } });
    }
    else if (request.method === 'tools/call') {
      const respond = () => write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { status: 'ok', pid: process.pid, args: request.params?.arguments ?? {}, child_args: process.argv.slice(2), site_root: process.env.NARADA_SITE_ROOT ?? null, caller_agent_id: process.env.NARADA_AGENT_ID ?? null, carrier_session_id: process.env.NARADA_CARRIER_SESSION_ID ?? null, site_id: process.env.NARADA_SITE_ID ?? null } } });
      const delayMs = Number(request.params?.arguments?.delay_ms ?? 0);
      if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    }
    else write({ jsonrpc: '2.0', id: request.id, result: {} });
  }
});
`, 'utf8');
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
    restartable: {
      command: 'node',
      args: [restartableEntrypoint, '--site-root', root, '--marker', 'fabric'],
      tools: ['echo'],
    },
    'guidance-surface': {
      command: 'node',
      args: [restartableEntrypoint, '--guidance'],
      tools: ['echo', 'guidance-surface_guidance'],
    },
    'absolute-node': {
      command: process.execPath,
      args: [restartableEntrypoint, '--site-root', root, '--marker', 'absolute'],
      tools: ['echo'],
    },
    'restartable-drift': {
      command: 'node',
      args: [restartableEntrypoint, '--site-root', root, '--marker', 'drift'],
      tools: [],
    },
    'restartable-unclassified': {
      command: 'node',
      args: [restartableEntrypoint, '--site-root', root, '--unclassified'],
      tools: ['echo'],
    },
    'narada-sonar-nars-session': {
      command: 'node',
      args: [restartableEntrypoint, '--site-root', root, '--marker', 'nars'],
      tools: ['echo'],
      surface_id: 'nars-session',
      surface_projection: {
        runtime_requirements: ['nars'],
      },
    },
  },
}), 'utf8');
writeFileSync(join(aggregateRoot, '.ai', 'mcp', 'narada-sonar-mcp.json'), JSON.stringify({
  mcpServers: {
    'site-loop': {
      command: 'node',
      args: ['--version'],
    },
  },
}), 'utf8');
writeFileSync(join(fragmentedRoot, '.ai', 'mcp', 'alpha-mcp.json'), JSON.stringify({
  site_id: 'fragmented-site',
  mcpServers: { alpha: { command: 'node', args: ['--version'] } },
}), 'utf8');
writeFileSync(join(fragmentedRoot, '.ai', 'mcp', 'beta-mcp.json'), JSON.stringify({
  site_id: 'fragmented-site',
  mcpServers: { beta: { command: 'node', args: ['--version'] } },
}), 'utf8');
writeFileSync(join(duplicateRoot, '.ai', 'mcp', 'alpha-mcp.json'), JSON.stringify({
  site_id: 'duplicate-site',
  mcpServers: { duplicate: { command: 'node', args: ['--version'] } },
}), 'utf8');
writeFileSync(join(duplicateRoot, '.ai', 'mcp', 'beta-mcp.json'), JSON.stringify({
  site_id: 'duplicate-site',
  mcpServers: { duplicate: { command: 'node', args: ['--help'] } },
}), 'utf8');
for (const [legacyRoot, site_id] of [[legacyAndreyRoot, 'narada-andrey'], [legacyUserSiteRoot, 'narada-user-site']] as const) {
  writeFileSync(join(legacyRoot, '.ai', 'mcp', 'legacy-mcp.json'), JSON.stringify({
    site_id,
    mcpServers: { legacy: { command: 'node', args: ['--version'] } },
  }), 'utf8');
}

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const child = spawn(process.execPath, [serverPath, '--allowed-site-root', root, '--allowed-site-root', aggregateRoot, '--allowed-site-root', fragmentedRoot, '--allowed-site-root', duplicateRoot, '--allowed-site-root', legacyAndreyRoot, '--allowed-site-root', legacyUserSiteRoot, '--allowed-entrypoint-prefix', root, '--allowed-entrypoint-prefix', aggregateRoot, '--allowed-entrypoint-prefix', join(dirname(serverPath), 'echo-server.mjs'), '--allowed-entrypoint-prefix', 'D:/code/mcp-surfaces/packages/', '--tool-call-timeout-ms', '1000'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NARADA_AGENT_ID: 'test.agent', NARADA_CARRIER_SESSION_ID: 'carrier-test', NARADA_SITE_ID: 'test-site' } });

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
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const response = lines.map((line) => JSON.parse(line)).find((m) => m.id === id);
    if (response) {
      if (response.error) return response.error as Record<string, any>;
      const result = response.result as Record<string, any>;
      return (result.structuredContent ?? result) as Record<string, any>;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

try {
  child.stdin.write(rpc('initialize', { protocolVersion: '2024-11-05' }, 1));
  child.stdin.write(rpc('tools/list', {}, 2));

  const guidance = await call('tools/call', { name: 'mcp_loader_guidance', arguments: { workflow: 'discover', tool: 'mcp_loader_list_tools' } }, 35);
  assert.equal(guidance?.schema, 'narada.mcp_surface.guidance.v0');
  assert.equal(guidance?.surface_id, 'mcp-loader');
  assert.equal(guidance?.guidance_tool, 'mcp_loader_guidance');
  assert.deepEqual(guidance?.requested, { workflow: 'discover', tool: 'mcp_loader_list_tools' });
  assert.equal(guidance?.runtime_lifecycle?.schema, 'narada.mcp_loader.runtime_lifecycle.v1');
  assert.equal(guidance?.runtime_lifecycle?.managed_by, 'mcp-loader');
  assert.equal(guidance?.runtime_lifecycle?.restartable, null);
  assert.equal(guidance?.runtime_lifecycle?.restartability_status, 'available_after_successful_attach');
  assert.equal(guidance?.runtime_lifecycle?.restart_tool, 'mcp_loader_surface_restart');
  assert.equal(guidance?.runtime_freshness?.schema, 'narada.mcp_loader.runtime_freshness.v1');
  assert.equal(guidance?.runtime_freshness?.status, 'current');
  assert.equal(guidance?.runtime_freshness?.runtime_entrypoint?.exists, true);
  assert.equal(guidance?.runtime_freshness?.source_entrypoint?.exists, true);
  assert.equal(guidance?.runtime_freshness?.reload_action?.kind, 'restart_loader_process');
  assert.ok((guidance?.tool_preference as Array<Record<string, unknown>>).some((step) => step.step === 'discover'));

  const runtimeStatus = await call('tools/call', { name: 'mcp_loader_runtime_status', arguments: {} }, 351);
  assert.equal(runtimeStatus?.schema, 'narada.mcp_loader.runtime_freshness.v1');
  assert.equal(runtimeStatus?.status, 'current');
  assert.equal(runtimeStatus?.runtime_entrypoint?.exists, true);
  assert.equal(runtimeStatus?.source_entrypoint?.exists, true);
  assert.equal(runtimeStatus?.reload_action?.kind, 'restart_loader_process');
  assert.ok((guidance?.boundaries as string[]).some((boundary) => boundary.includes('does not own attached-surface domain policy')));

  const emptyInventory = await call('tools/call', { name: 'mcp_loader_connection_inventory', arguments: {} }, 36);
  assert.equal(emptyInventory?.schema, 'narada.mcp_loader.connection_inventory.v1');
  assert.equal(emptyInventory?.connection_count, 0);
  assert.equal(emptyInventory?.available_slots, 8);
  assert.equal(emptyInventory?.closed_count, 0);
  assert.match(String(emptyInventory?.recovery?.note), /read-only/);

  const listResult = await call('tools/call', { name: 'mcp_loader_list_site_surfaces', arguments: { site_root: root } }, 3);
  assert.equal(listResult?.schema, 'narada.mcp_loader.site_surfaces.v1');
  const surfaces = listResult?.surfaces as { surface_id: string; runtime_lifecycle: Record<string, any> }[];
  assert.ok(surfaces.some((s) => s.surface_id === 'test-echo'), `expected test-echo in ${JSON.stringify(surfaces)}`);
  assert.ok(surfaces.some((s) => s.surface_id === 'nars-session'), `expected canonical nars-session in ${JSON.stringify(surfaces)}`);
  const restartableSurface = surfaces.find((s) => s.surface_id === 'restartable');
  assert.equal(restartableSurface?.runtime_lifecycle?.managed_by, 'mcp-loader');
  assert.equal(restartableSurface?.runtime_lifecycle?.restartable, null);
  assert.equal(restartableSurface?.runtime_lifecycle?.restartability_status, 'available_after_successful_attach');
  assert.equal(restartableSurface?.runtime_lifecycle?.connection_id_required, true);

  const aggregateListResult = await call('tools/call', { name: 'mcp_loader_list_site_surfaces', arguments: { site_root: aggregateRoot } }, 10);
  assert.equal(aggregateListResult?.schema, 'narada.mcp_loader.site_surfaces.v1');
  const aggregateSurfaces = aggregateListResult?.surfaces as { surface_id: string }[];
  assert.ok(aggregateSurfaces.some((s) => s.surface_id === 'site-loop'), `expected site-loop in ${JSON.stringify(aggregateSurfaces)}`);

  const fragmentedListResult = await call('tools/call', { name: 'mcp_loader_list_site_surfaces', arguments: { site_root: fragmentedRoot } }, 21);
  assert.equal(fragmentedListResult?.schema, 'narada.mcp_loader.site_surfaces.v1');
  const fragmentedSurfaces = fragmentedListResult?.surfaces as { surface_id: string }[];
  assert.deepEqual(fragmentedSurfaces.map((surface) => surface.surface_id).sort(), ['alpha', 'beta']);

  const duplicateListResult = await call('tools/call', { name: 'mcp_loader_list_site_surfaces', arguments: { site_root: duplicateRoot } }, 22);
  assert.equal(duplicateListResult?.data?.code, 'site_fabric_duplicate_surface');
  for (const legacyRoot of [legacyAndreyRoot, legacyUserSiteRoot]) {
    const legacyListResult = await call('tools/call', { name: 'mcp_loader_list_site_surfaces', arguments: { site_root: legacyRoot } }, 26);
    assert.equal(legacyListResult?.data?.code, 'site_fabric_legacy_site_id_rejected');
  }

  const inventoryOk = await call('tools/call', { name: 'mcp_loader_site_tool_inventory_check', arguments: { site_root: root, surface_ids: ['restartable'], include_ok: true } }, 23);
  assert.equal(inventoryOk?.status, 'ok');
  assert.equal(inventoryOk?.violation_count, 0);
  assert.deepEqual(inventoryOk?.observed_tools?.restartable, ['echo']);
  assert.deepEqual(inventoryOk?.requested_surface_ids, ['restartable']);
  assert.deepEqual(inventoryOk?.attempted_surface_ids, ['restartable']);
  assert.deepEqual(inventoryOk?.observed_surface_ids, ['restartable']);
  assert.deepEqual(inventoryOk?.unobserved_surface_ids, []);
  assert.equal(inventoryOk?.observation_coverage, 'partial');
  assert.deepEqual(inventoryOk?.observed_read_only_tools?.restartable, []);
  assert.deepEqual(inventoryOk?.observed_mutating_tools?.restartable, ['echo']);
  assert.deepEqual(inventoryOk?.observed_unclassified_tools?.restartable, []);
  assert.match(String(inventoryOk?.observation_ref), /^mcp_payload:/);
  const materializedObservation = payloadShow({ siteRoot: root, args: { ref: inventoryOk?.observation_ref } });
  assert.equal(materializedObservation.sha256, inventoryOk?.observation_sha256);
  assert.deepEqual(materializedObservation.payload?.observed_mutating_tools?.restartable, ['echo']);
  assert.equal(inventoryOk?.observation_retention?.max_entries, 32);
  assert.equal(inventoryOk?.observation_retention?.max_age_ms, 7 * 24 * 60 * 60 * 1000);
  assert.ok(inventoryOk?.observation_retention?.retained_payload_ids.includes(materializedObservation.payload_id));
  const inventoryDrift = await call('tools/call', { name: 'mcp_loader_site_tool_inventory_check', arguments: { site_root: root, surface_ids: ['restartable-drift'] } }, 24);
  assert.equal(inventoryDrift?.status, 'drift');
  assert.deepEqual(inventoryDrift?.findings?.[0]?.missing_from_fabric, ['echo']);
  const inventoryUnclassified = await call('tools/call', { name: 'mcp_loader_site_tool_inventory_check', arguments: { site_root: root, surface_ids: ['restartable-unclassified'] } }, 25);
  assert.equal(inventoryUnclassified?.status, 'drift');
  assert.deepEqual(inventoryUnclassified?.findings?.[0]?.unclassified_observed_tools, ['echo']);

  const runtimeNeutralInventory = await call('tools/call', { name: 'mcp_loader_site_tool_inventory_check', arguments: { site_root: root, surface_ids: ['nars-session'], include_ok: true } }, 27);
  assert.equal(runtimeNeutralInventory?.status, 'ok');
  assert.equal(runtimeNeutralInventory?.runtime_kind, null);
  assert.deepEqual(runtimeNeutralInventory?.runtime_skipped_surface_ids, ['nars-session']);
  assert.equal(runtimeNeutralInventory?.findings?.[0]?.status, 'runtime_not_selected');
  assert.deepEqual(runtimeNeutralInventory?.findings?.[0]?.runtime_requirements, ['nars']);

  const missingRuntimeAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'nars-session' } }, 28);
  assert.equal(missingRuntimeAttach?.data?.code, 'surface_runtime_required');
  const wrongRuntimeAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'nars-session', runtime_kind: 'codex' } }, 29);
  assert.equal(wrongRuntimeAttach?.data?.code, 'surface_runtime_not_supported');

  const narsAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'nars-session', runtime_kind: 'nars' } }, 30);
  assert.equal(narsAttach?.schema, 'narada.mcp_loader.surface_attached.v1');
  assert.equal(narsAttach?.runtime_kind, 'nars');
  assert.deepEqual(narsAttach?.runtime_requirements, ['nars']);
  const narsDetach = await call('tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: narsAttach?.connection_id } }, 31);
  assert.equal(narsDetach?.termination?.status, 'terminated');

  const narsInventory = await call('tools/call', { name: 'mcp_loader_site_tool_inventory_check', arguments: { site_root: root, surface_ids: ['nars-session'], runtime_kind: 'nars', include_ok: true } }, 32);
  assert.equal(narsInventory?.status, 'ok');
  assert.equal(narsInventory?.runtime_kind, 'nars');
  assert.deepEqual(narsInventory?.runtime_skipped_surface_ids, []);
  assert.deepEqual(narsInventory?.observed_tools?.['nars-session'], ['echo']);

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
  const failingAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'test-echo', entrypoint: failingEntrypoint } }, 9);
  assert.equal(failingAttach?.data?.code, 'child_exited');
  assert.match(failingAttach?.data?.details?.stderr_tail ?? '', /loader child import failed/);
  assert.equal(failingAttach?.data?.details?.runtime_lifecycle?.restartable, true);
  assert.equal(failingAttach?.data?.details?.runtime_lifecycle?.restart_tool, 'mcp_loader_surface_restart');

  const feedbackAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'surface-feedback' } }, 7);
  assert.equal(feedbackAttach?.code, undefined, JSON.stringify(feedbackAttach));
  assert.equal(feedbackAttach?.schema, 'narada.mcp_loader.surface_attached.v1');
  const feedbackArgs = feedbackAttach?.args as string[];
  assert.equal(feedbackArgs[feedbackArgs.indexOf('--feedback-root') + 1], 'D:/code/mcp-surfaces');
  assert.equal(feedbackArgs.includes(root), false);
  const feedbackDetach = await call('tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: feedbackAttach?.connection_id } }, 8);
  assert.equal(feedbackDetach?.termination?.status, 'terminated');

  const fabricAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'restartable' } }, 18);
  assert.equal(fabricAttach?.schema, 'narada.mcp_loader.surface_attached.v1');
  assert.equal(fabricAttach?.entrypoint, restartableEntrypoint.replace(/\\/g, '/'));
  assert.deepEqual(fabricAttach?.args, ['--site-root', root, '--marker', 'fabric']);
  const fabricCall = await call('tools/call', { name: 'mcp_loader_call_tool', arguments: { connection_id: fabricAttach?.connection_id, tool_name: 'echo', arguments: { n: 0 } } }, 19);
  assert.deepEqual(fabricCall?.result?.structuredContent?.child_args, ['--site-root', root, '--marker', 'fabric']);
  assert.equal(fabricCall?.result?.structuredContent?.site_root, root.replace(/\\/g, '/'));
  assert.equal(fabricCall?.result?.structuredContent?.caller_agent_id, 'test.agent');
  assert.equal(fabricCall?.result?.structuredContent?.carrier_session_id, 'carrier-test');
  assert.equal(fabricCall?.result?.structuredContent?.site_id, 'test-site');
  const propagatedTimeoutCall = await call('tools/call', { name: 'mcp_loader_call_tool', arguments: { connection_id: fabricAttach?.connection_id, tool_name: 'echo', arguments: { delay_ms: 1050, timeout_ms: 1200 } } }, 191);
  assert.equal(propagatedTimeoutCall?.schema, 'narada.mcp_loader.tool_result.v1');
  assert.equal(propagatedTimeoutCall?.result?.structuredContent?.args?.timeout_ms, 1200);
  const liveInventory = await call('tools/call', { name: 'mcp_loader_connection_inventory', arguments: {} }, 37);
  const liveEntry = (liveInventory?.connections as Array<Record<string, any>>).find((entry) => entry.connection_id === fabricAttach?.connection_id);
  assert.equal(liveEntry?.status, 'live');
  assert.equal(liveEntry?.liveness, 'live');
  assert.equal(typeof liveEntry?.age_ms, 'number');
  assert.equal(liveEntry?.runtime_lifecycle?.managed_by, 'mcp-loader');
  assert.equal(liveEntry?.runtime_lifecycle?.restartable, true);
  assert.equal(liveEntry?.runtime_lifecycle?.actions?.restart?.tool_name, 'mcp_loader_surface_restart');
  assert.equal(liveEntry?.recovery_actions?.inspect?.tool_name, 'mcp_loader_surface_status');
  assert.equal(liveEntry?.recovery_actions?.detach?.tool_name, 'mcp_loader_detach');
  const fabricDetach = await call('tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: fabricAttach?.connection_id } }, 20);
  assert.equal(fabricDetach?.termination?.status, 'terminated');

  const guidanceAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'guidance-surface' } }, 201);
  assert.equal(guidanceAttach?.schema, 'narada.mcp_loader.surface_attached.v1');
  const guidanceCall = await call('tools/call', { name: 'mcp_loader_call_tool', arguments: { connection_id: guidanceAttach?.connection_id, tool_name: 'guidance-surface_guidance', arguments: {} } }, 202);
  assert.equal(guidanceCall?.schema, 'narada.mcp_loader.tool_result.v1');
  assert.equal(guidanceCall?.result?.structuredContent?.loader_runtime_lifecycle?.schema, 'narada.mcp_loader.runtime_lifecycle.v1');
  assert.equal(guidanceCall?.result?.structuredContent?.loader_runtime_lifecycle?.managed_by, 'mcp-loader');
  assert.equal(guidanceCall?.result?.structuredContent?.loader_runtime_lifecycle?.restartable, true);
  assert.equal(guidanceCall?.result?.structuredContent?.loader_runtime_lifecycle?.actions?.restart?.tool_name, 'mcp_loader_surface_restart');
  assert.equal(guidanceCall?.result?.structuredContent?.loader_runtime_freshness?.schema, 'narada.mcp_loader.runtime_freshness.v1');
  const guidanceDetach = await call('tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: guidanceAttach?.connection_id } }, 203);
  assert.equal(guidanceDetach?.termination?.status, 'terminated');

  const absoluteNodeAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'absolute-node' } }, 33);
  assert.equal(absoluteNodeAttach?.schema, 'narada.mcp_loader.surface_attached.v1');
  assert.equal(absoluteNodeAttach?.entrypoint, restartableEntrypoint.replace(/\\/g, '/'));
  assert.deepEqual(absoluteNodeAttach?.args, ['--site-root', root, '--marker', 'absolute']);
  const absoluteNodeDetach = await call('tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: absoluteNodeAttach?.connection_id } }, 34);
  assert.equal(absoluteNodeDetach?.termination?.status, 'terminated');

  const restartableAttach = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'restartable', entrypoint: restartableEntrypoint } }, 11);
  assert.equal(restartableAttach?.schema, 'narada.mcp_loader.surface_attached.v1');
  assert.equal(restartableAttach?.runtime_lifecycle?.managed_by, 'mcp-loader');
  assert.equal(restartableAttach?.runtime_lifecycle?.restartable, true);
  assert.equal(restartableAttach?.runtime_lifecycle?.actions?.restart?.tool_name, 'mcp_loader_surface_restart');
  const oldConnectionId = String(restartableAttach?.connection_id);
  const initialStatus = await call('tools/call', { name: 'mcp_loader_surface_status', arguments: { connection_id: oldConnectionId } }, 12);
  assert.equal(initialStatus?.schema, 'narada.mcp_loader.surface_status.v1');
  assert.equal(initialStatus?.status, 'live');
  assert.equal(initialStatus?.runtime_lifecycle?.managed_by, 'mcp-loader');
  assert.equal(initialStatus?.runtime_lifecycle?.restartable, true);
  const firstCall = await call('tools/call', { name: 'mcp_loader_call_tool', arguments: { connection_id: oldConnectionId, tool_name: 'echo', arguments: { n: 1 } } }, 13);
  assert.equal(firstCall?.schema, 'narada.mcp_loader.tool_result.v1');
  assert.equal(firstCall?.runtime_lifecycle?.managed_by, 'mcp-loader');
  assert.equal(firstCall?.runtime_lifecycle?.restartable, true);
  const firstPid = firstCall?.result?.structuredContent?.pid;
  const restart = await call('tools/call', { name: 'mcp_loader_surface_restart', arguments: { connection_id: oldConnectionId, reason: 'test transport replacement' } }, 14);
  assert.equal(restart?.schema, 'narada.mcp_loader.surface_restarted.v1');
  assert.equal(restart?.status, 'restarted');
  assert.equal(restart?.previous_connection_id, oldConnectionId);
  assert.notEqual(restart?.connection_id, oldConnectionId);
  assert.equal(restart?.previous_connection?.status, 'live');
  assert.equal(restart?.replacement_connection?.status, 'live');
  assert.equal(restart?.runtime_lifecycle?.managed_by, 'mcp-loader');
  assert.equal(restart?.runtime_lifecycle?.restartable, true);
  assert.equal(restart?.termination?.status, 'terminated');
  const oldCall = await call('tools/call', { name: 'mcp_loader_call_tool', arguments: { connection_id: oldConnectionId, tool_name: 'echo', arguments: {} } }, 15);
  assert.equal(oldCall?.data?.code, 'connection_not_found');
  const replacementCall = await call('tools/call', { name: 'mcp_loader_call_tool', arguments: { connection_id: restart?.connection_id, tool_name: 'echo', arguments: { n: 2 } } }, 16);
  assert.equal(replacementCall?.schema, 'narada.mcp_loader.tool_result.v1');
  assert.notEqual(replacementCall?.result?.structuredContent?.pid, firstPid);
  const replacementDetach = await call('tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: restart?.connection_id } }, 17);
  assert.equal(replacementDetach?.termination?.status, 'terminated');

  const capacityBeforeFill = await call('tools/call', { name: 'mcp_loader_connection_inventory', arguments: {} }, 50);
  const availableSlots = Number(capacityBeforeFill?.available_slots ?? 0);
  for (let index = 0; index < availableSlots; index += 1) {
    const attached = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'restartable' } }, 60 + index);
    assert.equal(attached?.schema, 'narada.mcp_loader.surface_attached.v1');
  }
  const capacityRefusal = await call('tools/call', { name: 'mcp_loader_attach_surface', arguments: { site_root: root, surface_id: 'restartable' } }, 70);
  assert.equal(capacityRefusal?.data?.code, 'max_connections_reached');
  assert.equal(capacityRefusal?.data?.details?.available_slots, 0);
  assert.ok(Array.isArray(capacityRefusal?.data?.details?.closed_connection_ids));
  const fullInventory = await call('tools/call', { name: 'mcp_loader_connection_inventory', arguments: {} }, 71);
  assert.equal(fullInventory?.available_slots, 0);
  assert.equal(fullInventory?.connection_count, fullInventory?.max_connections);
  assert.equal(fullInventory?.closed_count, fullInventory?.closed_connection_ids?.length);
  for (const entry of fullInventory?.connections as Array<Record<string, any>>) {
    const detached = await call('tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: entry.connection_id } }, 80);
    assert.ok(['terminated', 'already_exited'].includes(detached?.termination?.status));
  }

  console.log('mcp-loader-mcp behavior ok');
} finally {
  child.stdin.end();
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('close', resolve);
      child.kill();
    });
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(dirname(aggregateRoot), { recursive: true, force: true });
  rmSync(fragmentedRoot, { recursive: true, force: true });
  rmSync(duplicateRoot, { recursive: true, force: true });
  rmSync(legacyAndreyRoot, { recursive: true, force: true });
  rmSync(legacyUserSiteRoot, { recursive: true, force: true });
  rmSync(externalRoot, { recursive: true, force: true });
}
