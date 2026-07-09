#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
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
  output_reader_closure?: Record<string, string>;
  output_reader_policy_note?: string;
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
const MCP_RUNTIME_PROXY_ENTRYPOINT = `${MCP_SURFACES_ROOT}/shared/mcp-runtime-proxy/dist/src/main.js`;
const USER_NARADA_ROOT = 'C:/Users/Andrey/Narada';

const GIT_TOOLS = ['git_guidance', 'git_policy_inspect', 'git_status', 'git_output_show', 'git_changed_summary', 'git_repositories_summary', 'git_workflow_record', 'git_diff', 'git_log', 'git_show', 'git_add', 'git_unstage', 'git_commit', 'git_push'];
const GRAPH_MAIL_TOOLS = ['graph_mail_guidance', 'graph_mail_doctor', 'graph_mail_auth_device_code_start', 'graph_mail_auth_device_code_poll', 'graph_mail_auth_status', 'graph_mail_auth_clear', 'graph_mail_query', 'graph_mail_message_show', 'graph_mail_output_show', 'graph_mail_folder_list', 'graph_mail_folder_create', 'graph_mail_message_move', 'graph_mail_attachment_list', 'graph_mail_attachment_get', 'graph_mail_attachment_add', 'graph_mail_attachment_upload_session_create', 'graph_mail_attachment_upload_chunk', 'graph_mail_attachment_upload_file', 'graph_mail_attachment_delete', 'graph_mail_draft_create', 'graph_mail_reply_draft_create', 'graph_mail_reply_all_draft_create', 'graph_mail_forward_draft_create', 'graph_mail_reply_all_to_last_in_thread_draft_create', 'graph_mail_draft_update', 'graph_mail_draft_discard', 'graph_mail_draft_send'];
const SITE_INBOX_TOOLS = ['inbox_guidance', 'inbox_doctor', 'inbox_list', 'inbox_show', 'inbox_submit', 'inbox_acknowledge', 'inbox_dismiss', 'inbox_promote_capa', 'inbox_audit', 'inbox_next', 'capa_queue', 'inbox_output_show'];
const TASK_LIFECYCLE_TOOLS = ['task_lifecycle_guidance', 'task_lifecycle_doctor', 'task_lifecycle_list', 'task_lifecycle_show', 'task_lifecycle_roster', 'task_lifecycle_payload_schema', 'task_lifecycle_roster_admit', 'task_lifecycle_claim', 'task_lifecycle_continue', 'task_lifecycle_unclaim', 'task_lifecycle_next', 'task_lifecycle_workboard_snapshot', 'task_lifecycle_obligations', 'task_lifecycle_inspect', 'task_lifecycle_inspect_range', 'task_lifecycle_admit_evidence', 'task_lifecycle_prove_criteria', 'task_lifecycle_disposition_closeout', 'task_lifecycle_closeout', 'task_lifecycle_audit', 'task_lifecycle_finish', 'task_lifecycle_submit_report', 'task_lifecycle_close', 'task_lifecycle_report_blocked', 'task_lifecycle_search', 'task_lifecycle_related', 'task_lifecycle_defer', 'task_lifecycle_un_defer', 'task_lifecycle_reopen', 'task_lifecycle_review', 'task_lifecycle_submit_observation', 'task_lifecycle_record_observation', 'task_lifecycle_bridge_poll', 'task_lifecycle_inbox_target', 'task_lifecycle_create', 'mcp_payload_create', 'mcp_payload_show', 'mcp_payload_derive', 'mcp_payload_validate', 'task_lifecycle_set_routing', 'task_lifecycle_test_mcp_tool', 'task_lifecycle_run_tests', 'task_lifecycle_recurring_create', 'task_lifecycle_recurring_list', 'task_lifecycle_recurring_show', 'task_lifecycle_recurring_suspend', 'task_lifecycle_recurring_retire', 'task_lifecycle_recurring_trigger', 'task_lifecycle_recurring_run_due', 'task_lifecycle_recurring_runs', 'task_lifecycle_chapter_add_task', 'task_lifecycle_chapter_show', 'task_lifecycle_submit_work', 'task_lifecycle_self_certification_preflight', 'task_lifecycle_restart', 'task_lifecycle_diagnose_task_ref', 'task_lifecycle_evidence_preflight', 'task_lifecycle_dependency_declare', 'task_lifecycle_dependency_disposition_record'];
const WORKER_DELEGATION_TOOLS = ['worker_guidance', 'worker_policy_inspect', 'worker_config_resolve', 'worker_run', 'worker_edit', 'worker_resume', 'worker_run_status', 'worker_run_reap', 'worker_runs_list', 'worker_run_wait', 'worker_run_batch', 'worker_run_wait_batch', 'worker_runs_synthesize', 'worker_dashboard_describe', 'worker_output_show', 'worker_operator_affordances'];
const DELEGATED_TASK_TOOLS = ['delegated_task_guidance', 'delegated_task_policy_inspect', 'delegated_task_template_catalog', 'delegated_task_validate', 'delegated_task_run', 'delegated_task_status', 'delegated_task_summary', 'delegated_task_result', 'delegated_task_wait', 'delegated_task_advance', 'delegated_task_events', 'delegated_task_cancel', 'delegated_task_acknowledge', 'delegated_task_parent_takeover', 'delegated_tasks_list'];
const MCP_LOADER_TOOLS = ['mcp_loader_policy_inspect', 'mcp_loader_list_site_surfaces', 'mcp_loader_site_fabric_diagnostics', 'mcp_loader_site_tool_inventory_check', 'mcp_loader_attach_surface', 'mcp_loader_list_tools', 'mcp_loader_surface_status', 'mcp_loader_tool_discovery_manifest', 'mcp_loader_call_tool', 'mcp_loader_detach', 'mcp_loader_surface_restart'];
const REGISTRAR_TOOLS = ['registrar_guidance', 'registrar_surface_list', 'registrar_site_list', 'registrar_site_surfaces', 'registrar_site_bind', 'registrar_site_unbind', 'registrar_carrier_list', 'registrar_carrier_bind', 'registrar_carrier_unbind', 'registrar_sync', 'registrar_carrier_materialize', 'registrar_carrier_apply', 'registrar_carrier_validate', 'registrar_carrier_diff', 'registrar_surface_usage', 'registrar_site_mcp_fabric_validate', 'registrar_site_surface_registry_sync', 'registrar_surface_tool_inventory_check', 'registrar_site_registry_conformance_check', 'registrar_site_output_reader_closure_check'];
const ARTIFACTS_TOOLS = ['artifacts_guidance', 'artifacts_doctor', 'artifact_register_file', 'artifact_list', 'artifact_read', 'artifact_present', 'artifact_message_part_create'];

