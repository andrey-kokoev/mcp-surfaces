#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'mcp-registrar';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

type ValidationFinding = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  server_key?: string;
  surface_id?: string;
  entrypoint?: string;
  detail?: JsonRecord;
};

type JsonRecord = Record<string, unknown>;

type McpInjectionScope = 'host' | 'user_site' | 'local_site';
type McpRestartOwner = McpInjectionScope;
type McpDefaultInjection = 'all_site_bound_sessions' | 'all_carrier_sessions';

type McpAuthorityLocus =
  | { kind: 'host' }
  | { kind: 'user_site'; site_root: string }
  | { kind: 'local_site'; site_root: string };

type SurfaceDef = {
  id: string;
  package: string;
  entrypoint: string;
  kind: 'mcp_surface' | 'site_tool';
  args: string[];
  tools: string[];
  injection_scope?: McpInjectionScope;
  default_injection?: McpDefaultInjection;
  restart_owner?: McpRestartOwner;
  env_vars?: string[];
  sops_dir?: string;
};

type SurfaceScopeMetadata = {
  injection_scope: McpInjectionScope;
  authority_locus: McpAuthorityLocus;
  mutation_locus: McpAuthorityLocus;
  restart_owner: McpRestartOwner;
};

type NaradaScopeMetadata = SurfaceScopeMetadata & {
  bound_into_site?: string;
  scope_source: 'registrar_surface_catalog' | 'site_config_narada_scope' | 'site_config_legacy_top_level';
};

type SiteLocalSurface = {
  surface_id: string;
  kind: 'mcp_entrypoint';
  command: string;
  path: string;
  canonical_tool_prefix?: string;
  replaces?: string;
};

type SiteDef = {
  site_id: string;
  root: string;
  config_path: string;
  surfaces: string[];
  local_surface_allowlist?: string[];
  surface_overrides?: Record<string, SurfaceOverride>;
};

type SiteMcpFabricMode = 'empty' | 'aggregate' | 'sidecar';

type SiteBinding = {
  site_id: string;
  surfaces: 'all' | string[];
  prefix: string;
  extra_allowed_roots?: string[];
};

type SurfaceOverride = {
  entrypoint?: string;
  args?: string[];
  env_vars?: string[];
  approval_mode?: 'auto' | 'approve';
  enabled?: boolean;
};

type MaterializedServer = {
  kind: 'shared' | 'local';
  entrypoint: string;
  command?: string;
  args: string[];
  surface?: SurfaceDef;
  local?: SiteLocalSurface;
  env_vars?: string[];
  enabled?: boolean;
  narada_scope: NaradaScopeMetadata;
} & SurfaceScopeMetadata;

type CarrierDef = {
  carrier_id: string;
  kind: 'opencode' | 'kimi' | 'codex';
  config_path: string;
  surfaces: string[];
  site_bindings: SiteBinding[];
  extra_allowed_roots?: string[];
  trust_projects?: string[];
  surface_overrides?: Record<string, SurfaceOverride>;
};

const MCP_SURFACES_ROOT = 'D:/code/mcp-surfaces/packages';
const USER_NARADA_ROOT = 'C:/Users/Andrey/Narada';

const GIT_TOOLS = ['git_policy_inspect', 'git_status', 'git_output_show', 'git_changed_summary', 'git_repositories_summary', 'git_workflow_record', 'git_diff', 'git_log', 'git_show', 'git_add', 'git_unstage', 'git_commit', 'git_push'];
const GRAPH_MAIL_TOOLS = ['graph_mail_doctor', 'graph_mail_query', 'graph_mail_message_show', 'graph_mail_attachment_list', 'graph_mail_attachment_get', 'graph_mail_attachment_add', 'graph_mail_attachment_upload_session_create', 'graph_mail_attachment_upload_chunk', 'graph_mail_attachment_upload_file', 'graph_mail_attachment_delete', 'graph_mail_draft_create', 'graph_mail_reply_draft_create', 'graph_mail_reply_all_draft_create', 'graph_mail_forward_draft_create', 'graph_mail_reply_all_to_last_in_thread_draft_create', 'graph_mail_draft_update', 'graph_mail_draft_discard', 'graph_mail_draft_send'];
const SITE_INBOX_TOOLS = ['inbox_doctor', 'inbox_list', 'inbox_show', 'inbox_next', 'inbox_acknowledge', 'inbox_dismiss', 'inbox_promote_capa', 'inbox_amend_capa', 'inbox_create_capa', 'inbox_export_disposition_ledger', 'inbox_stage_submission_workflow', 'inbox_submit_observation', 'inbox_submit_typed_envelope', 'capa_queue', 'capa_related', 'mcp_payload_create', 'mcp_payload_show', 'mcp_payload_derive', 'mcp_payload_validate', 'mcp_command_author_and_submit', 'mcp_command_create', 'mcp_command_show', 'mcp_command_submit', 'mcp_command_validate', 'mcp_output_show', 'mcp_result_show'];
const TASK_LIFECYCLE_TOOLS = ['task_lifecycle_doctor', 'task_lifecycle_list', 'task_lifecycle_show', 'task_lifecycle_roster', 'task_lifecycle_payload_schema', 'task_lifecycle_roster_admit', 'task_lifecycle_claim', 'task_lifecycle_continue', 'task_lifecycle_unclaim', 'task_lifecycle_next', 'task_lifecycle_workboard_snapshot', 'task_lifecycle_obligations', 'task_lifecycle_inspect', 'task_lifecycle_inspect_range', 'task_lifecycle_admit_evidence', 'task_lifecycle_prove_criteria', 'task_lifecycle_disposition_closeout', 'task_lifecycle_closeout', 'task_lifecycle_audit', 'task_lifecycle_finish', 'task_lifecycle_submit_report', 'task_lifecycle_close', 'task_lifecycle_report_blocked', 'task_lifecycle_search', 'task_lifecycle_related', 'task_lifecycle_defer', 'task_lifecycle_un_defer', 'task_lifecycle_reopen', 'task_lifecycle_review', 'task_lifecycle_submit_observation', 'task_lifecycle_record_observation', 'task_lifecycle_bridge_poll', 'task_lifecycle_inbox_target', 'task_lifecycle_create', 'mcp_payload_create', 'mcp_payload_show', 'mcp_payload_derive', 'mcp_payload_validate', 'task_lifecycle_set_routing', 'task_lifecycle_test_mcp_tool', 'task_lifecycle_run_tests', 'task_lifecycle_recurring_create', 'task_lifecycle_recurring_list', 'task_lifecycle_recurring_show', 'task_lifecycle_recurring_suspend', 'task_lifecycle_recurring_retire', 'task_lifecycle_recurring_trigger', 'task_lifecycle_recurring_run_due', 'task_lifecycle_recurring_runs', 'task_lifecycle_chapter_add_task', 'task_lifecycle_chapter_show', 'task_lifecycle_submit_work', 'task_lifecycle_self_certification_preflight', 'task_lifecycle_restart', 'task_lifecycle_diagnose_task_ref'];
const WORKER_DELEGATION_TOOLS = ['worker_policy_inspect', 'worker_config_resolve', 'worker_run', 'worker_edit', 'worker_resume', 'worker_run_status', 'worker_run_reap', 'worker_runs_list', 'worker_run_wait', 'worker_run_batch', 'worker_run_wait_batch', 'worker_runs_synthesize', 'worker_dashboard_describe'];
const DELEGATED_TASK_TOOLS = ['delegated_task_policy_inspect', 'delegated_task_template_catalog', 'delegated_task_validate', 'delegated_task_run', 'delegated_task_status', 'delegated_task_summary', 'delegated_task_result', 'delegated_task_wait', 'delegated_task_advance', 'delegated_task_events', 'delegated_task_cancel', 'delegated_task_acknowledge', 'delegated_task_parent_takeover', 'delegated_tasks_list'];
const MCP_LOADER_TOOLS = ['mcp_loader_policy_inspect', 'mcp_loader_list_site_surfaces', 'mcp_loader_site_fabric_diagnostics', 'mcp_loader_attach_surface', 'mcp_loader_list_tools', 'mcp_loader_tool_discovery_manifest', 'mcp_loader_call_tool', 'mcp_loader_detach'];
const REGISTRAR_TOOLS = ['registrar_surface_list', 'registrar_site_list', 'registrar_site_surfaces', 'registrar_site_bind', 'registrar_site_unbind', 'registrar_carrier_list', 'registrar_carrier_bind', 'registrar_carrier_unbind', 'registrar_sync', 'registrar_carrier_materialize', 'registrar_carrier_apply', 'registrar_carrier_validate', 'registrar_carrier_diff', 'registrar_surface_usage', 'registrar_site_mcp_fabric_validate', 'registrar_surface_tool_inventory_check'];

