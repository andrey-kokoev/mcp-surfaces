import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asRecord,
  createTemporaryE2eRoot,
  readMcpOutputText,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const root = createTemporaryE2eRoot('worker-delegation-live-edit-e2e');
const targetPath = join(root, 'worker-edit-target.txt');
const runRoot = join(root, 'runs');
const auditLogDir = join(root, 'audit');
const fixturePath = join(root, 'deterministic-agent-runtime.cjs');
const workerServerPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const filesystemServerPath = fileURLToPath(new URL('../../../local-filesystem-mcp/dist/src/main.js', import.meta.url));

mkdirSync(join(root, '.narada'), { recursive: true });
writeFileSync(targetPath, 'before\n', 'utf8');
writeFileSync(fixturePath, [
  "const { spawn } = require('node:child_process');",
  "const { readFileSync } = require('node:fs');",
  '',
  "let buffer = '';",
  "let handled = false;",
  "process.stdin.setEncoding('utf8');",
  "process.stdout.write(JSON.stringify({ event: 'session_started', session_id: 'deterministic-edit-worker', agent_id: 'worker.fixture', mcp_operational_state: 'healthy' }) + '\\n');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split(/\\r?\\n/);",
  "  buffer = lines.pop() || '';",
  "  for (const line of lines) {",
  "    if (!line.trim()) continue;",
  "    const frame = JSON.parse(line);",
  "    if (frame.method === 'session.submit' && !handled) {",
  "      handled = true;",
  "      handleSubmit(frame).catch((error) => {",
  "        process.stdout.write(JSON.stringify({ event: 'turn_failed', request_id: frame.id, turn_id: 'turn-edit-failed', error: error instanceof Error ? error.message : String(error) }) + '\\n');",
  "      });",
  "    }",
  "    if (frame.method === 'session.close') process.exit(0);",
  "  }",
  "});",
  '',
  "function marker(content, key) {",
  "  const match = content.match(new RegExp('^' + key + '=(.*)$', 'm'));",
  "  if (!match) throw new Error('missing marker: ' + key);",
  "  return match[1].trim();",
  "}",
  '',
  "async function handleSubmit(frame) {",
  "  const content = String(frame.params && frame.params.content || '');",
  "  const serverPath = marker(content, 'E2E_FILESYSTEM_SERVER');",
  "  const rootPath = marker(content, 'E2E_ROOT');",
  "  const target = marker(content, 'E2E_TARGET');",
  "  const projection = JSON.parse(process.env.NARADA_WORKER_MCP_CONFIG || '{}');",
  "  if (!Array.isArray(projection.mcp_tool_allowlist) || !projection.mcp_tool_allowlist.includes('local-filesystem-write.fs_apply_patch')) {",
  "    throw new Error('required MCP tool was not projected');",
  "  }",
  "  const patch = '*** Begin Patch\\n*** Update File: worker-edit-target.txt\\n@@\\n-before\\n+after\\n*** End Patch\\n';",
  "  const response = await callFilesystem(serverPath, rootPath, patch);",
  "  if (response.error || response.result && response.result.isError) throw new Error('filesystem MCP edit failed: ' + JSON.stringify(response));",
  "  if (readFileSync(target, 'utf8') !== 'after\\n') throw new Error('filesystem MCP edit did not change the target');",
  "  const output = {",
  "    summary: 'delegated worker edited a file through local-filesystem MCP',",
  "    deliverables: [{ path: target, description: 'target changed through fs_apply_patch' }],",
  "    open_questions: [],",
  "    next_actions: [],",
  "    edits_performed: true,",
  "    target_state_changed: true,",
  "    changes: [{ path: target, status: 'modified', summary: 'before to after through MCP' }],",
  "    verification: [{ tool: 'local-filesystem-write.fs_apply_patch', command: null, status: 'passed', summary: 'real child MCP transport returned a successful patch outcome', command_classification: 'not_applicable' }],",
  "    verification_budget_respected: true,",
  "    broad_unrelated_failures: [],",
  "    exit_interview: null",
  "  };",
  "  process.stdout.write(JSON.stringify({ event: 'turn_started', request_id: frame.id, turn_id: 'turn-edit' }) + '\\n');",
  "  process.stdout.write(JSON.stringify({ event: 'assistant_message', request_id: frame.id, turn_id: 'turn-edit', content: JSON.stringify(output) }) + '\\n');",
  "  process.stdout.write(JSON.stringify({ event: 'turn_complete', request_id: frame.id, turn_id: 'turn-edit', terminal_state: 'completed', delegated_mutation_admitted: true, carrier_mutation_admitted: true }) + '\\n');",
  "}",
  '',
  "function callFilesystem(serverPath, rootPath, patch) {",
  "  return new Promise((resolve, reject) => {",
  "    const child = spawn(process.execPath, [serverPath, '--mode', 'write', '--allowed-root', rootPath, '--output-root', rootPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });",
  "    let buffer = '';",
  "    let requestSent = false;",
  "    let settled = false;",
  "    const timer = setTimeout(() => finish(new Error('filesystem MCP child timed out')), 10000);",
  "    child.stdout.setEncoding('utf8');",
  "    child.stdout.on('data', (chunk) => {",
  "      buffer += chunk;",
  "      const lines = buffer.split(/\\r?\\n/);",
  "      buffer = lines.pop() || '';",
  "      for (const line of lines) {",
  "        if (!line.trim()) continue;",
  "        const message = JSON.parse(line);",
  "        if (message.id === 1 && !requestSent) {",
  "          requestSent = true;",
  "          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fs_apply_patch', arguments: { operation_id: 'worker-delegation-live-edit-e2e', patch } } }) + '\\n');",
  "        } else if (message.id === 2) {",
  "          finish(null, message);",
  "        }",
  "      }",
  "    });",
  "    child.stderr.setEncoding('utf8');",
  "    child.stderr.on('data', () => {});",
  "    child.on('error', (error) => finish(error));",
  "    child.on('close', (code) => {",
  "      if (!settled) finish(new Error('filesystem MCP child exited with code ' + code));",
  "    });",
  "    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\\n');",
  "    function finish(error, value) {",
  "      if (settled) return;",
  "      settled = true;",
  "      clearTimeout(timer);",
  "      const settle = () => { if (error) reject(error); else resolve(value); };",
  "      if (child.exitCode !== null) { settle(); return; }",
  "      const closeTimer = setTimeout(() => { try { child.kill(); } catch {} settle(); }, 2000);",
  "      child.once('close', () => { clearTimeout(closeTimer); settle(); });",
  "      if (!child.stdin.destroyed) child.stdin.end();",
  "      if (error) { try { child.kill(); } catch {} }",
  "    }",
  "  });",
  "}",
].join('\n'), 'utf8');

