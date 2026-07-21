import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { SITE_LOOP_CONFIG_JSON_SCHEMA } from './site-loop-config-schema.js';

type JsonObject = Record<string, unknown>;

export type SiteLoopCommandConfig = {
  execution: 'direct_spawn';
  command: string;
  args: string[];
  dry_run_arg?: string;
  limit_arg?: string;
  preferred_role_arg?: string;
};

export type SiteLoopScheduledSop = {
  id: string;
  sop_id: string;
  title: string;
  instructions: string;
  interval_days: number;
  anchor_at: string;
  target_role: string;
  preferred_agent_id: string;
};

export type SiteLoopConfig = {
  schema: string;
  loop_id: string;
  site_id: string;
  display_name: string;
  resident: {
    agent_id: string;
    role: string;
    required_task_tools: string[];
    required_mutating_task_tools: string[];
  };
  refs: {
    ticket_projection: { kind: string; ref: string };
  };
  mcp: {
    task_lifecycle_config_path: string;
    task_lifecycle_server_key: string;
    task_lifecycle_entrypoint_hint: string;
  };
  scheduler: {
    default_task_name: string;
    pid_files: string[];
  };
  scheduled_sops: SiteLoopScheduledSop[];
  resident_launch: {
    launcher_path: string;
    host_path?: string;
    materialization_command?: {
      command: string;
      args: string[];
    };
    runtime: string;
    launch_source?: string;
    trigger_source: string;
    trigger_reason: string;
    requested_by?: string;
    preferred_runtime: string;
    selection_reason: string;
    control_transport_schema: string;
    transport: string;
    carrier_relation: string;
    env: Record<string, string>;
  };
  resident_runtime: {
    preferred_runtime: string;
    fallback_runtime: string;
    legacy_fallback_runtimes: string[];
    preferred_preference: string;
    fallback_preference: string;
    process_probe_patterns: string[];
    fallback_process_probe_patterns: string[];
    session_root: string;
    external_session_roots: string[];
  };
  recovery_plan: {
    steps: { id: string; reason: string; command?: string }[];
    guardrails: string[];
  };
  schemas: Record<string, string>;
  commands: {
    source_sync: SiteLoopCommandConfig;
    ticket_task_reconciliation: SiteLoopCommandConfig;
    status: string;
    readiness: string;
    projection_drift: string;
    run_once: string;
    supervise: string;
    agent_cli_resident: string;
    live_fixture_proof: string;
    mailbox_proof: string;
    background_agent_cli: string;
  };
  policy: {
    schema: string;
    allowed_preferred_carriers: string[];
    allowed_fallback_carriers: string[];
    attention: Record<string, string>;
  };
  mailbox_proof: {
    schema: string;
    status_schema: string;
    freshness_ms: number;
  };
  test_authority: {
    enabled: boolean;
    state_root: string;
    allow_live_mailbox: boolean;
    allow_live_resident: boolean;
    allow_live_scheduler: boolean;
    allow_configured_commands: boolean;
    task_lifecycle_db: string;
    task_projection_root: string;
    inbox_projection: string;
    site_loop_store: string;
    resident_adapter: 'fixture';
    dispatch_adapter: 'fixture';
    operator_attention_root: string;
  };
  docs: { path: string; description: string }[];
  tests: Record<string, { command: string; args: string[] }>;
  notes: string[];
};

export const SITE_LOOP_CONFIG_SCHEMA = 'narada.site_loop.config.v1';
export const SITE_LOOP_CONFIG_PATH = '.narada/capabilities/site-loop-config.json';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSiteLoopConfigSchemaDocument: ValidateFunction = ajv.compile(SITE_LOOP_CONFIG_JSON_SCHEMA);

export function siteLoopConfigJsonSchema() {
  return SITE_LOOP_CONFIG_JSON_SCHEMA;
}