const SURFACES: SurfaceDef[] = [
  {
    id: 'local-filesystem', package: 'local-filesystem-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/local-filesystem-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--mode', 'write', '--allowed-root', '{site_root}', '--anchored-allowed-root', 'user_home:.codex', '--output-root', '{site_root}'],
    tools: ['fs_read_file', 'fs_read_file_range', 'fs_stat', 'fs_glob_search', 'fs_grep_search', 'fs_write_file', 'fs_str_replace_file', 'fs_replace_range', 'fs_apply_patch', 'fs_move_path', 'fs_create_directory', 'fs_rename_directory', 'fs_delete_directory'],
  },
  {
    id: 'structured-command', package: 'structured-command-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/structured-command-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-root', '{site_root}', '--allow-command', 'node', '--allow-command', 'pnpm', '--allow-command', 'npm'],
    tools: ['structured_command_execution_policy_inspect', 'structured_command_execute', 'structured_command_elevated_window_execute', 'structured_command_input_create'],
  },
  {
    id: 'git', package: 'git-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/git-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-root', '{site_root}', '--mode', 'write'],
    tools: GIT_TOOLS,
  },
  {
    id: 'completion-audit', package: 'completion-audit-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/completion-audit-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--audit-root', '{site_root}'],
    tools: ['completion_audit_record'],
  },
  {
    id: 'site-inbox', package: 'site-inbox-mcp',
    entrypoint: '{site_root}/tools/typed-mcp/inbox-mcp-server.mjs',
    kind: 'site_tool',
    args: ['--site-root', '{site_root}'],
    tools: SITE_INBOX_TOOLS,
  },
  {
    id: 'mailbox', package: 'mailbox-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/mailbox-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['mailbox_doctor', 'mailbox_accounts_list', 'mailbox_messages_list', 'mailbox_message_show', 'mailbox_search', 'mailbox_thread_show'],
  },
  {
    id: 'graph-mail', package: 'graph-mail-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/graph-mail-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: GRAPH_MAIL_TOOLS,
  },
  {
    id: 'calendar', package: 'calendar-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/calendar-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['calendar_doctor', 'calendar_list', 'calendar_event_query', 'calendar_event_show', 'calendar_event_create', 'calendar_event_update', 'calendar_event_delete'],
  },
  {
    id: 'task-lifecycle', package: 'task-lifecycle-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/task-lifecycle-mcp/dist/src/task-lifecycle/task-mcp-server.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: TASK_LIFECYCLE_TOOLS,
  },
  {
    id: 'site-ops', package: 'site-ops-mcp',
    entrypoint: '{site_root}/tools/site-ops/site-ops-mcp-server.mjs',
    kind: 'site_tool',
    args: ['--site-root', '{site_root}'],
    tools: ['site_ops_doctor', 'site_docs_list', 'site_docs_show', 'site_test_list', 'site_test_run', 'site_loop_status', 'site_loop_unified_status', 'site_loop_recovery_plan', 'site_loop_health', 'site_loop_operating_status', 'site_loop_readiness', 'site_loop_coherence', 'site_loop_runs_list', 'site_loop_run_show', 'site_loop_attention_list', 'site_loop_attention_show', 'site_loop_attention_ack', 'site_loop_control_set', 'site_loop_run_once'],
  },
  {
    id: 'site-lifecycle', package: 'site-lifecycle-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/site-lifecycle-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--narada-root', 'D:/code/narada'],
    tools: ['site_lifecycle_doctor', 'site_lifecycle_command_map', 'site_create_presets_list', 'site_create_plan', 'site_list', 'site_discover', 'site_show', 'site_doctor', 'site_init', 'site_lifecycle_kinds', 'site_lifecycle_preflight', 'site_relation_list', 'site_relation_validate', 'site_authority_preflight', 'site_deps_sync'],
  },
  {
    id: 'agent-context', package: 'agent-context-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/agent-context-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['agent_context_doctor', 'agent_context_whoami', 'agent_context_start_session', 'agent_context_checkpoint', 'agent_context_rehydrate', 'agent_context_hydrate_current', 'agent_context_startup_sequence', 'agent_context_list_sessions'],
  },
  {
    id: 'worker-delegation', package: 'worker-delegation-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/worker-delegation-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}', '--allowed-root', '{site_root}', '--run-root', '{site_root}/.narada/runtime/worker-delegation'],
    tools: WORKER_DELEGATION_TOOLS,
    env_vars: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE_URL', 'NARADA_WORKER_MCP_CONFIG'],
  },
  {
    id: 'delegated-task', package: 'delegated-task-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/delegated-task-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--task-root', '{site_root}', '--allowed-root', '{site_root}'],
    tools: DELEGATED_TASK_TOOLS,
  },
  {
    id: 'sop', package: 'sop-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/sop-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--sop-root', '{site_root}', '--server-name', '{site_id}-sop'],
    tools: ['sop_doctor', 'sop_template_create', 'sop_template_show', 'sop_template_export', 'sop_template_list', 'sop_template_search', 'sop_template_update', 'sop_template_deprecate', 'sop_template_import_yaml', 'sop_run_start', 'sop_run_status', 'sop_run_refresh', 'sop_run_advance', 'sop_run_list', 'sop_run_cancel', 'sop_run_events'],
    sops_dir: `${MCP_SURFACES_ROOT}/sop-mcp/sops`,
  },
  {
    id: 'scheduler', package: 'scheduler-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/scheduler-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: [],
    tools: ['scheduler_task_list', 'scheduler_task_show', 'scheduler_task_create', 'scheduler_task_delete', 'scheduler_task_update_action', 'scheduler_task_enable', 'scheduler_task_disable', 'scheduler_task_run', 'scheduler_task_history'],
  },
  {
    id: 'mcp-loader', package: 'mcp-loader-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/mcp-loader-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-site-root', 'D:/code', '--allowed-entrypoint-prefix', `${MCP_SURFACES_ROOT}/`, '--allowed-entrypoint-prefix', '{site_root}/tools/'],
    tools: MCP_LOADER_TOOLS,
  },
  {
    id: 'mcp-registrar', package: 'mcp-registrar',
    entrypoint: `${MCP_SURFACES_ROOT}/mcp-registrar/dist/src/main.js`,
    kind: 'mcp_surface',
    args: [],
    tools: REGISTRAR_TOOLS,
    injection_scope: 'user_site',
    sops_dir: `${MCP_SURFACES_ROOT}/mcp-registrar/sops`,
  },
  {
    id: 'surface-feedback', package: 'surface-feedback-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/surface-feedback-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--feedback-root', 'D:/code/mcp-surfaces'],
    tools: ['surface_feedback_doctor', 'surface_feedback_submit', 'surface_feedback_update_status', 'surface_feedback_update_status_batch', 'surface_feedback_import', 'surface_feedback_list', 'surface_feedback_show', 'surface_feedback_stats'],
    injection_scope: 'user_site',
  },
  {
    id: 'launcher', package: 'launcher-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/launcher-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--narada-root', 'C:/Users/Andrey/Narada'],
    tools: ['launcher_doctor', 'launcher_options_list', 'launcher_registry_list', 'launcher_plan', 'launcher_option_matrix', 'launcher_coherence_check'],
    injection_scope: 'user_site',
  },
  {
    id: 'speech', package: 'speech-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/speech-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: [],
    tools: ['speech_speak', 'speech_voices', 'speech_capture_transcribe', 'speech_prompt_capture_response', 'speech_listen_status', 'speech_listen_start', 'speech_listen_stop'],
    injection_scope: 'host',
    default_injection: 'all_carrier_sessions',
    env_vars: ['OPENAI_API_KEY'],
  },
  {
    id: 'operator-routing', package: 'operator-routing-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/operator-routing-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', 'C:/Users/Andrey/Narada'],
    tools: ['operator_route_doctor', 'operator_route_request'],
    injection_scope: 'user_site',
    default_injection: 'all_site_bound_sessions',
  },
  {
    id: 'cloudflare-carrier', package: 'cloudflare-carrier-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/cloudflare-carrier-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--repo-root', 'D:/code/narada', '--session-file', 'D:/code/narada/.narada/auth/cloudflare-operator-session.json'],
    tools: ['cloudflare_product_read', 'cloudflare_session_status', 'cloudflare_health', 'cloudflare_doctor'],
  },
  {
    id: 'site-coherence', package: 'site-coherence-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/site-coherence-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--repo-root', 'D:/code/narada'],
    tools: ['site_coherence_check', 'site_coherence_doctor'],
  },
];

const KNOWN_SITES: SiteDef[] = [
  { site_id: 'narada-andrey', root: 'C:/Users/Andrey/Narada', config_path: 'C:/Users/Andrey/Narada/config.json', surfaces: [] },
  { site_id: 'narada-proper', root: 'D:/code/narada', config_path: 'D:/code/narada/config.json', surfaces: [] },
  { site_id: 'narada-sonar', root: 'D:/code/narada.sonar', config_path: 'D:/code/narada.sonar/.narada/config.json', surfaces: [] },
  { site_id: 'narada-revolution', root: 'D:/code/narada.revolution', config_path: 'D:/code/narada.revolution/config.json', surfaces: [] },
  { site_id: 'narada-staccato', root: 'D:/code/narada.staccato', config_path: 'D:/code/narada.staccato/config.json', surfaces: [] },
  { site_id: 'narada-cpy', root: 'D:/code/narada.cpy', config_path: 'D:/code/narada.cpy/config.json', surfaces: [] },
  { site_id: 'narada-utz', root: 'D:/code/narada.utz', config_path: 'D:/code/narada.utz/config.json', surfaces: [] },
  { site_id: 'narada-timour', root: 'D:/code/narada.timour-marketing-agent', config_path: 'D:/code/narada.timour-marketing-agent/config.json', surfaces: [] },
  { site_id: 'smart-scheduling', root: 'D:/code/smart-scheduling/.narada', config_path: 'D:/code/smart-scheduling/.narada/config.json', surfaces: [] },
];

const CARRIERS: CarrierDef[] = [
  {
    carrier_id: 'opencode-andrey', kind: 'opencode', config_path: 'C:/Users/Andrey/.config/opencode/opencode.jsonc', surfaces: [],
    site_bindings: [{
      site_id: 'narada-andrey',
      surfaces: [
        'agent-context',
        'task-lifecycle',
        'site-inbox',
        'mailbox',
        'graph-mail',
        'git',
        'local-filesystem',
        'structured-command',
        'worker-delegation',
        'delegated-task',
        'sop',
        'scheduler',
        'mcp-registrar',
        'surface-feedback',
        'launcher',
        'speech',
        'cloudflare-carrier',
        'site-coherence',
      ],
      prefix: 'narada-andrey',
      extra_allowed_roots: ['D:/code'],
    }],
    extra_allowed_roots: ['D:/code'],
    surface_overrides: {
      'surface-feedback': { args: ['--feedback-root', 'D:/code/mcp-surfaces'] },
    },
  },
  {
    carrier_id: 'opencode-sonar', kind: 'opencode', config_path: 'D:/code/narada.sonar/opencode.json', surfaces: [],
    site_bindings: [{
      site_id: 'narada-sonar',
      surfaces: [
        'agent-context',
        'task-lifecycle',
        'site-inbox',
        'site-ops',
        'mailbox',
        'graph-mail',
        'git',
        'local-filesystem',
        'structured-command',
        'worker-delegation',
        'sop',
        'scheduler',
        'surface-feedback',
        'launcher',
        'delegated-task',
        'speech',
        'mcp-loader',
      ],
      prefix: 'narada-sonar',
      extra_allowed_roots: ['D:/code'],
    }],
    extra_allowed_roots: ['D:/code'],
    surface_overrides: {
      'surface-feedback': { args: ['--feedback-root', 'D:/code/mcp-surfaces'] },
      'site-inbox': { entrypoint: 'D:/code/narada.sonar/tools/inbox/inbox-mcp-server.mjs' },
    },
  },
  {
    carrier_id: 'kimi-andrey', kind: 'kimi', config_path: 'C:/Users/Andrey/.kimi-code/mcp.json', surfaces: [],
    site_bindings: [{
      site_id: 'narada-andrey',
      surfaces: [
        'agent-context',
        'task-lifecycle',
        'site-inbox',
        'mailbox',
        'graph-mail',
        'git',
        'local-filesystem',
        'structured-command',
        'worker-delegation',
        'delegated-task',
        'sop',
        'scheduler',
        'mcp-registrar',
        'surface-feedback',
        'launcher',
        'speech',
        'cloudflare-carrier',
        'site-coherence',
        'mcp-loader',
      ],
      prefix: 'narada-andrey',
      extra_allowed_roots: ['D:/code'],
    }],
    extra_allowed_roots: ['D:/code'],
    surface_overrides: {
      'surface-feedback': { args: ['--feedback-root', 'D:/code/mcp-surfaces'] },
    },
  },
  {
    carrier_id: 'codex-andrey', kind: 'codex', config_path: 'C:/Users/Andrey/.codex/config.toml', surfaces: [],
    site_bindings: [{
      site_id: 'narada-andrey',
      surfaces: [
        'agent-context',
        'task-lifecycle',
        'site-inbox',
        'mailbox',
        'graph-mail',
        'git',
        'local-filesystem',
        'structured-command',
        'worker-delegation',
        'delegated-task',
        'sop',
        'scheduler',
        'mcp-registrar',
        'surface-feedback',
        'launcher',
        'speech',
        'cloudflare-carrier',
        'site-coherence',
        'mcp-loader',
      ],
      prefix: 'narada-andrey',
      extra_allowed_roots: ['D:/code'],
    }],
    extra_allowed_roots: ['D:/code'],
    surface_overrides: {
      'surface-feedback': { args: ['--feedback-root', 'D:/code/mcp-surfaces'] },
    },
  },
];

