#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = join(tmpdir(), `site-coherence-mcp-smoke-${randomUUID()}`);
mkdirSync(root, { recursive: true });
mkdirSync(join(root, '.narada', 'site-continuity', 'health'), { recursive: true });
mkdirSync(join(root, '.narada', 'site-continuity'), { recursive: true });
mkdirSync(join(root, '.narada', 'auth'), { recursive: true });

writeFileSync(join(root, '.narada', 'auth', 'cloudflare-operator-session.json'), JSON.stringify({
  cookie: 'narada_operator_session=test_session',
}));

writeFileSync(join(root, '.narada', 'site-continuity', 'bindings.json'), JSON.stringify({
  bindings: [
    { site_id: 'site_live_smoke', relation_kind: 'same_site_embodiment' },
    { site_id: 'site_narada_cloudflare', relation_kind: 'same_site_embodiment' },
  ],
}));

writeFileSync(join(root, '.narada', 'site-continuity', 'health', 'cloudflare-continuity-health-last.json'), JSON.stringify({
  status: 'ok',
  generated_at: new Date().toISOString(),
  continuity_health: {
    local_sync_status: 'synced',
    local_inbound_status: 'synced',
    reconciliation_execution_status: 'completed',
  },
  cloudflare_product_posture: {
    state: 'loaded',
    site_product_overview: { site_count: 2, next_action: 'monitor_sites' },
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
});

const lines = proc.stdout.trim().split('\n');
const response = JSON.parse(lines[1] ?? lines[0]);
assert.equal(response.result.tools.length, 2);
const names = response.result.tools.map((t: Record<string, unknown>) => t.name);
assert.deepEqual(names, ['site_coherence_check', 'site_coherence_doctor']);

const checkTool = response.result.tools.find((t: Record<string, unknown>) => t.name === 'site_coherence_check');
assert.equal(checkTool.annotations.readOnlyHint, true);
assert.deepEqual(checkTool.inputSchema.required, ['site_id']);
assert.equal(checkTool.inputSchema.properties.fetch_cloudflare.default, true);

const doctorTool = response.result.tools.find((t: Record<string, unknown>) => t.name === 'site_coherence_doctor');
assert.equal(doctorTool.annotations.readOnlyHint, true);

rmSync(root, { recursive: true, force: true });
process.stderr.write('site-coherence-mcp protocol smoke ok\n');
