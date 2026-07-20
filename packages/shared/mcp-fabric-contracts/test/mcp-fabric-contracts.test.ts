import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MCP_FABRIC_SCHEMA_VERSION,
  fabricManifestDigest,
  parseFabricManifestV2,
  parseSurfaceDescriptorV2,
  surfaceDescriptorDigest,
  assertLiveToolsConform,
  defineSurface,
  defineNativeSurface,
  type SurfaceDescriptorV2,
} from '../src/index.js';
import { startHttpFixture } from '../src/http-fixture.js';

function descriptor(): SurfaceDescriptorV2 {
  return {
    schema_version: MCP_FABRIC_SCHEMA_VERSION,
    source: 'native',
    surface_id: 'example',
    surface_version: '1.0.0',
    package: '@example/mcp',
    guidance_tool: 'example_guidance',
    tools: [
      {
        name: 'example_read',
        description: 'Read one example.',
        input_schema: { type: 'object', properties: { b: {}, a: {} } },
        effect: { class: 'read', idempotency: 'replayable', confirmation: 'never' },
      },
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
  right.tools[1]!.input_schema = {
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
  assert.deepEqual(surface.tools, [definition]);
  assertLiveToolsConform(surface.descriptor, surface.tools);
  assert.equal(surface.descriptor.guidance_tool, 'example_guidance');
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
    tool_name: 'mcp_loader_surface_status',
    arguments: { surface_id: 'native-helper' },
    authority: 'mcp-loader',
    availability: 'loader-managed',
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
    () => parseSurfaceDescriptorV2({ ...descriptor(), schema_version: '3.0' }),
    /mcp_fabric_schema_major_unsupported/,
  );
});

test('duplicate tool and projection identities are rejected', () => {
  const duplicateTool = descriptor();
  duplicateTool.tools.push({ ...duplicateTool.tools[0]! });
  assert.throws(() => parseSurfaceDescriptorV2(duplicateTool), /duplicate tool/);

  const duplicateProjection = descriptor();
  duplicateProjection.projections.push({ ...duplicateProjection.projections[0]! });
  assert.throws(() => parseSurfaceDescriptorV2(duplicateProjection), /duplicate projection/);
});

test('invalid effect and lifecycle combinations are rejected', () => {
  const invalidEffect = descriptor();
  invalidEffect.tools[0]!.effect = {
    class: 'read',
    idempotency: 'non_idempotent',
    confirmation: 'always',
  };
  assert.throws(() => parseSurfaceDescriptorV2(invalidEffect), /read effects/);

  const invalidLifecycle = descriptor();
  invalidLifecycle.projections[0]!.lifecycle = { mode: 'restart_required' } as never;
  assert.throws(() => parseSurfaceDescriptorV2(invalidLifecycle), /restart_owner/);
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
  const parsed = parseFabricManifestV2(manifest);
  assert.equal(fabricManifestDigest(parsed), fabricManifestDigest({
    ...manifest,
    bindings: [{ ...manifest.bindings[0]!, config: { a: 2, z: 1 } }],
  }));
  assert.throws(
    () => parseFabricManifestV2({
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