type RegistrarState = JsonRecord;

export function createServerState(_options: JsonRecord = {}): RegistrarState {
  return {};
}

function siteAggregateMcpFileName(siteId: string): string {
  return `${siteId}-mcp.json`;
}

function siteMcpFabricMode(site: SiteDef): SiteMcpFabricMode {
  const configDir = join(site.root, '.ai', 'mcp');
  if (!existsSync(configDir)) return 'empty';
  const files = readdirSync(configDir).filter((f: string) => f.endsWith('.json'));
  if (files.length === 0) return 'empty';
  if (files.includes(siteAggregateMcpFileName(site.site_id))) return 'aggregate';
  return 'sidecar';
}

export function siteBindSidecarRefusal(site: SiteDef, surfaceId: string, options: JsonRecord = {}): JsonRecord | null {
  if (site.surface_overrides?.[surfaceId]?.enabled === false && options.allow_disabled_sidecar !== true) {
    return {
      status: 'refused',
      reason_code: 'registrar_site_bind_refused_surface_disabled',
      site_id: site.site_id,
      surface_id: surfaceId,
      sidecar_state: 'disabled_by_site_override',
      reason: 'This Site explicitly disables the requested surface, so registrar_site_bind will not materialize a sidecar for it.',
      required_next_step: 'Enable the surface in the Site override or pass allow_disabled_sidecar=true only for an intentional compatibility sidecar.',
    };
  }
  const fabricMode = siteMcpFabricMode(site);
  if (fabricMode !== 'aggregate' || options.allow_sidecar === true) return null;
  return {
    status: 'refused',
    reason_code: 'registrar_site_bind_refused_aggregate_fabric_exists',
    site_id: site.site_id,
    surface_id: surfaceId,
    aggregate_file: siteAggregateMcpFileName(site.site_id),
    reason: 'This Site has an authoritative aggregate MCP fabric. registrar_site_bind would create a sidecar snippet, so it is refused unless allow_sidecar is explicitly true.',
    required_next_step: 'Update the aggregate MCP fabric through the Site materialization path, or pass allow_sidecar=true only for an intentional compatibility sidecar.',
  };
}

function naradaScopeMetadata(surfaceId: string, siteRoot = '{site_root}', boundIntoSite?: string): NaradaScopeMetadata {
  const metadata = surfaceScopeMetadata(surfaceId, siteRoot);
  return {
    ...metadata,
    ...(boundIntoSite ? { bound_into_site: boundIntoSite } : {}),
    scope_source: 'registrar_surface_catalog',
  };
}

function isInjectionScope(value: unknown): value is McpInjectionScope {
  return value === 'host' || value === 'user_site' || value === 'local_site';
}

function locusFromRecord(value: unknown): McpAuthorityLocus | null {
  const record = asRecord(value);
  if (record.kind === 'host') return { kind: 'host' };
  if (record.kind === 'user_site' && typeof record.site_root === 'string') return { kind: 'user_site', site_root: record.site_root };
  if (record.kind === 'local_site' && typeof record.site_root === 'string') return { kind: 'local_site', site_root: record.site_root };
  return null;
}

function naradaScopeFromRecord(record: JsonRecord, source: NaradaScopeMetadata['scope_source']): NaradaScopeMetadata | null {
  const injectionScope = isInjectionScope(record.injection_scope) ? record.injection_scope : null;
  const authorityLocus = locusFromRecord(record.authority_locus);
  const mutationLocus = locusFromRecord(record.mutation_locus);
  const restartOwner = isInjectionScope(record.restart_owner) ? record.restart_owner : null;
  if (!injectionScope || !authorityLocus || !mutationLocus || !restartOwner) return null;
  return {
    injection_scope: injectionScope,
    authority_locus: authorityLocus,
    mutation_locus: mutationLocus,
    restart_owner: restartOwner,
    ...(typeof record.bound_into_site === 'string' ? { bound_into_site: record.bound_into_site } : {}),
    scope_source: source,
  };
}

function readNaradaScope(serverRecord: JsonRecord, fallbackSurfaceId: string, fallbackSiteRoot: string, fallbackBoundSite?: string): NaradaScopeMetadata {
  const nested = naradaScopeFromRecord(asRecord(serverRecord.narada_scope), 'site_config_narada_scope');
  if (nested) return nested;
  const legacy = naradaScopeFromRecord(serverRecord, 'site_config_legacy_top_level');
  if (legacy) return legacy;
  return naradaScopeMetadata(fallbackSurfaceId, fallbackSiteRoot, fallbackBoundSite);
}

