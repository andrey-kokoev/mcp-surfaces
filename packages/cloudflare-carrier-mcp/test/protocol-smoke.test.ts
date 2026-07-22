#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = join(tmpdir(), `cloudflare-carrier-mcp-smoke-${randomUUID()}`);
mkdirSync(root, { recursive: true });
mkdirSync(join(root, '.narada', 'auth'), { recursive: true });
mkdirSync(join(root, '.narada', 'site-continuity', 'health'), { recursive: true });

writeFileSync(join(root, '.narada', 'auth', 'cloudflare-operator-session.json'), JSON.stringify({
  cookie: 'narada_operator_session=test_session_cookie',
  captured_at: new Date().toISOString(),
}));

writeFileSync(join(root, '.narada', 'site-continuity', 'health', 'cloudflare-continuity-health-last.json'), JSON.stringify({
  schema: 'narada.cloudflare_carrier.site_continuity_scheduled_health_snapshot.v1',
  status: 'ok',
  generated_at: new Date().toISOString(),
  continuity_health: {
    local_sync_status: 'synced',
    local_sync_artifact_count: 2,
    local_inbound_status: 'synced',
    local_inbound_artifact_count: 2,
    reconciliation_execution_status: 'completed',
    reconciliation_execution_plan_status: 'ready',
  },
  cloudflare_product_posture: {
    state: 'loaded',
    site_product_overview: { site_count: 1, next_action: 'monitor_sites' },
  },
  cloudflare_product_binding_alignment: { state: 'aligned', reason: 'ok' },
  scheduler_task_readback: {
    scheduled_task_state: 'Enabled',
    last_result: '0',
    cadence_status: 'matches_plan',
  },
}));

const serverPath = join(import.meta.dirname ?? __dirname, '..', 'src', 'main.js');

const proc = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath, '--repo-root', root, '--worker-url', 'https://cloudflare.example.test'], {
  input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
  encoding: 'utf8',
  timeout: 10000,
  windowsHide: true,
});

const lines = proc.stdout.trim().split('\n');
const response = JSON.parse(lines[1] ?? lines[0]);
assert.equal(response.result.tools.length, 6);
const names = response.result.tools.map((t: Record<string, unknown>) => t.name);
assert.deepEqual(new Set(names), new Set([
  'cloudflare_carrier_guidance',
  'cloudflare_product_read',
  'cloudflare_session_status',
  'cloudflare_health',
  'cloudflare_doctor',
  'cloudflare_carrier_health',
]));

const readTool = response.result.tools.find((t: Record<string, unknown>) => t.name === 'cloudflare_product_read');
assert.equal(readTool.annotations.readOnlyHint, true);
assert.deepEqual(readTool.inputSchema.properties.operation.enum, ['site.list', 'site.read', 'operation.list', 'operation.read']);

const sessTool = response.result.tools.find((t: Record<string, unknown>) => t.name === 'cloudflare_session_status');
assert.equal(sessTool.annotations.readOnlyHint, true);

const healthTool = response.result.tools.find((t: Record<string, unknown>) => t.name === 'cloudflare_health');
assert.equal(healthTool.annotations.readOnlyHint, true);

const carrierHealthTool = response.result.tools.find((t: Record<string, unknown>) => t.name === 'cloudflare_carrier_health');
assert.equal(carrierHealthTool.annotations.readOnlyHint, true);
assert.deepEqual(carrierHealthTool.inputSchema.required, ['projection_id']);

rmSync(root, { recursive: true, force: true });
process.stderr.write('cloudflare-carrier-mcp protocol smoke ok\n');