function validateScheduledSops(errors: string[], schedules: SiteLoopScheduledSop[]) {
  if (!Array.isArray(schedules)) {
    errors.push('scheduled_sops_array_required');
    return;
  }
  const ids = new Set<string>();
  for (const [index, schedule] of schedules.entries()) {
    const path = `scheduled_sops[${index}]`;
    for (const key of ['id', 'sop_id', 'title', 'instructions', 'anchor_at', 'target_role', 'preferred_agent_id'] as const) {
      requireNonEmptyString(errors, schedule?.[key], `${path}.${key}`);
    }
    if (ids.has(schedule?.id)) errors.push(`${path}.id_duplicate:${schedule.id}`);
    ids.add(schedule?.id);
    if (!Number.isFinite(schedule?.interval_days) || schedule.interval_days <= 0) errors.push(`${path}.interval_days_positive_number_required`);
    if (!Number.isFinite(Date.parse(schedule?.anchor_at))) errors.push(`${path}.anchor_at_iso_timestamp_required`);
  }
}

export function validateSiteLoopConfigDocument(document: unknown) {
  const ok = validateSiteLoopConfigSchemaDocument(document);
  return ok ? [] : (validateSiteLoopConfigSchemaDocument.errors ?? []).map(siteLoopConfigSchemaError);
}

