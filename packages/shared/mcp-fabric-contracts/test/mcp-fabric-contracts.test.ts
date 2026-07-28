import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MCP_FABRIC_SCHEMA_VERSION,
  fabricManifestDigest,
  parseFabricManifestV3,
  parseSurfaceDescriptorV3,
  surfaceDescriptorDigest,
  assertLiveToolsConform,
  defineSurface,
  defineNativeSurface,
  standardSurfaceToolDefinitions,
  type SurfaceDescriptorV3,
  SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
  SURFACE_DESCRIBE_TOOL_NAME,
  standardSurfaceToolResult,
} from '../src/index.js';
import { startHttpFixture } from '../src/http-fixture.js';

function descriptor(): SurfaceDescriptorV3 {
  const standardTools = standardSurfaceToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { output_schema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    effect: { class: 'read' as const, idempotency: 'replayable' as const, confirmation: 'never' as const },
  }));
  return {
    schema_version: MCP_FABRIC_SCHEMA_VERSION,
    source: 'native',
    surface_id: 'example',
    surface_version: '1.0.0',
    package: '@example/mcp',
    description: 'Example MCP surface.',
    guidance_tool: 'example_guidance',
    tools: [
      {
        name: 'example_read',
        description: 'Read one example.',
        input_schema: { type: 'object', properties: { b: {}, a: {} } },
        effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
      },
      ...standardTools,
      {
        name: 'example_guidance',
        description: 'Show guidance.',
        input_schema: { type: 'object' },
        effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
      },
    ],
    projections: [
      {
        id: 'default',
        transport: {
          kind: 'stdio',
          command: 'node',
          args: ['dist/main.js', '--mode', 'read'],
          env: ['SITE_ROOT', 'OUTPUT_ROOT'],
        },
        injection_scope: 'local_site',
        default_injection: 'enabled',
        runtime_requirements: ['nars'],
        authority_requirements: ['site.local', 'site.read'],
        lifecycle: {
          mode: 'restart_required',
          restart_owner: 'mcp-loader',
        },
      },
    ],
  };
}

test('descriptor digest is stable across declaration and object-key order', () => {
  const left = descriptor();
  const right = descriptor();
  right.tools.reverse();
  right.projections[0]!.runtime_requirements.reverse();
  right.projections[0]!.authority_requirements.reverse();
  const transport = right.projections[0]!.transport;
  assert.equal(transport.kind, 'stdio');
  if (transport.kind === 'stdio') {
    right.projections[0]!.transport = {
      ...transport,
      env: ['OUTPUT_ROOT', 'SITE_ROOT'],
    };
  }
  right.tools.find((tool) => tool.name === 'example_read')!.input_schema = {
    properties: { a: {}, b: {} },
    type: 'object',
  };
  assert.equal(surfaceDescriptorDigest(left), surfaceDescriptorDigest(right));
});

