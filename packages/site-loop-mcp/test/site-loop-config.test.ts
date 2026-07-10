import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SITE_LOOP_CONFIG, loadSiteLoopConfig, requireSiteLoopConfig, SITE_LOOP_CONFIG_SCHEMA, siteLoopConfigJsonSchema, validateSiteLoopConfigDocument } from '../src/site-loop/site-loop-config.js';
import { loadSiteLoopOperatingPolicy, validateSiteLoopOperatingPolicy } from '../src/site-loop/operating-loop-policy.js';
import { openSiteLoopStore } from '../src/site-loop/site-loop-store.js';
import { checkTaskGovernancePackageBoundary, listSiteLoopAttention, processLaunchRequiredEnvironment, processLaunchSpawnEnvironmentDelta, runProjectionDriftCheck } from '../src/site-loop/site-loop-engine.js';
import { DEFAULT_SITE_LOOP_PHASE_PLAN, SITE_LOOP_ADAPTER_PHASE_PLAN, listSiteLoopRuns, runSiteLoop, siteLoopStatus } from '../src/site-loop/site-loop.js';
import { siteLoopDependencyBoundaries } from '../src/site-loop/site-loop-boundary.js';
import { getResidentStatus } from '../src/task-lifecycle/dispatch-directives.js';

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-config-'));
const packageRoot = new URL('..', import.meta.url);
const publishedSchema = JSON.parse(readFileSync(new URL('../schemas/site-loop-config.schema.json', packageRoot), 'utf8'));

assert.deepEqual(publishedSchema, siteLoopConfigJsonSchema());

const boundaries = siteLoopDependencyBoundaries();
assert.equal(boundaries.some((item) => item.surface === 'task-lifecycle' && item.owner.includes('task-lifecycle')), true);
assert.equal(boundaries.some((item) => item.surface === 'structured-command' && item.kind === 'configured_command'), true);
assert.deepEqual([...DEFAULT_SITE_LOOP_PHASE_PLAN], [
  'source_sync',
  'scheduled_sop_triggers',
  'inbox_bridge',
  'task_materialization',
  'resident_directive_emission',
  'ticket_task_reconciliation',
  'pre_backlog_outcome_reconciliation',
  'reported_resident_task_state_reconciliation',
  'resident_backlog_recovery_emission',
  'resident_supervisor',
  'resident_directive_dispatch',
  'receipt_reconciliation',
  'agent_outcome_reconciliation',
  'stale_escalation_reconciliation',
  'operating_alert_reconciliation',
]);
assert.deepEqual([...SITE_LOOP_ADAPTER_PHASE_PLAN], [...DEFAULT_SITE_LOOP_PHASE_PLAN]);

assert.deepEqual(processLaunchRequiredEnvironment({
  NARADA_SITE_ROOT: 'D:/site',
  KIMI_CODE_API_KEY: '<set>',
  OPENAI_API_KEY: '<set:51>',
  DEEPSEEK_API_KEY: '<redacted>',
  NARADA_AI_MODEL: 'kimi-k2.7',
  NON_STRING: 1,
}), {
  NARADA_SITE_ROOT: 'D:/site',
  NARADA_AI_MODEL: 'kimi-k2.7',
});
assert.deepEqual(processLaunchSpawnEnvironmentDelta({
  KIMI_CODE_API_KEY: 'real-key',
  NARADA_AI_MODEL: 'kimi-k2.7',
}), {
  status: 'ok',
  env: {
    KIMI_CODE_API_KEY: 'real-key',
    NARADA_AI_MODEL: 'kimi-k2.7',
  },
});
assert.equal(processLaunchSpawnEnvironmentDelta(null).status, 'refused');
assert.equal(processLaunchSpawnEnvironmentDelta({ KIMI_CODE_API_KEY: '<set>' }).status, 'refused');

const legacyProjectionConfig = {
  ...DEFAULT_SITE_LOOP_CONFIG,
  commands: {
    ...DEFAULT_SITE_LOOP_CONFIG.commands,
    projection_drift: 'pnpm cli -- task projection drift --json',
  },
};
const legacyProjectionCheck = runProjectionDriftCheck(siteRoot, legacyProjectionConfig);
assert.equal(legacyProjectionCheck.status, 'not_configured');
assert.equal(legacyProjectionCheck.exit_code, 0);
assert.equal((legacyProjectionCheck as Record<string, unknown>).note, 'legacy_projection_drift_cli_handler_not_migrated');