try {
  assert.equal(existsSync(filesystemServerPath), true, 'build ' + filesystemServerPath + ' before running this E2E test');
  const worker = spawnJsonlMcpServer(process.execPath, [
    workerServerPath,
    '--site-root', root,
    '--allowed-root', root,
    '--run-root', runRoot,
    '--audit-log-dir', auditLogDir,
    '--default-runtime', 'narada-agent-runtime-server',
    '--agent-runtime-server-command', process.execPath,
    '--agent-runtime-server-command-arg', fixturePath,
  ], {
    env: { ...process.env, NARADA_PROVIDER_SECRET_STORE: 'disabled' },
    timeoutMs: 15000,
    label: 'worker-delegation',
  });
  const client = worker.client;
  try {
    await runMcpProtocolSmoke(client, { expectedServerName: 'worker-delegation-mcp', toolsListId: 99 });
    const result = await client.request(2, 'tools/call', {
      name: 'worker_edit',
      arguments: {
        cwd: root,
        site_root: root,
        provider: 'codex-subscription',
        instruction: [
          'Perform exactly one delegated MCP edit.',
          'E2E_FILESYSTEM_SERVER=' + filesystemServerPath,
          'E2E_ROOT=' + root,
          'E2E_TARGET=' + targetPath,
        ].join('\n'),
        required_mcp_tools: ['local-filesystem-write.fs_apply_patch'],
        wait_for_completion: true,
        overrides: { runtime: 'narada-agent-runtime-server' },
      },
    });
    assert.equal(result.error, undefined, JSON.stringify(result));
    const resultEnvelope = asRecord(asRecord(result.result).structuredContent);
    assert.equal(resultEnvelope.schema, 'narada.producer_output_page.v1');
    assert.equal(typeof resultEnvelope.output_ref, 'string');
    const output = await readMcpOutputText({ output_text: '', next_offset: 0 }, async ({ offset, limit, pageNumber }) => {
      const pageResponse = await client.request(10 + pageNumber, 'tools/call', {
        name: 'worker_output_show',
        arguments: { ref: resultEnvelope.output_ref, offset, limit },
      });
      assert.equal(pageResponse.error, undefined, JSON.stringify(pageResponse));
      const page = asRecord(asRecord(pageResponse.result).structuredContent);
      assert.equal(page.schema, 'narada.mcp_output_page.v1');
      return page;
    }, { initialReadOffset: 0 });
    const structured = JSON.parse(output.text) as JsonRecord;
    assert.equal(structured.status, 'completed');
    assert.equal(structured.edits_performed, true, JSON.stringify(structured));
    assert.equal(structured.target_state_changed, true, JSON.stringify(structured));
    assert.equal(asRecord(structured.mcp_tool_verification).verification_state, 'projected_to_worker_runtime');
    const resolvedConfig = asRecord(structured.resolved_worker_config);
    assert.deepEqual(asRecord(resolvedConfig.worker_mcp_projection).mcp_tool_allowlist, ['local-filesystem-write.fs_apply_patch']);
    assert.equal(readFileSync(targetPath, 'utf8'), 'after\n');
    const verification = Array.isArray(structured.verification_results) ? structured.verification_results : [];
    assert.equal(verification.some((item) => asRecord(item).tool === 'local-filesystem-write.fs_apply_patch' && asRecord(item).status === 'passed'), true);
    console.log('worker-delegation delegated MCP edit e2e ok');
  } finally {
    await client.close();
  }
} finally {
  removeTemporaryE2eRoot(root);
}
