import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineSurface,
  surfaceDescriptorDigest,
  surfaceInterfaceDigest,
} from '@narada2/mcp-fabric-contracts';
import {
  CarrierGenerationError,
  assertCarrierGenerationActivated,
  buildCarrierActivationMarker,
  buildCarrierGeneration,
  parseCarrierGeneration,
  readCarrierGeneration,
  runtimeProxyCompatibility,
  sha256Text,
  validateCarrierBindingLaunch,
  writeCarrierGenerationImmutable,
  writeCarrierActivationMarkerImmutable,
} from '../src/carrier-generation.js';

const root = mkdtempSync(join(tmpdir(), 'carrier-generation-v3-'));
const configPath = join(root, 'config.toml');
const generationPath = join(root, 'generation.json');
const activationPath = join(root, 'activation.json');
const activationToken = 'activation-token';
const artifactStore = join(root, 'artifacts');
const proxyEntrypoint = join(artifactStore, 'closures', 'sha256', 'proxy', 'dist', 'src', 'main.js');
const launch = {
  command: process.execPath,
  args: [
    proxyEntrypoint,
    '--runtime-contract-version',
    '3',
    '--carrier-generation',
    generationPath,
    '--server-key',
    'example-server',
    '--artifact-store',
    artifactStore,
  ],
};
writeFileSync(configPath, [
  '[projects."D:\\\\unrelated"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.example-server]',
  `command = ${JSON.stringify(launch.command)}`,
  `args = ${JSON.stringify(launch.args)}`,
  '',
].join('\n'), 'utf8');

const surface = defineSurface({
  surface_id: 'example',
  surface_version: '1.0.0',
  package: '@example/mcp',
  description: 'Example sealed MCP surface.',
  tools: [{
    definition: {
      name: 'example_guidance',
      description: 'Describe the example workflow.',
      inputSchema: { type: 'object', additionalProperties: false },
    },
    effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
  }],
  projections: [{
    id: 'default',
    transport: { kind: 'stdio', command: 'node', args: ['dist/main.js'], env: [] },
    injection_scope: 'local_site',
    default_injection: 'enabled',
    runtime_requirements: [],
    authority_requirements: ['scope.local_site'],
    lifecycle: { mode: 'restart_required', restart_owner: 'carrier' },
  }],
});
const surfaceCompatibility = {
  artifact_profile: 'mcp-surface-v3',
  descriptor_digest: `sha256:${surfaceDescriptorDigest(surface.descriptor)}` as const,
  interface_digest: `sha256:${surfaceInterfaceDigest(surface.descriptor)}` as const,
};
const runtimeCompatibility = runtimeProxyCompatibility();
const generation = buildCarrierGeneration({
  generation_id: 'generation-test',
  carrier_id: 'codex-user',
  carrier_kind: 'codex',
  config_path: configPath,
  generated_at: '2026-07-25T00:00:00.000Z',
  activation: {
    cutover_id: 'cutover-test',
    marker_path: activationPath,
    token_digest: sha256Text(activationToken),
  },
  runtime_proxy: {
    artifact_selector: {
      mode: 'latest_compatible',
      store_root: artifactStore,
      package_name: '@narada2/mcp-runtime-proxy',
      compatibility: runtimeCompatibility,
      source_policy: 'require_fresh',
    },
    source: { package_root: join(root, 'proxy-source'), workspace_root: root },
    artifact_entrypoint: 'dist/src/main.js',
    closure_digest: `sha256:${'1'.repeat(64)}`,
    receipt_digest: `sha256:${'2'.repeat(64)}`,
  },
  bindings: [{
    binding_id: 'example-binding',
    server_key: 'example-server',
    surface_id: 'example',
    projection_id: 'default',
    descriptor: surface.descriptor,
    artifact_selector: {
      mode: 'latest_compatible',
      store_root: artifactStore,
      package_name: '@example/mcp',
      compatibility: surfaceCompatibility,
      source_policy: 'require_fresh',
    },
    closure_digest: `sha256:${'3'.repeat(64)}`,
    receipt_digest: `sha256:${'4'.repeat(64)}`,
    source: { package_root: join(root, 'example-source'), workspace_root: root },
    artifact_entrypoint: 'dist/main.js',
    child_args: ['--mode', 'write'],
    child_env_names: ['SITE_ROOT', 'SITE_ROOT'],
    client_tool_names: surface.descriptor.tools.map((tool) => tool.name),
    proxy_launch: launch,
  }],
});

assert.equal(generation.schema, 'narada.mcp_carrier_generation.v3');
assert.equal(generation.bindings[0]!.child_env_names.length, 1);
assert.deepEqual(parseCarrierGeneration(generation), generation);
writeCarrierGenerationImmutable(generationPath, generation);
writeCarrierGenerationImmutable(generationPath, generation);
assert.deepEqual(readCarrierGeneration(generationPath), generation);
assert.throws(
  () => assertCarrierGenerationActivated(generation),
  (error: unknown) =>
    error instanceof CarrierGenerationError
    && error.code === 'carrier_generation_not_activated',
);
writeCarrierActivationMarkerImmutable(activationPath, buildCarrierActivationMarker({
  cutover_id: 'cutover-test',
  activation_token: activationToken,
  generation_digests: [generation.generation_digest],
  activated_at: '2026-07-25T00:01:00.000Z',
}));
assert.doesNotThrow(() => assertCarrierGenerationActivated(generation));
validateCarrierBindingLaunch({ generation, binding: generation.bindings[0]! });

writeFileSync(configPath, [
  '[projects."D:\\\\changed-but-unrelated"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.example-server]',
  `command = ${JSON.stringify(launch.command)}`,
  `args = ${JSON.stringify(launch.args)}`,
  '',
].join('\n'), 'utf8');
validateCarrierBindingLaunch({ generation, binding: generation.bindings[0]! });

writeFileSync(configPath, [
  '[mcp_servers.example-server]',
  `command = ${JSON.stringify(launch.command)}`,
  `args = ${JSON.stringify([...launch.args, '--unexpected', 'value'])}`,
  '',
].join('\n'), 'utf8');
assert.throws(
  () => validateCarrierBindingLaunch({ generation, binding: generation.bindings[0]! }),
  (error: unknown) => error instanceof CarrierGenerationError && error.code === 'carrier_binding_stale',
);

const tampered = JSON.parse(readFileSync(generationPath, 'utf8')) as Record<string, unknown>;
tampered.carrier_id = 'tampered';
assert.throws(
  () => parseCarrierGeneration(tampered),
  (error: unknown) => error instanceof CarrierGenerationError && error.code === 'carrier_generation_corrupt',
);

assert.throws(
  () => writeCarrierGenerationImmutable(generationPath, {
    ...generation,
    generation_id: 'collision',
  }),
  CarrierGenerationError,
);
