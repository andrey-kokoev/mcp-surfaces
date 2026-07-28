import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareV3CarrierGeneration,
  writePreparedV3CarrierGeneration,
} from '@narada2/mcp-runtime-proxy/carrier-materialization';
import {
  buildCarrierActivationMarker,
  sha256Text,
  writeCarrierActivationMarkerImmutable,
} from '@narada2/mcp-runtime-proxy/carrier-generation';
import { registrarSurfaceDefinition } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'mcp-registrar-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const proxyPackageRoot = fileURLToPath(new URL('../../../shared/mcp-runtime-proxy', import.meta.url));
const artifactStore = join(workspaceRoot, '.ai', 'runtime', 'artifact-store-v3');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

async function exchangeThroughProxy(): Promise<Record<string, any>[]> {
  const descriptor = registrarSurfaceDefinition().descriptor;
  const projection = descriptor.projections.find((candidate) => candidate.transport.kind === 'stdio');
  assert.ok(projection?.transport.kind === 'stdio');
  const configPath = join(root, 'carrier.json');
  const activationPath = join(root, 'activation.json');
  const activationToken = 'registrar-protocol-smoke';
  const prepared = await prepareV3CarrierGeneration({
    carrier_id: 'registrar-protocol-smoke',
    carrier_kind: 'kimi',
    config_path: configPath,
    artifact_store: artifactStore,
    generation_root: join(root, 'carrier-generations'),
    runtime_proxy_package_root: proxyPackageRoot,
    runtime_proxy_workspace_root: workspaceRoot,
    generation_id: 'protocol-smoke',
    activation: {
      cutover_id: 'registrar-protocol-smoke',
      marker_path: activationPath,
      token_digest: sha256Text(activationToken),
    },
    bindings: [{
      binding_id: 'registrar-protocol-smoke',
      server_key: 'mcp-registrar',
      surface_id: descriptor.surface_id,
      projection_id: projection.id,
      descriptor,
      source: { package_root: packageRoot, workspace_root: workspaceRoot },
      artifact_entrypoint: serverPath,
      child_args: [],
      child_env_names: projection.transport.env,
      client_tool_names: descriptor.tools.map((tool) => tool.name),
    }],
  });
  writePreparedV3CarrierGeneration(prepared);
  const launch = prepared.launches.get('mcp-registrar');
  assert.ok(launch);
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'mcp-registrar': launch,
    },
  }));
  writeCarrierActivationMarkerImmutable(activationPath, buildCarrierActivationMarker({
    cutover_id: 'registrar-protocol-smoke',
    activation_token: activationToken,
    generation_digests: [prepared.generation.generation_digest],
  }));
  const proxy = spawn(launch.command, launch.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let proxyStdout = '';
  let proxyStderr = '';
  proxy.stdout.setEncoding('utf8');
  proxy.stderr.setEncoding('utf8');
  proxy.stdout.on('data', (chunk) => { proxyStdout += chunk; });
  proxy.stderr.on('data', (chunk) => { proxyStderr += chunk; });
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} })}\n`);
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'surface_describe', arguments: {} } })}\n`);
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'surface_contract_describe', arguments: {} } })}\n`);
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'not_exposed', arguments: {} } })}\n`);
  proxy.stdin.end();
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => proxy.on('close', resolve)),
    new Promise<never>((_, reject) => setTimeout(() => {
      proxy.kill();
      reject(new Error('registrar_proxy_protocol_timeout'));
    }, 5_000)),
  ]);
  assert.equal(exitCode, 0, proxyStderr);
  return proxyStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

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
  const expected = ['registrar_guidance', 'registrar_surface_list', 'registrar_site_list', 'registrar_site_surfaces', 'registrar_site_bind', 'registrar_site_unbind', 'registrar_carrier_list', 'registrar_carrier_bind', 'registrar_carrier_unbind', 'registrar_sync', 'registrar_carrier_materialize', 'registrar_carrier_apply', 'registrar_runtime_v3_cutover_prepare', 'registrar_runtime_v3_cutover_status', 'registrar_runtime_v3_cutover_discard_prepared', 'registrar_carrier_validate', 'registrar_carrier_diff', 'registrar_surface_usage', 'registrar_site_mcp_fabric_validate', 'registrar_site_surface_registry_sync', 'registrar_surface_tool_inventory_check', 'registrar_site_registry_conformance_check', 'registrar_site_output_reader_closure_check'];
  assert.deepEqual(tools.map((t: { name: string }) => t.name), expected);

  const bindTool = tools.find((t: { name: string }) => t.name === 'registrar_site_bind');
  assert.equal(bindTool.annotations.readOnlyHint, false);

  const unbindTool = tools.find((t: { name: string }) => t.name === 'registrar_site_unbind');
  assert.equal(unbindTool.annotations.readOnlyHint, true);
  assert.equal(unbindTool.annotations.destructiveHint, false);

  const materializeTool = tools.find((t: { name: string }) => t.name === 'registrar_carrier_materialize');
  assert.equal(materializeTool.annotations.readOnlyHint, true);

  const conformanceTool = tools.find((t: { name: string }) => t.name === 'registrar_site_registry_conformance_check');
  assert.deepEqual(conformanceTool.inputSchema.required, ['site_id', 'observation_ref']);
  assert.equal(conformanceTool.inputSchema.properties.observed_tools, undefined);

  const proxyResponses = await exchangeThroughProxy();
  assert.equal(proxyResponses.find((message) => message.id === 11)?.result?.serverInfo?.name, 'mcp-registrar');
  assert.deepEqual(
    proxyResponses.find((message) => message.id === 12)?.result?.tools?.map((tool: { name: string }) => tool.name),
    [...expected, 'surface_describe', 'surface_contract_describe'],
  );
  const proxyTools = proxyResponses.find((message) => message.id === 12)?.result?.tools;
  for (const name of ['surface_describe', 'surface_contract_describe']) {
    assert.deepEqual(proxyTools.find((tool: { name: string }) => tool.name === name).annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  const surfaceDescription = proxyResponses.find((message) => message.id === 13)?.result?.structuredContent;
  assert.equal(surfaceDescription.schema, 'narada.mcp_surface.description.v1');
  assert.equal(surfaceDescription.surface_id, 'mcp-registrar');
  assert.equal(surfaceDescription.runtime.schema, 'narada.mcp_surface.runtime.v1');
  assert.equal(surfaceDescription.runtime.status, 'ok');
  assert.equal(surfaceDescription.runtime.generation_id, 'protocol-smoke');
  assert.equal(surfaceDescription.client_interface_digest, surfaceDescription.interface_digest);
  const surfaceContract = proxyResponses.find((message) => message.id === 14)?.result?.structuredContent;
  assert.equal(surfaceContract.schema, 'narada.mcp_surface.contract.v1');
  assert.deepEqual(
    surfaceContract.tools.map((tool: { name: string }) => tool.name),
    [...expected, 'surface_describe', 'surface_contract_describe'],
  );
  assert.equal(surfaceContract.client_interface_digest, surfaceContract.interface_digest);
  assert.equal(proxyResponses.find((message) => message.id === 15)?.error?.data?.code, 'tool_not_exposed');

  console.log('mcp-registrar protocol smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
