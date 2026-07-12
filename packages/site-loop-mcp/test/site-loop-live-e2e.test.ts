import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnContentLengthMcpServer,
  type JsonRecord,
  type JsonRpcResponse,
} from '@narada2/mcp-e2e-harness';
import { openSiteLoopStore } from '../src/site-loop/site-loop-store.js';

const siteRoot = createTemporaryE2eRoot('site-loop-mcp-live-e2e');
const serverPath = fileURLToPath(new URL('../src/site-loop-mcp-server.js', import.meta.url));

mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });
writeFileSync(join(siteRoot, 'AGENTS.md'), '# Live E2E\n', 'utf8');
writeFileSync(join(siteRoot, 'README.md'), '# Live E2E\n', 'utf8');
writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v1',
  loop_id: 'live.e2e.loop',
  site_id: 'narada-live-e2e',
  display_name: 'Live E2E loop',
  resident: {
    agent_id: 'live.e2e.resident',
    role: 'resident',
  },
  refs: {
    ticket_projection: { kind: 'ticket_projection', ref: 'live-e2e' },
  },
  docs: [
    { path: 'AGENTS.md', description: 'Live E2E instructions.' },
    { path: 'README.md', description: 'Live E2E readme.' },
  ],
  tests: {
    smoke_echo: {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("live-e2e-ok")'],
    },
  },
}, null, 2), 'utf8');

const initializedLoopStore = openSiteLoopStore(siteRoot);
initializedLoopStore.close();

const server = spawnContentLengthMcpServer(process.execPath, ['--no-warnings', serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  label: 'site-loop-mcp-live-e2e',
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

try {
  await runMcpProtocolSmoke(client, {
    expectedServerName: 'narada-site-loop-mcp',
    requiredTools: ['site_loop_doctor', 'site_docs_list', 'site_docs_show', 'site_test_list', 'site_test_run', 'site_loop_config_validate', 'site_loop_status'],
    toolsListId: 99,
  });

  const configValidation = contentText('site_loop_config_validate', await client.request(3, 'tools/call', { name: 'site_loop_config_validate', arguments: {} }));
  assert.equal(configValidation.status, 'ok');
  assert.equal(configValidation.loop_id, 'live.e2e.loop');
  assert.equal(configValidation.site_id, 'narada-live-e2e');

  const doctor = contentText('site_loop_doctor', await client.request(4, 'tools/call', { name: 'site_loop_doctor', arguments: {} }));
  assert.equal(doctor.status, 'ok');
  assert.equal((doctor.site_loop_config as JsonRecord).status, 'ok');
  assert.equal((doctor.site_loop_config as JsonRecord).loop_id, 'live.e2e.loop');
  assert.deepEqual(doctor.approved_tests, ['smoke_echo']);

  const docsList = contentText('site_docs_list', await client.request(5, 'tools/call', { name: 'site_docs_list', arguments: {} }));
  assert.equal(docsList.status, 'ok');
  assert.equal(Array.isArray(docsList.docs) ? docsList.docs.length : 0, 2);
  const docs = Array.isArray(docsList.docs) ? docsList.docs : [];
  assert.equal(docs.some((doc) => (doc as JsonRecord).path === 'AGENTS.md'), true);
  assert.equal(docs.some((doc) => (doc as JsonRecord).path === 'README.md'), true);

  const docShow = contentText('site_docs_show', await client.request(6, 'tools/call', { name: 'site_docs_show', arguments: { path: 'AGENTS.md' } }));
  assert.equal(docShow.status, 'ok');
  assert.match(String(docShow.content), /Live E2E/);

  const testsList = contentText('site_test_list', await client.request(7, 'tools/call', { name: 'site_test_list', arguments: {} }));
  assert.equal(testsList.status, 'ok');
  const tests = Array.isArray(testsList.tests) ? testsList.tests : [];
  assert.equal(tests.length, 1);
  assert.equal((tests[0] as JsonRecord).selector, 'smoke_echo');

  const testRun = contentText('site_test_run', await client.request(8, 'tools/call', { name: 'site_test_run', arguments: { selector: 'smoke_echo' } }));
  assert.equal(testRun.status, 'passed');
  assert.equal(testRun.selector, 'smoke_echo');
  assert.equal(testRun.exit_code, 0);
  assert.equal(testRun.stdout, 'live-e2e-ok');

  const status = contentText('site_loop_status', await client.request(9, 'tools/call', { name: 'site_loop_status', arguments: {} }));
  assert.equal(status.loop_id, 'live.e2e.loop');
  assert.equal(status.schema, 'narada.site_operating_loop.status.v1');
} finally {
  await server.close();
  assert.equal(stderr.trim(), '');
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('site-loop-mcp live e2e ok');