export async function handleRequest(request: JsonRecord, state: RegistrarState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:') ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer);
    sawFramedInput ||= drained.framed;
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

async function dispatchMethod(method: string, params: JsonRecord, state: RegistrarState) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return await callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    {
      name: 'registrar_surface_list',
      description: 'List all known MCP surfaces with their packages, tools, and entrypoints.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'registrar_surface_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_list',
      description: 'List all known Narada sites with their root paths.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'registrar_site_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_surfaces',
      description: 'Show which surfaces are bound to a site.',
      inputSchema: { type: 'object', properties: { site_id: { type: 'string' } }, required: ['site_id'], additionalProperties: false },
      annotations: { title: 'registrar_site_surfaces', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_bind',
      description: 'Bind a surface to a Narada site MCP config. Creates or updates the site config file.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site identifier, e.g. narada-sonar.' },
          surface_id: { type: 'string', description: 'Surface identifier, e.g. scheduler.' },
          allow_sidecar: { type: 'boolean', description: 'Allow creating a compatibility sidecar even when an authoritative aggregate MCP fabric exists.' },
          allow_disabled_sidecar: { type: 'boolean', description: 'Allow binding a surface explicitly disabled by site override; intended only for compatibility repair.' },
        },
        required: ['site_id', 'surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_site_bind', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_unbind',
      description: 'Remove a surface from a Narada site MCP config.',
      inputSchema: {
        type: 'object',
        properties: { site_id: { type: 'string' }, surface_id: { type: 'string' } },
        required: ['site_id', 'surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_site_unbind', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_list',
      description: 'List all known carriers with their config paths.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'registrar_carrier_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_bind',
      description: 'Bind a surface to a carrier config (opencode, Kimi, or Codex).',
      inputSchema: {
        type: 'object',
        properties: {
          carrier_id: { type: 'string', description: 'Carrier identifier, e.g. codex-andrey.' },
          surface_id: { type: 'string', description: 'Surface identifier, e.g. scheduler.' },
          site_id: { type: 'string', description: 'Site context for arg interpolation, e.g. narada-sonar. Defaults to narada-andrey.' },
        },
        required: ['carrier_id', 'surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_carrier_bind', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_unbind',
      description: 'Remove a surface from a carrier config.',
      inputSchema: {
        type: 'object',
        properties: { carrier_id: { type: 'string' }, surface_id: { type: 'string' } },
        required: ['carrier_id', 'surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_carrier_unbind', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_sync',
      description: 'Bind a surface to all sites/carriers, or bind all surfaces to carriers.',
      inputSchema: {
        type: 'object',
        properties: {
          surface_id: { type: 'string', description: 'Surface identifier. Required unless target is all_surfaces_to_carriers or all_surfaces_to_all_carriers.' },
          target: { type: 'string', enum: ['all_sites', 'all_carriers', 'all', 'all_surfaces_to_carriers', 'all_surfaces_to_all_carriers'], description: 'all_sites/all_carriers/all: bind one surface. all_surfaces_to_carriers: bind all surfaces to a specific carrier. all_surfaces_to_all_carriers: bind all surfaces to all carriers.' },
          carrier_id: { type: 'string', description: 'Required when target is all_surfaces_to_carriers.' },
          site_filter: { type: 'string', description: 'Optional prefix filter for site IDs, e.g. narada-.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_sync', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_materialize',
      description: 'Generate a carrier-native MCP config from the carrier manifest and site configs. Preview-only unless output_path is provided.',
      inputSchema: {
        type: 'object',
        properties: {
          carrier_id: { type: 'string', description: 'Carrier identifier, e.g. kimi-andrey.' },
          output_path: { type: 'string', description: 'Optional path to write the generated config for inspection.' },
        },
        required: ['carrier_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_carrier_materialize', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_apply',
      description: 'Generate and write a carrier-native MCP config to the carrier config_path, backing up the existing file first.',
      inputSchema: {
        type: 'object',
        properties: {
          carrier_id: { type: 'string', description: 'Carrier identifier, e.g. kimi-andrey.' },
        },
        required: ['carrier_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_carrier_apply', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_validate',
      description: 'Validate a carrier configuration without writing it: report missing entrypoints, duplicate server keys, missing required flags, and local/shared collisions.',
      inputSchema: {
        type: 'object',
        properties: {
          carrier_id: { type: 'string', description: 'Carrier identifier, e.g. kimi-andrey.' },
          include_ok: { type: 'boolean', description: 'Include passing checks in output.' },
        },
        required: ['carrier_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_carrier_validate', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_diff',
      description: 'Compare the generated carrier config against the current carrier config file and report additions, removals, and changes.',
      inputSchema: {
        type: 'object',
        properties: {
          carrier_id: { type: 'string', description: 'Carrier identifier, e.g. kimi-andrey.' },
        },
        required: ['carrier_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_carrier_diff', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_surface_usage',
      description: 'Report which sites and carriers include a given MCP surface (shared surface id or site-local surface id ending in .local).',
      inputSchema: {
        type: 'object',
        properties: {
          surface_id: { type: 'string', description: 'Surface identifier, e.g. site-inbox, local-filesystem, or inbox-mcp.local.' },
        },
        required: ['surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_surface_usage', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_mcp_fabric_validate',
      description: 'Validate a site-local MCP fabric (.ai/mcp/*.json): entrypoints exist, required flags present, duplicate server keys.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site identifier, e.g. narada-proper.' },
          include_ok: { type: 'boolean', description: 'Include passing checks in output.' },
        },
        required: ['site_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_site_mcp_fabric_validate', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_surface_tool_inventory_check',
      description: 'Compare registrar surface tool metadata with observed MCP tools/list names and report per-surface drift.',
      inputSchema: {
        type: 'object',
        properties: {
          observed_tools: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Map of surface id to observed tools/list names.' },
          include_ok: { type: 'boolean', description: 'Include passing surfaces in the output.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'registrar_surface_tool_inventory_check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function callTool(params: JsonRecord, _state: RegistrarState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'registrar_surface_list': result = registrarSurfaceList(args); break;
    case 'registrar_site_list': result = registrarSiteList(args); break;
    case 'registrar_site_surfaces': result = registrarSiteSurfaces(args); break;
    case 'registrar_site_bind': result = registrarSiteBind(args); break;
    case 'registrar_site_unbind': result = registrarSiteUnbind(args); break;
    case 'registrar_carrier_list': result = registrarCarrierList(args); break;
    case 'registrar_carrier_bind': result = registrarCarrierBind(args); break;
    case 'registrar_carrier_unbind': result = registrarCarrierUnbind(args); break;
    case 'registrar_sync': result = registrarSync(args); break;
    case 'registrar_carrier_materialize': result = registrarCarrierMaterialize(args); break;
    case 'registrar_carrier_apply': result = registrarCarrierApply(args); break;
    case 'registrar_carrier_validate': result = registrarCarrierValidate(args); break;
    case 'registrar_carrier_diff': result = registrarCarrierDiff(args); break;
    case 'registrar_surface_usage': result = registrarSurfaceUsage(args); break;
    case 'registrar_site_mcp_fabric_validate': result = registrarSiteMcpFabricValidate(args); break;
    case 'registrar_surface_tool_inventory_check': result = registrarSurfaceToolInventoryCheck(args); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

function lookupSurface(surfaceId: string): SurfaceDef {
  const surface = SURFACES.find((s) => s.id === surfaceId);
  if (!surface) throw diagnosticError('registrar_unknown_surface', `registrar_unknown_surface:${surfaceId}`, { known: SURFACES.map((s) => s.id) });
  return surface;
}

function lookupSite(siteId: string): SiteDef {
  const site = KNOWN_SITES.find((s) => s.site_id === siteId);
  if (!site) throw diagnosticError('registrar_unknown_site', `registrar_unknown_site:${siteId}`, { known: KNOWN_SITES.map((s) => s.site_id) });
  return site;
}

function lookupCarrier(carrierId: string): CarrierDef {
  const carrier = CARRIERS.find((c) => c.carrier_id === carrierId);
  if (!carrier) throw diagnosticError('registrar_unknown_carrier', `registrar_unknown_carrier:${carrierId}`, { known: CARRIERS.map((c) => c.carrier_id) });
  return carrier;
}

function interpolateArgs(args: string[], siteId: string, siteRoot: string): string[] {
  return args.map((a) => interpolateArg(a, siteId, siteRoot));
}

function interpolateArg(value: string, siteId: string, siteRoot: string): string {
  return value.replace(/\{site_root\}/g, siteRoot).replace(/\{site_id\}/g, siteId);
}

function appendSopsDirs(args: string[]): string[] {
  for (const def of SURFACES) {
    if (def.sops_dir) {
      args.push('--sops-dir', def.sops_dir);
    }
  }
  return args;
}

function stripJsoncComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .replace(/^\s*\/\/.*$/gm, '');
}

function readSiteConfig(site: SiteDef): SiteLocalSurface[] {
  const configPath = site.config_path || join(site.root, 'config.json');
  if (!existsSync(configPath)) return [];
  try {
    const content = stripJsoncComments(readFileSync(configPath, 'utf8'));
    const cfg = asRecord(JSON.parse(content));
    const structural = asRecord(cfg.structural_config);
    const policy = asRecord(structural.agent_execution_policy);
    const entrypoints = policy.allowed_mcp_entrypoints as unknown[] | undefined;
    if (!Array.isArray(entrypoints)) return [];
    const surfaces: SiteLocalSurface[] = [];
    for (const ep of entrypoints) {
      const rec = asRecord(ep);
      const surfaceId = String(rec.surface_id ?? '');
      if (!surfaceId) continue;
      if (site.local_surface_allowlist && !site.local_surface_allowlist.includes(surfaceId)) continue;
      surfaces.push({
        surface_id: surfaceId,
        kind: 'mcp_entrypoint',
        command: String(rec.command ?? 'node'),
        path: String(rec.path ?? ''),
        canonical_tool_prefix: rec.canonical_tool_prefix ? String(rec.canonical_tool_prefix) : undefined,
        replaces: rec.replaces ? String(rec.replaces) : undefined,
      });
    }
    return surfaces;
  } catch {
    return [];
  }
}

function resolveEntrypoint(surface: SurfaceDef, siteId: string, siteRoot: string): string {
  const interpolated = interpolateArg(surface.entrypoint, siteId, siteRoot);
  return resolve(interpolated);
}

function catalogSurface(surfaceId: string): SurfaceDef | undefined {
  return SURFACES.find((surface) => surface.id === surfaceId);
}

function injectionScopeForSurface(surfaceId: string): McpInjectionScope {
  return catalogSurface(surfaceId)?.injection_scope ?? 'local_site';
}

function restartOwnerForSurface(surfaceId: string, injectionScope: McpInjectionScope): McpRestartOwner {
  return catalogSurface(surfaceId)?.restart_owner ?? injectionScope;
}

function locusForScope(scope: McpInjectionScope, siteRoot: string): McpAuthorityLocus {
  if (scope === 'host') return { kind: 'host' };
  if (scope === 'user_site') return { kind: 'user_site', site_root: USER_NARADA_ROOT };
  return { kind: 'local_site', site_root: siteRoot };
}

function surfaceScopeMetadata(surfaceId: string, siteRoot = '{site_root}'): SurfaceScopeMetadata {
  const injectionScope = injectionScopeForSurface(surfaceId);
  const locus = locusForScope(injectionScope, siteRoot);
  return {
    injection_scope: injectionScope,
    authority_locus: locus,
    mutation_locus: locus,
    restart_owner: restartOwnerForSurface(surfaceId, injectionScope),
  };
}

function scopeDiagnosticClass(scope: McpInjectionScope): string {
  if (scope === 'host') return 'host_injected_surface_missing_or_misconfigured_in_session';
  if (scope === 'user_site') return 'user_site_injected_surface_missing_or_misconfigured_in_session';
  return 'local_site_surface_missing_or_misconfigured';
}

function validationScopeDetail(surfaceId: string, siteRoot: string): JsonRecord {
  const metadata = surfaceScopeMetadata(surfaceId, siteRoot);
  const naradaScope = naradaScopeMetadata(surfaceId, siteRoot);
  return {
    ...metadata,
    narada_scope: naradaScope,
    diagnostic_class: scopeDiagnosticClass(metadata.injection_scope),
    required_repair_locus: metadata.mutation_locus,
  };
}

function scopeFindingDetail(naradaScope: NaradaScopeMetadata): JsonRecord {
  return {
    ...naradaScope,
    narada_scope: naradaScope,
    diagnostic_class: scopeDiagnosticClass(naradaScope.injection_scope),
    required_repair_locus: naradaScope.mutation_locus,
  };
}

function resolveLocalEntrypoint(local: SiteLocalSurface, siteRoot: string): string {
  const normalized = local.path.replace(/\\/g, '/');
  return resolve(siteRoot, normalized);
}

function rootsNeedingAllowedRoot(surfaceId: string): boolean {
  return ['local-filesystem', 'git', 'structured-command', 'delegated-task', 'worker-delegation'].includes(surfaceId);
}

function resolveSurfaceArgs(surface: SurfaceDef, siteId: string, siteRoot: string, extraRoots: string[]): string[] {
  const args = interpolateArgs(surface.args, siteId, siteRoot);
  if (extraRoots.length === 0 || !rootsNeedingAllowedRoot(surface.id)) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    out.push(args[i]);
    if (args[i] === '--allowed-root' && i + 1 < args.length) {
      out.push(args[++i]);
      for (const r of extraRoots) {
        if (!out.includes(r)) {
          out.push('--allowed-root', r);
        }
      }
    }
  }
  return out;
}

function dedupeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of roots) {
    const normalized = r.replace(/\\/g, '/');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function writeSiteAllowedRootsConfig(carrier: CarrierDef): void {
  for (const binding of carrier.site_bindings) {
    const site = lookupSite(binding.site_id);
    const siteRoot = site.root.replace(/\\/g, '/');
    const extraRoots = dedupeRoots([
      ...(carrier.extra_allowed_roots ?? []),
      ...(binding.extra_allowed_roots ?? []),
    ]).filter((r) => r !== siteRoot);

    if (extraRoots.length === 0) continue;

    const naradaDir = join(site.root, '.narada');
    try { mkdirSync(naradaDir, { recursive: true }); } catch { /* existing */ }
    const config = {
      schema: 'narada.site.allowed_roots.v1',
      generated_by: 'mcp-registrar',
      generated_at: new Date().toISOString(),
      site_id: binding.site_id,
      extra_allowed_roots: extraRoots,
    };
    writeFileSync(join(naradaDir, 'allowed-roots.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
}

function materializeSharedSurface(binding: SiteBinding, site: SiteDef, surfaceId: string, extraRoots: string[]): { key: string; server: MaterializedServer } {
  const surface = lookupSurface(surfaceId);
  const resolvedArgs = resolveSurfaceArgs(surface, site.site_id, site.root, extraRoots);
  const resolvedEntrypoint = resolveEntrypoint(surface, site.site_id, site.root);
  if (surfaceId === 'sop') appendSopsDirs(resolvedArgs);
  const serverKey = `${binding.prefix}-${surfaceId}`;
  const naradaScope = naradaScopeMetadata(surfaceId, site.root, site.site_id);
  return {
    key: serverKey,
    server: {
      kind: 'shared',
      entrypoint: resolvedEntrypoint,
      args: resolvedArgs,
      surface,
      ...naradaScope,
      narada_scope: naradaScope,
    },
  };
}

function localSurfaceKey(binding: SiteBinding, local: SiteLocalSurface): string {
  const stripped = local.surface_id.replace(/\.local$/, '');
  if (stripped.endsWith('-mcp')) {
    return `${binding.prefix}-${stripped.replace(/-mcp$/, '')}`;
  }
  return `${binding.prefix}-${stripped}`;
}

function materializeLocalSurface(binding: SiteBinding, site: SiteDef, local: SiteLocalSurface, extraRoots: string[]): { key: string; server: MaterializedServer } {
  const serverKey = localSurfaceKey(binding, local);
  const entrypoint = resolveLocalEntrypoint(local, site.root);
  const args = ['--site-root', site.root];
  const siteRootIncluded = extraRoots.length > 0;
  if (local.surface_id === 'local-filesystem-mcp.local' && siteRootIncluded) {
    const allRoots = dedupeRoots([site.root, ...extraRoots]);
    for (const r of allRoots) {
      if (!args.includes(r)) {
        args.push('--allowed-root', r);
      }
    }
    args.push('--output-root', site.root);
  }
  const naradaScope = naradaScopeMetadata(local.surface_id, site.root, site.site_id);
  return {
    key: serverKey,
    server: {
      kind: 'local',
      entrypoint,
      command: local.command,
      args,
      local,
      ...naradaScope,
      narada_scope: naradaScope,
    },
  };
}

export function sharedSurfaceIdsForBinding(binding: SiteBinding): string[] {
  const explicit = binding.surfaces === 'all' ? SURFACES.map((surface) => surface.id) : binding.surfaces.filter((surfaceId) => !surfaceId.endsWith('.local'));
  const ids = new Set(explicit);
  for (const surface of SURFACES) {
    if (surface.default_injection === 'all_site_bound_sessions' || surface.default_injection === 'all_carrier_sessions') ids.add(surface.id);
  }
  return Array.from(ids);
}

function collectCarrierServers(carrier: CarrierDef): Record<string, MaterializedServer> {
  const servers: Record<string, MaterializedServer> = {};
  for (const binding of carrier.site_bindings) {
    const site = lookupSite(binding.site_id);
    const extraRoots = dedupeRoots([site.root, ...(carrier.extra_allowed_roots ?? []), ...(binding.extra_allowed_roots ?? [])]);
    const sharedSurfaceIds = sharedSurfaceIdsForBinding(binding);
    for (const surfaceId of sharedSurfaceIds) {
      const { key, server } = materializeSharedSurface(binding, site, surfaceId, extraRoots);
      if (servers[key]) {
        console.warn(`mcp-registrar: duplicate server key '${key}' from shared surface '${surfaceId}' overwrites previous`);
      }
      servers[key] = server;
    }
    if (binding.surfaces === 'all' || binding.surfaces.some((s) => s.endsWith('.local'))) {
      for (const local of readSiteConfig(site)) {
        if (binding.surfaces !== 'all' && !binding.surfaces.includes(local.surface_id)) continue;
        const { key, server } = materializeLocalSurface(binding, site, local, extraRoots);
        if (servers[key]) {
          console.warn(`mcp-registrar: duplicate server key '${key}' from local surface '${local.surface_id}' overwrites shared/local predecessor`);
        }
        servers[key] = server;
      }
    }
  }
  return servers;
}

function carrierServerKeysForSurface(carrier: CarrierDef, surfaceId: string): string[] {
  return Object.entries(collectCarrierServers(carrier))
    .filter(([, server]) => {
      const serverSurfaceId = server.kind === 'local' ? (server.local as SiteLocalSurface).surface_id : (server.surface as SurfaceDef).id;
      return serverSurfaceId === surfaceId;
    })
    .map(([key]) => key);
}

function carrierInjectionSummary(carrier: CarrierDef): JsonRecord {
  const counts: Record<McpInjectionScope, number> = { host: 0, user_site: 0, local_site: 0 };
  const servers = Object.entries(collectCarrierServers(carrier)).map(([serverKey, server]) => {
    const surfaceId = server.kind === 'local' ? (server.local as SiteLocalSurface).surface_id : (server.surface as SurfaceDef).id;
    counts[server.injection_scope]++;
    return {
      server_key: serverKey,
      surface_id: surfaceId,
      injection_scope: server.injection_scope,
      authority_locus: server.authority_locus,
      restart_owner: server.restart_owner,
      narada_scope: server.narada_scope,
    };
  });
  return { counts, servers };
}

function applySurfaceOverrides(carrier: CarrierDef, server: MaterializedServer, surfaceId: string): MaterializedServer {
  const overrides = carrier.surface_overrides?.[surfaceId];
  if (!overrides) return server;
  return {
    ...server,
    entrypoint: overrides.entrypoint ?? server.entrypoint,
    args: overrides.args ?? server.args,
    env_vars: overrides.env_vars ?? server.env_vars,
    enabled: overrides.enabled ?? server.enabled,
  };
}

function emitOpencodeConfig(carrier: CarrierDef): { content: string; structured: JsonRecord } {
  const rawServers = collectCarrierServers(carrier);
  const mcp: JsonRecord = {};
  for (const [key, server] of Object.entries(rawServers)) {
    const surfaceId = server.kind === 'local' ? (server.local as SiteLocalSurface).surface_id : (server.surface as SurfaceDef).id;
    const overridden = applySurfaceOverrides(carrier, server, surfaceId);
    if (overridden.kind === 'local') {
      mcp[key] = {
        type: 'local',
        command: [overridden.command, overridden.entrypoint, ...overridden.args],
        enabled: overridden.enabled ?? true,
      };
    } else {
      mcp[key] = {
        type: 'local',
        command: ['node', overridden.entrypoint, ...overridden.args],
        enabled: overridden.enabled ?? true,
      };
    }
  }
  const structured = { $schema: 'https://opencode.ai/config.json', mcp };
  const header = '// Generated by mcp-registrar. Do not hand-edit; changes will be overwritten on next materialize.\n';
  return { content: header + JSON.stringify(structured, null, 2) + '\n', structured };
}

function emitKimiConfig(carrier: CarrierDef): { content: string; structured: JsonRecord } {
  const rawServers = collectCarrierServers(carrier);
  const mcpServers: JsonRecord = {};
  for (const [key, server] of Object.entries(rawServers)) {
    const surfaceId = server.kind === 'local' ? (server.local as SiteLocalSurface).surface_id : (server.surface as SurfaceDef).id;
    const overridden = applySurfaceOverrides(carrier, server, surfaceId);
    const approval = carrier.surface_overrides?.[surfaceId]?.approval_mode;
    const base: JsonRecord = {
      transport: 'stdio',
      command: overridden.kind === 'local' ? overridden.command : 'node',
      args: overridden.kind === 'local' ? [overridden.entrypoint, ...overridden.args] : [overridden.entrypoint, ...overridden.args],
    };
    if (approval) base.approval_mode = approval;
    if (overridden.env_vars) base.env_vars = overridden.env_vars;
    mcpServers[key] = base;
  }
  const structured = { mcpServers };
  return { content: JSON.stringify(structured, null, 2) + '\n', structured };
}

function emitCodexConfig(carrier: CarrierDef): { content: string; structured: JsonRecord } {
  const rawServers = collectCarrierServers(carrier);
  const lines: string[] = [];
  lines.push('# Generated by mcp-registrar. Do not hand-edit; changes will be overwritten on next materialize.');
  lines.push('');
  const trustProjects = dedupeRoots([...(carrier.trust_projects ?? []), ...(carrier.extra_allowed_roots ?? [])]);
  for (const project of trustProjects) {
    const escaped = project.replace(/\\/g, '\\\\');
    lines.push(`[projects.'${escaped}']`);
    lines.push('trust_level = "trusted"');
    lines.push('');
  }
  const mcpServers: JsonRecord = {};
  for (const [key, server] of Object.entries(rawServers)) {
    const surfaceId = server.kind === 'local' ? (server.local as SiteLocalSurface).surface_id : (server.surface as SurfaceDef).id;
    const overridden = applySurfaceOverrides(carrier, server, surfaceId);
    const args = overridden.kind === 'local' ? [overridden.entrypoint, ...overridden.args] : [overridden.entrypoint, ...overridden.args];
    lines.push(`[mcp_servers.${key}]`);
    lines.push(`command = "${overridden.kind === 'local' ? overridden.command : 'node'}"`);
    lines.push(`args = ${JSON.stringify(args)}`);
    if (carrier.surface_overrides?.[surfaceId]?.approval_mode) {
      lines.push(`approval_mode = "${carrier.surface_overrides[surfaceId].approval_mode}"`);
    }
    if (overridden.env_vars) {
      lines.push(`env_vars = ${JSON.stringify(overridden.env_vars)}`);
    }
    lines.push('');
    mcpServers[key] = { command: overridden.kind === 'local' ? overridden.command : 'node', args };
  }
  const structured = { trust_projects: trustProjects, mcpServers };
  return { content: lines.join('\n') + '\n', structured };
}

function registrarCarrierMaterialize(args: JsonRecord): JsonRecord {
  const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id');
  const carrier = lookupCarrier(carrierId);
  const injectionSummary = carrierInjectionSummary(carrier);
  let result: { content: string; structured: JsonRecord };
  switch (carrier.kind) {
    case 'opencode': result = emitOpencodeConfig(carrier); break;
    case 'kimi': result = emitKimiConfig(carrier); break;
    case 'codex': result = emitCodexConfig(carrier); break;
    default: throw diagnosticError('registrar_unknown_carrier_kind', `registrar_unknown_carrier_kind:${carrier.kind}`);
  }
  const outputPath = optionalString(args.output_path);
  if (outputPath) {
    const dir = resolve(outputPath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, result.content, 'utf8');
  }
  return { status: 'materialized', carrier_id: carrierId, kind: carrier.kind, output_path: outputPath, byte_size: Buffer.byteLength(result.content, 'utf8'), injection_scopes: injectionSummary };
}

function registrarCarrierApply(args: JsonRecord): JsonRecord {
  const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id');
  const carrier = lookupCarrier(carrierId);
  const injectionSummary = carrierInjectionSummary(carrier);
  let result: { content: string; structured: JsonRecord };
  switch (carrier.kind) {
    case 'opencode': result = emitOpencodeConfig(carrier); break;
    case 'kimi': result = emitKimiConfig(carrier); break;
    case 'codex': result = emitCodexConfig(carrier); break;
    default: throw diagnosticError('registrar_unknown_carrier_kind', `registrar_unknown_carrier_kind:${carrier.kind}`);
  }
  const configPath = carrier.config_path;
  if (existsSync(configPath)) {
    const backupPath = `${configPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    writeFileSync(backupPath, readFileSync(configPath, 'utf8'), 'utf8');
  }
  const dir = resolve(configPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, result.content, 'utf8');
  return { status: 'applied', carrier_id: carrierId, kind: carrier.kind, config_path: configPath, byte_size: Buffer.byteLength(result.content, 'utf8'), injection_scope_counts: injectionSummary.counts };
}

function registrarCarrierValidate(args: JsonRecord): JsonRecord {
  const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id');
  const carrier = lookupCarrier(carrierId);
  const includeOk = args.include_ok === true;
  const findings: ValidationFinding[] = [];

  function add(severity: ValidationFinding['severity'], code: string, message: string, detail: JsonRecord = {}) {
    findings.push({ severity, code, message, ...detail });
  }

  // Duplicate key detection
  const seenKeys = new Map<string, string>();
  const rawServers = collectCarrierServers(carrier);
  for (const [key, server] of Object.entries(rawServers)) {
    const surfaceId = server.kind === 'local' ? (server.local as SiteLocalSurface).surface_id : (server.surface as SurfaceDef).id;
    const scopeDetail = scopeFindingDetail(server.narada_scope);
    if (seenKeys.has(key)) {
      add('error', 'registrar_duplicate_server_key', `Server key '${key}' is produced by both '${seenKeys.get(key)}' and '${surfaceId}'`, { server_key: key, surface_id: surfaceId, ...scopeDetail });
    } else {
      seenKeys.set(key, surfaceId);
      if (includeOk) add('info', 'registrar_server_key_ok', `Server key '${key}' resolved for surface '${surfaceId}'`, { server_key: key, surface_id: surfaceId, ...scopeDetail });
    }
  }

  // Entrypoint existence and required flags
  for (const [key, server] of Object.entries(rawServers)) {
    const surfaceId = server.kind === 'local' ? (server.local as SiteLocalSurface).surface_id : (server.surface as SurfaceDef).id;
    const overridden = applySurfaceOverrides(carrier, server, surfaceId);
    const scopeDetail = scopeFindingDetail(server.narada_scope);
    if (!existsSync(overridden.entrypoint)) {
      add('error', 'registrar_missing_entrypoint', `Entrypoint for '${key}' does not exist: ${overridden.entrypoint}`, { server_key: key, surface_id: surfaceId, entrypoint: overridden.entrypoint, ...scopeDetail });
    } else if (includeOk) {
      add('info', 'registrar_entrypoint_exists', `Entrypoint for '${key}' exists: ${overridden.entrypoint}`, { server_key: key, surface_id: surfaceId, entrypoint: overridden.entrypoint, ...scopeDetail });
    }

    // Allowed-root requirement
    if (rootsNeedingAllowedRoot(surfaceId)) {
      const allowedRoots: string[] = [];
      for (let i = 0; i < overridden.args.length; i++) {
        if (overridden.args[i] === '--allowed-root' && i + 1 < overridden.args.length) {
          allowedRoots.push(overridden.args[i + 1]);
        }
      }
      if (allowedRoots.length === 0) {
        add('error', 'registrar_missing_allowed_root', `Surface '${surfaceId}' requires at least one --allowed-root but '${key}' has none`, { server_key: key, surface_id: surfaceId, ...scopeDetail });
      } else if (includeOk) {
        add('info', 'registrar_allowed_root_ok', `Surface '${surfaceId}' on '${key}' has ${allowedRoots.length} allowed root(s)`, { server_key: key, surface_id: surfaceId, allowed_roots: allowedRoots, ...scopeDetail });
      }
    }

    // Output-root requirement for local-filesystem
    if (surfaceId === 'local-filesystem' || surfaceId === 'local-filesystem-mcp.local') {
      const hasOutputRoot = overridden.args.some((a) => a === '--output-root');
      if (!hasOutputRoot) {
        add('warning', 'registrar_missing_output_root', `Filesystem surface '${key}' is missing --output-root`, { server_key: key, surface_id: surfaceId, ...scopeDetail });
      } else if (includeOk) {
        add('info', 'registrar_output_root_ok', `Filesystem surface '${key}' has --output-root`, { server_key: key, surface_id: surfaceId, ...scopeDetail });
      }
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return {
    status: errors > 0 ? 'invalid' : warnings > 0 ? 'valid_with_warnings' : 'valid',
    carrier_id: carrierId,
    server_count: Object.keys(rawServers).length,
    errors,
    warnings,
    findings,
  };
}

function registrarSiteMcpFabricValidate(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const site = lookupSite(siteId);
  return validateSiteMcpFabric(site, args.include_ok === true);
}

function registrarCarrierDiff(args: JsonRecord): JsonRecord {
  const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id');
  const carrier = lookupCarrier(carrierId);
  let generated: { content: string; structured: JsonRecord };
  switch (carrier.kind) {
    case 'opencode': generated = emitOpencodeConfig(carrier); break;
    case 'kimi': generated = emitKimiConfig(carrier); break;
    case 'codex': generated = emitCodexConfig(carrier); break;
    default: throw diagnosticError('registrar_unknown_carrier_kind', `registrar_unknown_carrier_kind:${carrier.kind}`);
  }

  const currentPath = carrier.config_path;
  const currentContent = existsSync(currentPath) ? readFileSync(currentPath, 'utf8') : null;
  const currentStructured = currentContent ? parseCarrierConfig(carrier.kind, currentContent) : null;

  const generatedServers = asRecord(generated.structured.mcpServers ?? generated.structured.mcp ?? {});
  const currentServers = currentStructured ? asRecord(currentStructured.mcpServers ?? currentStructured.mcp ?? {}) : {};

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const key of Object.keys(generatedServers)) {
    if (!(key in currentServers)) {
      added.push(key);
    } else if (JSON.stringify(generatedServers[key]) !== JSON.stringify(currentServers[key])) {
      changed.push(key);
    } else {
      unchanged.push(key);
    }
  }
  for (const key of Object.keys(currentServers)) {
    if (!(key in generatedServers)) removed.push(key);
  }

  return {
    status: 'diff',
    carrier_id: carrierId,
    config_path: currentPath,
    current_exists: currentContent !== null,
    added,
    removed,
    changed,
    unchanged,
    added_count: added.length,
    removed_count: removed.length,
    changed_count: changed.length,
  };
}

function parseCarrierConfig(kind: CarrierDef['kind'], content: string): JsonRecord | null {
  try {
    switch (kind) {
      case 'opencode':
      case 'kimi':
        return asRecord(JSON.parse(stripJsoncComments(content)));
      case 'codex':
        return parseCodexToml(content);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function parseCodexToml(content: string): JsonRecord {
  const result: JsonRecord = { mcpServers: {} };
  const lines = content.split(/\r?\n/);
  let currentKey: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#') || line.length === 0) continue;
    const sectionMatch = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionPath = sectionMatch[1];
      if (sectionPath.includes('.tools.')) {
        currentKey = null;
        continue;
      }
      currentKey = sectionPath;
      (result.mcpServers as JsonRecord)[currentKey] = {};
      continue;
    }
    if (currentKey) {
      const kvMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const [, k, rawV] = kvMatch;
        try {
          (result.mcpServers as JsonRecord)[currentKey][k] = JSON.parse(rawV);
        } catch {
          (result.mcpServers as JsonRecord)[currentKey][k] = rawV.replace(/^"|"$/g, '');
        }
      }
    }
  }
  return result;
}

function registrarSurfaceList(_args: JsonRecord): JsonRecord {
  return {
    items: SURFACES.map((surface) => ({
      ...surface,
      ...surfaceScopeMetadata(surface.id),
      narada_scope: naradaScopeMetadata(surface.id),
    })),
    count: SURFACES.length,
  };
}

function registrarSurfaceToolInventoryCheck(args: JsonRecord): JsonRecord {
  const observedInput = asRecord(args.observed_tools);
  const includeOk = args.include_ok === true;
  const surfaces = SURFACES.filter((surface) => Object.hasOwn(observedInput, surface.id));
  const findings = surfaces.flatMap((surface) => {
    const registered = uniqueStrings(surface.tools);
    const observed = uniqueStrings(Array.isArray(observedInput[surface.id]) ? (observedInput[surface.id] as unknown[]).map(String) : []);
    const missing_from_registrar = observed.filter((tool) => !registered.includes(tool));
    const extra_in_registrar = registered.filter((tool) => !observed.includes(tool));
    const status = missing_from_registrar.length === 0 && extra_in_registrar.length === 0 ? 'ok' : 'drift';
    if (status === 'ok' && !includeOk) return [];
    return [{
      surface_id: surface.id,
      package: surface.package,
      status,
      registered_count: registered.length,
      observed_count: observed.length,
      missing_from_registrar,
      extra_in_registrar,
    }];
  });
  return {
    schema: 'narada.registrar.surface_tool_inventory_check.v1',
    status: findings.some((finding) => finding.status === 'drift') ? 'drift' : 'ok',
    checked_count: surfaces.length,
    surfaces_without_observations: SURFACES.map((surface) => surface.id).filter((surfaceId) => !Object.hasOwn(observedInput, surfaceId)),
    findings,
  };
}

function registrarSiteList(_args: JsonRecord): JsonRecord {
  return { items: KNOWN_SITES, count: KNOWN_SITES.length };
}

function registrarSiteSurfaces(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const site = lookupSite(siteId);
  const configDir = join(site.root, '.ai', 'mcp');
  if (!existsSync(configDir)) return { site_id: siteId, surfaces: [], count: 0 };
  const files = readdirSync(configDir).filter((f: string) => f.endsWith('.json'));
  const allFound: string[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(configDir, file), 'utf8');
      const cfg = JSON.parse(content);
      const servers = asRecord(cfg.mcpServers);
      for (const surfaceId of SURFACES.map((s) => s.id)) {
        const canonicalKey = siteSurfaceServerKey(siteId, surfaceId);
        const legacyKey = legacySiteSurfaceServerKey(siteId, surfaceId);
        if ((servers[canonicalKey] || servers[legacyKey]) && !allFound.includes(surfaceId)) allFound.push(surfaceId);
      }
    } catch { /* skip */ }
  }
  return { site_id: siteId, surfaces: allFound, count: allFound.length };
}

export function siteSurfaceServerKey(siteId: string, surfaceId: string): string {
  return `${siteId}-${surfaceId}`;
}

function legacySiteSurfaceServerKey(siteId: string, surfaceId: string): string {
  return `${siteId.replace('narada-', '')}-${surfaceId}`;
}

export function buildSiteBindConfig(site: SiteDef, surface: SurfaceDef): { fileName: string; serverKey: string; config: JsonRecord } {
  const siteId = site.site_id;
  const surfaceId = surface.id;
  const serverKey = siteSurfaceServerKey(siteId, surfaceId);
  const fileName = `${siteId}-${surfaceId}-mcp.json`;
  const resolvedArgs = interpolateArgs(surface.args, siteId, site.root);
  const scopeMetadata = surfaceScopeMetadata(surfaceId, site.root);
  const naradaScope = naradaScopeMetadata(surfaceId, site.root, siteId);
  if (surfaceId === 'sop') appendSopsDirs(resolvedArgs);

  return {
    fileName,
    serverKey,
    config: {
      schema: 'narada.mcp.client_config.v0',
      site_id: siteId,
      description: `${surface.package} MCP surface bound by registrar.`,
      mcpServers: {
        [serverKey]: {
          transport: 'stdio',
          command: 'node',
          args: [surface.entrypoint, ...resolvedArgs],
          tools: surface.tools,
          env_vars: ['NARADA_AGENT_ID', 'NARADA_AGENT_START_EVENT_ID', 'NARADA_CARRIER_SESSION_ID', 'NARADA_SITE_ROOT', ...(surface.env_vars ?? [])],
          surface_id: `${surfaceId}-mcp.${siteId}`,
          authority_posture: scopeMetadata.injection_scope === 'local_site' ? 'site_local_mcp_surface' : `${scopeMetadata.injection_scope}_injected_mcp_surface`,
          ...scopeMetadata,
          bound_into_site: siteId,
          narada_scope: naradaScope,
        },
      },
    },
  };
}

function registrarSiteBind(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const site = lookupSite(siteId);
  const surface = lookupSurface(surfaceId);
  const configDir = join(site.root, '.ai', 'mcp');
  const sidecarRefusal = siteBindSidecarRefusal(site, surfaceId, args);
  if (sidecarRefusal) return sidecarRefusal;
  mkdirSync(configDir, { recursive: true });
  const { fileName, serverKey, config } = buildSiteBindConfig(site, surface);
  const filePath = join(configDir, fileName);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { status: 'bound', site_id: siteId, surface_id: surfaceId, file: fileName, server_key: serverKey };
}

function registrarSiteUnbind(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const site = lookupSite(siteId);
  const configDir = join(site.root, '.ai', 'mcp');
  if (!existsSync(configDir)) return { status: 'not_found', site_id: siteId, surface_id: surfaceId };
  const files = readdirSync(configDir).filter((f: string) => f.endsWith('.json'));
  const serverKey = siteSurfaceServerKey(siteId, surfaceId);
  const legacyServerKey = legacySiteSurfaceServerKey(siteId, surfaceId);
  let removed = 0;
  for (const file of files) {
    try {
      const content = readFileSync(join(configDir, file), 'utf8');
      const cfg = JSON.parse(content);
      const servers = asRecord(cfg.mcpServers);
      if (servers[serverKey] || servers[legacyServerKey]) {
        unlinkSync(join(configDir, file));
        removed++;
        return { status: 'unbound', site_id: siteId, surface_id: surfaceId, file };
      }
    } catch { /* skip */ }
  }
  return { status: 'not_bound', site_id: siteId, surface_id: surfaceId };
}

function registrarCarrierList(_args: JsonRecord): JsonRecord {
  return { items: CARRIERS, count: CARRIERS.length };
}

function registrarSurfaceUsage(args: JsonRecord): JsonRecord {
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const isLocal = surfaceId.endsWith('.local');
  const matchingSites: { site_id: string; via: 'shared' | 'local' }[] = [];
  const matchingCarriers: { carrier_id: string; kind: CarrierDef['kind']; via: 'shared' | 'local'; site_id: string }[] = [];

  for (const site of KNOWN_SITES) {
    if (!isLocal) {
      // Shared surface: appears if site has it in static surfaces or any carrier binding surfaces='all' includes it implicitly.
      // For direct site usage, check static site.surfaces.
      if (site.surfaces.includes(surfaceId)) {
        matchingSites.push({ site_id: site.site_id, via: 'shared' });
      }
    }
    // Site-local surface: check config.json allowed_mcp_entrypoints
    const locals = readSiteConfig(site);
    if (locals.some((l) => l.surface_id === surfaceId)) {
      matchingSites.push({ site_id: site.site_id, via: 'local' });
    }
  }

  for (const carrier of CARRIERS) {
    for (const binding of carrier.site_bindings) {
      const site = lookupSite(binding.site_id);
      const sharedIds = sharedSurfaceIdsForBinding(binding);
      if (!isLocal && sharedIds.includes(surfaceId)) {
        matchingCarriers.push({ carrier_id: carrier.carrier_id, kind: carrier.kind, via: 'shared', site_id: binding.site_id });
      }
      if (isLocal || binding.surfaces === 'all') {
        const locals = readSiteConfig(site);
        for (const local of locals) {
          if (local.surface_id !== surfaceId) continue;
          if (binding.surfaces !== 'all' && !binding.surfaces.includes(local.surface_id)) continue;
          matchingCarriers.push({ carrier_id: carrier.carrier_id, kind: carrier.kind, via: 'local', site_id: binding.site_id });
        }
      }
    }
  }

  // Dedupe carriers
  const carrierMap = new Map<string, typeof matchingCarriers[0]>();
  for (const c of matchingCarriers) carrierMap.set(`${c.carrier_id}:${c.site_id}:${c.via}`, c);
  const dedupedCarriers = Array.from(carrierMap.values());

  return {
    surface_id: surfaceId,
    is_local: isLocal,
    sites: matchingSites,
    carriers: dedupedCarriers,
    site_count: matchingSites.length,
    carrier_count: dedupedCarriers.length,
  };
}

type SiteMcpFabricServer = {
  server_key: string;
  command: string;
  args: string[];
  entrypoint: string;
  surface_id?: string;
  narada_scope: NaradaScopeMetadata;
  source_file: string;
};

function discoverSiteMcpFabric(site: SiteDef): SiteMcpFabricServer[] {
  const configDir = join(site.root, '.ai', 'mcp');
  if (!existsSync(configDir)) return [];
  const servers: SiteMcpFabricServer[] = [];
  for (const file of readdirSync(configDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = join(configDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    let cfg: JsonRecord;
    try {
      cfg = JSON.parse(content);
    } catch {
      continue;
    }
    const mcpServers = asRecord(cfg.mcpServers);
    for (const [serverKey, rawServer] of Object.entries(mcpServers)) {
      const server = asRecord(rawServer);
      const surfaceId = fabricSurfaceId(serverKey, site);
      let command = server.command ?? 'node';
      let args: string[] = [];
      if (Array.isArray(command)) {
        args = command.slice(2).map(String);
        command = command.slice(0, 2);
      } else {
        args = Array.isArray(server.args) ? server.args.map(String) : [];
      }
      let entrypoint = '';
      if (Array.isArray(command) && command.length >= 2) {
        entrypoint = String(command[1]);
      } else if (args.length > 0) {
        entrypoint = args[0];
        args = args.slice(1);
      }
      // Handle entrypoint that is itself a command with flags (e.g. node --import tsx path)
      if (entrypoint === 'node' && args.length >= 3 && args[0] === '--import') {
        args.shift(); // --import
        args.shift(); // tsx
        entrypoint = args.shift() ?? '';
      } else if (entrypoint === '--import' && args.length >= 2 && args[0] === 'tsx') {
        args.shift(); // tsx
        entrypoint = args.shift() ?? '';
      }
      // Resolve {site_root} placeholders
      entrypoint = entrypoint.replace(/\{site_root\}/g, site.root);
      const resolvedArgs = args.map((a) => a.replace(/\{site_root\}/g, site.root));
      servers.push({
        server_key: serverKey,
        command: Array.isArray(command) ? String(command[0] ?? 'node') : String(command),
        args: resolvedArgs,
        entrypoint,
        surface_id: server.surface_id ? String(server.surface_id) : undefined,
        narada_scope: readNaradaScope(server, surfaceId, site.root, site.site_id),
        source_file: file,
      });
    }
  }
  return servers;
}

function fabricSurfaceId(serverKey: string, site: SiteDef): string {
  const prefix = site.site_id.replace('narada-', '');
  if (serverKey.startsWith(`${prefix}-`)) {
    const rest = serverKey.slice(prefix.length + 1);
    const known = SURFACES.find((s) => s.id === rest);
    if (known) return known.id;
  }
  return serverKey;
}

export function validateSiteMcpFabric(site: SiteDef, includeOk = false): JsonRecord {
  const siteId = site.site_id;
  const findings: ValidationFinding[] = [];

  function add(severity: ValidationFinding['severity'], code: string, message: string, detail: JsonRecord = {}) {
    findings.push({ severity, code, message, ...detail });
  }

  const servers = discoverSiteMcpFabric(site);

  if (servers.length === 0) {
    add('warning', 'registrar_site_fabric_empty', `No MCP servers found in ${join(site.root, '.ai', 'mcp')}`, { site_id: siteId });
  }

  const seenKeys = new Set<string>();
  for (const server of servers) {
    const surfaceId = fabricSurfaceId(server.server_key, site);
    const scopeDetail = scopeFindingDetail(server.narada_scope);
    if (seenKeys.has(server.server_key)) {
      add('error', 'registrar_site_fabric_duplicate_server_key', `Duplicate server key '${server.server_key}' in site fabric`, { site_id: siteId, server_key: server.server_key, source_file: server.source_file, surface_id: surfaceId, ...scopeDetail });
    } else {
      seenKeys.add(server.server_key);
      if (includeOk) { add('info', 'registrar_site_fabric_server_key_ok', `Server key '${server.server_key}' found`, { site_id: siteId, server_key: server.server_key, source_file: server.source_file, surface_id: surfaceId, ...scopeDetail }); }
    }

    // Entrypoint existence
    const resolvedEntrypoint = resolve(server.entrypoint);
    if (!existsSync(resolvedEntrypoint)) {
      add('error', 'registrar_site_fabric_missing_entrypoint', `Entrypoint for '${server.server_key}' does not exist: ${resolvedEntrypoint}`, { site_id: siteId, server_key: server.server_key, entrypoint: resolvedEntrypoint, source_file: server.source_file, surface_id: surfaceId, ...scopeDetail });
    } else if (includeOk) {
      add('info', 'registrar_site_fabric_entrypoint_exists', `Entrypoint for '${server.server_key}' exists: ${resolvedEntrypoint}`, { site_id: siteId, server_key: server.server_key, entrypoint: resolvedEntrypoint, source_file: server.source_file, surface_id: surfaceId, ...scopeDetail });
    }

    // Allowed-root requirement
    if (rootsNeedingAllowedRoot(surfaceId)) {
      const allowedRoots: string[] = [];
      for (let i = 0; i < server.args.length; i++) {
        if (server.args[i] === '--allowed-root' && i + 1 < server.args.length) {
          allowedRoots.push(server.args[i + 1]);
        }
      }
      if (allowedRoots.length === 0) {
        add('error', 'registrar_site_fabric_missing_allowed_root', `Surface '${surfaceId}' requires at least one --allowed-root but '${server.server_key}' has none`, { site_id: siteId, server_key: server.server_key, surface_id: surfaceId, source_file: server.source_file, ...scopeDetail });
      } else if (includeOk) {
        add('info', 'registrar_site_fabric_allowed_root_ok', `Surface '${surfaceId}' on '${server.server_key}' has ${allowedRoots.length} allowed root(s)`, { site_id: siteId, server_key: server.server_key, surface_id: surfaceId, allowed_roots: allowedRoots, source_file: server.source_file, ...scopeDetail });
      }
    }

    // Output-root requirement for local-filesystem
    if (surfaceId === 'local-filesystem' || surfaceId === 'local-filesystem-mcp.local') {
      const hasOutputRoot = server.args.some((a) => a === '--output-root');
      if (!hasOutputRoot) {
        add('warning', 'registrar_site_fabric_missing_output_root', `Filesystem surface '${server.server_key}' is missing --output-root`, { site_id: siteId, server_key: server.server_key, surface_id: surfaceId, source_file: server.source_file, ...scopeDetail });
      } else if (includeOk) {
        add('info', 'registrar_site_fabric_output_root_ok', `Filesystem surface '${server.server_key}' has --output-root`, { site_id: siteId, server_key: server.server_key, surface_id: surfaceId, source_file: server.source_file, ...scopeDetail });
      }
    }

    // Site-root requirement for site-aware surfaces
    if (['agent-context', 'task-lifecycle', 'site-inbox', 'site-ops', 'mailbox', 'graph-mail', 'surface-feedback', 'delegated-task'].includes(surfaceId)) {
      const hasSiteRoot = server.args.some((a) => a === '--site-root');
      if (!hasSiteRoot) {
        add('warning', 'registrar_site_fabric_missing_site_root', `Surface '${surfaceId}' on '${server.server_key}' is missing --site-root`, { site_id: siteId, server_key: server.server_key, surface_id: surfaceId, source_file: server.source_file, ...scopeDetail });
      } else if (includeOk) {
        add('info', 'registrar_site_fabric_site_root_ok', `Surface '${surfaceId}' on '${server.server_key}' has --site-root`, { site_id: siteId, server_key: server.server_key, surface_id: surfaceId, source_file: server.source_file, ...scopeDetail });
      }
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return {
    status: errors > 0 ? 'invalid' : warnings > 0 ? 'valid_with_warnings' : 'valid',
    site_id: siteId,
    server_count: servers.length,
    errors,
    warnings,
    findings,
  };
}

function registrarCarrierBind(args: JsonRecord): JsonRecord {
  const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id');
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const carrier = lookupCarrier(carrierId);
  const surface = lookupSurface(surfaceId);
  const defaultSiteId = optionalString(args.site_id) ?? 'narada-andrey';
  const site = KNOWN_SITES.find((s) => s.site_id === defaultSiteId);
  const siteRoot = site ? site.root : defaultSiteId;

  const resolvedArgs = interpolateArgs(surface.args, defaultSiteId, siteRoot);
  const resolvedEntrypoint = interpolateArg(surface.entrypoint, defaultSiteId, siteRoot);
  if (surfaceId === 'sop') appendSopsDirs(resolvedArgs);

  const aggregateServerKeys = carrierServerKeysForSurface(carrier, surfaceId);
  if (aggregateServerKeys.length > 0) {
    const applied = registrarCarrierApply({ carrier_id: carrierId });
    writeSiteAllowedRootsConfig(carrier);
    return {
      ...applied,
      status: 'applied',
      surface_id: surfaceId,
      server_keys: aggregateServerKeys,
      binding_model: 'aggregate_carrier_config',
    };
  }

  let result: JsonRecord;
  switch (carrier.kind) {
    case 'opencode':
      result = opencodeBind(carrier.config_path, surfaceId, resolvedEntrypoint, resolvedArgs);
      break;
    case 'kimi':
      result = kimiBind(carrier.config_path, surfaceId, resolvedEntrypoint, resolvedArgs);
      break;
    case 'codex':
      result = codexBind(carrier.config_path, surfaceId, resolvedEntrypoint, resolvedArgs);
      break;
    default:
      throw diagnosticError('registrar_unknown_carrier_kind', `registrar_unknown_carrier_kind:${carrier.kind}`);
  }
  writeSiteAllowedRootsConfig(carrier);
  return result;
}

function registrarCarrierUnbind(args: JsonRecord): JsonRecord {
  const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id');
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const carrier = lookupCarrier(carrierId);
  const aggregateServerKeys = carrierServerKeysForSurface(carrier, surfaceId);
  if (aggregateServerKeys.length > 0) {
    throw diagnosticError(
      'registrar_carrier_unbind_refused_aggregate_surface',
      `registrar_carrier_unbind_refused_aggregate_surface:${surfaceId}`,
      {
        carrier_id: carrierId,
        surface_id: surfaceId,
        server_keys: aggregateServerKeys,
        remediation: 'This surface is produced by the aggregate carrier model. Remove it from the carrier site binding/source model, then run registrar_carrier_apply.',
      },
    );
  }
  let result: JsonRecord;
  switch (carrier.kind) {
    case 'opencode':
      result = opencodeUnbind(carrier.config_path, surfaceId);
      break;
    case 'kimi':
      result = kimiUnbind(carrier.config_path, surfaceId);
      break;
    case 'codex':
      result = codexUnbind(carrier.config_path, surfaceId);
      break;
    default:
      throw diagnosticError('registrar_unknown_carrier_kind', `registrar_unknown_carrier_kind:${carrier.kind}`);
  }
  writeSiteAllowedRootsConfig(carrier);
  return result;
}

function opencodeBind(configPath: string, surfaceId: string, entrypoint: string, resolvedArgs: string[]): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcp);
  const serverKey = `narada-sonar-${surfaceId}`;
  if (mcp[serverKey]) return { status: 'already_bound', carrier_id: 'opencode-sonar', surface_id: surfaceId, server_key: serverKey };
  mcp[serverKey] = {
    type: 'local',
    command: ['node', entrypoint, ...resolvedArgs],
    enabled: true,
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { status: 'bound', carrier_id: 'opencode-sonar', surface_id: surfaceId, server_key: serverKey };
}

function opencodeUnbind(configPath: string, surfaceId: string): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcp);
  const serverKey = `narada-sonar-${surfaceId}`;
  if (!mcp[serverKey]) return { status: 'not_bound', carrier_id: 'opencode-sonar', surface_id: surfaceId };
  delete mcp[serverKey];
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { status: 'unbound', carrier_id: 'opencode-sonar', surface_id: surfaceId, server_key: serverKey };
}

function kimiBind(configPath: string, surfaceId: string, entrypoint: string, resolvedArgs: string[]): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcpServers);
  const serverKey = `narada-andrey-${surfaceId}`;
  if (mcp[serverKey]) return { status: 'already_bound', carrier_id: 'kimi-andrey', surface_id: surfaceId, server_key: serverKey };
  mcp[serverKey] = {
    transport: 'stdio',
    command: 'node',
    args: [entrypoint, ...resolvedArgs],
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { status: 'bound', carrier_id: 'kimi-andrey', surface_id: surfaceId, server_key: serverKey };
}

function kimiUnbind(configPath: string, surfaceId: string): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcpServers);
  const serverKey = `narada-andrey-${surfaceId}`;
  if (!mcp[serverKey]) return { status: 'not_bound', carrier_id: 'kimi-andrey', surface_id: surfaceId };
  delete mcp[serverKey];
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { status: 'unbound', carrier_id: 'kimi-andrey', surface_id: surfaceId, server_key: serverKey };
}

function codexBind(configPath: string, surfaceId: string, entrypoint: string, resolvedArgs: string[]): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  let content = readFileSync(configPath, 'utf8');
  const sectionKey = `[mcp_servers.${surfaceId}]`;
  if (content.includes(sectionKey)) return { status: 'already_bound', carrier_id: 'codex-andrey', surface_id: surfaceId };
  content += `\n${sectionKey}\ncommand = "node"\nargs = ${JSON.stringify([entrypoint, ...resolvedArgs])}\n`;
  writeFileSync(configPath, content, 'utf8');
  return { status: 'bound', carrier_id: 'codex-andrey', surface_id: surfaceId };
}

function codexUnbind(configPath: string, surfaceId: string): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  let content = readFileSync(configPath, 'utf8');
  const sectionKey = `[mcp_servers.${surfaceId}]`;
  if (!content.includes(sectionKey)) return { status: 'not_bound', carrier_id: 'codex-andrey', surface_id: surfaceId };
  const idx = content.indexOf(sectionKey);
  const nextSection = content.indexOf('\n[', idx + sectionKey.length);
  if (nextSection >= 0) {
    content = content.slice(0, idx) + content.slice(nextSection);
  } else {
    content = content.slice(0, idx).trimEnd();
  }
  writeFileSync(configPath, content, 'utf8');
  return { status: 'unbound', carrier_id: 'codex-andrey', surface_id: surfaceId, server_key: surfaceId };
}

function registrarSync(args: JsonRecord): JsonRecord {
  const target = requiredString(args.target, 'registrar_requires_target');
  const results: JsonRecord[] = [];

  if (target === 'all_surfaces_to_carriers') {
    const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id_for_target');
    lookupCarrier(carrierId);
    for (const surface of SURFACES) {
      try { results.push(registrarCarrierBind({ carrier_id: carrierId, surface_id: surface.id })); }
      catch (e) { results.push({ carrier_id: carrierId, surface_id: surface.id, error: e instanceof Error ? e.message : String(e) }); }
    }
    return { target, carrier_id: carrierId, results, count: results.length };
  }

  if (target === 'all_surfaces_to_all_carriers') {
    for (const carrier of CARRIERS) {
      for (const surface of SURFACES) {
        try { results.push(registrarCarrierBind({ carrier_id: carrier.carrier_id, surface_id: surface.id })); }
        catch (e) { results.push({ carrier_id: carrier.carrier_id, surface_id: surface.id, error: e instanceof Error ? e.message : String(e) }); }
      }
    }
    return { target, results, count: results.length };
  }

  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  lookupSurface(surfaceId);
  if (target === 'all_sites' || target === 'all') {
    for (const site of KNOWN_SITES) {
      try { results.push(registrarSiteBind({ site_id: site.site_id, surface_id: surfaceId })); }
      catch (e) { results.push({ site_id: site.site_id, surface_id: surfaceId, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  if (target === 'all_carriers' || target === 'all') {
    for (const carrier of CARRIERS) {
      try { results.push(registrarCarrierBind({ carrier_id: carrier.carrier_id, surface_id: surfaceId })); }
      catch (e) { results.push({ carrier_id: carrier.carrier_id, surface_id: surfaceId, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  return { surface_id: surfaceId, target, results, count: results.length };
}

function renderResult(result: JsonRecord): string {
  if (result.items !== undefined) return `registrar: ${result.count ?? 0} items\n${(result.items as JsonRecord[]).map((i) => `  ${i.id ?? i.site_id ?? i.carrier_id ?? ''}`).join('\n')}`;
  if (result.results) return `registrar sync: ${result.count ?? 0} results\n${(result.results as JsonRecord[]).map((r) => `  ${r.status ?? r.error ?? ''}`).join('\n')}`;
  return `${result.status ?? 'ok'}: ${result.surface_id ?? ''} @ ${result.site_id ?? result.carrier_id ?? ''}`;
}

function requiredString(value: unknown, code: string, details: JsonRecord = {}): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code, details);
  return text;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(String).filter(Boolean))];
}

function diagnosticError(code: string, message: string = code, details: JsonRecord = {}) {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

function errorDiagnostic(error: unknown) {
  const record = asRecord(error);
  return { schema: 'narada.registrar.error.v1', code: String(record.codeName ?? 'registrar_error'), message: error instanceof Error ? error.message : String(error), details: asRecord(record.details) };
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  return { framed: false, remaining: lines.pop() ?? '', requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))) };
}

function drainJsonRpcFrames(buffer: string) {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const match = /Content-Length:\s*(\d+)/i.exec(remaining.slice(0, headerEnd));
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd))));
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  else process.stdout.write(`${body}\n`);
}

function parseArgs(_argv: string[]) {
  return {};
}

export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
