import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  captureSourceClosure,
  captureToolchainEvidence,
  collectSourceRoots,
  createBuildRecipe,
  loadPackageArtifactConfiguration,
  sealDeployment,
  type ArtifactCompatibility,
} from '@narada2/artifact-integrity';
import {
  defineSurface,
  surfaceDescriptorDigest,
  surfaceInterfaceDigest,
} from '@narada2/mcp-fabric-contracts';
import {
  MCP_CARRIER_GENERATION_SCHEMA,
  buildCarrierActivationMarker,
  resolveCarrierBinding,
  runtimeProxyCompatibility,
  sha256Text,
  writeCarrierActivationMarkerImmutable,
} from '@narada2/mcp-runtime-proxy/carrier-generation';
import {
  prepareV3CarrierGeneration,
  writePreparedV3CarrierGeneration,
} from '@narada2/mcp-runtime-proxy/carrier-materialization';

function packageManifest(input: {
  name: string;
  profile: string;
  entrypoint: string;
}) {
  return {
    name: input.name,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: { build: 'node --version' },
    narada: {
      artifact: {
        profile: input.profile,
        entrypoints: [input.entrypoint],
        build_script: 'build',
      },
    },
  };
}

async function sealFixture(input: {
  packageRoot: string;
  workspaceRoot: string;
  storeRoot: string;
  entrypoint: string;
  compatibility: ArtifactCompatibility;
}) {
  const configuration = await loadPackageArtifactConfiguration({
    package_root: input.packageRoot,
    workspace_root: input.workspaceRoot,
  });
  const sourceRoots = await collectSourceRoots(configuration);
  const sourceClosure = await captureSourceClosure({
    package_name: configuration.package_name,
    roots: sourceRoots,
  });
  const deploymentName = input.packageRoot.split(/[\\\\/]/u).pop() ?? 'package';
  const deployment = join(input.workspaceRoot, '.fixture-deployments', deploymentName);
  mkdirSync(join(deployment, 'dist', 'src'), { recursive: true });
  writeFileSync(join(deployment, 'package.json'), JSON.stringify({
    name: configuration.package_name,
    type: 'module',
  }));
  writeFileSync(
    join(deployment, input.entrypoint),
    'process.stdin.resume();\n',
  );
  return sealDeployment({
    store_root: input.storeRoot,
    deployment_root: deployment,
    package_name: configuration.package_name,
    artifact_profile: configuration.declaration.profile,
    source_closure: sourceClosure,
    build_recipe: createBuildRecipe(configuration),
    toolchain: await captureToolchainEvidence(input.workspaceRoot),
    entrypoints: configuration.declaration.entrypoints,
    compatibility: input.compatibility,
  });
}

