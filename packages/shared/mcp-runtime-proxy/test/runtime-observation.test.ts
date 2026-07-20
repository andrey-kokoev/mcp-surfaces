import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AtomicRuntimeObservationStore,
  createRuntimeObservationSink,
} from '../src/runtime-observation.js';

test('runtime observation records are atomic, process-inspectable, and lease-aware', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-runtime-observation-'));
  try {
    const options = {
      root,
      site_id: 'test-site',
      carrier_kind: 'codex',
      manifest_digest: 'a'.repeat(64),
    };
    const store = new AtomicRuntimeObservationStore(options);
    const sink = createRuntimeObservationSink({
      store,
      server_name: 'fixture-server',
      surface_id: 'fixture',
      projection_id: 'stdio',
      lifecycle: { mode: 'replayable' },
      recovery_actions: [{
        actuator: 'mcp-loader',
        tool_name: 'mcp_loader_surface_restart',
        arguments: { connection_id: 'fixture-connection' },
        guidance: 'Replace this generation through mcp-loader.',
      }],
    });
    sink({
      event: 'active',
      observed_at: '2026-07-19T00:00:01.000Z',
      logical_connection_id: 'fixture-connection',
      generation: {
        generation_id: 'generation-one',
        state: 'active',
        transport: 'stdio',
        inflight: 0,
        started_at: '2026-07-19T00:00:00.000Z',
        activated_at: '2026-07-19T00:00:01.000Z',
        drain_deadline: null,
        heartbeat_at: '2026-07-19T00:00:01.000Z',
        lease_expires_at: '2026-07-19T00:01:00.000Z',
        freshness: 'current',
        health: 'healthy',
        descriptor_digest: 'b'.repeat(64),
        tool_contract_digest: 'c'.repeat(64),
        failure: null,
      },
    });

    const recordPath = join(root, 'connections', 'fixture-connection.json');
    const raw = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(raw.active_generation.generation_id, 'generation-one');
    assert.equal(raw.active_generation.health, 'healthy');

    const inspectedByNewProcessState = new AtomicRuntimeObservationStore(options);
    const current = inspectedByNewProcessState.observe('2026-07-19T00:00:30.000Z');
    assert.equal(current.servers[0]!.active_generation!.freshness, 'current');
    const expired = inspectedByNewProcessState.observe('2026-07-19T00:02:00.000Z');
    assert.equal(expired.servers[0]!.active_generation!.freshness, 'stale');
    assert.equal(expired.servers[0]!.active_generation!.health, 'unreachable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