export const DEFAULT_SITE_LOOP_CONFIG: SiteLoopConfig = {
  schema: SITE_LOOP_CONFIG_SCHEMA,
  loop_id: 'site.loop',
  site_id: 'narada-site',
  display_name: 'Site operating loop',
  resident: {
    agent_id: 'site.resident',
    role: 'resident',
    required_task_tools: [
      'task_lifecycle_inspect',
      'task_lifecycle_claim',
      'task_lifecycle_disposition_closeout',
      'task_lifecycle_submit_report',
    ],
    required_mutating_task_tools: [
      'task_lifecycle_claim',
      'task_lifecycle_disposition_closeout',
      'task_lifecycle_submit_report',
    ],
  },
  refs: {
    ticket_projection: { kind: 'ticket_projection', ref: 'site' },
  },
  mcp: {
    task_lifecycle_config_path: '.ai/mcp/task-lifecycle-mcp.json',
    task_lifecycle_server_key: 'task-lifecycle',
    task_lifecycle_entrypoint_hint: 'D:/code/mcp-surfaces/packages/task-lifecycle-mcp/dist/src/task-lifecycle/task-mcp-server.js',
  },
  scheduler: {
    default_task_name: '\\Narada-Site-Loop',
    pid_files: ['daemon.pid', 'recurring-runner.pid', 'site-loop-runner.pid'],
  },
  scheduled_sops: [],
  resident_launch: {
    launcher_path: 'tools/agent-start/start-agent.js',
    host_path: 'tools/site-loop/agent-runtime-server-control-host.js',
    runtime: 'narada-agent-runtime-server',
    launch_source: 'site_loop',
    trigger_source: 'loop_ensure_resident',
    trigger_reason: 'no_acceptable_live_resident_carrier',
    requested_by: 'site.loop',
    preferred_runtime: 'narada-agent-runtime-server',
    selection_reason: 'no_live_preferred_resident_carrier',
    control_transport_schema: 'narada.agent_start.agent_runtime_server.v0',
    transport: 'jsonl_stdio_hosted_by_control_jsonl',
    carrier_relation: 'resident_agent_runtime_server_control_host',
    env: {
      NARADA_RESIDENT_PROOF_DRIVER: '1',
      NARADA_RESIDENT_AUTOWORK: '1',
    },
  },
  resident_runtime: {
    preferred_runtime: 'narada-agent-runtime-server',
    fallback_runtime: 'agent-runtime-server',
    legacy_fallback_runtimes: ['nars'],
    preferred_preference: 'interactive_agent_cli',
    fallback_preference: 'agent_runtime_server_fallback',
    process_probe_patterns: ['narada-agent-runtime-server', 'agent-cli', 'agent-runtime-server-control-host', 'nars-control-host'],
    fallback_process_probe_patterns: ['agent-runtime-server-control-host.js', 'nars-control-host.js'],
    session_root: '.narada/crew/nars-sessions',
    external_session_roots: [],
  },
  recovery_plan: {
    steps: [
      {
        id: 'inspect_unified_status',
        reason: 'Capture scheduler, PID, logical loop, and health posture before changing state.',
        command: 'site_loop_unified_status { "task_name": "{task_name}" }',
      },
      {
        id: 'restart_supervisor',
        reason: 'Use the site-owned idempotent supervisor start path; it cleans stale PID files before launch.',
        command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "{site_root}/scripts/supervisor.ps1" start',
      },
      {
        id: 'run_scheduled_task',
        reason: 'Ask Windows Task Scheduler to invoke the registered daemon task after supervisor scripts are healthy.',
        command: 'schtasks /run /tn "{task_name}"',
      },
      {
        id: 'verify_recovery',
        reason: 'Re-read unified status and health; do not infer recovery from process launch alone.',
        command: 'site_loop_unified_status { "task_name": "{task_name}" }',
      },
    ],
    guardrails: [
      'Do not delete or overwrite loop state files manually unless the configured recovery procedure reports stale PID cleanup failure.',
      'Use elevated PowerShell only for scheduled-task registration or trigger changes, not for ordinary status checks.',
      'After recovery, verify useful-work posture through site_loop_unified_status and site_loop_health.',
    ],
  },
  schemas: {
    site_loop_run: 'narada.site_loop.run.v2',
    source_sync: 'narada.site_loop.source_sync.v1',
    ticket_task_reconciliation: 'narada.site_loop.ticket_task_reconciliation.v1',
    agent_outcome_reconciliation: 'narada.site_loop.agent_outcome_reconciliation.v1',
    reported_resident_task_state_reconciliation: 'narada.site_loop.reported_resident_task_state_reconciliation.v1',
    resident_backlog_recovery: 'narada.site_loop.resident_backlog_recovery.v1',
    directive_dispatch: 'narada.site_loop.directive_dispatch.v1',
    site_loop_runs: 'narada.site_loop.runs.v1',
    site_loop_show: 'narada.site_loop.show.v1',
    operating_layer_status: 'narada.site_loop.operating_layer_status.v1',
    operating_layer_readiness: 'narada.site_loop.operating_layer_readiness.v1',
    operating_layer_coherence: 'narada.site_loop.operating_layer_coherence.v1',
    surface_policy_noise: 'narada.site_loop.surface_policy_noise.v1',
    resident_mailbox_proof: 'narada.site_loop.resident_mailbox_proof.v1',
    resident_mailbox_proof_status: 'narada.site_loop.resident_mailbox_proof_status.v1',
    resident_status: 'narada.site_loop.resident_status.v1',
    resident_carrier_state: 'narada.site_loop.resident_carrier_state.v1',
    resident_host_evidence: 'narada.site_loop.resident_host_evidence.v1',
    resident_pending_directives: 'narada.site_loop.resident_pending_directives.v1',
    resident_receipts: 'narada.site_loop.resident_receipts.v1',
    resident_outcomes: 'narada.site_loop.resident_outcomes.v1',
    directive_outcome_proof_split: 'narada.site_loop.directive_outcome_proof_split.v1',
    resident_backlog_summary: 'narada.site_loop.resident_backlog_summary.v1',
    resident_refusal: 'narada.site_loop.resident_refusal.v1',
    resident_capabilities: 'narada.site_loop.resident_capabilities.v1',
    resident_task_lifecycle_surface_policy: 'narada.site_loop.resident_task_lifecycle_surface_policy.v1',
    resident_supervisor: 'narada.site_loop.resident_supervisor.v1',
    redundant_fallback_cleanup: 'narada.site_loop.redundant_fallback_cleanup.v1',
    resident_restart_policy: 'narada.site_loop.resident_restart_policy.v1',
    operating_layer_alert: 'narada.site_loop.operating_layer_alert.v1',
    operating_layer_alert_reconciliation: 'narada.site_loop.operating_layer_alert_reconciliation.v1',
    resident_fixture_residue_cleanup: 'narada.site_loop.resident_fixture_residue_cleanup.v1',
    resident_fixture_residue_cleanup_evidence: 'narada.site_loop.resident_fixture_residue_cleanup_evidence.v1',
    task_lifecycle_db_health: 'narada.site_loop.task_lifecycle_db_health.v1',
    task_lifecycle_db_repair: 'narada.site_loop.task_lifecycle_db_repair.v1',
    task_lifecycle_write_lock: 'narada.site_loop.task_lifecycle_write_lock.v1',
    resident_e2e: 'narada.site_loop.resident_e2e.v1',
    resident_e2e_proof: 'narada.site_loop.resident_e2e.proof.v1',
    resident_e2e_store_simulation: 'narada.site_loop.resident_e2e.store_simulation.v1',
    loop_attention_list: 'narada.site_loop.attention_list.v1',
    loop_attention_show: 'narada.site_loop.attention_show.v1',
    loop_attention_ack: 'narada.site_loop.attention_ack.v1',
    resident_recover_stale: 'narada.site_loop.resident_recover_stale.v1',
    resident_stale_carrier_recovery: 'narada.site_loop.resident_stale_carrier_recovery.v1',
    resident_runtime_cleanup: 'narada.site_loop.resident_runtime_cleanup.v1',
    resident_proof_packet: 'narada.site_loop.resident_proof_packet.v1',
    resident_recovery_drill: 'narada.site_loop.resident_recovery_drill.v1',
    site_loop_schema_repair: 'narada.site_loop.schema_repair.v1',
    loop_fixture_seed: 'narada.site_loop.fixture_seed.v1',
    loop_fixture_cleanup: 'narada.site_loop.fixture_cleanup.v1',
    site_loop_supervisor_run: 'narada.site_loop.supervisor_run.v1',
    site_loop_soak: 'narada.site_loop.soak.v1',
    directive_recovery_supersession: 'narada.site_loop.directive_recovery_supersession.v1',
    resident_task_backlog_attention: 'narada.site_loop.resident_task_backlog_attention.v1',
    loop_escalation_reconciliation: 'narada.site_loop.escalation_reconciliation.v1',
    resident_carrier_retirement: 'narada.site_loop.resident_carrier_retirement.v1',
    controlled_mailbox_source_status: 'narada.site_loop.controlled_mailbox_source_status.v1',
  },
  commands: {
    source_sync: { execution: 'direct_spawn', command: 'pnpm', args: ['cli', '--', '--json', 'sync'], dry_run_arg: '--dry-run' },
    ticket_task_reconciliation: {
      execution: 'direct_spawn',
      command: 'pnpm',
      args: ['cli', '--', '--json', 'ticket', 'task', 'reconcile'],
      preferred_role_arg: '--preferred-role',
      limit_arg: '--limit',
      dry_run_arg: '--dry-run',
    },
    status: 'pnpm cli -- ops loop',
    readiness: 'pnpm cli -- ops readiness',
    projection_drift: 'not_available: task projection drift check is not configured; provide a typed MCP/site-loop check before enabling this readiness gate',
    run_once: 'pnpm cli -- loop run site.loop --once --ensure-resident',
    supervise: 'pnpm cli -- loop supervise site.loop --ensure-resident',
    agent_cli_resident: '.\\narada-site.ps1 agent-start -Agent {resident_agent_id} -Carrier agent-cli -Runtime narada-agent-runtime-server -Exec',
    live_fixture_proof: 'pnpm cli -- resident e2e --ack-fixture --live --ensure-resident --expect-carrier-preference interactive_agent_cli --production-proof --json',
    mailbox_proof: 'pnpm cli -- resident e2e --mailbox-proof --controlled-mailbox-proof --controlled-mailbox-source <ref> --live --ensure-resident --expect-carrier-preference interactive_agent_cli --production-proof --json',
    background_agent_cli: 'pnpm cli -- resident summon --background --json',
  },
  policy: {
    schema: 'narada.site_loop.operating_policy.v1',
    allowed_preferred_carriers: ['interactive_agent_cli'],
    allowed_fallback_carriers: ['agent-runtime-server'],
    attention: {
      no_carrier: 'warning',
      stale_delivery_lease: 'error',
      stale_action: 'error',
      stale_busy_carrier: 'error',
      policy_drift: 'error',
      repeated_loop_failure: 'critical',
      db_integrity_failure: 'critical',
      no_new_mailbox_work: 'info',
      duplicates_only: 'info',
    },
  },
  mailbox_proof: {
    schema: 'narada.site_loop.resident_mailbox_proof.v1',
    status_schema: 'narada.site_loop.resident_mailbox_proof_status.v1',
    freshness_ms: 24 * 60 * 60_000,
  },
  test_authority: {
    enabled: false,
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
    operator_attention_root: '.ai/test-authority/site-loop/operator-attention',
  },
  docs: [
    { path: 'AGENTS.md', description: 'Site-local agent instructions.' },
    { path: '.narada/site.json', description: 'Site identity and authority locus.' },
    { path: '.narada/capabilities/mcp-registration.json', description: 'Site-local MCP registry.' },
    { path: '.narada/capabilities/capability-policy.json', description: 'Capability admission policy.' },
    { path: '.narada/capabilities/site-access-policy.json', description: 'Admitted filesystem/access policy.' },
    { path: '.narada/mcp/README.md', description: 'MCP surface readiness and reload posture.' },
  ],
  tests: {
    check: { command: 'pnpm', args: ['check'] },
    launcher_smoke: { command: 'node', args: ['tools/agent-context/agent-launcher-smoke.js'] },
    agent_context_smoke: { command: 'node', args: ['tools/agent-context/agent-context-smoke.js'] },
    mcp_bridge_poll: { command: 'not_available', args: ['legacy task-lifecycle bridge poll test removed; use task_lifecycle_test_mcp_tool when admitted'] },
  },
  notes: [
    'This status is scoped by site-loop config.',
    'transport_ready means loop plumbing is usable; production_ready additionally requires the configured primary runtime and non-proof-driver report evidence.',
    'Unrelated site warnings are intentionally excluded unless config declares them as loop inputs.',
  ],
};