const modernTaskLifecycleRoot = mkdtempSync(join(tmpdir(), 'site-loop-modern-task-lifecycle-'));
const modernTaskLifecyclePackageRoot = join(modernTaskLifecycleRoot, 'packages', 'task-lifecycle-mcp');
mkdirSync(join(modernTaskLifecyclePackageRoot, 'dist', 'src', 'task-lifecycle'), { recursive: true });
writeFileSync(join(modernTaskLifecyclePackageRoot, 'package.json'), JSON.stringify({
  name: '@narada2/task-lifecycle-mcp',
  dependencies: { '@narada2/task-governance-core': 'workspace:*' },
}, null, 2), 'utf8');
const modernSiteRoot = mkdtempSync(join(tmpdir(), 'site-loop-modern-site-'));
mkdirSync(join(modernSiteRoot, '.ai', 'mcp'), { recursive: true });
writeFileSync(join(modernSiteRoot, '.ai', 'mcp', 'narada-modern-mcp.json'), JSON.stringify({
  schema: 'narada.mcp.client_config.v0',
  mcpServers: {
    'narada-modern-task-lifecycle': {
      transport: 'stdio',
      command: 'node',
      args: [join(modernTaskLifecyclePackageRoot, 'dist', 'src', 'task-lifecycle', 'task-mcp-server.js'), '--site-root', modernSiteRoot],
      surface_id: 'task-lifecycle',
    },
  },
}, null, 2), 'utf8');
const modernBoundary = checkTaskGovernancePackageBoundary(modernSiteRoot);
assert.equal(modernBoundary.status, 'ok');
assert.equal(modernBoundary.boundary_mode, 'shared_mcp_package');
assert.equal(modernBoundary.task_lifecycle_root, modernTaskLifecyclePackageRoot);

