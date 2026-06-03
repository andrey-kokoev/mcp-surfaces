import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'inbox-mcp-'));

try {
  const state = createServerState({ siteRoot: root });
  const submit = handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'inbox_submit',
      arguments: {
        kind: 'incident',
        title: 'Inbox extraction regression',
        principal: 'test-agent',
        payload: { summary: 'A regression was reported.' },
      },
    },
  }, state);
  assert.equal(submit.error, undefined);
  const submitted = submit.result.structuredContent;
  assert.equal(submitted.status, 'admitted');
  assert.equal(existsSync(submitted.envelope_path), true);

  const next = handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'inbox_next', arguments: {} },
  }, state);
  assert.equal(next.error, undefined);
  const nextPayload = next.result.structuredContent;
  assert.equal(nextPayload.status, 'ok');
  assert.equal(nextPayload.envelope.kind, 'incident');
  assert.equal(nextPayload.envelope.action, 'materialize');

  const doctor = handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'inbox_doctor', arguments: {} },
  }, state);
  assert.equal(doctor.error, undefined);
  const doctorPayload = doctor.result.structuredContent;
  assert.equal(doctorPayload.storage_mode, 'node_sqlite');

  const filtered = handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'inbox_list',
      arguments: {
        kind: 'incident',
        target_role: 'architect',
        action: 'materialize',
      },
    },
  }, state);
  assert.equal(filtered.error, undefined);
  const filteredPayload = filtered.result.structuredContent;
  assert.deepEqual(filteredPayload.filters, {
    status: 'received',
    kind: 'incident',
    target_role: 'architect',
    action: 'materialize',
  });
  assert.equal(filteredPayload.count, 1);
  assert.equal(filteredPayload.envelopes[0].envelope_id, submitted.envelope_id);

  const rejected = handleRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'inbox_list', arguments: { kind: 'bogus' } },
  }, state);
  assert.match(rejected.error.message, /kind_must_be_one_of/);

  const queue = handleRequest({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'capa_queue', arguments: {} },
  }, state);
  assert.equal(queue.error, undefined);
  const queuePayload = queue.result.structuredContent;
  assert.equal(queuePayload.count, 1);

  console.log('inbox-mcp behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
