import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  discoverPackageSourceRoots,
  resolveArtifactSelector,
  type ArtifactSelector,
} from '@narada2/artifact-integrity';
import { createServerState, handleRequest } from '../src/main.js';

export type KimiMcpServerConfig = {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  env_vars?: string[];
};

export type KimiCarrierConfig = {
  mcpServers: Record<string, KimiMcpServerConfig>;
};

export async function materializeKimiCarrierConfig(_outputPath: string): Promise<KimiCarrierConfig> {
  const response = await ((handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'registrar_carrier_materialize', arguments: { carrier_id: 'kimi-andrey' } },
  }, createServerState({}))) as any) as any as Record<string, any>;
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  const result = response.result?.structuredContent as Record<string, unknown> | undefined;
  assert.equal(result?.status, 'preview');
  assert.equal(result?.carrier_id, 'kimi-andrey');
  const generation = isRecord(result?.carrier_generation)
    ? result.carrier_generation
    : null;
  assert.ok(generation && Array.isArray(generation.bindings), 'preview must contain carrier generation bindings');

  // Contract tests execute the exact sealed child closures directly. The preview
  // generation is deliberately inert until a coordinated activation marker exists.
  const mcpServers: Record<string, KimiMcpServerConfig> = {};
  for (const rawBinding of generation.bindings) {
    const binding = isRecord(rawBinding) ? rawBinding : {};
    const source = isRecord(binding.source) ? binding.source : {};
    const selector = binding.artifact_selector as ArtifactSelector;
    assert.equal(typeof binding.server_key, 'string');
    assert.equal(typeof binding.artifact_entrypoint, 'string');
    assert.equal(typeof source.package_root, 'string');
    assert.equal(typeof source.workspace_root, 'string');
    const roots = await discoverPackageSourceRoots({
      package_root: String(source.package_root),
      workspace_root: String(source.workspace_root),
    });
    const artifact = await resolveArtifactSelector({
      selector,
      source_roots: roots.source_roots,
    });
    mcpServers[String(binding.server_key)] = {
      transport: 'stdio',
      command: process.execPath,
      args: [
        join(artifact.closure_path, ...String(binding.artifact_entrypoint).split('/')),
        ...(Array.isArray(binding.child_args) ? binding.child_args.map(String) : []),
      ],
      env_vars: Array.isArray(binding.child_env_names)
        ? binding.child_env_names.map(String)
        : [],
    };
  }
  assert.ok(Object.keys(mcpServers).length > 0, 'preview must contain at least one server');
  return { mcpServers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
