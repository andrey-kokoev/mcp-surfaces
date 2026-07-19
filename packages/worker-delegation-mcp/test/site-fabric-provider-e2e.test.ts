import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asRecord,
  createTemporaryE2eRoot,
  readMcpOutputText,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  structured,
  tomlPath,
  writeE2eResultArtifact,
  type JsonlMcpClient,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const TEST_ID = 'worker-delegation-site-fabric-provider-e2e';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultPath = join(packageRoot, '.tmp', 'e2e-results', `${TEST_ID}.json`);
const startedAt = new Date().toISOString();

async function main(): Promise<void> {
  const root = createTemporaryE2eRoot(TEST_ID);
  const targetPath = join(root, 'worker-edit-target.txt');
  const runRoot = join(root, 'runs');
  const auditLogDir = join(root, 'audit');
  const fixturePath = join(root, 'deterministic-provider-runtime.cjs');
  const providerRegistryPath = join(root, '.narada', 'provider-registry.json');
  const workerServerPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const loaderServerPath = fileURLToPath(new URL('../../../mcp-loader-mcp/dist/src/main.js', import.meta.url));
  const filesystemServerPath = fileURLToPath(new URL('../../../local-filesystem-mcp/dist/src/main.js', import.meta.url));
  const fabricPath = join(root, '.ai', 'mcp', 'config.json');
  let status: 'passed' | 'failed' | 'not_run' = 'failed';
  let failureReason: string | null = null;
  let loaderClient: JsonlMcpClient | null = null;
  let loaderConnectionId: string | null = null;
  let cleanupStatus: 'passed' | 'failed' = 'passed';
  const providerEvidence: JsonRecord[] = [];
  let diagnosticState: JsonRecord | null = null;

  try {
    const missingPrerequisite = [loaderServerPath, filesystemServerPath].find((path) => !existsSync(path));
    if (missingPrerequisite) {
      status = 'not_run';
      failureReason = `built prerequisite missing: ${missingPrerequisite}`;
      process.exitCode = 2;
      return;
    }

    mkdirSync(join(root, '.narada'), { recursive: true });
    mkdirSync(join(root, '.ai', 'mcp'), { recursive: true });
    writeFileSync(targetPath, 'before\n', 'utf8');
    writeFileSync(providerRegistryPath, JSON.stringify({
      schema: 'narada.provider.registry.fixture.v1',
      default_provider: 'codex-subscription',
      providers: {
        'codex-subscription': {
          base_url: 'https://provider-fixture.invalid',
          default_model: 'fixture-default-model',
          default_thinking: 'medium',
          available_models: ['fixture-low-model', 'fixture-medium-model', 'fixture-high-model'],
          cognition_defaults: {
            low: { model: 'fixture-low-model', reasoning_effort: 'low' },
            medium: { model: 'fixture-medium-model', reasoning_effort: 'medium' },
            high: { model: 'fixture-high-model', reasoning_effort: 'high' },
          },
          credential_requirement: { kind: 'none' },
          base_url_env_names: ['FIXTURE_PROVIDER_BASE_URL'],
          model_env_names: ['CODEX_MODEL'],
        },
      },
    }, null, 2), 'utf8');
    writeFileSync(fixturePath, [
      "const { spawn } = require('node:child_process');",
      "const { readFileSync } = require('node:fs');",
      '',
      "let buffer = '';",
      "let handled = false;",
      "process.stdin.setEncoding('utf8');",
      "process.stdout.write(JSON.stringify({ event: 'session_started', session_id: 'site-fabric-provider-worker', agent_id: 'worker.fixture', mcp_operational_state: 'healthy' }) + '\\n');",
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
      "        process.stdout.write(JSON.stringify({ event: 'turn_failed', request_id: frame.id, turn_id: 'turn-failed', error: error instanceof Error ? error.message : String(error) }) + '\\n');",
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
      "function emit(frame, output) {",
      "  process.stdout.write(JSON.stringify({ event: 'turn_started', request_id: frame.id, turn_id: 'turn-complete' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ event: 'assistant_message', request_id: frame.id, turn_id: 'turn-complete', content: JSON.stringify(output) }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ event: 'turn_complete', request_id: frame.id, turn_id: 'turn-complete', terminal_state: 'completed', delegated_mutation_admitted: true, carrier_mutation_admitted: true }) + '\\n');",
      "}",
      '',
      "async function handleSubmit(frame) {",
      "  const content = String(frame.params && frame.params.content || '');",
      "  if (content.includes('E2E_FILESYSTEM_SERVER=')) {",
      "    const serverPath = marker(content, 'E2E_FILESYSTEM_SERVER');",
      "    const rootPath = marker(content, 'E2E_ROOT');",
      "    const target = marker(content, 'E2E_TARGET');",
      "    const projection = JSON.parse(process.env.NARADA_WORKER_MCP_CONFIG || '{}');",
      "    if (!Array.isArray(projection.mcp_tool_allowlist) || !projection.mcp_tool_allowlist.includes('local-filesystem-write.fs_apply_patch')) throw new Error('required MCP tool was not projected');",
      "    const patch = '*** Begin Patch\\n*** Update File: worker-edit-target.txt\\n@@\\n-before\\n+after\\n*** End Patch\\n';",
      "    const response = await callFilesystem(serverPath, rootPath, patch);",
      "    if (response.error || response.result && response.result.isError) throw new Error('filesystem MCP edit failed: ' + JSON.stringify(response));",
      "    if (readFileSync(target, 'utf8') !== 'after\\n') throw new Error('filesystem MCP edit did not change target');",
      "    emit(frame, { summary: 'delegated worker edited through Site fabric', deliverables: [{ path: target, description: 'target changed through fs_apply_patch' }], open_questions: [], next_actions: [], edits_performed: true, target_state_changed: true, changes: [{ path: target, status: 'modified', summary: 'before to after through MCP' }], verification: [{ tool: 'local-filesystem-write.fs_apply_patch', command: null, status: 'passed', summary: 'Site-fabric worker projection reached the real filesystem child', command_classification: 'not_applicable' }], verification_budget_respected: true, broad_unrelated_failures: [], exit_interview: null });",
      "    return;",
      "  }",
      "  const provider = process.env.NARADA_INTELLIGENCE_PROVIDER || null;",
      "  const model = process.env.NARADA_AI_MODEL || null;",
      "  const thinking = process.env.NARADA_AI_THINKING || null;",
      "  const codexModel = process.env.CODEX_MODEL || null;",
      "  emit(frame, { summary: 'provider cognition binding fixture completed', deliverables: [], open_questions: [], next_actions: [], edits_performed: false, target_state_changed: false, changes: [], verification: [{ tool: 'provider-runtime-fixture', command: null, status: 'passed', summary: 'provider=' + provider + ' model=' + model + ' thinking=' + thinking + ' codex_model=' + codexModel, command_classification: 'not_applicable' }], verification_budget_respected: true, broad_unrelated_failures: [], exit_interview: null });",
      "}",
      '',
      "function callFilesystem(serverPath, rootPath, patch) {",
      "  return new Promise((resolve, reject) => {",
      "    const child = spawn(process.execPath, [serverPath, '--mode', 'write', '--allowed-root', rootPath, '--output-root', rootPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });",
      "    let buffer = '';",
      "    let settled = false;",
      "    let requestSent = false;",
      "    const timer = setTimeout(() => finish(new Error('filesystem MCP child timed out')), 10000);",
      "    child.stdout.setEncoding('utf8');",
      "    child.stdout.on('data', (chunk) => {",
      "      buffer += chunk;",
      "      const lines = buffer.split(/\\r?\\n/);",
      "      buffer = lines.pop() || '';",
      "      for (const line of lines) {",
      "        if (!line.trim()) continue;",
      "        const message = JSON.parse(line);",
      "        if (message.id === 1 && !requestSent) { requestSent = true; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fs_apply_patch', arguments: { operation_id: 'site-fabric-provider-e2e-edit', patch } } }) + '\\n'); }",
      "        else if (message.id === 2) finish(null, message);",
      "      }",
      "    });",
      "    child.stderr.on('data', () => {});",
      "    child.on('error', (error) => finish(error));",
      "    child.on('close', (code) => { if (!settled) finish(new Error('filesystem MCP child exited with code ' + code)); });",
      "    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\\n');",
      "    function finish(error, value) {",
      "      if (settled) return;",
      "      settled = true;",
      "      clearTimeout(timer);",
      "      if (!child.stdin.destroyed) child.stdin.end();",
      "      if (error) { try { child.kill(); } catch {} reject(error); return; }",
      "      const closeTimer = setTimeout(() => { try { child.kill(); } catch {} resolve(value); }, 2000);",
      "      child.once('close', () => { clearTimeout(closeTimer); resolve(value); });",
      "    }",
      "  });",
      "}",
    ].join('\n'), 'utf8');

    const workerArgs = [
      workerServerPath,
      '--site-root', root,
      '--allowed-root', root,
      '--run-root', runRoot,
      '--audit-log-dir', auditLogDir,
      '--default-runtime', 'narada-agent-runtime-server',
      '--agent-runtime-server-command', process.execPath,
      '--agent-runtime-server-command-arg', fixturePath,
      '--provider-registry-path', providerRegistryPath,
    ];
    writeFileSync(fabricPath, JSON.stringify({
      schema: 'narada.mcp.fabric.fixture.v1',
      site_id: 'worker-delegation-e2e-site',
      generated_by: 'worker-delegation-site-fabric-provider-e2e',
      mcpServers: {
        'worker-delegation': {
          command: 'node',
          args: workerArgs,
          tools: ['worker_edit', 'worker_run', 'worker_output_show'],
        },
      },
    }, null, 2), 'utf8');

    const loader = spawnJsonlMcpServer(process.execPath, [loaderServerPath, '--allowed-site-root', root], {
      env: siteFabricChildEnv(root, { NARADA_PROVIDER_SECRET_STORE: 'disabled' }),
      label: 'mcp-loader',
    });
    loaderClient = loader.client;
    await runMcpProtocolSmoke(loaderClient, { expectedServerName: 'mcp-loader-mcp', toolsListId: 99 });

    const surfaces = structured(await loaderClient.request(2, 'tools/call', {
      name: 'mcp_loader_list_site_surfaces',
      arguments: { site_root: root },
    }));
    assert.equal(surfaces.schema, 'narada.mcp_loader.site_surfaces.v1');
    assert.equal((surfaces.surfaces as JsonRecord[]).some((surface) => surface.surface_id === 'worker-delegation'), true);

    const diagnostics = structured(await loaderClient.request(3, 'tools/call', {
      name: 'mcp_loader_site_fabric_diagnostics',
      arguments: { site_root: root },
    }));
    const workerDiagnostic = (diagnostics.diagnostics as JsonRecord[]).find((entry) => entry.surface_id === 'worker-delegation');
    assert.equal(workerDiagnostic?.classification, 'matches_shared_registry');
    assert.equal(workerDiagnostic?.entrypoint_exists, true);

    const attached = structured(await loaderClient.request(4, 'tools/call', {
      name: 'mcp_loader_attach_surface',
      arguments: { site_root: root, surface_id: 'worker-delegation' },
    }));
    assert.equal(attached.schema, 'narada.mcp_loader.surface_attached.v1');
    loaderConnectionId = String(attached.connection_id);
    assert.equal(attached.entrypoint, workerServerPath.replaceAll('\\', '/'));

    const attachedTools = structured(await loaderClient.request(5, 'tools/call', {
      name: 'mcp_loader_list_tools',
      arguments: { connection_id: loaderConnectionId },
    }));
    const toolNames = (attachedTools.tools as JsonRecord[]).map((tool) => tool.name);
    for (const requiredTool of ['worker_edit', 'worker_run', 'worker_output_show']) assert.equal(toolNames.includes(requiredTool), true, `missing ${requiredTool}`);

    const refusal = await loaderClient.request(6, 'tools/call', {
      name: 'mcp_loader_attach_surface',
      arguments: { site_root: root, surface_id: 'not-admitted' },
    });
    assert.ok(refusal.error, 'undeclared surface must be refused by loader admission');

    const editResult = await callAttached(loaderClient, loaderConnectionId, 7, 'worker_edit', {
      cwd: root,
      site_root: root,
      provider: 'codex-subscription',
      instruction: [
        'Perform exactly one delegated MCP edit.',
        `E2E_FILESYSTEM_SERVER=${filesystemServerPath}`,
        `E2E_ROOT=${root}`,
        `E2E_TARGET=${targetPath}`,
      ].join('\n'),
      required_mcp_tools: ['local-filesystem-write.fs_apply_patch'],
      wait_for_completion: true,
      overrides: { runtime: 'narada-agent-runtime-server' },
    });
    const editPage = asRecord(editResult.structuredContent);
    assert.equal(editPage.schema, 'narada.producer_output_page.v1');
    const editOutputRecord = await readProducedJson(loaderClient, loaderConnectionId, editPage, 20);
    assert.equal(editOutputRecord.status, 'completed');
    assert.equal(editOutputRecord.edits_performed, true);
    assert.equal(editOutputRecord.target_state_changed, true);
    assert.equal(readFileSync(targetPath, 'utf8'), 'after\n');

    const cognitionExpectations = {
      low: { model: 'fixture-low-model', thinking: 'low' },
      medium: { model: 'fixture-medium-model', thinking: 'medium' },
      high: { model: 'fixture-high-model', thinking: 'high' },
    } as const;
    let requestId = 40;
    for (const [cognition, expected] of Object.entries(cognitionExpectations)) {
      const runResult = await callAttached(loaderClient, loaderConnectionId, requestId++, 'worker_run', {
        intent: { instruction: `Read-only provider binding check for ${cognition}.` },
        constraints: {
          cwd: root,
          site_root: root,
          authority: 'read',
          cognition,
          provider: 'codex-subscription',
          wait_for_completion: true,
          overrides: { runtime: 'narada-agent-runtime-server' },
        },
      });
      const runPage = asRecord(runResult.structuredContent);
      assert.equal(runPage.schema, 'narada.producer_output_page.v1');
      const runStructured = await readProducedJson(loaderClient, loaderConnectionId, runPage, requestId + 100);
      diagnosticState = runStructured;
      const resolved = asRecord(runStructured.resolved_worker_config);
      assert.equal(runStructured.status, 'completed', JSON.stringify(runStructured));
      assert.equal(resolved.provider, 'codex-subscription');
      assert.equal(resolved.cognition, cognition);
      assert.equal(resolved.model, expected.model);
      assert.equal(resolved.reasoning_effort, expected.thinking);
      assert.equal(asRecord(resolved.provider_runtime_binding).credential_source, 'not_required');
      assert.equal('api_key' in asRecord(resolved.provider_runtime_binding), false);
      const verification = Array.isArray(runStructured.verification_results) ? runStructured.verification_results : [];
      const summary = String(asRecord(verification[0]).summary ?? '');
      assert.match(summary, new RegExp(`provider=codex-subscription`));
      assert.match(summary, new RegExp(`model=${expected.model}`));
      assert.match(summary, new RegExp(`thinking=${expected.thinking}`));
      assert.match(summary, new RegExp(`codex_model=${expected.model}`));
      providerEvidence.push({ cognition, provider: resolved.provider, model: resolved.model, reasoning_effort: resolved.reasoning_effort, status: runStructured.status, summary });
    }

    status = 'passed';
    console.log(JSON.stringify({
      schema: 'narada.mcp.e2e.result.v1',
      test_id: TEST_ID,
      status,
      authority: 'A0',
      external_authority: 'not_run',
      provider_boundary: 'controlled_deterministic_fixture',
      site_root: root,
      site_fabric_path: fabricPath,
      provider_profiles: providerEvidence.length,
      edit_verified: true,
    }));
  } catch (error) {
    failureReason = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    if (loaderClient && loaderConnectionId) {
      try {
        await loaderClient.request(90, 'tools/call', { name: 'mcp_loader_detach', arguments: { connection_id: loaderConnectionId } });
      } catch {
        cleanupStatus = 'failed';
      }
    }
    if (loaderClient) {
      try {
        await loaderClient.close();
      } catch {
        cleanupStatus = 'failed';
      }
    }
    if (!removeTemporaryE2eRoot(root)) cleanupStatus = 'failed';
    if (cleanupStatus === 'failed') {
      status = 'failed';
      failureReason ??= 'cleanup_failed';
      process.exitCode = 1;
    }
    writeE2eResultArtifact(resultPath, {
      schema: 'narada.mcp.e2e.result.v1',
      test_id: TEST_ID,
      status,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      site_root: root,
      authority: 'A0',
      external_authority: 'not_run',
      provider_boundary: 'controlled_deterministic_fixture',
      site_fabric: { path: fabricPath, admission: status === 'passed' ? 'matches_shared_registry' : 'not_verified' },
      provider_profiles: providerEvidence,
      diagnostic_state: diagnosticState,
      operation: { delegated_edit: status === 'passed', output_reader_used: status === 'passed' },
      cleanup: { status: cleanupStatus, loader_connection_detached: loaderConnectionId !== null && cleanupStatus === 'passed' },
      failure_reason: failureReason,
    });
  }
}