test('defineSurface uses one registry for tools/list and descriptor emission', () => {
  const definition = {
    name: 'example_guidance',
    description: 'Show guidance.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
  const surface = defineSurface({
    surface_id: 'single-source',
    surface_version: '1.0.0',
    package: '@example/single-source',
    tools: [{
      definition,
      effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
    }],
    projections: [descriptor().projections[0]!],
  });
  assert.deepEqual(surface.tools.map((tool) => tool.name), [
    'example_guidance',
    SURFACE_DESCRIBE_TOOL_NAME,
    SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
  ]);
  for (const tool of surface.tools.slice(-2)) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  assertLiveToolsConform(surface.descriptor, surface.tools);
  assertLiveToolsConform(surface.descriptor, [definition]);
  assert.equal(surface.descriptor.guidance_tool, 'example_guidance');
  const described = standardSurfaceToolResult({
    descriptor: surface.descriptor,
    tool_name: SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
    arguments: { tool_name: 'example_guidance' },
    observed_capabilities: { tools: {} },
  });
  assert.equal(
    (described.structuredContent as { tools: unknown[] }).tools.length,
    1,
  );
  const runtimeDescription = standardSurfaceToolResult({
    descriptor: surface.descriptor,
    tool_name: SURFACE_DESCRIBE_TOOL_NAME,
    runtime_observation: {
      schema: 'narada.mcp_surface.runtime.v1',
      status: 'ok',
      generation_id: 'generation-test',
    },
  });
  assert.deepEqual(
    (runtimeDescription.structuredContent as { runtime: unknown }).runtime,
    {
      generation_id: 'generation-test',
      schema: 'narada.mcp_surface.runtime.v1',
      status: 'ok',
    },
  );
  const subsetDescriptor = descriptor();
  const subsetContract = standardSurfaceToolResult({
    descriptor: subsetDescriptor,
    tool_name: SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
    client_tool_names: [
      'example_guidance',
      SURFACE_DESCRIBE_TOOL_NAME,
      SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
    ],
  }).structuredContent as {
    client_tool_names: string[];
    tools: Array<{ name: string }>;
    interface_digest: string;
    client_interface_digest: string;
  };
  assert.deepEqual(
    subsetContract.tools.map((tool) => tool.name),
    [
      'example_guidance',
      SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
      SURFACE_DESCRIBE_TOOL_NAME,
    ],
  );
  assert.deepEqual(subsetContract.client_tool_names, [
    'example_guidance',
    SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
    SURFACE_DESCRIBE_TOOL_NAME,
  ]);
  assert.notEqual(subsetContract.interface_digest, subsetContract.client_interface_digest);
  assert.throws(
    () => standardSurfaceToolResult({
      descriptor: subsetDescriptor,
      tool_name: SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
      arguments: { tool_name: 'example_read' },
      client_tool_names: [
        'example_guidance',
        SURFACE_DESCRIBE_TOOL_NAME,
        SURFACE_CONTRACT_DESCRIBE_TOOL_NAME,
      ],
    }),
    /mcp_fabric_tool_contract_missing/,
  );
});

test('defineNativeSurface validates read-only inventory and exposes lifecycle readback', () => {
  const definition = {
    name: 'native_guidance',
    description: 'Show native guidance.',
    inputSchema: { type: 'object', additionalProperties: false },
  };
  const base = {
    surface_id: 'native-helper',
    surface_version: '1.0.0',
    package: '@example/native-helper',
    entrypoint: 'dist/main.js',
    tools: [definition],
    read_only_tools: ['native_guidance'] as const,
    default_effect: 'read' as const,
    projections: [descriptor().projections[0]!],
  };
  const surface = defineNativeSurface(base);
  assert.deepEqual(surface.descriptor.metadata?.lifecycle_readback, {
    authority: 'mcp-loader',
    availability: 'loader-managed',
    discovery: {
      tool_name: 'mcp_loader_connection_inventory',
      arguments: {},
      select: { field: 'surface_id', equals: 'native-helper', result_field: 'connection_id' },
    },
    status: {
      tool_name: 'mcp_loader_surface_status',
      arguments: { connection_id: '{connection_id}' },
      connection_id_from: 'discovery.selected.connection_id',
    },
  });
  assert.throws(
    () => defineNativeSurface({ ...base, read_only_tools: ['stale_tool'] as const }),
    /mcp_fabric_read_only_tool_undeclared/,
  );
});

test('Streamable HTTP fixture is session-pinned and conforms to fresh tools/list', async () => {
  const fixture = await startHttpFixture();
  try {
    const response = await fetch(fixture.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(response.status, 200);
    const message = await response.json() as {
      result: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
    };
    assertLiveToolsConform(fixture.surface.descriptor, message.result.tools);
    assert.equal(fixture.surface.descriptor.projections[0]!.lifecycle.mode, 'session_pinned');
  } finally {
    await fixture.close();
  }
});

test('unsupported schema majors fail closed', () => {
  assert.throws(
    () => parseSurfaceDescriptorV3({ ...descriptor(), schema_version: '2.0' }),
    /mcp_fabric_schema_major_unsupported/,
  );
});

test('duplicate tool and projection identities are rejected', () => {
  const duplicateTool = descriptor();
  duplicateTool.tools.push({ ...duplicateTool.tools[0]! });
  assert.throws(() => parseSurfaceDescriptorV3(duplicateTool), /duplicate tool/);

  const duplicateProjection = descriptor();
  duplicateProjection.projections.push({ ...duplicateProjection.projections[0]! });
  assert.throws(() => parseSurfaceDescriptorV3(duplicateProjection), /duplicate projection/);
});

test('invalid effect and lifecycle combinations are rejected', () => {
  const invalidEffect = descriptor();
  invalidEffect.tools[0]!.effect = {
    class: 'read',
    idempotency: 'non_idempotent',
    confirmation: 'always',
  };
  assert.throws(() => parseSurfaceDescriptorV3(invalidEffect), /read effects/);

  const invalidLifecycle = descriptor();
  invalidLifecycle.projections[0]!.lifecycle = { mode: 'restart_required' } as never;
  assert.throws(() => parseSurfaceDescriptorV3(invalidLifecycle), /restart_owner/);
});

test('manifest digest is stable and duplicate bindings fail closed', () => {
  const manifest = {
    schema_version: MCP_FABRIC_SCHEMA_VERSION,
    manifest_id: 'example-manifest',
    site_id: 'example-site',
    generated_at: '2026-07-19T00:00:00.000Z',
    descriptors: [descriptor()],
    bindings: [
      {
        binding_id: 'example-binding',
        surface_id: 'example',
        projection_id: 'default',
        server_name: 'example',
        enabled: true,
        config: { z: 1, a: 2 },
      },
    ],
    source_digest: 'a'.repeat(64),
  };
  const parsed = parseFabricManifestV3(manifest);
  assert.equal(fabricManifestDigest(parsed), fabricManifestDigest({
    ...manifest,
    bindings: [{ ...manifest.bindings[0]!, config: { a: 2, z: 1 } }],
  }));
  assert.throws(
    () => parseFabricManifestV3({
      ...manifest,
      bindings: [...manifest.bindings, { ...manifest.bindings[0]! }],
    }),
    /duplicate binding/,
  );
});

test('postcompile emits JSON Schema artifacts', async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  await access(path.join(packageRoot, 'dist', 'schema', 'surface-descriptor.schema.json'));
  await access(path.join(packageRoot, 'dist', 'schema', 'fabric-manifest.schema.json'));
});
