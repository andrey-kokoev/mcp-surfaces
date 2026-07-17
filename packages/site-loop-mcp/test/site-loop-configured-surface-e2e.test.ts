import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  readMcpOutputText,
  runMcpProtocolSmoke,
  spawnContentLengthMcpServer,
  structured,
  type JsonRecord,
  type JsonRpcResponse,
} from '@narada2/mcp-e2e-harness';
import { openSiteLoopStore } from '../src/site-loop/site-loop-store.js';

const siteRoot = createTemporaryE2eRoot('site-loop-mcp-configured-surface-e2e');
const serverPath = fileURLToPath(new URL('../src/site-loop-mcp-server.js', import.meta.url));

mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });
writeFileSync(join(siteRoot, 'AGENTS.md'), '# Configured Site Loop E2E\n', 'utf8');
writeFileSync(join(siteRoot, 'README.md'), '# Configured Site Loop E2E\n', 'utf8');
writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v1',
  loop_id: 'configured.e2e.loop',
  site_id: 'narada-configured-e2e',
  display_name: 'Configured Site Loop E2E',
  resident: {
    agent_id: 'live.e2e.resident',
    role: 'resident',
  },
  refs: {
    ticket_projection: { kind: 'ticket_projection', ref: 'configured-e2e' },
  },
  docs: [
    { path: 'AGENTS.md', description: 'Configured Site Loop E2E instructions.' },
    { path: 'README.md', description: 'Configured Site Loop E2E readme.' },
  ],
  tests: {
    smoke_echo: {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("configured-site-loop-e2e-ok")'],
    },
  },
}, null, 2), 'utf8');

const initializedLoopStore = openSiteLoopStore(siteRoot);
initializedLoopStore.close();

const server = spawnContentLengthMcpServer(process.execPath, ['--no-warnings', serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  label: 'site-loop-mcp-configured-surface-e2e',
  timeoutMs: 8_000,
});
const client = server.client;
let stderr = '';
server.child.stderr.setEncoding('utf8');
server.child.stderr.on('data', (chunk) => {
  stderr = (stderr + String(chunk)).slice(-4_000);
});

function contentText(label: string, response: JsonRpcResponse): JsonRecord {
  assert.equal(response.error, undefined, label + ': ' + JSON.stringify(response));
  const result = response.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  assert.equal(content.length > 0, true, label + ': ' + JSON.stringify(response));
  const first = content[0];
  assert.equal(first && typeof first === 'object' && !Array.isArray(first) && (first as JsonRecord).type, 'text', label + ': ' + JSON.stringify(response));
  return JSON.parse(String((first as JsonRecord).text ?? '')) as JsonRecord;
}

async function toolJson(id: number, name: string, args: JsonRecord): Promise<JsonRecord> {
  const response = await client.request(id, 'tools/call', { name, arguments: args });
  const inline = contentText(name, response);
  if (inline.truncated !== true || typeof inline.output_ref !== 'string') return inline;
  const firstPage = structured(response);
  const materialized = await readMcpOutputText(
    firstPage,
    async ({ offset, limit, pageNumber }) => structured(await client.request(`${id}-page-${pageNumber}`, 'tools/call', {
      name: 'site_loop_output_show',
      arguments: { ref: firstPage.output_ref, offset, limit },
    })),
    { pageSize: 5_000, maxPages: 20, maxTextChars: 1_000_000 },
  );
  return JSON.parse(materialized.text) as JsonRecord;
}