test('registrar prepares one immutable sealed V3 carrier generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-registrar-carrier-v3-'));
  try {
    const workspaceRoot = join(root, 'workspace');
    const storeRoot = join(root, 'artifact-store');
    const generationRoot = join(root, 'generations');
    const proxyRoot = join(workspaceRoot, 'packages', 'proxy');
    const surfaceRoot = join(workspaceRoot, 'packages', 'surface');
    const configPath = join(root, 'codex.toml');
    const activationPath = join(root, 'activation.json');
    const activationToken = 'fixture-activation-token';
    mkdirSync(proxyRoot, { recursive: true });
    mkdirSync(surfaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    writeFileSync(join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    writeFileSync(join(proxyRoot, 'package.json'), JSON.stringify(packageManifest({
      name: '@narada2/mcp-runtime-proxy',
      profile: 'mcp-runtime-proxy-v3',
      entrypoint: 'dist/src/main.js',
    }), null, 2));
    writeFileSync(join(surfaceRoot, 'package.json'), JSON.stringify(packageManifest({
      name: '@narada2/fixture-surface',
      profile: 'mcp-surface-v3',
      entrypoint: 'dist/src/main.js',
    }), null, 2));
    writeFileSync(join(proxyRoot, 'source.ts'), 'export const proxy = 3;\n');
    writeFileSync(join(surfaceRoot, 'source.ts'), 'export const surface = 3;\n');

    const defined = defineSurface({
      surface_id: 'fixture-surface',
      surface_version: '1.0.0',
      package: '@narada2/fixture-surface',
      description: 'Fixture surface.',
      tools: [{
        definition: {
          name: 'fixture_guidance',
          description: 'Describe fixture use.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
      }],
      projections: [{
        id: 'default',
        transport: { kind: 'stdio', command: 'node', args: [], env: [] },
        injection_scope: 'host',
        default_injection: 'enabled',
        runtime_requirements: [],
        authority_requirements: ['scope.host'],
        lifecycle: { mode: 'replayable' },
      }],
    });
    const surfaceCompatibility: ArtifactCompatibility = {
      artifact_profile: 'mcp-surface-v3',
      descriptor_digest: `sha256:${surfaceDescriptorDigest(defined.descriptor)}`,
      interface_digest: `sha256:${surfaceInterfaceDigest(defined.descriptor)}`,
    };
    await sealFixture({
      packageRoot: proxyRoot,
      workspaceRoot,
      storeRoot,
      entrypoint: 'dist/src/main.js',
      compatibility: runtimeProxyCompatibility(),
    });
    await sealFixture({
      packageRoot: surfaceRoot,
      workspaceRoot,
      storeRoot,
      entrypoint: 'dist/src/main.js',
      compatibility: surfaceCompatibility,
    });

    const prepared = await prepareV3CarrierGeneration({
      carrier_id: 'fixture-codex',
      carrier_kind: 'codex',
      config_path: configPath,
      artifact_store: storeRoot,
      generation_root: generationRoot,
      runtime_proxy_package_root: proxyRoot,
      runtime_proxy_workspace_root: workspaceRoot,
      generation_id: 'fixture-generation',
      generated_at: '2026-07-25T00:00:00.000Z',
      activation: {
        cutover_id: 'fixture-cutover',
        marker_path: activationPath,
        token_digest: sha256Text(activationToken),
      },
      bindings: [{
        binding_id: 'fixture.binding',
        server_key: 'fixture-server',
        surface_id: defined.descriptor.surface_id,
        projection_id: 'default',
        descriptor: defined.descriptor,
        source: { package_root: surfaceRoot, workspace_root: workspaceRoot },
        artifact_entrypoint: join(surfaceRoot, 'dist', 'src', 'main.js'),
        child_args: ['--fixture'],
        child_env_names: ['FIXTURE_TOKEN'],
        client_tool_names: defined.descriptor.tools.map((tool) => tool.name),
      }],
    });
    const launch = prepared.launches.get('fixture-server');
    assert.ok(launch);
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args.slice(1), [
      '--runtime-contract-version',
      '3',
      '--carrier-generation',
      prepared.generation_path,
      '--server-key',
      'fixture-server',
      '--artifact-store',
      storeRoot,
    ]);
    assert.equal(launch.args.includes('--entrypoint'), false);
    assert.equal(launch.args.includes('--artifact-manifest'), false);
    assert.equal(launch.args.includes('--materialization-sidecar'), false);

    writePreparedV3CarrierGeneration(prepared);
    assert.equal(
      JSON.parse(readFileSync(prepared.generation_path, 'utf8')).schema,
      MCP_CARRIER_GENERATION_SCHEMA,
    );
    writeFileSync(
      configPath,
      `[mcp_servers.fixture-server]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(launch.args)}\n`,
    );
    writeCarrierActivationMarkerImmutable(activationPath, buildCarrierActivationMarker({
      cutover_id: 'fixture-cutover',
      activation_token: activationToken,
      generation_digests: [prepared.generation.generation_digest],
      activated_at: '2026-07-25T00:01:00.000Z',
    }));
    const resolved = await resolveCarrierBinding({
      generation_path: prepared.generation_path,
      server_key: 'fixture-server',
      artifact_store: storeRoot,
    });
    assert.equal(resolved.binding.descriptor.tools.some((tool) => tool.name === 'surface_describe'), true);
    assert.equal(
      resolved.binding.descriptor.tools.some((tool) => tool.name === 'surface_contract_describe'),
      true,
    );
    assert.equal(resolved.child_entrypoint.endsWith(join('dist', 'src', 'main.js')), true);

    // The generation's closure/receipt pins are authoritative; runtime startup
    // must not need the mutable source tree to re-resolve the child artifact.
    rmSync(surfaceRoot, { recursive: true, force: true });
    const resolvedWithoutSource = await resolveCarrierBinding({
      generation_path: prepared.generation_path,
      server_key: 'fixture-server',
      artifact_store: storeRoot,
    });
    assert.equal(resolvedWithoutSource.closure_digest, prepared.generation.bindings[0]!.closure_digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