export function siteLoopConfigPath(siteRoot: string) {
  return join(siteRoot, SITE_LOOP_CONFIG_PATH);
}

function validateResidentRuntime(errors: string[], runtime: SiteLoopConfig['resident_runtime']) {
  requireNonEmptyString(errors, runtime?.preferred_runtime, 'resident_runtime.preferred_runtime');
  requireNonEmptyString(errors, runtime?.fallback_runtime, 'resident_runtime.fallback_runtime');
  requireStringArray(errors, runtime?.legacy_fallback_runtimes, 'resident_runtime.legacy_fallback_runtimes');
  requireNonEmptyString(errors, runtime?.preferred_preference, 'resident_runtime.preferred_preference');
  requireNonEmptyString(errors, runtime?.fallback_preference, 'resident_runtime.fallback_preference');
  requireStringArray(errors, runtime?.process_probe_patterns, 'resident_runtime.process_probe_patterns');
  requireStringArray(errors, runtime?.fallback_process_probe_patterns, 'resident_runtime.fallback_process_probe_patterns');
  requireSafeRelativePath(errors, runtime?.session_root, 'resident_runtime.session_root');
  requireStringArray(errors, runtime?.external_session_roots, 'resident_runtime.external_session_roots');
}

export function loadSiteLoopConfig(siteRoot: string): { status: 'ok' | 'missing' | 'invalid'; path: string; config: SiteLoopConfig; errors: string[] } {
  const path = siteLoopConfigPath(siteRoot);
  if (!existsSync(path)) {
    const errors = validateSiteLoopConfig(DEFAULT_SITE_LOOP_CONFIG);
    return { status: errors.length === 0 ? 'missing' : 'invalid', path, config: DEFAULT_SITE_LOOP_CONFIG, errors };
  }
  try {
    const override = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
    const schemaErrors = validateSiteLoopConfigDocument(override);
    const overrideErrors = validateOverrideShape(DEFAULT_SITE_LOOP_CONFIG, override);
    const config = mergeConfig(DEFAULT_SITE_LOOP_CONFIG, override) as SiteLoopConfig;
    const errors = [...schemaErrors, ...overrideErrors, ...validateSiteLoopConfig(config)];
    return { status: errors.length === 0 ? 'ok' : 'invalid', path, config, errors };
  } catch (error) {
    return {
      status: 'invalid',
      path,
      config: DEFAULT_SITE_LOOP_CONFIG,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function requireSiteLoopConfig(siteRoot: string): SiteLoopConfig {
  const loaded = loadSiteLoopConfig(siteRoot);
  if (loaded.status === 'missing') {
    throw new SiteLoopConfigError(loaded.path, ['site_loop_config_missing']);
  }
  if (loaded.status !== 'ok') {
    throw new SiteLoopConfigError(loaded.path, loaded.errors);
  }
  return loaded.config;
}

export class SiteLoopConfigError extends Error {
  constructor(public readonly path: string, public readonly errors: string[]) {
    super(`site_loop_config_invalid: ${path}: ${errors.join('; ')}`);
    this.name = 'SiteLoopConfigError';
  }
}

export function schemaName(config: SiteLoopConfig, key: string) {
  return config.schemas[key] ?? `narada.site_loop.${key}.v1`;
}

function validateSiteLoopConfig(config: SiteLoopConfig) {
  const errors: string[] = [];
  if (config.schema !== SITE_LOOP_CONFIG_SCHEMA) errors.push(`schema_mismatch:${config.schema}`);
  requireNonEmptyString(errors, config.loop_id, 'loop_id');
  requireNonEmptyString(errors, config.site_id, 'site_id');
  requireNonEmptyString(errors, config.display_name, 'display_name');
  requireNonEmptyString(errors, config.resident?.agent_id, 'resident.agent_id');
  requireNonEmptyString(errors, config.resident?.role, 'resident.role');
  requireStringArray(errors, config.resident?.required_task_tools, 'resident.required_task_tools');
  requireStringArray(errors, config.resident?.required_mutating_task_tools, 'resident.required_mutating_task_tools');
  requireNonEmptyString(errors, config.refs?.ticket_projection?.kind, 'refs.ticket_projection.kind');
  requireNonEmptyString(errors, config.refs?.ticket_projection?.ref, 'refs.ticket_projection.ref');
  requireSafeRelativePath(errors, config.mcp?.task_lifecycle_config_path, 'mcp.task_lifecycle_config_path');
  requireNonEmptyString(errors, config.mcp?.task_lifecycle_server_key, 'mcp.task_lifecycle_server_key');
  requireNonEmptyString(errors, config.mcp?.task_lifecycle_entrypoint_hint, 'mcp.task_lifecycle_entrypoint_hint');
  requireNonEmptyString(errors, config.scheduler?.default_task_name, 'scheduler.default_task_name');
  requireStringArray(errors, config.scheduler?.pid_files, 'scheduler.pid_files');
  for (const [index, path] of (Array.isArray(config.scheduler?.pid_files) ? config.scheduler.pid_files : []).entries()) {
    requireSafeRelativePath(errors, path, `scheduler.pid_files[${index}]`);
  }
  validateScheduledSops(errors, config.scheduled_sops);
  validateResidentLaunch(errors, config.resident_launch);
  validateResidentRuntime(errors, config.resident_runtime);
  validateRecoveryPlan(errors, config.recovery_plan);
  validateSchemaMap(errors, config.schemas);
  validateExecutableCommand(errors, config.commands?.source_sync, 'commands.source_sync');
  validateExecutableCommand(errors, config.commands?.ticket_task_reconciliation, 'commands.ticket_task_reconciliation');
  for (const key of ['status', 'readiness', 'projection_drift', 'run_once', 'supervise', 'agent_cli_resident', 'live_fixture_proof', 'mailbox_proof', 'background_agent_cli']) {
    requireNonEmptyString(errors, config.commands?.[key], `commands.${key}`);
  }
  requireNonEmptyString(errors, config.policy?.schema, 'policy.schema');
  requireStringArray(errors, config.policy?.allowed_preferred_carriers, 'policy.allowed_preferred_carriers');
  requireStringArray(errors, config.policy?.allowed_fallback_carriers, 'policy.allowed_fallback_carriers');
  validateStringMap(errors, config.policy?.attention, 'policy.attention');
  requireNonEmptyString(errors, config.mailbox_proof?.schema, 'mailbox_proof.schema');
  requireNonEmptyString(errors, config.mailbox_proof?.status_schema, 'mailbox_proof.status_schema');
  if (!Number.isFinite(config.mailbox_proof?.freshness_ms) || config.mailbox_proof.freshness_ms <= 0) errors.push('mailbox_proof.freshness_ms_positive_number_required');
  validateTestAuthority(errors, config.test_authority);
  validateDocs(errors, config.docs);
  validateTests(errors, config.tests);
  requireStringArray(errors, config.notes, 'notes');
  return errors;
}

function validateTestAuthority(errors: string[], testAuthority: SiteLoopConfig['test_authority']) {
  if (!testAuthority || typeof testAuthority !== 'object') {
    errors.push('test_authority_object_required');
    return;
  }
  for (const key of ['enabled', 'allow_live_mailbox', 'allow_live_resident', 'allow_live_scheduler', 'allow_configured_commands'] as const) {
    if (typeof testAuthority[key] !== 'boolean') errors.push(`test_authority.${key}_boolean_required`);
  }
  for (const key of ['state_root', 'task_lifecycle_db', 'task_projection_root', 'inbox_projection', 'site_loop_store', 'operator_attention_root'] as const) {
    requireSafeRelativePath(errors, testAuthority[key], `test_authority.${key}`);
  }
  if (testAuthority.resident_adapter !== 'fixture') errors.push('test_authority.resident_adapter_fixture_required');
  if (testAuthority.dispatch_adapter !== 'fixture') errors.push('test_authority.dispatch_adapter_fixture_required');
}

function validateResidentLaunch(errors: string[], launch: SiteLoopConfig['resident_launch']) {
  if (launch?.materialization_command) {
    requireNonEmptyString(errors, launch.materialization_command.command, 'resident_launch.materialization_command.command');
    if (!Array.isArray(launch.materialization_command.args)) errors.push('resident_launch.materialization_command.args_array_required');
  } else {
    requireSafeRelativePath(errors, launch?.launcher_path, 'resident_launch.launcher_path');
  }
  if (!launch?.materialization_command || launch?.host_path != null) {
    requireSafeRelativePath(errors, launch?.host_path, 'resident_launch.host_path');
  }
  requireNonEmptyString(errors, launch?.runtime, 'resident_launch.runtime');
  requireNonEmptyString(errors, launch?.trigger_source, 'resident_launch.trigger_source');
  requireNonEmptyString(errors, launch?.trigger_reason, 'resident_launch.trigger_reason');
  requireNonEmptyString(errors, launch?.preferred_runtime, 'resident_launch.preferred_runtime');
  requireNonEmptyString(errors, launch?.selection_reason, 'resident_launch.selection_reason');
  requireNonEmptyString(errors, launch?.control_transport_schema, 'resident_launch.control_transport_schema');
  requireNonEmptyString(errors, launch?.transport, 'resident_launch.transport');
  requireNonEmptyString(errors, launch?.carrier_relation, 'resident_launch.carrier_relation');
  if (launch?.launch_source != null) requireNonEmptyString(errors, launch.launch_source, 'resident_launch.launch_source');
  if (launch?.requested_by != null) requireNonEmptyString(errors, launch.requested_by, 'resident_launch.requested_by');
  validateStringMap(errors, launch?.env, 'resident_launch.env');
}

function validateRecoveryPlan(errors: string[], plan: SiteLoopConfig['recovery_plan']) {
  if (!Array.isArray(plan?.steps)) {
    errors.push('recovery_plan.steps_string_array_required');
  } else {
    for (const [index, step] of plan.steps.entries()) {
      requireNonEmptyString(errors, step?.id, `recovery_plan.steps[${index}].id`);
      requireNonEmptyString(errors, step?.reason, `recovery_plan.steps[${index}].reason`);
      if (step?.command != null) requireNonEmptyString(errors, step.command, `recovery_plan.steps[${index}].command`);
    }
  }
  requireStringArray(errors, plan?.guardrails, 'recovery_plan.guardrails');
}

function validateSchemaMap(errors: string[], value: unknown) {
  validateStringMap(errors, value, 'schemas');
  if (isPlainObject(value)) {
    for (const [key, schema] of Object.entries(value)) {
      if (!String(schema).startsWith('narada.')) errors.push(`schemas.${key}_narada_schema_required`);
    }
  }
}

function validateDocs(errors: string[], docs: unknown) {
  if (!Array.isArray(docs)) {
    errors.push('docs_array_required');
    return;
  }
  for (const [index, doc] of docs.entries()) {
    const record = isPlainObject(doc) ? doc : null;
    requireSafeRelativePath(errors, record?.path, `docs[${index}].path`);
    requireNonEmptyString(errors, record?.description, `docs[${index}].description`);
  }
}

function validateTests(errors: string[], tests: unknown) {
  if (!isPlainObject(tests)) {
    errors.push('tests_object_required');
    return;
  }
  for (const [selector, test] of Object.entries(tests)) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(selector)) errors.push(`tests.${selector}_selector_invalid`);
    validateCommand(errors, test, `tests.${selector}`);
  }
}

function validateCommand(errors: string[], command: unknown, path: string) {
  const record = isPlainObject(command) ? command : null;
  requireNonEmptyString(errors, record?.command, `${path}.command`);
  requireStringArray(errors, record?.args, `${path}.args`);
  for (const key of ['dry_run_arg', 'limit_arg', 'preferred_role_arg']) {
    if (record?.[key] != null) requireNonEmptyString(errors, record[key], `${path}.${key}`);
  }
}

function validateExecutableCommand(errors: string[], command: unknown, path: string) {
  const record = isPlainObject(command) ? command : null;
  if (record?.execution !== 'direct_spawn') errors.push(`${path}.execution_direct_spawn_required`);
  validateCommand(errors, command, path);
}

function validateStringMap(errors: string[], value: unknown, path: string) {
  if (!isPlainObject(value)) {
    errors.push(`${path}_object_required`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    requireNonEmptyString(errors, entry, `${path}.${key}`);
  }
}

function requireNonEmptyString(errors: string[], value: unknown, path: string) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${path}_non_empty_string_required`);
}

function requireStringArray(errors: string[], value: unknown, path: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) errors.push(`${path}_string_array_required`);
}

function requireSafeRelativePath(errors: string[], value: unknown, path: string) {
  requireNonEmptyString(errors, value, path);
  if (typeof value !== 'string') return;
  const normalized = normalize(value).replace(/\\/g, '/');
  if (isAbsolute(value) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    errors.push(`${path}_safe_relative_path_required`);
  }
}

function validateOverrideShape(base: unknown, override: unknown, path = 'config'): string[] {
  if (!isPlainObject(override)) return [`${path}_object_required`];
  if (!isPlainObject(base)) return [];
  if (isOpenKeyMapPath(path)) return [];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(override)) {
    const childPath = `${path}.${key}`;
    if (!(key in base)) {
      if (isKnownOptionalOverrideKey(path, key)) continue;
      errors.push(`${childPath}_unknown_key`);
      continue;
    }
    const baseValue = base[key];
    if (Array.isArray(baseValue)) {
      if (!Array.isArray(value)) errors.push(`${childPath}_array_required`);
      continue;
    }
    if (isPlainObject(baseValue)) {
      if (!isPlainObject(value)) {
        errors.push(`${childPath}_object_required`);
      } else {
        errors.push(...validateOverrideShape(baseValue, value, childPath));
      }
      continue;
    }
    if (typeof value !== typeof baseValue) errors.push(`${childPath}_${typeof baseValue}_required`);
  }
  return errors;
}

function isKnownOptionalOverrideKey(path: string, key: string) {
  return path === 'config.resident_launch' && key === 'materialization_command';
}

function isOpenKeyMapPath(path: string) {
  return path === 'config.schemas'
    || path === 'config.policy.attention'
    || path === 'config.tests'
    || path === 'config.resident_launch.env';
}

function mergeConfig(base: unknown, override: unknown, path = 'config'): unknown {
  if (isReplaceMapPath(path) && override != null) return override;
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? mergeConfig(merged[key], value, `${path}.${key}`) : value;
  }
  return merged;
}

function isReplaceMapPath(path: string) {
  return path === 'config.tests' || path === 'config.resident_launch.env';
}

function siteLoopConfigSchemaError(error: ErrorObject) {
  const path = schemaErrorPath(error);
  if (error.keyword === 'additionalProperties' && isPlainObject(error.params)) {
    const property = error.params.additionalProperty;
    if (typeof property === 'string' && property.trim()) return `${path}.${property}_unknown_key`;
  }
  if (error.keyword === 'required' && isPlainObject(error.params)) {
    const property = error.params.missingProperty;
    if (typeof property === 'string' && property.trim()) return `${path}.${property}_required`;
  }
  if (error.keyword === 'const') return `${path}_const_required`;
  if (error.keyword === 'type') return `${path}_${String(error.params?.type ?? 'type')}_required`;
  if (error.keyword === 'minLength') return `${path}_non_empty_string_required`;
  if (error.keyword === 'exclusiveMinimum') return `${path}_positive_number_required`;
  return `${path}_${error.keyword}`;
}

function schemaErrorPath(error: ErrorObject) {
  if (!error.instancePath) return 'config';
  const path = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
  return path ? `config.${path}` : 'config';
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