const READ_ONLY_TOOLS_BY_SURFACE: Record<string, string[]> = {
  'local-filesystem': ['fs_guidance', 'fs_read_file', 'fs_read_file_range', 'fs_stat', 'fs_glob_search', 'fs_grep_search', 'fs_doctor'],
  'structured-command': ['structured_command_execution_policy_inspect', 'structured_command_powershell_parse_check'],
  git: ['git_guidance', 'git_policy_inspect', 'git_status', 'git_output_show', 'git_changed_summary', 'git_repositories_summary', 'git_diff', 'git_log', 'git_show'],
  'site-inbox': ['inbox_guidance', 'inbox_doctor', 'inbox_list', 'inbox_show', 'inbox_audit', 'inbox_next', 'capa_queue', 'inbox_output_show'],
  mailbox: ['mailbox_guidance', 'mailbox_doctor', 'mailbox_accounts_list', 'mailbox_messages_list', 'mailbox_message_show', 'mailbox_output_show', 'mailbox_search', 'mailbox_thread_show'],
  'graph-mail': ['graph_mail_guidance', 'graph_mail_doctor', 'graph_mail_auth_status', 'graph_mail_query', 'graph_mail_message_show', 'graph_mail_output_show', 'graph_mail_folder_list', 'graph_mail_attachment_list', 'graph_mail_attachment_get'],
  calendar: ['calendar_doctor', 'calendar_list', 'calendar_event_query', 'calendar_event_show', 'calendar_output_show'],
  'task-lifecycle': ['task_lifecycle_guidance', 'task_lifecycle_doctor', 'task_lifecycle_list', 'task_lifecycle_show', 'task_lifecycle_roster', 'task_lifecycle_payload_schema', 'task_lifecycle_evidence_preflight', 'task_lifecycle_next', 'task_lifecycle_workboard_snapshot', 'task_lifecycle_obligations', 'task_lifecycle_inspect', 'task_lifecycle_inspect_range', 'task_lifecycle_audit', 'task_lifecycle_search', 'task_lifecycle_related', 'mcp_payload_show', 'mcp_payload_validate', 'task_lifecycle_recurring_list', 'task_lifecycle_recurring_show', 'task_lifecycle_recurring_runs', 'task_lifecycle_chapter_show', 'task_lifecycle_diagnose_task_ref'],
  'site-loop': ['site_loop_guidance', 'site_loop_doctor', 'site_loop_config_validate', 'site_loop_output_show', 'site_loop_operator_affordances', 'site_docs_list', 'site_docs_show', 'site_test_list', 'site_loop_status', 'site_loop_unified_status', 'site_loop_recovery_plan', 'site_loop_health', 'site_loop_operating_status', 'site_loop_proof_status', 'site_loop_readiness', 'site_loop_coherence', 'site_loop_runs_list', 'site_loop_run_show', 'site_loop_attention_list', 'site_loop_attention_show'],
  'site-lifecycle': ['site_lifecycle_doctor', 'site_lifecycle_command_map', 'site_create_presets_list', 'site_create_plan', 'site_list', 'site_discover', 'site_show', 'site_doctor', 'site_lifecycle_kinds', 'site_lifecycle_preflight', 'site_relation_list', 'site_relation_validate', 'site_authority_preflight'],
  'agent-context': ['agent_context_guidance', 'agent_context_doctor', 'agent_context_whoami', 'agent_context_rehydrate', 'agent_context_hydrate_current', 'agent_context_startup_sequence', 'agent_context_list_sessions', 'agent_context_output_show'],
  'worker-delegation': ['worker_guidance', 'worker_policy_inspect', 'worker_config_resolve', 'worker_run_status', 'worker_runs_list', 'worker_run_wait', 'worker_run_wait_batch', 'worker_runs_synthesize', 'worker_dashboard_describe', 'worker_output_show', 'worker_operator_affordances'],
  'delegated-task': ['delegated_task_guidance', 'delegated_task_policy_inspect', 'delegated_task_template_catalog', 'delegated_task_validate', 'delegated_task_status', 'delegated_task_summary', 'delegated_task_result', 'delegated_task_wait', 'delegated_task_events', 'delegated_tasks_list'],
  sop: ['sop_guidance', 'sop_doctor', 'sop_template_show', 'sop_template_export', 'sop_template_list', 'sop_template_search', 'sop_template_candidate_list', 'sop_template_candidate_show', 'sop_run_status', 'sop_run_list', 'sop_run_events', 'sop_run_coverage_since'],
  scheduler: ['scheduler_guidance', 'scheduler_task_list', 'scheduler_task_show', 'scheduler_task_history'],
  'mcp-loader': ['mcp_loader_policy_inspect', 'mcp_loader_list_site_surfaces', 'mcp_loader_site_fabric_diagnostics', 'mcp_loader_site_tool_inventory_check', 'mcp_loader_list_tools', 'mcp_loader_surface_status', 'mcp_loader_tool_discovery_manifest'],
  'mcp-registrar': ['registrar_guidance', 'registrar_surface_list', 'registrar_site_list', 'registrar_site_surfaces', 'registrar_carrier_list', 'registrar_carrier_validate', 'registrar_carrier_diff', 'registrar_surface_usage', 'registrar_site_mcp_fabric_validate', 'registrar_surface_tool_inventory_check', 'registrar_site_registry_conformance_check', 'registrar_site_output_reader_closure_check'],
  'surface-feedback': ['surface_feedback_guidance', 'surface_feedback_doctor', 'surface_feedback_list', 'surface_feedback_show', 'surface_feedback_stats', 'surface_feedback_live_proof_template'],
  launcher: ['launcher_doctor', 'launcher_options_list', 'launcher_registry_list', 'launcher_plan', 'launcher_option_matrix', 'launcher_coherence_check'],
  speech: ['speech_guidance', 'speech_voices', 'speech_listen_status'],
  'operator-routing': ['operator_route_doctor'],
  artifacts: ['artifacts_guidance', 'artifacts_doctor', 'artifact_list', 'artifact_read', 'artifact_message_part_create'],
  'cloudflare-carrier': ['cloudflare_product_read', 'cloudflare_session_status', 'cloudflare_health', 'cloudflare_doctor'],
  'site-coherence': ['site_coherence_check', 'site_coherence_doctor'],
};

const REFUSED_TOOLS_BY_SURFACE: Record<string, string[]> = {};

