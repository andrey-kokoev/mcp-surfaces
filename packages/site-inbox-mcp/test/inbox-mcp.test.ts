import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

type DynamicTestValue = string & DynamicTestValue[] & {
  [key: string]: DynamicTestValue;
  [index: number]: DynamicTestValue;
};

type JsonRpcTestResponse = {
  error: DynamicTestValue;
  result: {
    structuredContent: DynamicTestValue;
  };
};

const rpc = handleRequest as unknown as (...args: Parameters<typeof handleRequest>) => JsonRpcTestResponse;

const root = mkdtempSync(join(tmpdir(), 'inbox-mcp-'));

try {
  const state = createServerState({ siteRoot: root });
  const submit = rpc({
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

  const next = rpc({
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

  const doctor = rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'inbox_doctor', arguments: {} },
  }, state);
  assert.equal(doctor.error, undefined);
  const doctorPayload = doctor.result.structuredContent;
  assert.equal(doctorPayload.storage_mode, 'node_sqlite');

  const filtered = rpc({
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

  const rejected = rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'inbox_list', arguments: { kind: 'bogus' } },
  }, state);
  assert.match(rejected.error.message, /kind_must_be_one_of/);

  const queue = rpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'capa_queue', arguments: {} },
  }, state);
  assert.equal(queue.error, undefined);
  const queuePayload = queue.result.structuredContent;
  assert.equal(queuePayload.count, 1);

  const audit = rpc({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'inbox_audit', arguments: { limit: 10 } },
  }, state);
  assert.equal(audit.error, undefined);
  const auditPayload = audit.result.structuredContent;
  assert.ok(auditPayload.total_entries);
  assert.ok(auditPayload.entries.length);
  assert.ok(auditPayload.entries[0].event_kind);

  const ack = rpc({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'inbox_acknowledge', arguments: { envelope_id: submitted.envelope_id, principal: 'test-architect', reason: 'Not actionable.' } },
  }, state);
  assert.equal(ack.error, undefined);
  const ackPayload = ack.result.structuredContent;
  assert.equal(ackPayload.status, 'acknowledged');
  assert.equal(ackPayload.envelope_id, submitted.envelope_id);

  const afterAck = rpc({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'inbox_show', arguments: { envelope_id: submitted.envelope_id } },
  }, state);
  assert.equal(afterAck.result.structuredContent.envelope.status, 'acknowledged');

  console.log('inbox-mcp behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
