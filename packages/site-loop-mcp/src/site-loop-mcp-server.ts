#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
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
const options = parseArgs(process.argv.slice(2));
const siteRoot = resolve(String(options.siteRoot ?? process.cwd()));

function currentSiteLoopConfigLoad() {
  return loadSiteLoopConfig(siteRoot);
}

const TOOLS = [
  guidanceToolDefinition(),
  guidanceToolDefinition('site_ops_guidance', 'Compatibility alias for site_loop_guidance. Prefer site_loop_guidance for new callers.'),
  tool('site_loop_doctor', 'Inspect configured Site Loop MCP readiness.', {}),
  tool('site_ops_doctor', 'Compatibility alias for site_loop_doctor. Prefer site_loop_doctor for new callers.', {}),
  tool('site_docs_list', 'List configured read-only documentation paths exposed to agents.', {}),
  tool('site_docs_show', 'Show a configured allowlisted documentation file.', {
    path: { type: 'string', description: 'Allowlisted docs path from site_docs_list.' },
  }, ['path']),
  tool('site_test_list', 'List approved local test selectors.', {}),
  tool('site_test_run', 'Run one approved local test selector; no arbitrary shell is accepted.', {
    selector: { type: 'string', description: 'Approved selector from site_test_list.' },
  }, ['selector']),
  tool('site_loop_config_validate', 'Validate the site-loop config file and report schema/semantic diagnostics without running the loop.', {}),
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
  }, ['run_id']),
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
    limit: { type: 'number', description: 'Processing limit.' },
    drain: { type: 'boolean', description: 'Drain eligible intake when supported.' },
    source_sync: { type: 'boolean', description: 'Request source sync before loop processing.' },
  }),
].map((tool) => ({ ...tool, annotations: toolAnnotations(tool.name), outputSchema: genericToolOutputSchema() }));

function toolAnnotations(name: string) {
  const writes = /run|ack|control_set|autopilot_step/.test(name);
  return {
    title: name,
    readOnlyHint: !writes,
    destructiveHint: /control_set/.test(name),
    idempotentHint: /doctor|validate|list|show|status|health|readiness|coherence/.test(name),
    openWorldHint: true,
    deprecatedHint: name.startsWith('site_ops_'),
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
        capabilities: { tools: {}, prompts: {}, completions: {}, logging: {} },
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
      respond(id, { content: [assistantTextContent(JSON.stringify(result, null, 2))] });
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
    { name: 'site_ops_workflow', title: 'Site Ops Workflow', description: 'Compatibility alias for site_loop_workflow.', arguments: [] },
  ];
}

function promptGet(params) {
  const name = String(params.name ?? '');
  if (name !== 'site_loop_workflow' && name !== 'site_ops_workflow') throw new Error(`unknown_prompt: ${name}`);
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

async function callTool(name, args, context: SiteOpsRequestContext = {}) {
  if (name !== 'site_loop_guidance' && name !== 'site_ops_guidance' && name !== 'site_loop_doctor' && name !== 'site_ops_doctor' && name !== 'site_loop_config_validate') {
    requireActiveSiteLoopConfig();
  }
  switch (name) {
    case 'site_loop_guidance':
    case 'site_ops_guidance':
      return buildGuidanceResult(args);
    case 'site_loop_doctor':
    case 'site_ops_doctor': {
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
        compatibility_aliases: {
          tools: ['site_ops_guidance', 'site_ops_doctor'],
          prompts: ['site_ops_workflow'],
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
    case 'site_loop_readiness':
      return (await loadSiteLoopModule()).siteLoopReadiness(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_coherence':
      return (await loadSiteLoopModule()).siteLoopCoherence(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_runs_list':
      return (await loadSiteLoopModule()).listSiteLoopRuns(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_run_show':
      return (await loadSiteLoopModule()).showSiteLoopRun(siteRoot, args.run_id);
    case 'site_loop_attention_list':
      return (await loadSiteLoopModule()).listSiteLoopAttention(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_attention_show':
      return (await loadSiteLoopModule()).showSiteLoopAttention(siteRoot, args.attention_id);
    case 'site_loop_attention_ack':
      return (await loadSiteLoopModule()).ackSiteLoopAttention(siteRoot, args.attention_id, normalizeLoopOptions(args));
    case 'site_loop_control_set':
      return (await loadSiteLoopModule()).setSiteLoopControl(siteRoot, normalizeLoopControl(args));
    case 'site_loop_run_once':
      return (await loadSiteLoopModule()).runSiteLoop(siteRoot, normalizeLoopOptions(args));
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
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
    requireProduction: args.require_production === true || args.requireProduction === true,
    requireMailboxChain: args.require_mailbox_chain === true || args.requireMailboxChain === true,
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
