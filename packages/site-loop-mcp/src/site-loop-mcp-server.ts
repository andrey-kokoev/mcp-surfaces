#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  affordanceToolAction,
  createAffordanceDocument,
  validateAffordanceDocument,
  type AffordanceAction,
  type AffordancePanel,
} from '@narada2/mcp-affordances';
import {
  buildBoundedToolResult,
  listOutputResources,
  outputShow,
  readOutputResource,
} from '@narada2/mcp-transport';
import { loadSiteLoopConfig, siteLoopConfigJsonSchema } from './site-loop/site-loop-config.js';
import { siteLoopDependencyBoundaries } from './site-loop/site-loop-boundary.js';
let siteLoopModulePromise = null;
type SiteOpsServerArgs = Record<string, unknown>;
type SiteLoopToolArgs = SiteOpsServerArgs;
type LoopControlToolArgs = SiteOpsServerArgs;
type SiteOpsRequestContext = { abortSignal?: AbortSignal };
type SiteOpsChildResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
};

const SERVER_NAME = 'narada-site-loop-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2026-04-18';
const INLINE_RESULT_BYTE_LIMIT = 6000;
const options = parseArgs(process.argv.slice(2));
const siteRoot = resolve(String(options.siteRoot ?? process.cwd()));

function currentSiteLoopConfigLoad() {
  return loadSiteLoopConfig(siteRoot);
}

const READ_ONLY_TOOL_NAMES = new Set([
  'site_loop_guidance',
  'site_loop_doctor',
  'site_docs_list',
  'site_docs_show',
  'site_test_list',
  'site_loop_config_validate',
  'site_loop_operator_affordances',
  'site_loop_status',
  'site_loop_unified_status',
  'site_loop_recovery_plan',
  'site_loop_health',
  'site_loop_operating_status',
  'site_loop_proof_status',
  'site_loop_readiness',
  'site_loop_coherence',
  'site_loop_runs_list',
  'site_loop_run_show',
  'site_loop_output_show',
  'site_loop_attention_list',
  'site_loop_attention_show',
]);

const MUTATING_TOOL_NAMES = new Set([
  'site_test_run',
  'site_loop_proof_run',
  'site_loop_recovery_drill',
  'site_loop_attention_ack',
  'site_loop_control_set',
  'site_loop_run_once',
]);