try {
  await runMcpProtocolSmoke(client, {
    expectedServerName: 'narada-site-loop-mcp',
    requiredTools: [
      'site_loop_doctor',
      'site_docs_list',
      'site_docs_show',
      'site_test_list',
      'site_test_run',
      'site_loop_config_validate',
      'site_loop_status',
      'site_loop_unified_status',
      'site_loop_recovery_plan',
      'site_loop_readiness',
      'site_loop_coherence',
      'site_loop_proof_status',
      'site_loop_recovery_drill',
      'site_loop_runs_list',
    ],
    toolsListId: 99,
  });

  const configValidation = contentText('site_loop_config_validate', await client.request(3, 'tools/call', { name: 'site_loop_config_validate', arguments: {} }));
  assert.equal(configValidation.status, 'ok');
  assert.equal(configValidation.loop_id, 'configured.e2e.loop');
  assert.equal(configValidation.site_id, 'narada-configured-e2e');

  const doctor = contentText('site_loop_doctor', await client.request(4, 'tools/call', { name: 'site_loop_doctor', arguments: {} }));
  assert.equal(doctor.status, 'ok');
  assert.equal((doctor.site_loop_config as JsonRecord).status, 'ok');
  assert.equal((doctor.site_loop_config as JsonRecord).loop_id, 'configured.e2e.loop');
  assert.deepEqual(doctor.approved_tests, ['smoke_echo']);

  const docsList = contentText('site_docs_list', await client.request(5, 'tools/call', { name: 'site_docs_list', arguments: {} }));
  assert.equal(docsList.status, 'ok');
  assert.equal(Array.isArray(docsList.docs) ? docsList.docs.length : 0, 2);
  const docs = Array.isArray(docsList.docs) ? docsList.docs : [];
  assert.equal(docs.some((doc) => (doc as JsonRecord).path === 'AGENTS.md'), true);
  assert.equal(docs.some((doc) => (doc as JsonRecord).path === 'README.md'), true);

  const docShow = contentText('site_docs_show', await client.request(6, 'tools/call', { name: 'site_docs_show', arguments: { path: 'AGENTS.md' } }));
  assert.equal(docShow.status, 'ok');
  assert.match(String(docShow.content), /Configured Site Loop E2E/);

  const testsList = contentText('site_test_list', await client.request(7, 'tools/call', { name: 'site_test_list', arguments: {} }));
  assert.equal(testsList.status, 'ok');
  const tests = Array.isArray(testsList.tests) ? testsList.tests : [];
  assert.equal(tests.length, 1);
  assert.equal((tests[0] as JsonRecord).selector, 'smoke_echo');

  const testRun = contentText('site_test_run', await client.request(8, 'tools/call', { name: 'site_test_run', arguments: { selector: 'smoke_echo' } }));
  assert.equal(testRun.status, 'passed');
  assert.equal(testRun.selector, 'smoke_echo');
  assert.equal(testRun.exit_code, 0);
  assert.equal(testRun.stdout, 'configured-site-loop-e2e-ok');

  const status = contentText('site_loop_status', await client.request(9, 'tools/call', { name: 'site_loop_status', arguments: {} }));
  assert.equal(status.loop_id, 'configured.e2e.loop');
  assert.equal(status.schema, 'narada.site_operating_loop.status.v1');

  const unifiedStatus = contentText('site_loop_unified_status', await client.request(10, 'tools/call', { name: 'site_loop_unified_status', arguments: {} }));
  assert.equal(unifiedStatus.status, 'ok', JSON.stringify(unifiedStatus));
  assert.equal(typeof unifiedStatus.posture, 'string', JSON.stringify(unifiedStatus));
  assert.equal(['missing', 'unsupported_platform'].includes(String((unifiedStatus.scheduled_task as JsonRecord).status)), true, JSON.stringify(unifiedStatus));

  const recoveryPlan = await toolJson(11, 'site_loop_recovery_plan', { include_commands: true });
  assert.equal(recoveryPlan.status, 'ok', JSON.stringify(recoveryPlan));
  assert.equal(recoveryPlan.read_only, true, JSON.stringify(recoveryPlan));
  assert.equal(recoveryPlan.mutation_performed, false, JSON.stringify(recoveryPlan));
  assert.equal(Array.isArray(recoveryPlan.current_blockers), true, JSON.stringify(recoveryPlan));
  assert.equal(Array.isArray(recoveryPlan.recommended_order), true, JSON.stringify(recoveryPlan));

  const readiness = await toolJson(12, 'site_loop_readiness', { require_production: true });
  assert.equal(readiness.status, 'not_ready', JSON.stringify(readiness));
  assert.equal((readiness.failed_gates as unknown[]).includes('resident_carrier'), true, JSON.stringify(readiness));
  assert.equal((readiness.failed_gates as unknown[]).includes('production_runtime'), true, JSON.stringify(readiness));

  const coherence = await toolJson(13, 'site_loop_coherence', { require_production: false, require_mailbox_chain: false });
  assert.equal(coherence.status, 'not_coherent', JSON.stringify(coherence));
  assert.equal(coherence.coherent, false, JSON.stringify(coherence));

  const proofStatus = contentText('site_loop_proof_status', await client.request(14, 'tools/call', { name: 'site_loop_proof_status', arguments: {} }));
  assert.equal(proofStatus.status, 'missing_or_stale', JSON.stringify(proofStatus));
  assert.equal((proofStatus.production_proof as JsonRecord).status, 'missing', JSON.stringify(proofStatus));

  const runs = contentText('site_loop_runs_list', await client.request(15, 'tools/call', { name: 'site_loop_runs_list', arguments: { limit: 5 } }));
  assert.equal(runs.loop_id, 'configured.e2e.loop', JSON.stringify(runs));
  assert.equal(Array.isArray(runs.runs), true, JSON.stringify(runs));
} finally {
  await server.close();
  assert.equal(stderr.trim(), '');
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('site-loop-mcp configured surface e2e ok');
