#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
let siteLoopModulePromise = null;

const SERVER_NAME = 'narada-sonar-site-ops-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2026-04-18';
const options = parseArgs(process.argv.slice(2));
const siteRoot = resolve(options.siteRoot ?? process.cwd());
const DOCS = [
  { path: 'AGENTS.md', description: 'Site-local agent instructions.' },
  { path: '.narada/site.json', description: 'Site identity and authority locus.' },
  { path: '.narada/capabilities/mcp-registration.json', description: 'Sonar-local MCP registry.' },
  { path: '.narada/capabilities/capability-policy.json', description: 'Capability admission policy.' },
  { path: '.narada/capabilities/sonar-access-policy.json', description: 'Admitted filesystem/access policy.' },
  { path: '.narada/mcp/README.md', description: 'MCP surface readiness and reload posture.' },
];

const TESTS = {
  check: ['pnpm', ['check']],
  launcher_smoke: ['node', ['tools/agent-context/sonar-agent-launcher-smoke.mjs']],
  agent_context_smoke: ['node', ['tools/agent-context/sonar-agent-context-smoke.mjs']],
  mcp_bridge_poll: ['node', ['tools/task-lifecycle/tests/Test-McpBridgePoll.mjs']],
};

const TOOLS = [
  tool('site_ops_doctor', 'Inspect Sonar-local site ops MCP readiness.', {}),
  tool('site_docs_list', 'List Sonar-local read-only documentation paths exposed to agents.', {}),
  tool('site_docs_show', 'Show an allowlisted Sonar-local documentation file.', {
    path: { type: 'string', description: 'Allowlisted docs path from site_docs_list.' },
  }, ['path']),
  tool('site_test_list', 'List approved local test selectors.', {}),
  tool('site_test_run', 'Run one approved local test selector; no arbitrary shell is accepted.', {
    selector: { type: 'string', description: 'Approved selector from site_test_list.' },
  }, ['selector']),
  tool('site_loop_status', 'Show Sonar email resident Site Operating Loop status.', {}),
  tool('site_loop_health', 'Show Sonar email resident Site Operating Loop health.', {}),
  tool('site_loop_operating_status', 'Show composed operating-layer status for the Sonar email resident loop.', {
    limit: { type: 'number', description: 'Pending/directive row limit.' },
  }),
  tool('site_loop_readiness', 'Evaluate unattended-operation readiness gates for the Sonar email resident loop.', {
    require_production: { type: 'boolean', description: 'Require production proof, not only transport proof.' },
  }),
  tool('site_loop_coherence', 'Evaluate strict coherence blockers for the Sonar email resident loop.', {
    require_production: { type: 'boolean', description: 'Require production proof.' },
    require_mailbox_chain: { type: 'boolean', description: 'Require mailbox-chain proof.' },
  }),
  tool('site_loop_runs_list', 'List recent Sonar email resident Site Operating Loop runs.', {
    limit: { type: 'number', description: 'Maximum runs to return.' },
  }),
  tool('site_loop_run_show', 'Show a Site Operating Loop run by run id.', {
    run_id: { type: 'string', description: 'Loop run id.' },
  }, ['run_id']),
  tool('site_loop_attention_list', 'List Sonar email resident loop attention records.', {
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
  tool('site_loop_control_set', 'Set Sonar email resident loop control flags.', {
    enabled: { type: 'boolean', description: 'Enable or disable loop execution.' },
    paused: { type: 'boolean', description: 'Pause or unpause loop execution.' },
    reason: { type: 'string', description: 'Reason for the control change.' },
    changed_by: { type: 'string', description: 'Principal changing loop control.' },
  }, ['reason']),
  tool('site_loop_run_once', 'Run one bounded Sonar email resident loop pass.', {
    dry_run: { type: 'boolean', description: 'Plan/read without mutation.' },
    limit: { type: 'number', description: 'Processing limit.' },
    drain: { type: 'boolean', description: 'Drain eligible intake when supported.' },
    source_sync: { type: 'boolean', description: 'Request source sync before loop processing.' },
  }),
];

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  processInputBuffer();
});

