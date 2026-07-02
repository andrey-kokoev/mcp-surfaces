import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArtifactTelemetryDeclaration,
  buildCalendarTelemetryDeclaration,
  buildCommandMetadataTelemetryDeclaration,
  buildGraphMailTelemetryDeclaration,
  buildMetadataOnlyTelemetryDeclaration,
  buildPathMetadataTelemetryDeclaration,
  buildReadOnlyTelemetryDeclaration,
  buildTaskTransitionTelemetryDeclaration,
  buildWriteTelemetryDeclaration,
  decideTelemetryEmission,
  emitTelemetryEvent,
  loadTelemetryPolicy,
  normalizeTelemetryPolicy,
  telemetryErrorCodeFromUnknown,
  telemetryRefusalCodeFromResult,
  telemetryPath,
  type TelemetryDeclaration,
} from '../src/main.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'narada-mcp-telemetry-'));
const declaration: TelemetryDeclaration = {
  events: ['tool_completed', 'tool_refused', 'tool_failed'],
  sensitivity: 'medium',
  args: 'none',
  result: 'none',
  timing: true,
  policy_decision: true,
  authority_locus: true,
};

try {
  const defaultPolicy = loadTelemetryPolicy(siteRoot);
  assert.equal(defaultPolicy.enabled, false);
  const disabled = emitTelemetryEvent({
    context: { siteRoot, siteId: 'narada.test', surfaceId: 'test-surface', agentId: 'test.agent', carrierSessionId: 'carrier-test' },
    declaration,
    event: { toolName: 'test_tool', eventKind: 'tool_failed', status: 'error', errorCode: 'boom' },
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(existsSync(telemetryPath(siteRoot, 'test-surface')), false);

  mkdirSync(join(siteRoot, '.ai'), { recursive: true });
  writeFileSync(join(siteRoot, '.ai', 'mcp-telemetry.json'), JSON.stringify({
    enabled: true,
    sink: 'site-local-jsonl',
    level: 'errors_only',
    include_args: false,
    include_results: false,
    retention_days: 30,
    surfaces: {
      'test-surface': { enabled: true, level: 'all' },
      muted: { enabled: false },
    },
  }, null, 2), 'utf8');

  const enabledPolicy = loadTelemetryPolicy(siteRoot);
  assert.equal(enabledPolicy.enabled, true);
  assert.equal(enabledPolicy.retention_days, 30);
  assert.equal(enabledPolicy.surfaces['test-surface'].level, 'all');

  const startedAt = new Date('2026-07-02T18:00:00.000Z');
  const completedAt = new Date('2026-07-02T18:00:00.042Z');
  const emitted = emitTelemetryEvent({
    policy: enabledPolicy,
    context: {
      siteRoot,
      siteId: 'narada.test',
      surfaceId: 'test-surface',
      agentId: 'test.agent',
      carrierSessionId: 'carrier-test',
      authorityLocus: { kind: 'local_site', site_root: siteRoot },
    },
    declaration,
    event: {
      toolName: 'test_tool',
      eventKind: 'tool_completed',
      status: 'ok',
      startedAt,
      completedAt,
      correlationId: 'corr-1',
      policyDecision: { status: 'allowed', secret: 'must-not-persist' },
    },
  });
  assert.equal(emitted.status, 'emitted');
  assert.equal(emitted.path, telemetryPath(siteRoot, 'test-surface'));
  const lines = readFileSync(emitted.path!, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.schema, 'narada.mcp_telemetry.event.v1');
  assert.equal(event.site_id, 'narada.test');
  assert.equal(event.surface_id, 'test-surface');
  assert.equal(event.tool_name, 'test_tool');
  assert.equal(event.event_kind, 'tool_completed');
  assert.equal(event.status, 'ok');
  assert.equal(event.duration_ms, 42);
  assert.equal(event.agent_id, 'test.agent');
  assert.equal(event.carrier_session_id, 'carrier-test');
  assert.equal(event.correlation_id, 'corr-1');
  assert.deepEqual(event.policy_decision, { status: 'allowed' });
  assert.deepEqual(event.authority_locus, { kind: 'local_site', site_root: siteRoot });
  assert.equal('args' in event, false);
  assert.equal('arguments' in event, false);
  assert.equal('result' in event, false);
  assert.equal(JSON.stringify(event).includes('must-not-persist'), false);

  const errorsOnlyPolicy = normalizeTelemetryPolicy({ enabled: true, level: 'errors_only' });
  const skippedSuccess = decideTelemetryEmission(errorsOnlyPolicy, 'test-surface', declaration, { toolName: 'test_tool', eventKind: 'tool_completed', status: 'ok' });
  assert.equal(skippedSuccess.emit, false);
  assert.equal(skippedSuccess.reason, 'telemetry_level_errors_only_skipped_success');
  const admittedRefusal = decideTelemetryEmission(errorsOnlyPolicy, 'test-surface', declaration, { toolName: 'test_tool', eventKind: 'tool_refused', status: 'refused', refusalCode: 'policy_refused' });
  assert.equal(admittedRefusal.emit, true);

  const undeclared = decideTelemetryEmission(enabledPolicy, 'test-surface', declaration, { toolName: 'test_tool', eventKind: 'tool_started', status: 'started' });
  assert.equal(undeclared.emit, false);
  assert.equal(undeclared.reason, 'event_not_declared_for_tool');

  const muted = emitTelemetryEvent({
    policy: enabledPolicy,
    context: { siteRoot, surfaceId: 'muted' },
    declaration,
    event: { toolName: 'muted_tool', eventKind: 'tool_failed', status: 'error', errorCode: 'muted_error' },
  });
  assert.equal(muted.status, 'disabled');
  assert.equal(existsSync(telemetryPath(siteRoot, 'muted')), false);

  const argsDeclaration: TelemetryDeclaration = { ...declaration, args: 'redacted' };
  const argsDecision = decideTelemetryEmission(normalizeTelemetryPolicy({ enabled: true, level: 'all', include_args: true }), 'test-surface', argsDeclaration, { toolName: 'test_tool', eventKind: 'tool_failed', status: 'error' });
  assert.equal(argsDecision.emit, false);
  assert.equal(argsDecision.reason, 'args_persistence_not_supported_in_v1');

  const resultDeclaration: TelemetryDeclaration = { ...declaration, result: 'summary' };
  const resultDecision = decideTelemetryEmission(normalizeTelemetryPolicy({ enabled: true, level: 'all', include_results: true }), 'test-surface', resultDeclaration, { toolName: 'test_tool', eventKind: 'tool_failed', status: 'error' });
  assert.equal(resultDecision.emit, false);
  assert.equal(resultDecision.reason, 'result_persistence_not_supported_in_v1');

  const metadataOnly = buildMetadataOnlyTelemetryDeclaration({ sensitivity: 'high' });
  assert.equal(metadataOnly.args, 'none');
  assert.equal(metadataOnly.result, 'none');
  assert.equal(metadataOnly.policy_decision, false);
  assert.equal(metadataOnly.authority_locus, false);

  const readOnly = buildReadOnlyTelemetryDeclaration();
  assert.equal(readOnly.sensitivity, 'low');
  assert.equal(readOnly.args, 'none');
  assert.equal(readOnly.result, 'none');

  const writeOnly = buildWriteTelemetryDeclaration();
  assert.equal(writeOnly.sensitivity, 'high');
  assert.equal(writeOnly.policy_decision, true);
  assert.equal(writeOnly.args, 'none');
  assert.equal(writeOnly.result, 'none');

  const pathMetadata = buildPathMetadataTelemetryDeclaration();
  assert.equal(pathMetadata.sensitivity, 'low');
  assert.equal(pathMetadata.policy_decision, false);

  const commandMetadata = buildCommandMetadataTelemetryDeclaration();
  assert.equal(commandMetadata.sensitivity, 'high');
  assert.equal(commandMetadata.policy_decision, true);

  const graphMailMetadata = buildGraphMailTelemetryDeclaration();
  assert.equal(graphMailMetadata.sensitivity, 'medium');

  const calendarMetadata = buildCalendarTelemetryDeclaration();
  assert.equal(calendarMetadata.sensitivity, 'medium');

  const taskTransitionMetadata = buildTaskTransitionTelemetryDeclaration();
  assert.equal(taskTransitionMetadata.sensitivity, 'high');

  const artifactMetadata = buildArtifactTelemetryDeclaration();
  assert.equal(artifactMetadata.sensitivity, 'low');

  assert.equal(telemetryErrorCodeFromUnknown(new Error('structured_command_input_too_long:arguments.args[0]:20001>20000')), 'structured_command_input_too_long');
  assert.equal(telemetryErrorCodeFromUnknown({ codeName: 'graph_mail_attachment_upload_failed:400:secret' }), 'graph_mail_attachment_upload_failed');
  assert.equal(telemetryRefusalCodeFromResult({ reason: 'mailbox_not_allowed:secret@example.test' }), 'mailbox_not_allowed');
  assert.equal(telemetryRefusalCodeFromResult({ decision: { reasons: ['command_not_allowed:pwsh.exe -Command secret'] } }), 'command_not_allowed');
} finally {
  rmSync(siteRoot, { recursive: true, force: true });
}

console.log('mcp telemetry contract tests passed');