const TOOLS = [
  guidanceToolDefinition(),
  tool('site_loop_doctor', 'Inspect configured Site Loop MCP readiness.', {}),
  tool('site_docs_list', 'List configured read-only documentation paths exposed to agents.', {}),
  tool('site_docs_show', 'Show a configured allowlisted documentation file.', {
    path: { type: 'string', description: 'Allowlisted docs path from site_docs_list.' },
  }, ['path']),
  tool('site_test_list', 'List approved local test selectors.', {}),
  tool('site_test_run', 'Run one approved local test selector; no arbitrary shell is accepted.', {
    selector: { type: 'string', description: 'Approved selector from site_test_list.' },
  }, ['selector']),
  tool('site_loop_config_validate', 'Validate the site-loop config file and report schema/semantic diagnostics without running the loop.', {}),
  tool('site_loop_operator_affordances', 'Return UI-neutral operator affordances for rendering Site Loop status, attention, controls, and recovery actions.', {}),
  tool('site_loop_status', 'Show configured Site Operating Loop status.', {}),
  tool('site_loop_unified_status', 'Show unified configured site-loop status: scheduled launcher, supervisor PID files, logical loop control, health, and useful-work posture.', {
    task_name: { type: 'string', description: 'Scheduled task name. Defaults to the configured site-loop scheduler task.' },
  }),
  tool('site_loop_recovery_plan', 'Return a safe operator recovery plan for the configured site loop without mutating state.', {
    task_name: { type: 'string', description: 'Scheduled task name. Defaults to the configured site-loop scheduler task.' },
    include_commands: { type: 'boolean', description: 'Include concrete operator commands. Defaults true.' },
  }),
  tool('site_loop_health', 'Show configured Site Operating Loop health.', {}),
  tool('site_loop_operating_status', 'Show composed operating-layer status for the configured site loop.', {
    limit: { type: 'number', description: 'Pending/directive row limit.' },
  }),
  tool('site_loop_proof_status', 'Show proof freshness and configured proof commands without running proof workflows.', {}),
  tool('site_loop_proof_run', 'Run a controlled resident or mailbox proof workflow through the configured Site Loop proof engine.', {
    proof_kind: { type: 'string', enum: ['resident_production', 'controlled_mailbox'], description: 'Proof workflow to run.' },
    controlled_mailbox_source: { type: 'string', description: 'Required for controlled_mailbox proof. Source ref used to identify new controlled mailbox work.' },
    wait_for_completion: { type: 'boolean', description: 'Wait synchronously for proof completion. Refused when timeout exceeds the MCP transport budget.' },
    timeout_ms: { type: 'number', description: 'Maximum proof wait time in milliseconds.' },
    poll_ms: { type: 'number', description: 'Polling interval in milliseconds.' },
    limit: { type: 'number', description: 'Site Loop processing limit during proof.' },
    ensure_resident: { type: 'boolean', description: 'Ensure the configured resident carrier before dispatch.' },
    require_live_carrier: { type: 'boolean', description: 'Require live carrier rather than fixture simulation.' },
  }, ['proof_kind']),
  tool('site_loop_recovery_drill', 'Retire the current resident carrier, require a replacement live carrier, run a production resident proof, and clean up the deterministic fixture.', {
    id: { type: 'string', description: 'Deterministic recovery-drill fixture id.' },
    reason: { type: 'string', description: 'Operator-approved reason for retiring the current resident carrier.' },
    title: { type: 'string', description: 'Optional fixture title.' },
    summary: { type: 'string', description: 'Optional fixture summary.' },
    timeout_ms: { type: 'number', description: 'Maximum recovery proof wait in milliseconds.' },
    poll_ms: { type: 'number', description: 'Recovery proof polling interval in milliseconds.' },
  }, ['reason']),
  tool('site_loop_readiness', 'Evaluate unattended-operation readiness gates for the configured site loop.', {
    require_production: { type: 'boolean', description: 'Require production proof, not only transport proof.' },
  }),
  tool('site_loop_coherence', 'Evaluate strict coherence blockers for the configured site loop.', {
    require_production: { type: 'boolean', description: 'Require production proof.' },
    require_mailbox_chain: { type: 'boolean', description: 'Require mailbox-chain proof.' },
  }),
  tool('site_loop_runs_list', 'List recent configured Site Operating Loop runs.', {
    limit: { type: 'number', description: 'Maximum runs to return.' },
  }),
  tool('site_loop_run_show', 'Show a Site Operating Loop run by run id.', {
    run_id: { type: 'string', description: 'Loop run id.' },
    detail: { type: 'string', enum: ['summary', 'full'], description: 'summary returns bounded step/evidence summaries and is the default. full returns the complete stored run and may be materialized as an output ref.' },
    include_evidence_preview: { type: 'boolean', description: 'Include short bounded evidence previews in summary mode. Defaults false.' },
    evidence_preview_chars: { type: 'number', description: 'Maximum evidence preview characters per step in summary mode. Capped at 1000.' },
  }, ['run_id']),
  tool('site_loop_output_show', 'Read a materialized Site Loop MCP output ref with offset/limit paging.', {
    ref: { type: 'string', description: 'Output ref returned by a Site Loop MCP tool.' },
    output_ref: { type: 'string', description: 'Alias for ref.' },
    offset: { type: 'number', description: 'Character offset into the materialized output.' },
    limit: { type: 'number', description: 'Maximum characters to return.' },
  }),
  tool('site_loop_attention_list', 'List configured loop attention records.', {
    status: { type: 'string', description: 'Optional attention status filter.' },
    limit: { type: 'number', description: 'Maximum attention records.' },
  }),
  tool('site_loop_attention_show', 'Show one loop attention record.', {
    attention_id: { type: 'string', description: 'Attention id.' },
  }, ['attention_id']),
  tool('site_loop_attention_ack', 'Acknowledge one loop attention record.', {
    attention_id: { type: 'string', description: 'Attention id.' },
    reason: { type: 'string', description: 'Acknowledgement reason.' },
    acknowledged_by: { type: 'string', description: 'Acknowledging principal.' },
  }, ['attention_id', 'reason']),
  tool('site_loop_control_set', 'Set configured loop control flags.', {
    enabled: { type: 'boolean', description: 'Enable or disable loop execution.' },
    paused: { type: 'boolean', description: 'Pause or unpause loop execution.' },
    reason: { type: 'string', description: 'Reason for the control change.' },
    changed_by: { type: 'string', description: 'Principal changing loop control.' },
  }, ['reason']),
  tool('site_loop_run_once', 'Run one bounded configured site loop pass.', {
    dry_run: { type: 'boolean', description: 'Plan/read without mutation.' },
    wait_for_completion: { type: 'boolean', description: 'Required for mutating MCP execution. Long-running loop passes should use the site scheduler/supervisor, not this synchronous MCP call.' },
    timeout_ms: { type: 'number', description: 'Maximum synchronous wait budget. Values over 10000 are refused before side effects.' },
    test_authority: { type: 'boolean', description: 'Run non-dry work against the configured test authority root instead of production state.' },
    limit: { type: 'number', description: 'Processing limit.' },
    drain: { type: 'boolean', description: 'Drain eligible intake when supported.' },
    source_sync: { type: 'boolean', description: 'Request source sync before loop processing.' },
    ensureResident: { type: 'boolean', description: 'Ensure the configured resident carrier before dispatch when allowed.' },
    requireLiveCarrier: { type: 'boolean', description: 'Require a live resident carrier for dispatch. Set false for fixture/test-authority runs.' },
  }),
].map((tool) => ({ ...tool, annotations: toolAnnotations(tool.name), outputSchema: genericToolOutputSchema() }));