function parseArgs(argv) {
  const parsed = {};
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
  const id = message?.id ?? null;
  try {
    if (message.method === 'initialize') {
      respond(id, {
        protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    if (message.method === 'notifications/initialized') return;
    if (message.method === 'tools/list') {
      respond(id, { tools: TOOLS });
      return;
    }
    if (message.method === 'tools/call') {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      return;
    }
    respondError(id, new Error(`unsupported_method: ${message.method}`));
  } catch (error) {
    respondError(id, error);
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'site_ops_doctor':
      return {
        status: 'ok',
        site_root: siteRoot,
        server_name: SERVER_NAME,
        read_only_docs: DOCS.length,
        approved_tests: Object.keys(TESTS),
        site_loop_tools: TOOLS.filter((item) => item.name.startsWith('site_loop_')).map((item) => item.name),
      };
    case 'site_docs_list':
      return { status: 'ok', site_root: siteRoot, docs: DOCS };
    case 'site_docs_show':
      return showDoc(args.path);
    case 'site_test_list':
      return {
        status: 'ok',
        site_root: siteRoot,
        tests: Object.entries(TESTS).map(([selector, [command, commandArgs]]) => ({
          selector,
          command: [command, ...commandArgs].join(' '),
        })),
      };
    case 'site_test_run':
      return runTest(args.selector);
    case 'site_loop_status':
      return (await loadSiteLoopModule()).sonarEmailResidentLoopStatus(siteRoot);
    case 'site_loop_health':
      return (await loadSiteLoopModule()).sonarEmailResidentLoopHealth(siteRoot);
    case 'site_loop_operating_status':
      return (await loadSiteLoopModule()).sonarEmailResidentOperatingLayerStatus(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_readiness':
      return (await loadSiteLoopModule()).sonarEmailResidentReadiness(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_coherence':
      return (await loadSiteLoopModule()).sonarEmailResidentCoherence(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_runs_list':
      return (await loadSiteLoopModule()).listSonarEmailResidentLoopRuns(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_run_show':
      return (await loadSiteLoopModule()).showSonarEmailResidentLoopRun(siteRoot, args.run_id);
    case 'site_loop_attention_list':
      return (await loadSiteLoopModule()).listSonarLoopAttention(siteRoot, normalizeLoopOptions(args));
    case 'site_loop_attention_show':
      return (await loadSiteLoopModule()).showSonarLoopAttention(siteRoot, args.attention_id);
    case 'site_loop_attention_ack':
      return (await loadSiteLoopModule()).ackSonarLoopAttention(siteRoot, args.attention_id, normalizeLoopOptions(args));
    case 'site_loop_control_set':
      return (await loadSiteLoopModule()).setSonarEmailResidentLoopControl(siteRoot, normalizeLoopControl(args));
    case 'site_loop_run_once':
      return (await loadSiteLoopModule()).runSonarEmailResidentLoop(siteRoot, normalizeLoopOptions(args));
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
}

function loadSiteLoopModule() {
  siteLoopModulePromise ??= import('./site-loop/sonar-email-resident-loop.mjs');
  return siteLoopModulePromise;
}
function normalizeLoopOptions(args = {}) {
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

function normalizeLoopControl(args = {}) {
  return {
    enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
    paused: typeof args.paused === 'boolean' ? args.paused : undefined,
    reason: optionalString(args.reason),
    changedBy: optionalString(args.changed_by) ?? optionalString(args.changedBy) ?? 'site-ops-mcp',
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
  const doc = DOCS.find((item) => item.path === path);
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

function runTest(selector) {
  if (!Object.hasOwn(TESTS, selector)) throw new Error(`test_selector_not_approved: ${selector}`);
  const [command, args] = TESTS[selector];
  const result = spawnSync(command, args, {
    cwd: siteRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    env: { ...process.env },
  });
  return {
    status: result.status === 0 ? 'passed' : 'failed',
    selector,
    exit_code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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