const SURFACES: SurfaceDef[] = [
  {
    id: 'local-filesystem', package: 'local-filesystem-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/local-filesystem-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--mode', 'write', '--allowed-root', '{site_root}', '--anchored-allowed-root', 'user_home:.codex', '--output-root', '{site_root}'],
    tools: ['fs_guidance', 'fs_read_file', 'fs_read_file_range', 'fs_stat', 'fs_glob_search', 'fs_grep_search', 'fs_doctor', 'fs_write_file', 'fs_str_replace_file', 'fs_replace_range', 'fs_apply_patch', 'fs_move_path', 'fs_create_directory', 'fs_rename_directory', 'fs_delete_directory'],
  },
  {
    id: 'structured-command', package: 'structured-command-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/structured-command-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-root', '{site_root}', '--allow-command', 'node', '--allow-command', 'pnpm', '--allow-command', 'npm'],
    tools: ['structured_command_execution_policy_inspect', 'structured_command_powershell_parse_check', 'structured_command_execute', 'structured_command_elevated_window_execute', 'structured_command_input_create'],
  },
  {
    id: 'git', package: 'git-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/git-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-root', '{site_root}', '--mode', 'write'],
    tools: GIT_TOOLS,
    output_reader_closure: {
      git_status: 'git_output_show',
      git_diff: 'git_output_show',
      git_log: 'git_output_show',
      git_show: 'git_output_show',
    },
  },
  {
    id: 'site-inbox', package: 'site-inbox-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/site-inbox-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: SITE_INBOX_TOOLS,
    output_reader_closure: {
      inbox_list: 'inbox_output_show',
      inbox_show: 'inbox_output_show',
      inbox_audit: 'inbox_output_show',
    },
  },
  {
    id: 'mailbox', package: 'mailbox-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/mailbox-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['mailbox_guidance', 'mailbox_doctor', 'mailbox_accounts_list', 'mailbox_messages_list', 'mailbox_message_show', 'mailbox_output_show', 'mailbox_search', 'mailbox_thread_show'],
    output_reader_closure: {
      mailbox_messages_list: 'mailbox_output_show',
      mailbox_message_show: 'mailbox_output_show',
      mailbox_search: 'mailbox_output_show',
      mailbox_thread_show: 'mailbox_output_show',
    },
  },
  {
    id: 'graph-mail', package: 'graph-mail-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/graph-mail-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: GRAPH_MAIL_TOOLS,
    output_reader_closure: {
      graph_mail_query: 'graph_mail_output_show',
      graph_mail_message_show: 'graph_mail_output_show',
    },
  },
  {
    id: 'calendar', package: 'calendar-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/calendar-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['calendar_doctor', 'calendar_list', 'calendar_event_query', 'calendar_event_show', 'calendar_output_show', 'calendar_event_create', 'calendar_event_update', 'calendar_event_delete'],
    output_reader_closure: {
      calendar_list: 'calendar_output_show',
      calendar_event_query: 'calendar_output_show',
      calendar_event_show: 'calendar_output_show',
    },
  },
  {
    id: 'task-lifecycle', package: 'task-lifecycle-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/task-lifecycle-mcp/dist/src/task-lifecycle/task-mcp-server.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: TASK_LIFECYCLE_TOOLS,
  },
  {
    id: 'site-loop', package: 'site-loop-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/site-loop-mcp/dist/src/site-loop-mcp-server.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['site_loop_guidance', 'site_loop_doctor', 'site_loop_config_validate', 'site_loop_output_show', 'site_loop_operator_affordances', 'site_docs_list', 'site_docs_show', 'site_test_list', 'site_test_run', 'site_loop_status', 'site_loop_unified_status', 'site_loop_recovery_plan', 'site_loop_health', 'site_loop_operating_status', 'site_loop_proof_status', 'site_loop_proof_run', 'site_loop_readiness', 'site_loop_coherence', 'site_loop_runs_list', 'site_loop_run_show', 'site_loop_attention_list', 'site_loop_attention_show', 'site_loop_attention_ack', 'site_loop_control_set', 'site_loop_run_once'],
    output_reader_closure: {
      site_loop_guidance: 'site_loop_output_show',
      site_ops_guidance: 'site_loop_output_show',
    },
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
    args: ['--site-root', '{site_root}', '--site-id', '{site_id}'],
    tools: ['agent_context_guidance', 'agent_context_doctor', 'agent_context_whoami', 'agent_context_start_session', 'agent_context_checkpoint', 'agent_context_rehydrate', 'agent_context_hydrate_current', 'agent_context_startup_sequence', 'agent_context_list_sessions', 'agent_context_output_show'],
    output_reader_closure: {
      agent_context_hydrate_current: 'agent_context_output_show',
      agent_context_startup_sequence: 'agent_context_output_show',
    },
  },
  {
    id: 'worker-delegation', package: 'worker-delegation-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/worker-delegation-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}', '--allowed-root', '{site_root}', '--run-root', '{site_runtime_root}/worker-delegation'],
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
    tools: ['sop_guidance', 'sop_doctor', 'sop_template_create', 'sop_template_show', 'sop_template_export', 'sop_template_list', 'sop_template_search', 'sop_template_candidate_list', 'sop_template_candidate_show', 'sop_template_update', 'sop_template_deprecate', 'sop_template_import_yaml', 'sop_template_unimport', 'sop_run_start', 'sop_run_status', 'sop_run_refresh', 'sop_run_advance', 'sop_run_list', 'sop_run_cancel', 'sop_run_events', 'sop_run_coverage_since'],
    sops_dir: `${MCP_SURFACES_ROOT}/sop-mcp/sops`,
  },
  {
    id: 'scheduler', package: 'scheduler-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/scheduler-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: [],
    tools: ['scheduler_guidance', 'scheduler_task_list', 'scheduler_task_show', 'scheduler_task_create', 'scheduler_task_delete', 'scheduler_task_update_action', 'scheduler_task_enable', 'scheduler_task_disable', 'scheduler_task_run', 'scheduler_task_history'],
  },
  {
    id: 'mcp-loader', package: 'mcp-loader-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/mcp-loader-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-site-root', 'D:/code', '--allowed-site-root', USER_NARADA_ROOT, '--allowed-entrypoint-prefix', `${MCP_SURFACES_ROOT}/`, '--allowed-entrypoint-prefix', `${USER_NARADA_ROOT}/tools/`, '--allowed-entrypoint-prefix', '{site_root}/tools/'],
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
    tools: ['surface_feedback_guidance', 'surface_feedback_doctor', 'surface_feedback_submit', 'surface_feedback_update_status', 'surface_feedback_update_status_batch', 'surface_feedback_import', 'surface_feedback_list', 'surface_feedback_show', 'surface_feedback_stats', 'surface_feedback_live_proof_template'],
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
    tools: ['speech_guidance', 'speech_speak', 'speech_voices', 'speech_capture_transcribe', 'speech_prompt_capture_response', 'speech_listen_status', 'speech_listen_start', 'speech_listen_stop'],
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
    id: 'artifacts', package: 'artifacts-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/artifacts-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: [],
    tools: ARTIFACTS_TOOLS,
    injection_scope: 'local_site',
    default_injection: 'all_site_bound_sessions',
    env_vars: ['NARADA_SESSION_ID', 'NARADA_SITE_ROOT', 'NARADA_NARS_BASE_URL'],
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
        'calendar',
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
        'artifacts',
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
    carrier_id: 'kimi-andrey', kind: 'kimi', config_path: 'C:/Users/Andrey/.kimi-code/mcp.json', surfaces: [],
    site_bindings: [{
      site_id: 'narada-andrey',
      surfaces: [
        'agent-context',
        'task-lifecycle',
        'site-inbox',
        'mailbox',
        'graph-mail',
        'calendar',
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
        'artifacts',
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
        'calendar',
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
        'artifacts',
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

function duplicateStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates].sort();
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
    guidanceToolDefinition(),
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
          allow_sidecar: { type: 'boolean', description: 'Allow explicit compatibility sidecar creation for sites with authoritative aggregate MCP fabric.' },
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
      name: 'registrar_site_surface_registry_sync',
      description: 'Regenerate a site action-admission MCP surface registry from the site MCP fabric and registrar surface catalog.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site identifier, e.g. narada-sonar.' },
          dry_run: { type: 'boolean', description: 'Return the generated registry without writing it.' },
        },
        required: ['site_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_site_surface_registry_sync', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    {
      name: 'registrar_site_registry_conformance_check',
      description: 'Prove materialized site MCP registry conformance across live tools/list observations, site fabric declarations, registrar catalog metadata, and admission classification.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Known site identifier, e.g. smart-scheduling.' },
          observed_tools: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Live tools/list names keyed by site fabric server name.' },
          observed_read_only_tools: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Live tools with readOnlyHint=true keyed by site fabric server name.' },
          observed_mutating_tools: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Live tools with readOnlyHint=false keyed by site fabric server name.' },
          include_ok: { type: 'boolean', description: 'Include passing per-surface findings.' },
        },
        required: ['site_id', 'observed_tools', 'observed_read_only_tools', 'observed_mutating_tools'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_site_registry_conformance_check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_output_reader_closure_check',
      description: 'Check materialized site MCP surface registries for output-ref producer tools whose required reader tools are missing from live or read-only admission metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Single known site identifier to inspect.' },
          site_ids: { type: 'array', items: { type: 'string' }, description: 'Known site identifiers to inspect.' },
          site_root: { type: 'string', description: 'Single explicit site root to inspect.' },
          site_roots: { type: 'array', items: { type: 'string' }, description: 'Explicit site roots to inspect.' },
          include_ok: { type: 'boolean', description: 'Include passing site summaries in output.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'registrar_site_output_reader_closure_check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function callTool(params: JsonRecord, _state: RegistrarState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'registrar_guidance':
      result = buildGuidanceResult(args);
      break;
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
    case 'registrar_site_surface_registry_sync': result = registrarSiteSurfaceRegistrySync(args); break;
    case 'registrar_surface_tool_inventory_check': result = registrarSurfaceToolInventoryCheck(args); break;
    case 'registrar_site_registry_conformance_check': result = registrarSiteRegistryConformanceCheck(args); break;
    case 'registrar_site_output_reader_closure_check': result = registrarSiteOutputReaderClosureCheck(args); break;
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

type SitePathInterpolation = {
  siteRoot: string;
  siteControlRoot: string;
  siteRuntimeRoot: string;
};

function sitePathInterpolation(siteRoot: string): SitePathInterpolation {
  const normalizedRoot = siteRoot.replace(/\\/g, '/');
  const siteControlRoot = normalizedRoot.endsWith('/.narada') ? siteRoot : join(siteRoot, '.narada');
  return {
    siteRoot,
    siteControlRoot,
    siteRuntimeRoot: join(siteControlRoot, 'runtime'),
  };
}

function interpolateArgs(args: string[], siteId: string, siteRoot: string): string[] {
  const paths = sitePathInterpolation(siteRoot);
  return args.map((a) => interpolateArg(a, siteId, paths));
}

function interpolateArg(value: string, siteId: string, paths: SitePathInterpolation | string): string {
  const resolvedPaths = typeof paths === 'string' ? sitePathInterpolation(paths) : paths;
  return value
    .replace(/\{site_root\}/g, resolvedPaths.siteRoot)
    .replace(/\{site_control_root\}/g, resolvedPaths.siteControlRoot)
    .replace(/\{site_runtime_root\}/g, resolvedPaths.siteRuntimeRoot)
    .replace(/\{site_id\}/g, siteId);
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

function readJsonFile(path: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(stripJsoncComments(readFileSync(path, 'utf8'))));
  } catch {
    return null;
  }
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
    const siteControlRoot = sitePathInterpolation(site.root).siteControlRoot;
    const extraRoots = dedupeRoots([
      ...(carrier.extra_allowed_roots ?? []),
      ...(binding.extra_allowed_roots ?? []),
    ]).filter((r) => r !== siteRoot);

    if (extraRoots.length === 0) continue;

    const naradaDir = siteControlRoot;
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

function writeSiteSurfaceRegistriesForCarrier(carrier: CarrierDef): JsonRecord[] {
  const seen = new Set<string>();
  const results: JsonRecord[] = [];
  for (const binding of carrier.site_bindings) {
    if (seen.has(binding.site_id)) continue;
    seen.add(binding.site_id);
    results.push(writeSiteSurfaceRegistry(lookupSite(binding.site_id)));
  }
  return results;
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

type CarrierLaunchCommand = {
  command: string;
  args: string[];
  uses_runtime_proxy: boolean;
  runtime_proxy_entrypoint?: string;
  child_entrypoint: string;
  child_args: string[];
};

function carrierLaunchCommand(server: MaterializedServer, surfaceId: string): CarrierLaunchCommand {
  const childEntrypoint = server.entrypoint;
  const childArgs = server.args;
  if (server.kind === 'local') {
    return {
      command: server.command ?? 'node',
      args: [childEntrypoint, ...childArgs],
      uses_runtime_proxy: false,
      child_entrypoint: childEntrypoint,
      child_args: childArgs,
    };
  }
  return {
    command: 'node',
    args: [
      MCP_RUNTIME_PROXY_ENTRYPOINT,
      '--surface-id',
      surfaceId,
      '--entrypoint',
      childEntrypoint,
      '--',
      ...childArgs,
    ],
    uses_runtime_proxy: true,
    runtime_proxy_entrypoint: MCP_RUNTIME_PROXY_ENTRYPOINT,
    child_entrypoint: childEntrypoint,
    child_args: childArgs,
  };
}

type RuntimeDependencyCheck = {
  dependency: string;
  package_root: string;
  export_path: string;
  exists: boolean;
};

function sharedRuntimeDependencyChecks(surface: SurfaceDef): RuntimeDependencyCheck[] {
  const packageRoot = `${MCP_SURFACES_ROOT}/${surface.package}`;
  const packagePath = `${packageRoot}/package.json`;
  if (!existsSync(packagePath)) return [];
  let packageJson: JsonRecord;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as JsonRecord;
  } catch {
    return [];
  }
  const dependencies = asRecord(packageJson.dependencies);
  const checks: RuntimeDependencyCheck[] = [];
  for (const dependency of Object.keys(dependencies).filter((name) => name.startsWith('@narada2/mcp-'))) {
    const sharedName = dependency.replace('@narada2/', '');
    const dependencyRoot = `${MCP_SURFACES_ROOT}/shared/${sharedName}`;
    const dependencyPackagePath = `${dependencyRoot}/package.json`;
    if (!existsSync(dependencyPackagePath)) {
      checks.push({ dependency, package_root: dependencyRoot, export_path: dependencyPackagePath, exists: false });
      continue;
    }
    let dependencyPackageJson: JsonRecord;
    try {
      dependencyPackageJson = JSON.parse(readFileSync(dependencyPackagePath, 'utf8')) as JsonRecord;
    } catch {
      checks.push({ dependency, package_root: dependencyRoot, export_path: dependencyPackagePath, exists: false });
      continue;
    }
    for (const exportTarget of packageExportRuntimeTargets(dependencyPackageJson)) {
      const exportPath = `${dependencyRoot}/${exportTarget.replace(/^\.\//, '')}`;
      checks.push({ dependency, package_root: dependencyRoot, export_path: exportPath, exists: existsSync(exportPath) });
    }
  }
  return checks;
}

function packageExportRuntimeTargets(packageJson: JsonRecord): string[] {
  const exportsValue = packageJson.exports;
  if (typeof exportsValue === 'string') return [exportsValue];
  const exportsRecord = asRecord(exportsValue);
  const targets: string[] = [];
  for (const value of Object.values(exportsRecord)) {
    if (typeof value === 'string') targets.push(value);
    else {
      const record = asRecord(value);
      if (typeof record.default === 'string') targets.push(record.default);
    }
  }
  return Array.from(new Set(targets));
}

function addRuntimePreflightFindings(
  add: (severity: ValidationFinding['severity'], code: string, message: string, detail?: JsonRecord) => void,
  includeOk: boolean,
  detail: JsonRecord,
  surface: SurfaceDef | null,
  usesRuntimeProxy: boolean,
): void {
  if (usesRuntimeProxy) {
    if (!existsSync(MCP_RUNTIME_PROXY_ENTRYPOINT)) {
      add('error', 'registrar_runtime_proxy_missing', `Runtime proxy does not exist: ${MCP_RUNTIME_PROXY_ENTRYPOINT}`, {
        ...detail,
        runtime_proxy_entrypoint: MCP_RUNTIME_PROXY_ENTRYPOINT,
        remediation: 'Run pnpm --filter @narada2/mcp-runtime-proxy build before launching carrier MCPs.',
      });
    } else if (includeOk) {
      add('info', 'registrar_runtime_proxy_exists', `Runtime proxy exists: ${MCP_RUNTIME_PROXY_ENTRYPOINT}`, { ...detail, runtime_proxy_entrypoint: MCP_RUNTIME_PROXY_ENTRYPOINT });
    }
  }
  if (!surface) return;
  for (const check of sharedRuntimeDependencyChecks(surface)) {
    if (!check.exists) {
      add('error', 'registrar_runtime_dependency_missing', `Runtime dependency export for '${check.dependency}' does not exist: ${check.export_path}`, {
        ...detail,
        dependency: check.dependency,
        package_root: check.package_root,
        export_path: check.export_path,
        remediation: `Run pnpm --filter ${check.dependency} build before launching carrier MCPs.`,
      });
    } else if (includeOk) {
      add('info', 'registrar_runtime_dependency_exists', `Runtime dependency export for '${check.dependency}' exists: ${check.export_path}`, {
        ...detail,
        dependency: check.dependency,
        package_root: check.package_root,
        export_path: check.export_path,
      });
    }
  }
}

function emitOpencodeConfig(carrier: CarrierDef): { content: string; structured: JsonRecord } {
  const rawServers = collectCarrierServers(carrier);
  const mcp: JsonRecord = {};
  for (const [key, server] of Object.entries(rawServers)) {
    const surfaceId = server.kind === 'local' ? (server.local as SiteLocalSurface).surface_id : (server.surface as SurfaceDef).id;
    const overridden = applySurfaceOverrides(carrier, server, surfaceId);
    const launch = carrierLaunchCommand(overridden, surfaceId);
    mcp[key] = {
      type: 'local',
      command: [launch.command, ...launch.args],
      enabled: overridden.enabled ?? true,
    };
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
    const launch = carrierLaunchCommand(overridden, surfaceId);
    const base: JsonRecord = {
      transport: 'stdio',
      command: launch.command,
      args: launch.args,
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
    const launch = carrierLaunchCommand(overridden, surfaceId);
    const carrierAvailableTools = codexCarrierAvailableTools(server);
    lines.push(`[mcp_servers.${key}]`);
    lines.push(`command = "${launch.command}"`);
    lines.push(`args = ${JSON.stringify(launch.args)}`);
    lines.push('approval_mode = "approve"');
    if (overridden.env_vars) {
      lines.push(`env_vars = ${JSON.stringify(overridden.env_vars)}`);
    }
    lines.push('');
    if (carrierAvailableTools.length > 0) {
      lines.push('# Generated carrier availability metadata. Narada MCP surfaces own policy.');
      for (const toolName of carrierAvailableTools) {
        lines.push(`[mcp_servers.${key}.tools.${toolName}]`);
        lines.push('approval_mode = "approve"');
        lines.push('');
      }
    }
    mcpServers[key] = {
      command: launch.command,
      args: launch.args,
      approval_mode: 'approve',
    };
  }
  const structured = { trust_projects: trustProjects, mcpServers };
  return { content: lines.join('\n') + '\n', structured };
}

function codexCarrierAvailableTools(server: MaterializedServer): string[] {
  if (server.kind === 'shared') return uniqueStrings((server.surface as SurfaceDef).tools);
  return [];
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
  const configPath = carrier.config_path;
  const existingContent = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  let result: { content: string; structured: JsonRecord };
  switch (carrier.kind) {
    case 'opencode': result = emitOpencodeConfig(carrier); break;
    case 'kimi': result = emitKimiConfig(carrier); break;
    case 'codex': result = emitCodexConfig(carrier); break;
    default: throw diagnosticError('registrar_unknown_carrier_kind', `registrar_unknown_carrier_kind:${carrier.kind}`);
  }
  if (existingContent !== null) {
    const backupPath = `${configPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    writeFileSync(backupPath, existingContent, 'utf8');
  }
  const dir = resolve(configPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, result.content, 'utf8');
  writeSiteAllowedRootsConfig(carrier);
  const site_surface_registries = writeSiteSurfaceRegistriesForCarrier(carrier);
  return { status: 'applied', carrier_id: carrierId, kind: carrier.kind, config_path: configPath, byte_size: Buffer.byteLength(result.content, 'utf8'), injection_scope_counts: injectionSummary.counts, site_surface_registries };
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
    const launch = carrierLaunchCommand(overridden, surfaceId);
    if (!existsSync(overridden.entrypoint)) {
      add('error', 'registrar_missing_entrypoint', `Entrypoint for '${key}' does not exist: ${overridden.entrypoint}`, { server_key: key, surface_id: surfaceId, entrypoint: overridden.entrypoint, ...scopeDetail });
    } else if (includeOk) {
      add('info', 'registrar_entrypoint_exists', `Entrypoint for '${key}' exists: ${overridden.entrypoint}`, { server_key: key, surface_id: surfaceId, entrypoint: overridden.entrypoint, ...scopeDetail });
    }
    addRuntimePreflightFindings(add, includeOk, { server_key: key, surface_id: surfaceId, entrypoint: overridden.entrypoint, ...scopeDetail }, server.kind === 'shared' ? server.surface as SurfaceDef : null, launch.uses_runtime_proxy);

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

function sameStringSet(left: string[], right: string[]): boolean {
  const a = uniqueStrings(left).sort();
  const b = uniqueStrings(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function stringSetDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(uniqueStrings(right));
  return uniqueStrings(left).filter((value) => !rightSet.has(value)).sort();
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = asRecord(value);
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function observedToolsForSurface(input: JsonRecord, server: SiteMcpFabricServer, registrySurface?: JsonRecord): string[] | null {
  const keys = uniqueStrings([
    server.server_key,
    `${server.server_key}.local`,
    server.surface_id ?? '',
    String(registrySurface?.catalog_surface_id ?? ''),
  ]);
  for (const key of keys) {
    if (Object.hasOwn(input, key) && Array.isArray(input[key])) {
      return (input[key] as unknown[]).map(String);
    }
  }
  return null;
}

export function checkSiteRegistryConformance(
  site: SiteDef,
  registry: JsonRecord,
  observedToolsInput: JsonRecord,
  observedReadOnlyToolsInput: JsonRecord,
  observedMutatingToolsInput: JsonRecord,
  includeOk = false,
): JsonRecord {
  const violations: JsonRecord[] = [];
  const surfaceResults: JsonRecord[] = [];
  const rawRegistrySurfaces = Array.isArray(registry.surfaces) ? registry.surfaces : [];
  const registrySurfaces = rawRegistrySurfaces.map((entry) => asRecord(entry));
  const registryByServer = new Map<string, JsonRecord>();

  const addGlobal = (code: string, details: JsonRecord = {}) => {
    violations.push({ layer: 'materialized_registry', code, surface_id: null, server_name: null, ...details });
  };

  if (registry.schema !== 'narada.site.capabilities.mcp_surfaces.v1') {
    addGlobal('registry_schema_mismatch', { expected: 'narada.site.capabilities.mcp_surfaces.v1', actual: registry.schema ?? null });
  }
  if (registry.site_id !== site.site_id) {
    addGlobal('registry_site_id_mismatch', { expected: site.site_id, actual: registry.site_id ?? null });
  }
  if (registry.generated_by !== 'mcp-registrar') {
    addGlobal('registry_generator_mismatch', { expected: 'mcp-registrar', actual: registry.generated_by ?? null });
  }
  const generationPolicy = asRecord(registry.generation_policy);
  if (generationPolicy.mode !== 'enabled_surface_tool_authority') {
    addGlobal('registry_generation_policy_mismatch', { expected: 'enabled_surface_tool_authority', actual: generationPolicy.mode ?? null });
  }
  if (generationPolicy.source !== '.ai/mcp + registrar surface catalog') {
    addGlobal('registry_generation_source_mismatch', { expected: '.ai/mcp + registrar surface catalog', actual: generationPolicy.source ?? null });
  }
  if (generationPolicy.note !== 'Every tool exposed by an enabled MCP surface is declared for action admission. The MCP surface remains responsible for command policy and mutation enforcement.') {
    addGlobal('registry_generation_note_mismatch');
  }
  if (typeof registry.generated_at !== 'string' || !Number.isFinite(Date.parse(registry.generated_at))) {
    addGlobal('registry_generated_at_invalid', { actual: registry.generated_at ?? null });
  }
  if (!Array.isArray(registry.surfaces)) {
    addGlobal('registry_surfaces_invalid', { actual_type: typeof registry.surfaces });
  }

  for (const surface of registrySurfaces) {
    const serverName = String(surface.server_name ?? '');
    if (!serverName) {
      addGlobal('registry_surface_server_name_missing', { surface_id: surface.surface_id ?? null });
      continue;
    }
    if (registryByServer.has(serverName)) {
      addGlobal('registry_surface_server_name_duplicate', { server_name: serverName });
      continue;
    }
    registryByServer.set(serverName, surface);
  }

  const fabricServers = discoverSiteMcpFabric(site);
  const fabricServerNames = new Set(fabricServers.map((server) => server.server_key));
  for (const registryServerName of registryByServer.keys()) {
    if (!fabricServerNames.has(registryServerName)) {
      addGlobal('registry_surface_not_in_fabric', { server_name: registryServerName });
    }
  }

  for (const server of fabricServers) {
    const surfaceViolations: JsonRecord[] = [];
    const actualSurface = registryByServer.get(server.server_key);
    const catalogSurfaceId = actualSurface
      ? String(actualSurface.catalog_surface_id ?? '')
      : (server.surface_id ?? fabricSurfaceId(server.server_key, site));
    const catalog = catalogSurface(catalogSurfaceId) ?? catalogSurfaceAlias(catalogSurfaceId);
    const rawFabricTools = readConfiguredServerToolsRaw(site, server);
    const fabricTools = uniqueStrings(rawFabricTools);
    const liveTools = observedToolsForSurface(observedToolsInput, server, actualSurface);
    const liveReadOnlyTools = observedToolsForSurface(observedReadOnlyToolsInput, server, actualSurface);
    const liveMutatingTools = observedToolsForSurface(observedMutatingToolsInput, server, actualSurface);
    const add = (layer: string, code: string, details: JsonRecord = {}) => {
      const violation = {
        layer,
        code,
        surface_id: actualSurface?.surface_id ?? `${server.server_key}.local`,
        server_name: server.server_key,
        catalog_surface_id: catalog?.id ?? catalogSurfaceId,
        ...details,
      };
      surfaceViolations.push(violation);
      violations.push(violation);
    };
    const compare = (layer: string, code: string, expected: string[], actual: string[]) => {
      if (sameStringSet(expected, actual)) return;
      add(layer, code, {
        missing: stringSetDifference(expected, actual),
        extra: stringSetDifference(actual, expected),
        expected_count: uniqueStrings(expected).length,
        actual_count: uniqueStrings(actual).length,
      });
    };

    if (!actualSurface) add('materialized_registry', 'registry_surface_missing');
    if (!catalog) add('registrar_catalog', 'catalog_surface_missing');
    if (liveTools === null) add('live_surface', 'live_tool_observation_missing');
    if (liveReadOnlyTools === null) add('live_surface', 'live_read_only_observation_missing');
    if (liveMutatingTools === null) add('live_surface', 'live_mutating_observation_missing');
    const duplicateFabricTools = duplicateStrings(rawFabricTools);
    if (duplicateFabricTools.length > 0) add('site_fabric', 'fabric_tools_duplicate', { duplicate_tools: duplicateFabricTools });
    if (liveTools !== null) {
      const duplicateLiveTools = duplicateStrings(liveTools);
      if (duplicateLiveTools.length > 0) add('live_surface', 'live_tools_duplicate', { duplicate_tools: duplicateLiveTools });
    }
    if (liveReadOnlyTools !== null) {
      const duplicateLiveReadOnlyTools = duplicateStrings(liveReadOnlyTools);
      if (duplicateLiveReadOnlyTools.length > 0) add('live_surface', 'live_read_only_tools_duplicate', { duplicate_tools: duplicateLiveReadOnlyTools });
    }
    if (liveMutatingTools !== null) {
      const duplicateLiveMutatingTools = duplicateStrings(liveMutatingTools);
      if (duplicateLiveMutatingTools.length > 0) add('live_surface', 'live_mutating_tools_duplicate', { duplicate_tools: duplicateLiveMutatingTools });
    }
    if (liveTools !== null && liveReadOnlyTools !== null && liveMutatingTools !== null) {
      compare('live_surface', 'live_tool_semantics_partition_incomplete', liveTools, [...liveReadOnlyTools, ...liveMutatingTools]);
      const liveOverlaps = uniqueStrings(liveReadOnlyTools.filter((tool) => liveMutatingTools.includes(tool)));
      if (liveOverlaps.length > 0) add('live_surface', 'live_tool_semantics_partition_overlap', { overlapping_tools: liveOverlaps });
    }

    if (liveTools !== null) {
      compare('site_fabric', 'fabric_tools_differ_from_live', liveTools, fabricTools);
      if (catalog) compare('registrar_catalog', 'catalog_tools_differ_from_live', liveTools, catalog.tools);
    }

    if (actualSurface) {
      const registeredTools = uniqueStrings(Array.isArray(actualSurface.registered_live_tools) ? actualSurface.registered_live_tools.map(String) : []);
      const contract = asRecord(actualSurface.tool_contract);
      const rawRegisteredTools = Array.isArray(actualSurface.registered_live_tools) ? actualSurface.registered_live_tools.map(String) : [];
      const rawReadOnlyTools = Array.isArray(contract.read_only_tools) ? contract.read_only_tools.map(String) : [];
      const rawMutatingTools = Array.isArray(contract.mutating_tools) ? contract.mutating_tools.map(String) : [];
      const rawRefusedTools = Array.isArray(contract.refused_tools) ? contract.refused_tools.map(String) : [];
      const readOnlyTools = uniqueStrings(rawReadOnlyTools);
      const mutatingTools = uniqueStrings(rawMutatingTools);
      const refusedTools = uniqueStrings(rawRefusedTools);
      const contractUnion = uniqueStrings([...readOnlyTools, ...mutatingTools, ...refusedTools]);
      const overlaps = uniqueStrings([
        ...readOnlyTools.filter((tool) => mutatingTools.includes(tool) || refusedTools.includes(tool)),
        ...mutatingTools.filter((tool) => refusedTools.includes(tool)),
      ]);
      const duplicateContractTools = {
        registered_live_tools: duplicateStrings(rawRegisteredTools),
        read_only_tools: duplicateStrings(rawReadOnlyTools),
        mutating_tools: duplicateStrings(rawMutatingTools),
        refused_tools: duplicateStrings(rawRefusedTools),
      };
      if (Object.values(duplicateContractTools).some((entries) => entries.length > 0)) {
        add('tool_contract', 'tool_contract_contains_duplicates', duplicateContractTools);
      }

      if (liveTools !== null) compare('materialized_registry', 'registered_tools_differ_from_live', liveTools, registeredTools);
      compare('materialized_registry', 'registered_tools_differ_from_fabric', fabricTools, registeredTools);
      if (catalog) compare('materialized_registry', 'registered_tools_differ_from_catalog', catalog.tools, registeredTools);
      compare('tool_contract', 'tool_contract_partition_incomplete', registeredTools, contractUnion);
      if (overlaps.length > 0) add('tool_contract', 'tool_contract_partition_overlap', { overlapping_tools: overlaps });
      if (refusedTools.length > 0) add('tool_contract', 'tool_contract_contains_external_refusals', { refused_tools: refusedTools });
      if (liveReadOnlyTools !== null) {
        compare('tool_contract', 'read_only_classification_differ_from_live', liveReadOnlyTools, readOnlyTools);
      }
      if (liveMutatingTools !== null) compare('tool_contract', 'mutating_classification_differ_from_live', liveMutatingTools, mutatingTools);

      const expectedSurface = registrySurfaceForFabricServer(site, server);
      for (const field of ['surface_id', 'display_name', 'server_name', 'authority_boundary', 'client_config', 'catalog_surface_id']) {
        if (canonicalJson(actualSurface[field]) !== canonicalJson(asRecord(expectedSurface)[field])) {
          add('materialized_registry', 'registry_surface_projection_drift', { field });
        }
      }
    }

    if (includeOk || surfaceViolations.length > 0) {
      surfaceResults.push({
        surface_id: actualSurface?.surface_id ?? `${server.server_key}.local`,
        server_name: server.server_key,
        catalog_surface_id: catalog?.id ?? catalogSurfaceId,
        status: surfaceViolations.length === 0 ? 'ok' : 'drift',
        violation_count: surfaceViolations.length,
        violations: surfaceViolations,
      });
    }
  }

  const outputReaderCheck = checkOutputReaderClosureForRegistry(registry, {
    site_id: site.site_id,
    site_root: site.root,
    registry_path: materializedSurfaceRegistryPathForRoot(site.root),
  });
  for (const rawViolation of Array.isArray(outputReaderCheck.violations) ? outputReaderCheck.violations : []) {
    const violation = { layer: 'output_reader_closure', code: 'output_reader_closure_violation', ...asRecord(rawViolation) };
    violations.push(violation);
  }

  return {
    schema: 'narada.registrar.site_registry_conformance_check.v1',
    status: violations.length === 0 ? 'ok' : 'drift',
    site_id: site.site_id,
    site_root: site.root,
    registry_path: materializedSurfaceRegistryPathForRoot(site.root),
    checked_surface_count: fabricServers.length,
    observed_surface_count: Object.keys(observedToolsInput).length,
    violation_count: violations.length,
    violations,
    surfaces: surfaceResults,
    output_reader_closure: outputReaderCheck,
  };
}

function registrarSiteRegistryConformanceCheck(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const site = lookupSite(siteId);
  const registryPath = materializedSurfaceRegistryPathForRoot(site.root);
  if (!existsSync(registryPath)) {
    throw diagnosticError('registrar_site_surface_registry_not_found', `registrar_site_surface_registry_not_found:${registryPath}`, { site_id: siteId, registry_path: registryPath });
  }
  let registry: JsonRecord;
  try {
    registry = asRecord(JSON.parse(readFileSync(registryPath, 'utf8')));
  } catch (error) {
    throw diagnosticError('registrar_site_surface_registry_parse_failed', `registrar_site_surface_registry_parse_failed:${registryPath}`, {
      site_id: siteId,
      registry_path: registryPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return checkSiteRegistryConformance(
    site,
    registry,
    asRecord(args.observed_tools),
    asRecord(args.observed_read_only_tools),
    asRecord(args.observed_mutating_tools),
    args.include_ok === true,
  );
}

type OutputReaderClosureContext = {
  site_id?: string;
  site_root?: string;
  registry_path?: string;
};

export function checkOutputReaderClosureForRegistry(registry: JsonRecord, context: OutputReaderClosureContext = {}): JsonRecord {
  const rawSurfaces = asRecord(registry).surfaces;
  const violations: JsonRecord[] = [];
  let producerRuleCount = 0;
  if (!Array.isArray(rawSurfaces)) {
    violations.push({
      site_id: context.site_id ?? null,
      site_root: context.site_root ?? null,
      registry_path: context.registry_path ?? null,
      surface_id: null,
      server_name: null,
      catalog_surface_id: null,
      producer_tool: null,
      required_reader_tool: null,
      violation: 'invalid_registry_surfaces',
    });
  } else {
    for (const rawSurface of rawSurfaces) {
      const surface = asRecord(rawSurface);
      const registeredTools = new Set(uniqueStrings(Array.isArray(surface.registered_live_tools) ? surface.registered_live_tools : []));
      const toolContract = asRecord(surface.tool_contract);
      const readOnlyTools = new Set(uniqueStrings(Array.isArray(toolContract.read_only_tools) ? toolContract.read_only_tools : []));
      const outputReaderClosure = outputReaderClosureForRegistrySurface(surface);
      producerRuleCount += Object.keys(outputReaderClosure).length;
      for (const [producerTool, requiredReaderTool] of Object.entries(outputReaderClosure)) {
        if (!registeredTools.has(producerTool)) continue;
        const base = {
          site_id: context.site_id ?? null,
          site_root: context.site_root ?? null,
          registry_path: context.registry_path ?? null,
          surface_id: String(surface.surface_id ?? ''),
          server_name: String(surface.server_name ?? ''),
          catalog_surface_id: String(surface.catalog_surface_id ?? ''),
          producer_tool: producerTool,
          required_reader_tool: requiredReaderTool,
        };
        if (!registeredTools.has(requiredReaderTool)) {
          violations.push({ ...base, violation: 'missing_registered_live_tool' });
        }
        if (!readOnlyTools.has(requiredReaderTool)) {
          violations.push({ ...base, violation: 'missing_read_only_admission' });
        }
      }
    }
  }
  return {
    schema: 'narada.registrar.output_reader_closure_check.v1',
    status: violations.length > 0 ? 'drift' : 'ok',
    site_id: context.site_id ?? null,
    site_root: context.site_root ?? null,
    registry_path: context.registry_path ?? null,
    checked_surface_count: Array.isArray(rawSurfaces) ? rawSurfaces.length : 0,
    producer_rule_count: producerRuleCount,
    violation_count: violations.length,
    violations,
  };
}

function outputReaderClosureForRegistrySurface(surface: JsonRecord): Record<string, string> {
  const catalogSurfaceId = typeof surface.catalog_surface_id === 'string' ? surface.catalog_surface_id : '';
  const registeredTools = uniqueStrings(Array.isArray(surface.registered_live_tools) ? surface.registered_live_tools : []);
  const resolvedCatalogSurface = catalogSurfaceId ? (catalogSurface(catalogSurfaceId) ?? catalogSurfaceAlias(catalogSurfaceId)) : null;
  if (resolvedCatalogSurface?.output_reader_closure) return resolvedCatalogSurface.output_reader_closure;
  const inferredSurface = SURFACES.find((candidate) => {
    if (!candidate.output_reader_closure) return false;
    return Object.keys(candidate.output_reader_closure).some((producerTool) => registeredTools.includes(producerTool));
  });
  return inferredSurface?.output_reader_closure ?? {};
}

function materializedSurfaceRegistryPathForRoot(siteRoot: string): string {
  const resolvedRoot = resolve(siteRoot);
  const normalizedRoot = resolvedRoot.replace(/\\/g, '/');
  const controlRoot = normalizedRoot.endsWith('/.narada') ? resolvedRoot : join(resolvedRoot, '.narada');
  return join(controlRoot, 'capabilities', 'mcp-surfaces.json');
}

function knownSiteIdForRoot(siteRoot: string): string | null {
  const requested = portablePath(siteRoot);
  const match = KNOWN_SITES.find((site) => {
    const siteRoot = portablePath(site.root);
    const controlRoot = portablePath(siteMcpControlRoot(site));
    return requested === siteRoot || requested === controlRoot;
  });
  return match?.site_id ?? null;
}

function registrarSiteOutputReaderClosureCheck(args: JsonRecord): JsonRecord {
  const includeOk = args.include_ok === true;
  const requested: OutputReaderClosureContext[] = [];
  const seenRegistryPaths = new Set<string>();

  function add(siteRoot: string, siteId?: string): void {
    const registryPath = materializedSurfaceRegistryPathForRoot(siteRoot);
    const normalizedRegistryPath = portablePath(registryPath);
    if (seenRegistryPaths.has(normalizedRegistryPath)) return;
    seenRegistryPaths.add(normalizedRegistryPath);
    requested.push({
      site_id: siteId ?? knownSiteIdForRoot(siteRoot) ?? undefined,
      site_root: resolve(siteRoot),
      registry_path: registryPath,
    });
  }

  const siteIds = uniqueStrings([
    ...(args.site_id ? [args.site_id] : []),
    ...(Array.isArray(args.site_ids) ? args.site_ids : []),
  ]);
  for (const siteId of siteIds) {
    const site = lookupSite(siteId);
    add(site.root, site.site_id);
  }

  const siteRoots = uniqueStrings([
    ...(args.site_root ? [args.site_root] : []),
    ...(Array.isArray(args.site_roots) ? args.site_roots : []),
  ]);
  for (const siteRoot of siteRoots) add(siteRoot);

  if (requested.length === 0) {
    throw diagnosticError('registrar_requires_site_for_output_reader_closure_check', 'registrar_requires_site_for_output_reader_closure_check', {
      expected: 'Pass site_id, site_ids, site_root, or site_roots.',
    });
  }

  const sites: JsonRecord[] = [];
  const violations: JsonRecord[] = [];
  let missingCount = 0;
  let driftCount = 0;
  let checkedSurfaceCount = 0;

  for (const context of requested) {
    const registryPath = requiredString(context.registry_path, 'registrar_internal_missing_registry_path');
    if (!existsSync(registryPath)) {
      missingCount++;
      const missing = {
        status: 'missing',
        site_id: context.site_id ?? null,
        site_root: context.site_root ?? null,
        registry_path: registryPath,
        violation: 'missing_registry',
      };
      sites.push(missing);
      continue;
    }
    const registry = readJsonFile(registryPath);
    if (!registry) {
      driftCount++;
      const invalid = {
        status: 'drift',
        site_id: context.site_id ?? null,
        site_root: context.site_root ?? null,
        registry_path: registryPath,
        violation: 'invalid_registry_json',
      };
      sites.push(invalid);
      violations.push(invalid);
      continue;
    }
    const check = checkOutputReaderClosureForRegistry(registry, context);
    checkedSurfaceCount += Number(check.checked_surface_count ?? 0);
    if (check.status === 'drift') driftCount++;
    violations.push(...((check.violations as JsonRecord[] | undefined) ?? []));
    if (check.status !== 'ok' || includeOk) sites.push(check);
  }

  return {
    schema: 'narada.registrar.site_output_reader_closure_check.v1',
    status: driftCount > 0 ? 'drift' : missingCount > 0 ? 'missing' : 'ok',
    checked_site_count: requested.length,
    checked_surface_count: checkedSurfaceCount,
    missing_count: missingCount,
    drift_count: driftCount,
    violation_count: violations.length,
    violations,
    sites,
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
  return `${siteSurfacePrefix(siteId)}-${surfaceId}`;
}

function siteSurfacePrefix(siteId: string): string {
  return siteId.startsWith('narada-') ? siteId : `narada-${siteId}`;
}

function legacySiteSurfaceServerKey(siteId: string, surfaceId: string): string {
  return `${siteId.replace('narada-', '')}-${surfaceId}`;
}

export function buildSiteBindConfig(site: SiteDef, surface: SurfaceDef): { fileName: string; serverKey: string; config: JsonRecord } {
  const siteId = site.site_id;
  const surfaceId = surface.id;
  const serverKey = siteSurfaceServerKey(siteId, surfaceId);
  const fileName = `${siteSurfacePrefix(siteId)}-${surfaceId}-mcp.json`;
  const resolvedArgs = interpolateArgs(surface.args, siteId, site.root);
  const resolvedEntrypoint = resolveEntrypoint(surface, siteId, site.root);
  const scopeMetadata = surfaceScopeMetadata(surfaceId, site.root);
  const naradaScope = naradaScopeMetadata(surfaceId, site.root, siteId);
  if (surfaceId === 'sop') appendSopsDirs(resolvedArgs);
  const launch = carrierLaunchCommand({
    kind: 'shared',
    entrypoint: resolvedEntrypoint,
    args: resolvedArgs,
    surface,
    ...scopeMetadata,
    narada_scope: naradaScope,
  }, surfaceId);

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
          command: launch.command,
          args: launch.args,
          tools: surface.tools,
          env_vars: uniqueStrings(['NARADA_AGENT_ID', 'NARADA_AGENT_START_EVENT_ID', 'NARADA_CARRIER_SESSION_ID', 'NARADA_SITE_ROOT', ...(surface.env_vars ?? [])]),
          surface_id: surfaceId,
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
      const fabricSurfaceIds = new Set(discoverSiteMcpFabric(site).map((server) => server.surface_id ?? fabricSurfaceId(server.server_key, site)));
      if (site.surfaces.includes(surfaceId) || fabricSurfaceIds.has(surfaceId)) {
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
  launch_entrypoint: string;
  uses_runtime_proxy: boolean;
  surface_id?: string;
  narada_scope: NaradaScopeMetadata;
  source_file: string;
};

function unwrapRuntimeProxyLaunch(entrypoint: string, args: string[]): { entrypoint: string; args: string[]; usesRuntimeProxy: boolean; launchEntrypoint: string } {
  const launchEntrypoint = entrypoint;
  if (portablePath(entrypoint) !== portablePath(MCP_RUNTIME_PROXY_ENTRYPOINT)) {
    return { entrypoint, args, usesRuntimeProxy: false, launchEntrypoint };
  }
  const entrypointIndex = args.indexOf('--entrypoint');
  const separatorIndex = args.indexOf('--');
  const childEntrypoint = entrypointIndex >= 0 ? args[entrypointIndex + 1] : '';
  const childArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
  return { entrypoint: childEntrypoint, args: childArgs, usesRuntimeProxy: true, launchEntrypoint };
}

function portablePath(path: string): string {
  return resolve(path).replace(/\\/g, '/');
}

function siteMcpControlRoot(site: SiteDef): string {
  if (site.root.replace(/\\/g, '/').endsWith('/.narada')) return site.root;
  if (existsSync(join(site.root, '.ai', 'mcp'))) return site.root;
  const nestedControlRoot = sitePathInterpolation(site.root).siteControlRoot;
  if (existsSync(join(nestedControlRoot, '.ai', 'mcp'))) return nestedControlRoot;
  return site.root;
}

function discoverSiteMcpFabric(site: SiteDef): SiteMcpFabricServer[] {
  const controlRoot = siteMcpControlRoot(site);
  const configDir = join(controlRoot, '.ai', 'mcp');
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
      entrypoint = entrypoint.replace(/\{site_root\}/g, controlRoot);
      const resolvedArgs = args.map((a) => a.replace(/\{site_root\}/g, controlRoot));
      const unwrapped = unwrapRuntimeProxyLaunch(entrypoint, resolvedArgs);
      servers.push({
        server_key: serverKey,
        command: Array.isArray(command) ? String(command[0] ?? 'node') : String(command),
        args: unwrapped.args,
        entrypoint: unwrapped.entrypoint,
        launch_entrypoint: unwrapped.launchEntrypoint,
        uses_runtime_proxy: unwrapped.usesRuntimeProxy,
        surface_id: server.surface_id ? String(server.surface_id) : undefined,
        narada_scope: readNaradaScope(server, surfaceId, controlRoot, site.site_id),
        source_file: file,
      });
    }
  }
  return servers;
}

function fabricSurfaceId(serverKey: string, site: SiteDef): string {
  const canonicalPrefix = siteSurfacePrefix(site.site_id);
  if (serverKey.startsWith(`${canonicalPrefix}-`)) {
    const rest = serverKey.slice(canonicalPrefix.length + 1);
    const known = SURFACES.find((s) => s.id === rest);
    if (known) return known.id;
    const alias = catalogSurfaceAlias(rest);
    if (alias) return alias.id;
  }
  const prefix = site.site_id.replace('narada-', '');
  if (serverKey.startsWith(`${prefix}-`)) {
    const rest = serverKey.slice(prefix.length + 1);
    const known = SURFACES.find((s) => s.id === rest);
    if (known) return known.id;
    const alias = catalogSurfaceAlias(rest);
    if (alias) return alias.id;
  }
  return serverKey;
}

function catalogSurfaceAlias(surfaceId: string): SurfaceDef | undefined {
  if (surfaceId === 'inbox') return catalogSurface('site-inbox');
  return undefined;
}

type SiteSurfaceRegistrySurface = {
  surface_id: string;
  display_name: string;
  server_name: string;
  authority_boundary: JsonRecord;
  client_config: JsonRecord;
  tool_contract: {
    read_only_tools: string[];
    mutating_tools: string[];
    refused_tools: string[];
  };
  registered_live_tools: string[];
  catalog_surface_id: string;
};

function registrySurfaceForFabricServer(site: SiteDef, server: SiteMcpFabricServer): SiteSurfaceRegistrySurface {
  const surfaceId = server.surface_id ?? fabricSurfaceId(server.server_key, site);
  const catalog = catalogSurface(surfaceId) ?? catalogSurfaceAlias(surfaceId);
  const registeredTools = uniqueStrings(catalog?.tools ?? readConfiguredServerTools(site, server));
  const toolContract = surfaceToolContract(catalog?.id ?? surfaceId, registeredTools);
  return {
    surface_id: `${server.server_key}.local`,
    display_name: server.server_key,
    server_name: server.server_key,
    authority_boundary: {
      posture: 'registrar_generated_runtime_surface_registry',
      grants_tool_authority: true,
      granted_tool_authority_kind: 'declared_enabled_mcp_surface_tools',
      source: 'site_mcp_fabric_and_registrar_catalog',
    },
    client_config: {
      generated_path: `.ai/mcp/${server.source_file}`,
      generated_file: server.source_file,
    },
    tool_contract: toolContract,
    registered_live_tools: registeredTools,
    catalog_surface_id: catalog?.id ?? surfaceId,
  };
}

function readConfiguredServerToolsRaw(site: SiteDef, server: SiteMcpFabricServer): string[] {
  const filePath = join(siteMcpControlRoot(site), '.ai', 'mcp', server.source_file);
  const cfg = readJsonFile(filePath);
  const rawServer = asRecord(asRecord(cfg?.mcpServers)[server.server_key]);
  return Array.isArray(rawServer.tools) ? rawServer.tools.map(String) : [];
}

function readConfiguredServerTools(site: SiteDef, server: SiteMcpFabricServer): string[] {
  return uniqueStrings(readConfiguredServerToolsRaw(site, server));
}

function surfaceToolContract(surfaceId: string, registeredTools: string[]): SiteSurfaceRegistrySurface['tool_contract'] {
  const readOnlyTools = uniqueStrings(READ_ONLY_TOOLS_BY_SURFACE[surfaceId] ?? [])
    .filter((tool) => registeredTools.includes(tool));
  const refusedTools = uniqueStrings(REFUSED_TOOLS_BY_SURFACE[surfaceId] ?? [])
    .filter((tool) => registeredTools.includes(tool));
  const classified = new Set([...readOnlyTools, ...refusedTools]);
  return {
    read_only_tools: readOnlyTools,
    mutating_tools: registeredTools.filter((tool) => !classified.has(tool)),
    refused_tools: refusedTools,
  };
}

export function buildSiteSurfaceRegistry(site: SiteDef): JsonRecord {
  const servers = discoverSiteMcpFabric(site);
  const surfaces = servers
    .map((server) => registrySurfaceForFabricServer(site, server))
    .filter((surface) => surface.registered_live_tools.length > 0)
    .sort((a, b) => a.server_name.localeCompare(b.server_name));
  return {
    schema: 'narada.site.capabilities.mcp_surfaces.v1',
    site_id: site.site_id,
    generated_by: 'mcp-registrar',
    generated_at: new Date().toISOString(),
    generation_policy: {
      source: '.ai/mcp + registrar surface catalog',
      mode: 'enabled_surface_tool_authority',
      note: 'Every tool exposed by an enabled MCP surface is declared for action admission. The MCP surface remains responsible for command policy and mutation enforcement.',
    },
    surfaces,
  };
}

function writeSiteSurfaceRegistry(site: SiteDef): JsonRecord {
  const registry = buildSiteSurfaceRegistry(site);
  const dir = join(siteMcpControlRoot(site), 'capabilities');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mcp-surfaces.json');
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  return {
    status: 'synced',
    site_id: site.site_id,
    path,
    surface_count: Array.isArray(registry.surfaces) ? registry.surfaces.length : 0,
    tool_count: Array.isArray(registry.surfaces)
      ? registry.surfaces.reduce((sum, surface) => {
        const tools = asRecord(surface).registered_live_tools;
        return sum + (Array.isArray(tools) ? tools.length : 0);
      }, 0)
      : 0,
  };
}

function registrarSiteSurfaceRegistrySync(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const site = lookupSite(siteId);
  const registry = buildSiteSurfaceRegistry(site);
  if (args.dry_run === true) {
    return {
      status: 'dry_run',
      site_id: siteId,
      path: join(siteMcpControlRoot(site), 'capabilities', 'mcp-surfaces.json'),
      registry,
    };
  }
  return writeSiteSurfaceRegistry(site);
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
  const presentSurfaceIds = new Set<string>();
  for (const server of servers) {
    const surfaceId = fabricSurfaceId(server.server_key, site);
    presentSurfaceIds.add(server.surface_id ?? surfaceId);
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
    addRuntimePreflightFindings(add, includeOk, {
      site_id: siteId,
      server_key: server.server_key,
      entrypoint: resolvedEntrypoint,
      source_file: server.source_file,
      surface_id: surfaceId,
      ...scopeDetail,
    }, SURFACES.find((surface) => surface.id === surfaceId) ?? null, server.uses_runtime_proxy);

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
    if (['agent-context', 'task-lifecycle', 'site-inbox', 'site-loop', 'mailbox', 'graph-mail', 'surface-feedback', 'delegated-task'].includes(surfaceId)) {
      const hasSiteRoot = server.args.some((a) => a === '--site-root');
      if (!hasSiteRoot) {
        add('warning', 'registrar_site_fabric_missing_site_root', `Surface '${surfaceId}' on '${server.server_key}' is missing --site-root`, { site_id: siteId, server_key: server.server_key, surface_id: surfaceId, source_file: server.source_file, ...scopeDetail });
      } else if (includeOk) {
        add('info', 'registrar_site_fabric_site_root_ok', `Surface '${surfaceId}' on '${server.server_key}' has --site-root`, { site_id: siteId, server_key: server.server_key, surface_id: surfaceId, source_file: server.source_file, ...scopeDetail });
      }
    }
  }

  for (const surface of SURFACES) {
    if (surface.injection_scope !== 'local_site' || surface.default_injection !== 'all_site_bound_sessions') continue;
    if (presentSurfaceIds.has(surface.id)) continue;
    add('error', 'registrar_site_fabric_missing_default_surface', `Default local Site surface '${surface.id}' is missing from runtime-authoritative Site MCP fabric`, {
      site_id: siteId,
      surface_id: surface.id,
      default_injection: surface.default_injection,
      injection_scope: surface.injection_scope,
      expected_server_key: siteSurfaceServerKey(siteId, surface.id),
      required_repair_locus: { kind: 'local_site', site_root: site.root },
      remediation: `Materialize '${surface.id}' into ${join(site.root, '.ai', 'mcp')} before launching Site-bound NARS/agent sessions.`,
    });
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
      throw diagnosticError('registrar_single_surface_bind_unsupported_for_opencode_aggregate', 'registrar_single_surface_bind_unsupported_for_opencode_aggregate');
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
      throw diagnosticError('registrar_single_surface_unbind_unsupported_for_opencode_aggregate', 'registrar_single_surface_unbind_unsupported_for_opencode_aggregate');
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

function kimiBind(configPath: string, surfaceId: string, entrypoint: string, resolvedArgs: string[]): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcpServers);
  const serverKey = `narada-andrey-${surfaceId}`;
  if (mcp[serverKey]) return { status: 'already_bound', carrier_id: 'kimi-andrey', surface_id: surfaceId, server_key: serverKey };
  const surface = lookupSurface(surfaceId);
  const launch = carrierLaunchCommand({ kind: 'shared', entrypoint, args: resolvedArgs, surface, ...naradaScopeMetadata(surfaceId, entrypoint, 'narada-andrey'), narada_scope: naradaScopeMetadata(surfaceId, entrypoint, 'narada-andrey') }, surfaceId);
  mcp[serverKey] = {
    transport: 'stdio',
    command: launch.command,
    args: launch.args,
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
  const surface = lookupSurface(surfaceId);
  const launch = carrierLaunchCommand({ kind: 'shared', entrypoint, args: resolvedArgs, surface, ...naradaScopeMetadata(surfaceId, entrypoint, 'narada-andrey'), narada_scope: naradaScopeMetadata(surfaceId, entrypoint, 'narada-andrey') }, surfaceId);
  content += `\n${sectionKey}\ncommand = "${launch.command}"\nargs = ${JSON.stringify(launch.args)}\n`;
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
      try { results.push(registrarSiteBind({ site_id: site.site_id, surface_id: surfaceId, allow_sidecar: args.allow_sidecar === true })); }
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
