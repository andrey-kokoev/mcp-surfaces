import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeMcpRestartRequest, validateMcpRestartAcknowledgement, writeMcpRestartRequest } from '../src/mcp-freshness-service.js';

const pcSiteRoot = mkdtempSync(join(tmpdir(), 'task-lifecycle-freshness-'));

try {
  mkdirSync(join(pcSiteRoot, 'runtime'), { recursive: true });
  writeFileSync(join(pcSiteRoot, 'runtime', 'mcp-runtime-instances.json'), JSON.stringify({
    schema: 'narada.pc_runtime.mcp_runtime_instance_registry.v0',
    instances: [{
      surface_id: 'task-lifecycle-mcp.local',
      server_entrypoint: 'tools/task-lifecycle/task-mcp-server.js',
      process_identity_evidence: {
        pid: 100,
        booted_at: '2026-07-01T00:00:00.000Z',
        carrier_session_id: 'stale-carrier',
      },
      carrier_session_id: 'stale-carrier',
      carrier_session_binding: { status: 'bound_to_parent_carrier_session' },
    }],
  }), 'utf8');

  const restartRequest = {
    requested_at: '2026-07-11T17:00:00.000Z',
    requested_process: { pid: 200 },
  };
  const common = {
    pcSiteRoot,
    targetSurface: 'task-lifecycle-mcp.local',
    targetEntrypoint: 'tools/task-lifecycle/task-mcp-server.js',
    restartRequest,
    sourceEvidence: {},
    expectedTools: ['task_lifecycle_doctor'],
    registeredTools: ['task_lifecycle_doctor'],
  };

  const accepted = validateMcpRestartAcknowledgement({
    ...common,
    liveProcessEvidence: {
      pid: 300,
      booted_at: '2026-07-11T18:00:00.000Z',
      evidence_source: 'live_mcp_process_self_observation',
    },
  });
  assert.equal(accepted.status, 'acknowledgeable');
  assert.deepEqual(accepted.post_restart_process_identity, {
    pid: 300,
    booted_at: '2026-07-11T18:00:00.000Z',
    evidence_source: 'live_mcp_process_self_observation',
  });
  assert.deepEqual(accepted.carrier_session_binding, {
    status: 'not_required_for_live_process_self_observation',
  });

  const sameProcess = validateMcpRestartAcknowledgement({
    ...common,
    liveProcessEvidence: {
      pid: 200,
      booted_at: '2026-07-11T18:00:00.000Z',
      evidence_source: 'live_mcp_process_self_observation',
    },
  });
  assert.equal(sameProcess.status, 'rejected');
  assert.equal(sameProcess.reason, 'post_request_boot_evidence_missing');

  const verifierProcess = validateMcpRestartAcknowledgement({
    ...common,
    liveProcessEvidence: {
      pid: 301,
      booted_at: '2026-07-11T18:00:00.000Z',
      evidence_source: 'one_shot_verifier',
    },
  });
  assert.equal(verifierProcess.status, 'rejected');
  assert.equal(verifierProcess.reason, 'post_request_boot_evidence_missing');

  const siteRoot = join(pcSiteRoot, 'site');
  const restartRequestPath = join(siteRoot, '.ai', 'tmp', 'task-lifecycle-restart-request.json');
  const baselinePath = join(siteRoot, '.ai', 'tmp', 'mcp-baseline.json');
  const requested = writeMcpRestartRequest({
    siteRoot,
    serverName: 'task-lifecycle-mcp',
    targetSurface: 'task-lifecycle-mcp.local',
    targetEntrypoint: 'tools/task-lifecycle/task-mcp-server.js',
    restartRequestPath,
    baselinePath,
    requestedBy: 'test-agent',
    reason: 'Exercise the complete restart lifecycle.',
    note: 'Test replacement child requested.',
  });
  assert.equal(requested.status, 'restart_requested');
  assert.equal(existsSync(restartRequestPath), true);
  const replacementBootedAt = new Date(Date.parse(requested.requested_at) + 1_000).toISOString();
  const restarted = acknowledgeMcpRestartRequest({
    siteRoot,
    pcSiteRoot,
    serverName: 'task-lifecycle-mcp',
    targetSurface: 'task-lifecycle-mcp.local',
    targetEntrypoint: 'tools/task-lifecycle/task-mcp-server.js',
    restartRequestPath,
    baselinePath,
    acknowledgedBy: 'test-agent',
    reason: 'Test replacement child acknowledgement.',
    note: 'Test restart marker cleared.',
    watchedPaths: [],
    expectedTools: ['task_lifecycle_doctor'],
    registeredTools: ['task_lifecycle_doctor'],
    liveProcessEvidence: {
      pid: process.pid + 1,
      booted_at: replacementBootedAt,
      evidence_source: 'live_mcp_process_self_observation',
    },
  });
  assert.equal(restarted.status, 'restart_acknowledged');
  assert.equal(existsSync(restartRequestPath), false);
  const alreadyClear = acknowledgeMcpRestartRequest({
    siteRoot,
    pcSiteRoot,
    serverName: 'task-lifecycle-mcp',
    targetSurface: 'task-lifecycle-mcp.local',
    targetEntrypoint: 'tools/task-lifecycle/task-mcp-server.js',
    restartRequestPath,
    baselinePath,
    acknowledgedBy: 'test-agent',
    reason: 'Idempotent acknowledgement check.',
    note: 'Already clear.',
  });
  assert.equal(alreadyClear.status, 'no_restart_request');
  assert.equal(alreadyClear.already_cleared, true);

  console.log('mcp-freshness-service tests passed');
} finally {
  rmSync(pcSiteRoot, { recursive: true, force: true });
}
