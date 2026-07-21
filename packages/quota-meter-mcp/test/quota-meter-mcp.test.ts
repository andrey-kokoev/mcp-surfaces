import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest, listTools, normalizeProviderSelection, normalizeRefreshSeconds, quotaMeterOverlayStatus } from '../src/main.js';
import { surfaceDefinition } from '../src/surface-definition.js';

const stateRoot = mkdtempSync(join(tmpdir(), 'quota-meter-mcp-'));
const state = createServerState({ quotaMeterRoot: 'D:\\code\\quota-meter', stateRoot });
const stateWithWindowsRoot = createServerState(
  { quotaMeterRoot: 'D:\\code\\quota-meter', stateRoot },
  { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
);

try {
  assert.equal(normalizeProviderSelection(undefined), 'all');
  assert.equal(normalizeProviderSelection('codex,kimi'), 'codex,kimi');
  assert.equal(normalizeRefreshSeconds(undefined), 60);
  assert.equal(normalizeRefreshSeconds(30), 30);
  if (process.platform === 'win32') assert.equal(stateWithWindowsRoot.env.windir, 'C:\\Windows');
  assert.throws(() => normalizeProviderSelection('codex, kimi'), /quota_meter_invalid_provider_selection/);
  assert.throws(() => normalizeRefreshSeconds(4), /quota_meter_invalid_refresh_seconds/);

  const tools = listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'quota_meter_guidance',
    'quota_meter_glide_status',
    'quota_meter_overlay_status',
    'quota_meter_overlay_start',
    'quota_meter_overlay_stop',
  ]);
  assert.equal((tools.find((tool) => tool.name === 'quota_meter_overlay_status') as any).annotations.readOnlyHint, true);
  assert.equal((tools.find((tool) => tool.name === 'quota_meter_overlay_start') as any).annotations.readOnlyHint, false);

  const descriptor = surfaceDefinition().descriptor;
  assert.equal(descriptor.projections[0]?.injection_scope, 'host');
  assert.equal(descriptor.projections[0]?.default_injection, 'enabled');

  const status = quotaMeterOverlayStatus(state);
  assert.equal(status.status, 'stopped');
  assert.equal(status.running, false);
  assert.equal(status.position, null);

  const response = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quota_meter_guidance', arguments: {} } }, state);
  assert.equal((response as any).result.structuredContent.surface_id, 'quota-meter');
  assert.match((response as any).result.structuredContent.purpose, /overlay/);
} finally {
  rmSync(stateRoot, { recursive: true, force: true });
}

console.log('quota-meter-mcp behavior ok');
