import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest, listTools } from '../src/main.js';
import { surfaceDefinition } from '../src/surface-definition.js';

const root = mkdtempSync(join(tmpdir(), 'operator-console-overlay-mcp-'));
const entrypoint = join(root, 'overlay.mjs');
const stateRoot = join(root, 'overlay-state');
writeFileSync(entrypoint, [
  'const command = process.argv[2];',
  'console.log(JSON.stringify({ schema: "test.overlay.result.v1", state: command === "stop" ? "stopped" : command === "inspect" ? "running" : command, command, args: process.argv.slice(3) }));',
  '',
].join('\n'));

const state = createServerState({
  naradaRoot: root,
  overlayEntrypoint: entrypoint,
  stateRoot,
  nodePath: process.execPath,
});

try {
  assert.deepEqual(listTools().map((tool) => tool.name), [
    'operator_console_overlay_guidance',
    'operator_console_overlay_status',
    'operator_console_overlay_open',
    'operator_console_overlay_refresh',
    'operator_console_overlay_close',
  ]);
  assert.equal(
    (listTools().find((tool) => tool.name === 'operator_console_overlay_status') as any).annotations.readOnlyHint,
    true,
  );
  assert.equal(
    (listTools().find((tool) => tool.name === 'operator_console_overlay_open') as any).annotations.readOnlyHint,
    false,
  );
  assert.equal(surfaceDefinition().descriptor.projections[0]?.injection_scope, 'host');
  assert.equal(surfaceDefinition().descriptor.projections[0]?.default_injection, 'enabled');

  const guidance = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'operator_console_overlay_guidance', arguments: {} },
  }, state);
  assert.equal((guidance as any).result.structuredContent.surface_id, 'operator-console-overlay');

  const opened = await handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'operator_console_overlay_open',
      arguments: { url: 'http://127.0.0.1:61729', title: 'Test Console', refresh_seconds: 5 },
    },
  }, state);
  const openedOverlay = (opened as any).result.structuredContent.overlay;
  assert.equal(openedOverlay.command, 'start');
  assert.deepEqual(openedOverlay.args.slice(0, 2), ['--url', 'http://127.0.0.1:61729']);
  assert.equal(openedOverlay.args.includes('--state-root'), true);

  const status = await handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'operator_console_overlay_status', arguments: {} },
  }, state);
  assert.equal((status as any).result.structuredContent.overlay.command, 'inspect');
  assert.deepEqual((status as any).result.structuredContent.overlay.args, ['--state-root', stateRoot]);

  const closed = await handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'operator_console_overlay_close', arguments: {} },
  }, state);
  assert.equal((closed as any).result.structuredContent.overlay.command, 'stop');
  assert.deepEqual((closed as any).result.structuredContent.overlay.args, ['--state-root', stateRoot]);

  assert.throws(() => createServerState({
    naradaRoot: root,
    overlayEntrypoint: join(root, '..', 'outside.mjs'),
  }), /operator_console_overlay_entrypoint_outside_narada_root/);
  const invalidUrl = await handleRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'operator_console_overlay_open', arguments: { url: 'file:///secret' } },
  }, state);
  assert.equal((invalidUrl as any).error.data.code, 'operator_console_overlay_url_scheme_invalid');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('operator-console-overlay-mcp behavior ok');