function writeSiteLoopConfig(root, config) {
  mkdirSync(join(root, '.narada', 'capabilities'), { recursive: true });
  writeFileSync(join(root, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify(config, null, 2), 'utf8');
}

const phasePlanRoot = mkdtempSync(join(tmpdir(), 'site-loop-phase-plan-'));
writeSiteLoopConfig(phasePlanRoot, {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'phase.plan.loop',
  site_id: 'narada-phase-plan',
  display_name: 'Phase plan loop',
  resident: { agent_id: 'phase.plan.resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'phase-plan' } },
});
const phasePlanRun = await runSiteLoop(phasePlanRoot, {
  dryRun: true,
  sourceSync: true,
  runId: 'phase-plan-runtime-test',
  sourceSyncRunner: () => ({ status: 'ok', schema: 'narada.site_loop.source_sync.v1', cursor_path: '.ai/state/source.cursor' }),
});
assert.deepEqual(phasePlanRun.steps.map((step) => step.step_id), [
  'source_sync',
  'inbox_bridge',
  'task_materialization',
  'resident_directive_emission',
  'ticket_task_reconciliation',
  'pre_backlog_outcome_reconciliation',
  'reported_resident_task_state_reconciliation',
  'resident_backlog_recovery_emission',
  'resident_directive_dispatch',
  'receipt_reconciliation',
  'agent_outcome_reconciliation',
  'stale_escalation_reconciliation',
  'operating_alert_reconciliation',
]);

const testAuthorityRoot = mkdtempSync(join(tmpdir(), 'site-loop-test-authority-'));
writeSiteLoopConfig(testAuthorityRoot, {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'test.authority.loop',
  site_id: 'narada-test-authority',
  display_name: 'Test authority loop',
  resident: { agent_id: 'test.authority.resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'test-authority' } },
  test_authority: {
    enabled: true,
    state_root: '.ai/test-authority/site-loop',
    allow_live_mailbox: false,
    allow_live_resident: false,
    allow_live_scheduler: false,
    allow_configured_commands: false,
    task_lifecycle_db: '.ai/test-authority/site-loop/.ai/task-lifecycle.db',
    task_projection_root: '.ai/test-authority/site-loop/.ai/tasks',
    inbox_projection: '.ai/test-authority/site-loop/.ai/inbox-envelopes',
    site_loop_store: '.ai/test-authority/site-loop/.ai/task-lifecycle.db',
    resident_adapter: 'fixture',
    dispatch_adapter: 'fixture',
    operator_attention_root: '.ai/test-authority/site-loop/.ai/operator-attention',
  },
});
const testAuthorityRun = await runSiteLoop(testAuthorityRoot, {
  test_authority: true,
  dry_run: false,
  source_sync: false,
  ensureResident: false,
  requireLiveCarrier: false,
  limit: 1,
  runId: 'test-authority-runtime-test',
});
assert.equal(testAuthorityRun.status, 'ok');
assert.equal(testAuthorityRun.dry_run, false);
assert.equal(testAuthorityRun.authority_mode, 'test');
assert.equal(testAuthorityRun.test_authority.production_site_root, testAuthorityRoot);
assert.match(testAuthorityRun.test_authority.execution_site_root, /site-loop-test-authority-/);
assert.equal(existsSync(join(testAuthorityRoot, '.ai', 'task-lifecycle.db')), false);
assert.equal(existsSync(join(testAuthorityRoot, '.ai', 'test-authority', 'site-loop', '.ai', 'task-lifecycle.db')), true);
const testAuthorityRefusal = await runSiteLoop(testAuthorityRoot, {
  test_authority: true,
  dry_run: false,
  source_sync: true,
  requireLiveCarrier: false,
  runId: 'test-authority-refusal-test',
});
assert.equal(testAuthorityRefusal.status, 'refused');
assert.equal(testAuthorityRefusal.authority_mode, 'test');
assert.equal(testAuthorityRefusal.test_authority.reason, 'test_authority_binding_refused');
assert.equal(testAuthorityRefusal.test_authority.refused_edges.includes('test_authority_configured_commands_not_allowed'), true);

const defaultLoad = loadSiteLoopConfig(siteRoot);
assert.equal(defaultLoad.status, 'missing');
assert.equal(defaultLoad.config.loop_id, DEFAULT_SITE_LOOP_CONFIG.loop_id);
assert.equal(defaultLoad.config.resident.agent_id, DEFAULT_SITE_LOOP_CONFIG.resident.agent_id);
assert.throws(() => requireSiteLoopConfig(siteRoot), /site_loop_config_missing/);

const minimalSiteLoopConfig = {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'example.loop',
  site_id: 'narada-example',
  display_name: 'Example loop',
  resident: {
    agent_id: 'example.resident',
    role: 'operator',
  },
  refs: {
    ticket_projection: { kind: 'ticket_projection', ref: 'example' },
  },
  commands: {
    source_sync: { execution: 'direct_spawn', command: 'example-sync', args: ['--json'] },
    status: 'example status',
  },
  schemas: {
    site_loop_runs: 'narada.example.loop.runs.v1',
  },
  scheduler: {
    default_task_name: '\\Example-Site-Loop',
    pid_files: ['example-loop.pid'],
  },
  resident_launch: {
    runtime: 'example-runtime',
    launch_source: 'example_launch_source',
    trigger_source: 'example_trigger',
    trigger_reason: 'example_reason',
    requested_by: 'example.requester',
    preferred_runtime: 'example-preferred-runtime',
    selection_reason: 'example_selection',
    control_transport_schema: 'narada.example.launch.v1',
    transport: 'example_transport',
    carrier_relation: 'example_carrier_relation',
    env: { EXAMPLE_ENV: '1' },
  },
  resident_runtime: {
    preferred_runtime: 'example-preferred-runtime',
    fallback_runtime: 'example-fallback-runtime',
    legacy_fallback_runtimes: ['example-legacy-runtime'],
    preferred_preference: 'example_preferred_carrier',
    fallback_preference: 'example_fallback_carrier',
    process_probe_patterns: ['example-preferred-process', 'example-fallback-process'],
    fallback_process_probe_patterns: ['example-fallback-process'],
    session_root: '.example/sessions',
    external_session_roots: ['D:/example/sessions'],
  },
  recovery_plan: {
    steps: [
      { id: 'inspect', reason: 'Inspect current posture.', command: 'site_loop_unified_status { "task_name": "{task_name}" }' },
    ],
    guardrails: ['Verify after recovery.'],
  },
  policy: {
    allowed_preferred_carriers: ['example_preferred_carrier'],
    allowed_fallback_carriers: ['example-fallback-runtime'],
  },
  tests: {
    smoke: { command: 'node', args: ['smoke.js'] },
  },
  docs: [
    { path: 'README.md', description: 'Example docs.' },
  ],
};

assert.deepEqual(validateSiteLoopConfigDocument(minimalSiteLoopConfig), []);
writeSiteLoopConfig(siteRoot, minimalSiteLoopConfig);

const overrideLoad = loadSiteLoopConfig(siteRoot);
assert.equal(overrideLoad.status, 'ok');
assert.equal(overrideLoad.config.loop_id, 'example.loop');
assert.equal(overrideLoad.config.site_id, 'narada-example');
assert.equal(overrideLoad.config.resident.agent_id, 'example.resident');
assert.equal(overrideLoad.config.resident.role, 'operator');
assert.equal(overrideLoad.config.resident.required_task_tools.length, DEFAULT_SITE_LOOP_CONFIG.resident.required_task_tools.length);
assert.deepEqual(overrideLoad.config.refs.ticket_projection, { kind: 'ticket_projection', ref: 'example' });
assert.equal(overrideLoad.config.commands.source_sync.command, 'example-sync');
assert.deepEqual(overrideLoad.config.commands.source_sync.args, ['--json']);
assert.equal(overrideLoad.config.commands.status, 'example status');
assert.equal(overrideLoad.config.scheduler.default_task_name, '\\Example-Site-Loop');
assert.deepEqual(overrideLoad.config.scheduler.pid_files, ['example-loop.pid']);
assert.equal(overrideLoad.config.resident_launch.runtime, 'example-runtime');
assert.equal(overrideLoad.config.resident_launch.transport, 'example_transport');
assert.deepEqual(overrideLoad.config.resident_launch.env, { EXAMPLE_ENV: '1' });
assert.equal(overrideLoad.config.resident_runtime.preferred_runtime, 'example-preferred-runtime');
assert.equal(overrideLoad.config.resident_runtime.fallback_runtime, 'example-fallback-runtime');
assert.deepEqual(overrideLoad.config.resident_runtime.legacy_fallback_runtimes, ['example-legacy-runtime']);
assert.equal(overrideLoad.config.resident_runtime.preferred_preference, 'example_preferred_carrier');
assert.equal(overrideLoad.config.resident_runtime.fallback_preference, 'example_fallback_carrier');
assert.deepEqual(overrideLoad.config.resident_runtime.process_probe_patterns, ['example-preferred-process', 'example-fallback-process']);
assert.deepEqual(overrideLoad.config.resident_runtime.fallback_process_probe_patterns, ['example-fallback-process']);
assert.equal(overrideLoad.config.resident_runtime.session_root, '.example/sessions');
assert.deepEqual(overrideLoad.config.resident_runtime.external_session_roots, ['D:/example/sessions']);
assert.equal(overrideLoad.config.recovery_plan.steps[0].id, 'inspect');
assert.deepEqual(overrideLoad.config.recovery_plan.guardrails, ['Verify after recovery.']);
assert.deepEqual(overrideLoad.config.policy.allowed_preferred_carriers, ['example_preferred_carrier']);
assert.deepEqual(overrideLoad.config.policy.allowed_fallback_carriers, ['example-fallback-runtime']);
assert.equal(overrideLoad.config.resident_launch.runtime, 'example-runtime');
assert.equal(overrideLoad.config.resident_launch.launch_source, 'example_launch_source');
assert.equal(overrideLoad.config.resident_launch.requested_by, 'example.requester');
assert.equal(overrideLoad.config.resident_launch.transport, 'example_transport');
assert.equal(overrideLoad.config.tests.smoke.command, 'node');
assert.equal(overrideLoad.config.docs[0].path, 'README.md');
const operatingPolicyLoad = loadSiteLoopOperatingPolicy(siteRoot);
assert.equal(operatingPolicyLoad.status, 'ok');
assert.equal(operatingPolicyLoad.policy.carrier.preferred, 'example_preferred_carrier');
assert.equal(operatingPolicyLoad.policy.carrier.fallback, 'example-fallback-runtime');
const configuredPolicyValidation = validateSiteLoopOperatingPolicy(operatingPolicyLoad.policy, { cwd: siteRoot });
assert.equal(configuredPolicyValidation.status, 'ok');
const defaultPolicyValidation = validateSiteLoopOperatingPolicy(operatingPolicyLoad.policy);
assert.equal(defaultPolicyValidation.status, 'invalid');
assert.equal(defaultPolicyValidation.errors.includes('unsupported_loop_id'), true);
const initializedLoopStore = openSiteLoopStore(siteRoot);
initializedLoopStore.close();
const configuredRuns = listSiteLoopRuns(siteRoot, { limit: 1 });
assert.equal(configuredRuns.schema, 'narada.example.loop.runs.v1');
assert.equal(configuredRuns.loop_id, 'example.loop');
const configuredStatus = siteLoopStatus(siteRoot);
assert.equal(configuredStatus.loop_id, 'example.loop');
const configuredResident = getResidentStatus(siteRoot);
assert.equal(configuredResident.agent_id, 'example.resident');
const writeLockedStore = openSiteLoopStore(siteRoot);
try {
  const attentionList = listSiteLoopAttention(siteRoot, { limit: 1 });
  assert.equal(attentionList.loop_id, 'example.loop');
  assert.equal(Array.isArray(attentionList.attention), true);
} finally {
  writeLockedStore.close();
}
assert.equal(overrideLoad.config.tests.smoke.command, 'node');
assert.equal(overrideLoad.config.docs[0].path, 'README.md');

const invalidUnknownRoot = mkdtempSync(join(tmpdir(), 'site-loop-config-invalid-'));
writeSiteLoopConfig(invalidUnknownRoot, {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'bad.loop',
  site_id: 'narada-bad',
  display_name: 'Bad loop',
  resident: { agent_id: 'bad.resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'bad' } },
  unexpected_root_key: true,
});
const unknownRootLoad = loadSiteLoopConfig(invalidUnknownRoot);
assert.equal(unknownRootLoad.status, 'invalid');
assert.equal(unknownRootLoad.errors.some((error) => error.includes('unexpected_root_key_unknown_key')), true);
assert.throws(() => requireSiteLoopConfig(invalidUnknownRoot), /site_loop_config_invalid/);

const invalidMissingSchemaRoot = mkdtempSync(join(tmpdir(), 'site-loop-config-missing-schema-'));
writeSiteLoopConfig(invalidMissingSchemaRoot, {
  loop_id: 'missing.schema.loop',
  site_id: 'narada-missing-schema',
  display_name: 'Missing schema loop',
  resident: { agent_id: 'missing.resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'missing' } },
});
const invalidMissingSchemaLoad = loadSiteLoopConfig(invalidMissingSchemaRoot);
assert.equal(invalidMissingSchemaLoad.status, 'invalid');
assert.equal(invalidMissingSchemaLoad.errors.some((error) => error.includes('config.schema_required')), true);

const invalidPathRoot = mkdtempSync(join(tmpdir(), 'site-loop-config-invalid-path-'));
writeSiteLoopConfig(invalidPathRoot, {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'bad.path.loop',
  site_id: 'narada-bad-path',
  display_name: 'Bad path loop',
  resident: { agent_id: 'bad.resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'bad' } },
  mcp: { task_lifecycle_config_path: '../outside.json' },
});
const invalidPathLoad = loadSiteLoopConfig(invalidPathRoot);
assert.equal(invalidPathLoad.status, 'invalid');
assert.equal(invalidPathLoad.errors.some((error) => error.includes('safe_relative_path_required')), true);

const invalidCommandRoot = mkdtempSync(join(tmpdir(), 'site-loop-config-invalid-command-'));
writeSiteLoopConfig(invalidCommandRoot, {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'bad.command.loop',
  site_id: 'narada-bad-command',
  display_name: 'Bad command loop',
  resident: { agent_id: 'bad.resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'bad' } },
  commands: { source_sync: { execution: 'direct_spawn', command: 'bad-sync', args: '--json' } },
});
const invalidCommandLoad = loadSiteLoopConfig(invalidCommandRoot);
assert.equal(invalidCommandLoad.status, 'invalid');
assert.equal(invalidCommandLoad.errors.some((error) => error.includes('commands.source_sync.args')), true);

const invalidExecutionRoot = mkdtempSync(join(tmpdir(), 'site-loop-config-invalid-execution-'));
writeSiteLoopConfig(invalidExecutionRoot, {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'bad.execution.loop',
  site_id: 'narada-bad-execution',
  display_name: 'Bad execution loop',
  resident: { agent_id: 'bad.resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'bad' } },
  commands: { source_sync: { execution: 'shell_string', command: 'bad-sync', args: ['--json'] } },
});
const invalidExecutionLoad = loadSiteLoopConfig(invalidExecutionRoot);
assert.equal(invalidExecutionLoad.status, 'invalid');
assert.equal(invalidExecutionLoad.errors.some((error) => error.includes('commands.source_sync.execution_direct_spawn_required')), true);

const invalidRuntimeRoot = mkdtempSync(join(tmpdir(), 'site-loop-config-invalid-runtime-'));
writeSiteLoopConfig(invalidRuntimeRoot, {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'bad.runtime.loop',
  site_id: 'narada-bad-runtime',
  display_name: 'Bad runtime loop',
  resident: { agent_id: 'bad.resident', role: 'resident' },
  refs: { ticket_projection: { kind: 'ticket_projection', ref: 'bad' } },
  resident_runtime: { process_probe_patterns: 'agent-cli' },
});
const invalidRuntimeLoad = loadSiteLoopConfig(invalidRuntimeRoot);
assert.equal(invalidRuntimeLoad.status, 'invalid');
assert.equal(invalidRuntimeLoad.errors.some((error) => error.includes('resident_runtime.process_probe_patterns')), true);

console.log('site-loop config ok');