function toolAnnotations(name: string) {
  const readOnly = READ_ONLY_TOOL_NAMES.has(name);
  const mutating = MUTATING_TOOL_NAMES.has(name);
  if (readOnly === mutating) {
    throw new Error(`site_loop_tool_semantics_not_explicit:${name}`);
  }
  return {
    title: name,
    readOnlyHint: readOnly,
    destructiveHint: name === 'site_loop_control_set',
    idempotentHint: readOnly,
    openWorldHint: true,
    deprecatedHint: false,
  };
}

function renderRecoveryTemplate(template: string, values: { siteRoot: string; taskName: string }) {
  return template
    .replaceAll('{site_root}', values.siteRoot)
    .replaceAll('{task_name}', values.taskName);
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

let inputBuffer = '';
const activeRequests = new Map<string, AbortController>();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  processInputBuffer();
});

function parseArgs(argv) {
  const parsed: SiteOpsServerArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function processInputBuffer() {
  while (true) {
    const framedBody = readFramedMessage();
    if (framedBody !== null) {
      handleMessage(JSON.parse(framedBody));
      continue;
    }

    if (/^Content-Length:/i.test(inputBuffer)) return;

    const lineEnd = inputBuffer.indexOf('\n');
    if (lineEnd === -1) return;
    const line = inputBuffer.slice(0, lineEnd).trim();
    inputBuffer = inputBuffer.slice(lineEnd + 1);
    if (!line) continue;
    handleMessage(JSON.parse(line));
  }
}

function readFramedMessage() {
  const crlfHeaderEnd = inputBuffer.indexOf('\r\n\r\n');
  const lfHeaderEnd = inputBuffer.indexOf('\n\n');
  const headerEnd = crlfHeaderEnd !== -1 ? crlfHeaderEnd : lfHeaderEnd;
  if (headerEnd === -1) return null;

  const separatorLength = crlfHeaderEnd !== -1 ? 4 : 2;
  const header = inputBuffer.slice(0, headerEnd);
  const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
  if (!match) return null;

  const length = Number(match[1]);
  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + length;
  if (inputBuffer.length < bodyEnd) return null;

  const body = inputBuffer.slice(bodyStart, bodyEnd);
  inputBuffer = inputBuffer.slice(bodyEnd);
  return body;
}

async function handleMessage(message) {
  if (!message?.id && message?.method === 'notifications/cancelled') {
    const requestId = String(message.params?.requestId ?? '');
    activeRequests.get(requestId)?.abort();
    return;
  }
  if (!message?.id && typeof message?.method === 'string' && message.method.startsWith('notifications/')) return;
  const id = message?.id ?? null;
  const requestId = id == null ? null : String(id);
  const abortController = requestId == null ? null : new AbortController();
  if (requestId) activeRequests.set(requestId, abortController);
  try {
    sendProgress(message, 0, 'started');
    if (message.method === 'initialize') {
      respond(id, {
        protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {}, completions: {}, logging: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    if (message.method === 'tools/list') {
      respond(id, { tools: TOOLS });
      return;
    }
    if (message.method === 'tools/call') {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {}, { abortSignal: abortController?.signal });
      respond(id, toolResult(result, String(message.params?.name ?? 'unknown_tool')));
      return;
    }
    if (message.method === 'resources/list') {
      respond(id, listOutputResources({ siteRoot }));
      return;
    }
    if (message.method === 'resources/read') {
      respond(id, readOutputResource({ siteRoot, uri: message.params?.uri }));
      return;
    }
    if (message.method === 'prompts/list') {
      respond(id, { prompts: listPrompts() });
      return;
    }
    if (message.method === 'prompts/get') {
      respond(id, promptGet(message.params ?? {}));
      return;
    }
    if (message.method === 'completion/complete') {
      respond(id, completeArgument(message.params ?? {}));
      return;
    }
    if (message.method === 'logging/setLevel') {
      respond(id, {});
      return;
    }
    respondError(id, new Error(`unsupported_method: ${message.method}`));
  } catch (error) {
    respondError(id, error);
  } finally {
    sendProgress(message, 1, abortController?.signal.aborted ? 'cancelled' : 'completed');
    if (requestId) activeRequests.delete(requestId);
  }
}

function listPrompts() {
  return [
    { name: 'site_loop_workflow', title: 'Site Loop Workflow', description: 'Guidance for Site Loop tools.', arguments: [] },
  ];
}

function promptGet(params) {
  const name = String(params.name ?? '');
  if (name !== 'site_loop_workflow') throw new Error(`unknown_prompt: ${name}`);
  return {
    description: 'Guidance for Site Loop tools.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Inspect readiness, health, and coherence before running site operations or changing loop control flags.' } }],
  };
}