void main().catch(() => { process.exitCode = 1; });

async function callAttached(client: JsonlMcpClient, connectionId: string, id: number, toolName: string, args: JsonRecord): Promise<JsonRecord> {
  const response = await client.request(id, 'tools/call', {
    name: 'mcp_loader_call_tool',
    arguments: { connection_id: connectionId, tool_name: toolName, arguments: args },
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  const envelope = structured(response);
  assert.equal(envelope.schema, 'narada.mcp_loader.tool_result.v1');
  const result = asRecord(envelope.result);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result;
}

async function readProducedJson(client: JsonlMcpClient, connectionId: string, producerPage: JsonRecord, firstPageId: number): Promise<JsonRecord> {
  const outputRef = String(producerPage.output_ref ?? producerPage.ref ?? '');
  assert.ok(outputRef);
  const output = await readMcpOutputText({ output_text: '', next_offset: 0 }, async ({ offset, limit, pageNumber }) => {
    const pageResult = await callAttached(client, connectionId, firstPageId + pageNumber, 'worker_output_show', { ref: outputRef, offset, limit });
    const page = asRecord(pageResult.structuredContent);
    assert.equal(page.schema, 'narada.mcp_output_page.v1');
    return page;
  }, { initialReadOffset: 0 });
  return JSON.parse(output.text) as JsonRecord;
}
