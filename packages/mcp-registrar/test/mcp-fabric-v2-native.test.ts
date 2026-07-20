import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLiveToolsConform } from '@narada2/mcp-fabric-contracts';
import { nativeSurfaceDescriptor, SURFACES } from '../src/main.js';

test('every registered surface is backed by a package-owned native descriptor', () => {
  assert.ok(SURFACES.length > 0);
  for (const surface of SURFACES) {
    const descriptor = nativeSurfaceDescriptor(surface.id);
    assert.equal(descriptor.source, 'native', surface.id);
    assert.equal(descriptor.surface_id, surface.id);
    assert.equal(descriptor.package, '@narada2/' + surface.package);
    assert.deepEqual(
      descriptor.tools.map((tool) => tool.name),
      surface.tools,
      'native tool registry changed for ' + surface.id,
    );
    assertLiveToolsConform(descriptor, descriptor.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
      ...(tool.output_schema === undefined ? {} : { outputSchema: tool.output_schema }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    })));
  }
});

test('native projection transport and registrar projection transport remain equivalent', () => {
  for (const surface of SURFACES) {
    const native = nativeSurfaceDescriptor(surface.id);
    const registrarProjections = surface.projections ?? [];
    assert.equal(registrarProjections.length, native.projections.length, surface.id);
    for (const nativeProjection of native.projections) {
      const registrarProjection = registrarProjections.find((candidate) => candidate.id === nativeProjection.id);
      assert.ok(registrarProjection, `${surface.id}:${nativeProjection.id} missing registrar projection`);
      assert.equal(nativeProjection.transport.kind, 'stdio');
      if (nativeProjection.transport.kind === 'stdio') {
        assert.deepEqual(
          [registrarProjection!.entrypoint, ...(registrarProjection!.args ?? [])],
          nativeProjection.transport.args.map((arg, index) => index === 0 && arg.includes('{mcp_surfaces_root}')
            ? arg.replace('{mcp_surfaces_root}', 'D:/code/mcp-surfaces/packages')
            : arg),
          `${surface.id}:${nativeProjection.id} transport drift`,
        );
      }
      assert.equal(registrarProjection!.injection_scope, nativeProjection.injection_scope);
      assert.deepEqual(registrarProjection!.runtime_requirements, nativeProjection.runtime_requirements.filter((value) => value === 'nars'));
    }
  }
});

test('native descriptors preserve explicit projection selection boundaries', () => {
  for (const surface of SURFACES) {
    const descriptor = nativeSurfaceDescriptor(surface.id);
    assert.equal(new Set(descriptor.projections.map((projection) => projection.id)).size, descriptor.projections.length);
    for (const projection of descriptor.projections) {
      assert.ok(projection.transport.kind === 'stdio', `${surface.id}:${projection.id} must be stdio for registrar carriers`);
      assert.ok(projection.lifecycle.mode.length > 0, `${surface.id}:${projection.id} lifecycle is required`);
      assert.ok(projection.injection_scope.length > 0, `${surface.id}:${projection.id} authority scope is required`);
    }
  }
});