function completeArgument(params) {
  const argumentName = String((params.argument && typeof params.argument === 'object' ? params.argument.name : '') ?? '');
  const values = argumentName === 'name' ? TOOLS.map((tool) => tool.name).filter(Boolean).slice(0, 100) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

function assistantTextContent(text: string) {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
}

function toolResult(value: unknown, toolName: string) {
  return buildBoundedToolResult({
    siteRoot,
    toolName,
    value,
    limit: INLINE_RESULT_BYTE_LIMIT,
    readerTool: 'site_loop_output_show',
  });
}

async function callTool(name, args, context: SiteOpsRequestContext = {}) {
  if (name !== 'site_loop_guidance' && name !== 'site_loop_doctor' && name !== 'site_loop_config_validate' && name !== 'site_loop_output_show') {
    requireActiveSiteLoopConfig();
  }
  switch (name) {
    case 'site_loop_guidance':
      return buildGuidanceResult(args);
    case 'site_loop_doctor': {
      const loaded = currentSiteLoopConfigLoad();
      const config = loaded.config;
      return {
        status: 'ok',
        site_root: siteRoot,
        server_name: SERVER_NAME,
        site_loop_config: {
          status: loaded.status,
          path: loaded.path,
          loop_id: config.loop_id,
          display_name: config.display_name,
          errors: loaded.errors,
        },
        dependency_boundaries: siteLoopDependencyBoundaries(),
        read_only_docs: config.docs.length,
        approved_tests: Object.keys(config.tests),
        site_loop_tools: TOOLS.filter((item) => item.name.startsWith('site_loop_')).map((item) => item.name),
      };
    }
    case 'site_loop_config_validate': {
      const loaded = currentSiteLoopConfigLoad();
      const config = loaded.config;
      const schema = siteLoopConfigJsonSchema();
      return {
        schema: 'narada.site_loop.config_validation.v1',
        status: loaded.status,
        site_root: siteRoot,
        path: loaded.path,
        schema_id: typeof schema.$id === 'string' ? schema.$id : null,
        config_schema: config.schema,
        loop_id: config.loop_id,
        site_id: config.site_id,
        display_name: config.display_name,
        errors: loaded.errors,
        active_tools_refuse: loaded.status !== 'ok',
      };
    }
    case 'site_loop_operator_affordances':
      return siteLoopOperatorAffordances();
    case 'site_docs_list':
      return { status: 'ok', site_root: siteRoot, docs: activeDocs() };
    case 'site_docs_show':
      return showDoc(args.path);
    case 'site_test_list':
      return {
        status: 'ok',
        site_root: siteRoot,
        tests: Object.entries(activeTests()).map(([selector, command]) => ({
          selector,
          command: [command.command, ...command.args].join(' '),
        })),
      };
    case 'site_test_run':
      return runTest(args.selector, context);
    case 'site_loop_status':
      return (await loadSiteLoopModule()).siteLoopStatus(siteRoot);
    case 'site_loop_unified_status':
      return unifiedSiteLoopStatus(args);
    case 'site_loop_recovery_plan':
      return siteLoopRecoveryPlan(args);
    case 'site_loop_health':
      return (await loadSiteLoopModule()).siteLoopHealth(siteRoot);
    case 'site_loop_operating_status':
      return (await loadSiteLoopModule()).siteLoopOperatingLayerStatus(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_proof_status':
      return (await loadSiteLoopModule()).siteLoopProofStatus(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_proof_run':
      return (await loadSiteLoopModule()).runSiteResidentE2E(siteRoot, normalizeProofRunOptions(args));
    case 'site_loop_recovery_drill':
      return (await loadSiteLoopModule()).runSiteResidentRecoveryDrill(siteRoot, normalizeRecoveryDrillOptions(args));
    case 'site_loop_readiness':
      return (await loadSiteLoopModule()).siteLoopReadiness(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_coherence':
      return (await loadSiteLoopModule()).siteLoopCoherence(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_runs_list':
      return (await loadSiteLoopModule()).listSiteLoopRuns(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_run_show':
      return (await loadSiteLoopModule()).showSiteLoopRun(siteRoot, args);
    case 'site_loop_output_show':
      return outputShow({ siteRoot, args });
    case 'site_loop_attention_list':
      return (await loadSiteLoopModule()).listSiteLoopAttention(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_attention_show':
      return (await loadSiteLoopModule()).showSiteLoopAttention(siteRoot, args.attention_id);
    case 'site_loop_attention_ack':
      return (await loadSiteLoopModule()).ackSiteLoopAttention(siteRoot, args.attention_id, normalizeLoopOptions(args));
    case 'site_loop_control_set':
      return (await loadSiteLoopModule()).setSiteLoopControl(siteRoot, normalizeLoopControl(args));
    case 'site_loop_run_once':
      assertRunOnceTransportBudget(args);
      return (await loadSiteLoopModule()).runSiteLoop(siteRoot, normalizeLoopOptions(args));
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
}

function siteLoopOperatorAffordances() {
  const config = requireActiveSiteLoopConfig();
  const actions: AffordanceAction[] = [
    affordanceToolAction({
      id: 'refresh_unified_status',
      label: 'Refresh status',
      intent: 'refresh',
      tool: 'site_loop_unified_status',
      arguments: { task_name: config.scheduler.default_task_name },
      description: 'Refresh scheduled launcher, loop control, health, and useful-work posture.',
      audience: ['operator', 'agent'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
    }),
    affordanceToolAction({
      id: 'check_readiness',
      label: 'Check readiness',
      intent: 'inspect',
      tool: 'site_loop_readiness',
      arguments: { require_production: false },
      description: 'Evaluate unattended-operation readiness gates.',
      audience: ['operator', 'agent'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
    }),
    affordanceToolAction({
      id: 'check_coherence',
      label: 'Check coherence',
      intent: 'inspect',
      tool: 'site_loop_coherence',
      arguments: { require_production: false, require_mailbox_chain: false },
      description: 'Evaluate strict Site Loop coherence blockers.',
      audience: ['operator', 'agent'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
    }),
    affordanceToolAction({
      id: 'list_attention',
      label: 'List attention',
      intent: 'inspect',
      tool: 'site_loop_attention_list',
      arguments: { limit: 25 },
      description: 'List active loop attention records.',
      audience: ['operator', 'agent'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
    }),
    affordanceToolAction({
      id: 'ack_attention',
      label: 'Acknowledge attention',
      intent: 'acknowledge',
      tool: 'site_loop_attention_ack',
      description: 'Acknowledge one attention record after operator review.',
      audience: ['operator'],
      danger_level: 'medium',
      read_only: false,
      idempotent: false,
      destructive: false,
      confirmation: { required: true, message: 'Acknowledge the selected Site Loop attention record.' },
      input_schema: {
        type: 'object',
        required: ['attention_id', 'reason'],
        properties: {
          attention_id: { type: 'string' },
          reason: { type: 'string' },
          acknowledged_by: { type: 'string' },
        },
      },
    }),
    affordanceToolAction({
      id: 'dry_run_once',
      label: 'Dry run once',
      intent: 'run',
      tool: 'site_loop_run_once',
      arguments: { dry_run: true, limit: 25 },
      description: 'Run one non-mutating Site Loop pass.',
      audience: ['operator', 'agent'],
      danger_level: 'low',
      read_only: true,
      idempotent: false,
    }),
    affordanceToolAction({
      id: 'run_resident_proof',
      label: 'Run resident proof',
      intent: 'run',
      tool: 'site_loop_proof_run',
      arguments: { proof_kind: 'resident_production', ensure_resident: true, require_live_carrier: true, wait_for_completion: false },
      description: 'Start the controlled resident production proof required for unattended operation; poll proof status/readiness afterward.',
      audience: ['operator'],
      danger_level: 'high',
      read_only: false,
      idempotent: false,
      confirmation: { required: true, message: 'Run a controlled resident production proof.' },
    }),
    affordanceToolAction({
      id: 'run_mailbox_proof',
      label: 'Run mailbox proof',
      intent: 'run',
      tool: 'site_loop_proof_run',
      arguments: { proof_kind: 'controlled_mailbox', ensure_resident: true, require_live_carrier: true },
      description: 'Run the controlled mailbox proof required for strict coherence.',
      audience: ['operator'],
      danger_level: 'high',
      read_only: false,
      idempotent: false,
      confirmation: { required: true, message: 'Run a controlled mailbox proof with an operator-approved source ref.' },
      input_schema: {
        type: 'object',
        required: ['proof_kind', 'controlled_mailbox_source'],
        properties: {
          proof_kind: { type: 'string', enum: ['controlled_mailbox'] },
          controlled_mailbox_source: { type: 'string' },
          timeout_ms: { type: 'number' },
          poll_ms: { type: 'number' },
        },
      },
    }),
    affordanceToolAction({
      id: 'pause_loop',
      label: 'Pause loop',
      intent: 'pause',
      tool: 'site_loop_control_set',
      arguments: { paused: true, reason: 'operator_requested' },
      description: 'Pause logical Site Loop execution.',
      audience: ['operator'],
      danger_level: 'medium',
      read_only: false,
      idempotent: true,
      confirmation: { required: true, message: 'Pause logical Site Loop execution.' },
    }),
    affordanceToolAction({
      id: 'resume_loop',
      label: 'Resume loop',
      intent: 'resume',
      tool: 'site_loop_control_set',
      arguments: { paused: false, reason: 'operator_requested' },
      description: 'Resume logical Site Loop execution.',
      audience: ['operator'],
      danger_level: 'medium',
      read_only: false,
      idempotent: true,
      confirmation: { required: true, message: 'Resume logical Site Loop execution.' },
    }),
    affordanceToolAction({
      id: 'recovery_plan',
      label: 'Recovery plan',
      intent: 'recover',
      tool: 'site_loop_recovery_plan',
      arguments: { task_name: config.scheduler.default_task_name, include_commands: true },
      description: 'Show a safe operator recovery plan without mutating loop state.',
      audience: ['operator', 'maintainer'],
      danger_level: 'none',
      read_only: true,
      idempotent: true,
    }),
  ];

  const panels: AffordancePanel[] = [
    {
      id: 'status',
      title: 'Status',
      kind: 'status',
      priority: 10,
      actions: ['refresh_unified_status', 'check_readiness', 'check_coherence'],
      metrics: [
        { id: 'loop_id', label: 'Loop', value: config.loop_id, severity: 'info' },
        { id: 'resident', label: 'Resident', value: config.resident.agent_id, severity: 'info' },
      ],
    },
    {
      id: 'attention',
      title: 'Attention',
      kind: 'attention',
      priority: 20,
      actions: ['list_attention', 'ack_attention'],
      data: { attention_ack_requires_selection: true },
    },
    {
      id: 'runs',
      title: 'Runs',
      kind: 'runs',
      priority: 30,
      actions: ['dry_run_once', 'run_resident_proof', 'run_mailbox_proof'],
    },
    {
      id: 'controls',
      title: 'Controls',
      kind: 'controls',
      priority: 40,
      actions: ['pause_loop', 'resume_loop', 'recovery_plan'],
    },
  ];

  const document = createAffordanceDocument({
    surface_id: 'site-loop',
    title: `${config.display_name} operator affordances`,
    audience: ['operator', 'agent', 'maintainer'],
    summary: 'UI-neutral affordances for inspecting and operating the configured Site Loop.',
    panels,
    actions,
    refresh: { mode: 'poll', interval_ms: 30000, actions: ['refresh_unified_status'] },
    source: {
      tool: 'site_loop_operator_affordances',
      site_id: config.site_id,
      site_root: siteRoot,
    },
  });
  const validation = validateAffordanceDocument(document);
  if (validation.status !== 'ok') {
    throw new Error(`site_loop_operator_affordances_invalid: ${validation.errors.join('; ')}`);
  }
  return document;
}

function loadSiteLoopModule() {
  siteLoopModulePromise ??= import('./site-loop/site-loop.js');
  return siteLoopModulePromise;
}

function requireActiveSiteLoopConfig() {
  const loaded = currentSiteLoopConfigLoad();
  if (loaded.status === 'missing') {
    throw new Error(`site_loop_config_missing: ${loaded.path}`);
  }
  if (loaded.status !== 'ok') {
    throw new Error(`site_loop_config_invalid: ${loaded.path}: ${loaded.errors.join('; ')}`);
  }
  return loaded.config;
}

function activeDocs() {
  return requireActiveSiteLoopConfig().docs;
}

function activeTests() {
  return requireActiveSiteLoopConfig().tests;
}

function normalizeLoopOptions(args: SiteLoopToolArgs = {}) {
  return {
    limit: optionalNumber(args.limit),
    status: optionalString(args.status),
    reason: optionalString(args.reason),
    acknowledgedBy: optionalString(args.acknowledged_by) ?? optionalString(args.acknowledgedBy),
    dryRun: args.dry_run === true || args.dryRun === true,
    drain: args.drain === true,
    sourceSync: args.source_sync === true || args.sourceSync === true,
    testAuthority: args.test_authority === true || args.testAuthority === true,
    ensureResident: args.ensure_resident === true || args.ensureResident === true,
    requireLiveCarrier: typeof args.require_live_carrier === 'boolean'
      ? args.require_live_carrier
      : typeof args.requireLiveCarrier === 'boolean'
        ? args.requireLiveCarrier
        : undefined,
    requireProduction: args.require_production === true || args.requireProduction === true,
    requireMailboxChain: args.require_mailbox_chain === true || args.requireMailboxChain === true,
  };
}

function assertRunOnceTransportBudget(args: SiteLoopToolArgs = {}) {
  const dryRun = args.dry_run === true || args.dryRun === true;
  if (dryRun) return;
  throw new Error('site_loop_run_once_mutating_mcp_not_supported: use the scheduler/supervisor path for production mutation; MCP run_once is dry-run only');
}

function normalizeProofRunOptions(args: SiteLoopToolArgs = {}) {
  const config = requireActiveSiteLoopConfig();
  const proofKind = optionalString(args.proof_kind) ?? optionalString(args.proofKind);
  const waitForCompletion = args.wait_for_completion === true || args.waitForCompletion === true;
  const timeoutMs = optionalNumber(args.timeout_ms) ?? optionalNumber(args.timeoutMs);
  if (waitForCompletion && timeoutMs && timeoutMs > 10_000) {
    throw new Error('proof_run_wait_exceeds_mcp_transport_budget: use bounded start mode, then poll site_loop_proof_status/readiness');
  }
  const base = {
    live: true,
    requireProductionProof: true,
    expectCarrierPreference: config.resident_runtime.preferred_preference,
    ensureResident: args.ensure_resident !== false && args.ensureResident !== false,
    requireLiveCarrier: typeof args.require_live_carrier === 'boolean'
      ? args.require_live_carrier
      : typeof args.requireLiveCarrier === 'boolean'
        ? args.requireLiveCarrier
        : true,
    timeoutMs,
    pollMs: optionalNumber(args.poll_ms) ?? optionalNumber(args.pollMs),
    limit: optionalNumber(args.limit),
  };
  if (proofKind === 'resident_production') {
    return {
      ...base,
      ackFixture: true,
      startOnly: !waitForCompletion,
    };
  }
  if (proofKind === 'controlled_mailbox') {
    const controlledMailboxSource = optionalString(args.controlled_mailbox_source) ?? optionalString(args.controlledMailboxSource);
    if (!controlledMailboxSource) throw new Error('controlled_mailbox_source_required');
    return {
      ...base,
      mailboxProof: true,
      controlledMailboxProof: true,
      controlledMailboxSource,
    };
  }
  throw new Error(`unknown_proof_kind: ${proofKind ?? ''}`);
}

function normalizeRecoveryDrillOptions(args: SiteLoopToolArgs = {}) {
  const timeoutMs = optionalNumber(args.timeout_ms) ?? optionalNumber(args.timeoutMs);
  if (timeoutMs !== undefined && timeoutMs > 120_000) {
    throw new Error('recovery_drill_timeout_exceeds_mcp_transport_budget');
  }
  return {
    id: optionalString(args.id),
    reason: optionalString(args.reason),
    title: optionalString(args.title),
    summary: optionalString(args.summary),
    timeoutMs,
    pollMs: optionalNumber(args.poll_ms) ?? optionalNumber(args.pollMs),
  };
}

function normalizeLoopControl(args: LoopControlToolArgs = {}) {
  return {
    enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
    paused: typeof args.paused === 'boolean' ? args.paused : undefined,
    reason: optionalString(args.reason),
    changedBy: optionalString(args.changed_by) ?? optionalString(args.changedBy) ?? 'site-loop-mcp',
  };
}

function optionalString(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function optionalNumber(value) {
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function showDoc(path) {
  const doc = activeDocs().find((item) => item.path === path);
  if (!doc) throw new Error(`doc_not_allowlisted: ${path}`);
  const absolutePath = resolve(siteRoot, doc.path);
  if (!isPathInside(absolutePath, siteRoot)) throw new Error(`doc_outside_site_root: ${path}`);
  if (!existsSync(absolutePath)) return { status: 'missing', site_root: siteRoot, path: doc.path };
  return {
    status: 'ok',
    site_root: siteRoot,
    path: doc.path,
    content: readFileSync(absolutePath, 'utf8'),
  };
}

async function runTest(selector, context: SiteOpsRequestContext = {}) {
  const tests = activeTests();
  if (!Object.hasOwn(tests, selector)) throw new Error(`test_selector_not_approved: ${selector}`);
  const { command, args } = tests[selector];
  const result = await runChildProcess(command, args, {
    cwd: siteRoot,
    timeout: 120_000,
    env: { ...process.env },
    abortSignal: context.abortSignal,
  });
  return {
    status: result.cancelled ? 'cancelled' : result.status === 0 ? 'passed' : 'failed',
    selector,
    exit_code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function unifiedSiteLoopStatus(args: SiteOpsServerArgs = {}) {
  const config = requireActiveSiteLoopConfig();
  const taskName = optionalString(args.task_name) ?? optionalString(args.taskName) ?? config.scheduler.default_task_name;
  const [loopStatus, loopHealth, scheduledTask] = await Promise.all([
    loadSiteLoopModule().then((module) => module.siteLoopStatus(siteRoot)).catch((error) => statusError(error)),
    loadSiteLoopModule().then((module) => module.siteLoopHealth(siteRoot)).catch((error) => statusError(error)),
    readScheduledTaskStatus(taskName),
  ]);
  const pidFiles = config.scheduler.pid_files.map((name) => readPidFileStatus(name));
  const stalePidFiles = pidFiles.filter((item) => item.exists && item.pid && item.process_alive === false).map((item) => item.name);
  const livePidFiles = pidFiles.filter((item) => item.exists && item.process_alive === true).map((item) => item.name);
  const logicalLoopEnabled = loopStatus?.control?.enabled ?? loopStatus?.enabled;
  const logicalLoopPaused = loopStatus?.control?.paused ?? loopStatus?.paused;
  const healthStatus = loopHealth?.status ?? loopHealth?.overall_status ?? loopHealth?.health;
  const blockers = [
    ...(scheduledTask.status === 'missing' ? ['scheduled_task_missing'] : []),
    ...(scheduledTask.status === 'error' ? ['scheduled_task_query_failed'] : []),
    ...(stalePidFiles.length > 0 ? ['stale_pid_files'] : []),
    ...(logicalLoopEnabled === false ? ['logical_loop_disabled'] : []),
    ...(logicalLoopPaused === true ? ['logical_loop_paused'] : []),
    ...(loopStatus?.status === 'error' ? ['loop_status_unavailable'] : []),
    ...(loopHealth?.status === 'error' ? ['loop_health_unavailable'] : []),
  ];
  const posture = blockers.length === 0 && livePidFiles.length > 0 ? 'running' : blockers.length === 0 ? 'ready_but_no_live_pid' : 'attention_needed';
  return {
    status: 'ok',
    site_root: siteRoot,
    posture,
    blockers,
    scheduled_task: scheduledTask,
    pid_files: pidFiles,
    logical_loop: {
      enabled: logicalLoopEnabled,
      paused: logicalLoopPaused,
      status: loopStatus?.status,
    },
    health: {
      status: healthStatus,
      raw_status: loopHealth?.status,
    },
    useful_work: summarizeUsefulWork(loopStatus, loopHealth),
    raw: {
      loop_status: loopStatus,
      loop_health: loopHealth,
    },
  };
}

async function siteLoopRecoveryPlan(args: SiteOpsServerArgs = {}) {
  const config = requireActiveSiteLoopConfig();
  const taskName = optionalString(args.task_name) ?? optionalString(args.taskName) ?? config.scheduler.default_task_name;
  const includeCommands = args.include_commands !== false && args.includeCommands !== false;
  const status = await unifiedSiteLoopStatus({ ...args, task_name: taskName });
  const steps = config.recovery_plan.steps.map((step) => ({
    ...step,
    command: step.command == null ? undefined : renderRecoveryTemplate(step.command, { siteRoot, taskName }),
  }));
  return {
    status: 'ok',
    site_root: siteRoot,
    read_only: true,
    mutation_performed: false,
    task_name: taskName,
    current_posture: status.posture,
    current_blockers: status.blockers,
    recommended_order: includeCommands ? steps : steps.map(({ id, reason }) => ({ id, reason })),
    guardrails: config.recovery_plan.guardrails,
    status_snapshot: status,
  };
}

function readPidFileStatus(name: string) {
  const path = join(siteRoot, 'logs', name);
  if (!existsSync(path)) return { name, path, exists: false, pid: null, process_alive: null };
  const raw = readFileSync(path, 'utf8').trim();
  const pid = Number(raw);
  return {
    name,
    path,
    exists: true,
    raw,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    process_alive: Number.isInteger(pid) && pid > 0 ? isProcessAlive(pid) : null,
  };
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readScheduledTaskStatus(taskName: string) {
  if (process.platform !== 'win32') return { status: 'unsupported_platform', task_name: taskName, platform: process.platform };
  const result = await runChildProcess('schtasks.exe', ['/query', '/tn', taskName, '/fo', 'LIST', '/v'], {
    cwd: siteRoot,
    timeout: 20_000,
    env: { ...process.env },
  });
  if (result.status !== 0) {
    const text = `${result.stdout}\n${result.stderr}`.trim();
    return {
      status: /cannot find|does not exist/i.test(text) ? 'missing' : 'error',
      task_name: taskName,
      exit_code: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }
  const fields = parseListOutput(result.stdout);
  return {
    status: 'ok',
    task_name: taskName,
    enabled: fields['Scheduled Task State'] ? !/disabled/i.test(fields['Scheduled Task State']) : undefined,
    task_status: fields.Status,
    last_run_time: fields['Last Run Time'],
    last_result: fields['Last Result'],
    next_run_time: fields['Next Run Time'],
    task_to_run: fields['Task To Run'],
    start_in: fields['Start In'],
    raw: fields,
  };
}

function parseListOutput(output: string) {
  const fields: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

function summarizeUsefulWork(loopStatus, loopHealth) {
  return {
    last_run_id: loopStatus?.last_run_id ?? loopStatus?.lastRunId ?? loopHealth?.last_run_id,
    last_run_at: loopStatus?.last_run_at ?? loopStatus?.lastRunAt ?? loopHealth?.last_run_at,
    pending_work: loopStatus?.pending_work ?? loopStatus?.pendingWork ?? loopHealth?.pending_work,
    attention_open: loopStatus?.attention_open ?? loopStatus?.attentionOpen ?? loopHealth?.attention_open,
  };
}

function statusError(error) {
  return { status: 'error', error: error instanceof Error ? error.message : String(error) };
}

function runChildProcess(command, args, options): Promise<SiteOpsChildResult> {
  return new Promise((resolveResult) => {
    if (options.abortSignal?.aborted) {
      resolveResult({ status: null, stdout: '', stderr: '', signal: null, cancelled: true });
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', abortHandler);
      resolveResult(value);
    };
    const abortHandler = () => {
      cancelled = true;
      child.kill('SIGTERM');
      settle({ status: null, stdout, stderr, signal: null, cancelled: true });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeout);
    options.abortSignal?.addEventListener('abort', abortHandler, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      settle({ status: null, stdout, stderr: stderr ? `${stderr}\n${error.message}` : error.message, signal: null, cancelled });
    });
    child.on('close', (status, signal) => {
      settle({ status, stdout, stderr: timedOut ? `${stderr}\ntimed_out`.trim() : stderr, signal, cancelled });
    });
  });
}

function respond(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function respondError(id, error) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
  });
}

function sendProgress(message, progress, progressMessage) {
  const progressToken = message?.params?._meta?.progressToken;
  if (progressToken === undefined) return;
  writeMessage({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken, progress, total: 1, message: progressMessage },
  });
}

function writeMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}

${body}`);
}

function isPathInside(candidate, root) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}
