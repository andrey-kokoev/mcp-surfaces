import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveNaradaSitePaths } from '@narada2/site-paths';
import { buildGuidanceResult } from '../src/guidance.js';
import { buildInputEvent, createSessionClient, configFromEnv } from '../src/session-client.js';
import { handleRequest, listTools } from '../src/main.js';

test('lists the governed NARS session tool boundary', () => {
  assert.deepEqual(listTools().map((tool) => tool.name), [
    'nars_session_guidance',
    'nars_session_list',
    'nars_session_show',
    'nars_session_input_deliver',
    'nars_session_input_status',
  ]);
  const deliver = listTools().find((tool) => tool.name === 'nars_session_input_deliver');
  assert.equal(deliver?.annotations?.readOnlyHint, false);
  assert.deepEqual(buildGuidanceResult().delivery_modes.steer.includes('interruptive'), true);
});

test('builds agent-originated directive input without operator impersonation', () => {
  const event = buildInputEvent({
    content: 'inspect the current session state',
    delivery: 'enqueue',
    siteId: 'test-site',
    sessionId: 'session_test',
    sourceKind: 'agent',
    sourceId: 'sender.agent',
    carrierSessionId: 'carrier_sender',
    authorityEpoch: 3,
    authorityRuntimeId: 'auth_local_sender',
    idempotencyKey: 'input-1',
  });
  assert.equal(event.schema, 'narada.carrier.input_event.v1');
  assert.equal(event.source_kind, 'agent');
  assert.equal(event.source, 'agent_control');
  assert.equal(event.metadata.agent_control_input, true);
  assert.equal(event.metadata.directive_provenance.kind, 'agent_directive_surface');
  assert.equal(event.delivery_mode, 'admit_after_active_turn');
  assert.match(event.directive_id, /^dir_nars_input_/);
});

test('guidance is available without constructing a site authority client', async () => {
  const response = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'nars_session_guidance', arguments: {} },
  });
  assert.equal(response?.error, undefined);
  const result = record(response?.result);
  assert.equal(record(result.structuredContent).schema, 'narada.nars_session_mcp.guidance.v1');
});

test('discovers a bounded session from the canonical site-paths root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nars-session-mcp-discovery-'));
  try {
    const paths = resolveNaradaSitePaths({ siteRoot: root });
    const sessionDir = join(paths.narsSessionsRoot, 'session_test');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(paths.narsSessionsRoot, 'index.json'), JSON.stringify({
      schema: 'narada.nars.session_index.v1',
      site_root: root,
      sessions: [{ session_id: 'session_test', site_id: 'test-site' }],
    }));
    writeFileSync(join(sessionDir, 'session-index-record.json'), JSON.stringify({
      schema: 'narada.nars.session_index_record.v1',
      session_id: 'session_test',
      site_id: 'test-site',
      site_root: root,
      agent_id: 'resident',
      runtime_kind: 'narada-agent-runtime-server',
      source_write_admission: 'active',
      authority_epoch: 1,
      authority_runtime_id: 'auth_local_session_test',
      event_endpoint: null,
      health_endpoint: null,
    }));
    const client = createSessionClient({ NARADA_SITE_ROOT: root, NARADA_SITE_ID: 'test-site', NARADA_AGENT_ID: 'test.agent' });
    const result = await client.list({ include_health: false });
    assert.equal(result.count, 1);
    assert.equal(result.sessions[0].session_id, 'session_test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('user-site operator projection resolves sessions only through the admitted Site registry', async () => {
  const userRoot = mkdtempSync(join(tmpdir(), 'nars-session-mcp-user-site-'));
  const siteRoot = mkdtempSync(join(tmpdir(), 'nars-session-mcp-user-child-'));
  const registry = new DatabaseSync(join(userRoot, 'registry.db'));
  try {
    registry.exec('CREATE TABLE site_registry (site_id TEXT NOT NULL, site_root TEXT NOT NULL, created_at TEXT NOT NULL)');
    registry.prepare('INSERT INTO site_registry (site_id, site_root, created_at) VALUES (?, ?, ?)').run('fixture-site', siteRoot, '2026-01-01T00:00:00Z');
    const paths = resolveNaradaSitePaths({ siteRoot });
    const sessionDir = join(paths.narsSessionsRoot, 'session_user_site');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(paths.narsSessionsRoot, 'index.json'), JSON.stringify({ sessions: [{ session_id: 'session_user_site', site_id: 'fixture-site' }] }));
    writeFileSync(join(sessionDir, 'session-index-record.json'), JSON.stringify({
      schema: 'narada.nars.session_index_record.v1',
      session_id: 'session_user_site',
      site_id: 'fixture-site',
      site_root: siteRoot,
      event_endpoint: null,
    }));
    registry.close();

    const argv = ['--projection', 'user-site-operator', '--user-site-root', userRoot, '--source-kind', 'operator', '--operator-id', 'andrey'];
    const config = configFromEnv({ USERPROFILE: userRoot }, argv);
    assert.equal(config.scope, 'user_site');
    assert.equal(config.sourceKind, 'operator');
    assert.equal(config.sourceId, 'andrey');
    assert.deepEqual(config.authorities.map((authority) => authority.siteId), ['fixture-site']);

    const result = await createSessionClient({ USERPROFILE: userRoot }, argv).list({ include_health: false });
    assert.equal(result.count, 1);
    assert.equal(result.sessions[0].site_id, 'fixture-site');
    assert.equal(result.sessions[0].site_root, siteRoot);
  } finally {
    try { registry.close(); } catch { /* already closed */ }
    rmSync(userRoot, { recursive: true, force: true });
    rmSync(siteRoot, { recursive: true, force: true });
  }
});

test('delivers through the live NARS websocket authority path and returns admission evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nars-session-mcp-delivery-'));
  const server = createServer((socket) => fakeNarsWebSocket(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const paths = resolveNaradaSitePaths({ siteRoot: root });
    const sessionDir = join(paths.narsSessionsRoot, 'session_test');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session-index-record.json'), JSON.stringify({
      schema: 'narada.nars.session_index_record.v1',
      session_id: 'session_test',
      site_id: 'test-site',
      site_root: root,
      agent_id: 'resident',
      runtime_kind: 'narada-agent-runtime-server',
      source_write_admission: 'active',
      authority_epoch: 1,
      authority_runtime_id: 'auth_local_session_test',
      event_endpoint: `ws://127.0.0.1:${port}/events`,
      health_endpoint: null,
    }));
    const client = createSessionClient({
      NARADA_SITE_ROOT: root,
      NARADA_SITE_ID: 'test-site',
      NARADA_AGENT_ID: 'sender.agent',
      NARADA_CARRIER_SESSION_ID: 'carrier_sender',
    });
    const result = await client.deliver({
      session_id: 'session_test',
      delivery: 'enqueue',
      content: 'continue the bounded investigation',
      idempotency_key: 'delivery-1',
    });
    assert.equal(result.status, 'admitted');
    assert.equal(result.admission, 'queued');
    assert.equal(result.session_id, 'session_test');
    assert.match(result.input_event_id, /^input_/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires a bound caller identity', () => {
  assert.throws(
    () => configFromEnv({ NARADA_SITE_ROOT: 'D:/site' }),
    (error: unknown) => record(error).code === 'caller_agent_identity_required',
  );
});

test('refuses delivery when the session authority posture is not explicit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nars-session-mcp-authority-'));
  try {
    const paths = resolveNaradaSitePaths({ siteRoot: root });
    const sessionDir = join(paths.narsSessionsRoot, 'session_test');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session-index-record.json'), JSON.stringify({
      schema: 'narada.nars.session_index_record.v1',
      session_id: 'session_test',
      site_root: root,
      event_endpoint: 'ws://127.0.0.1:1/events',
    }));
    const client = createSessionClient({ NARADA_SITE_ROOT: root, NARADA_AGENT_ID: 'sender.agent' });
    await assert.rejects(
      () => client.deliver({ session_id: 'session_test', delivery: 'enqueue', content: 'do not guess authority', idempotency_key: 'delivery-unknown-authority' }),
      (error: unknown) => record(error).code === 'session_authority_not_writable',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeNarsWebSocket(socket: Socket) {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let handshaken = false;
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshaken) {
      const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(header)?.[1]?.trim();
      if (!key) return socket.destroy();
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      buffer = buffer.subarray(headerEnd + 4);
      handshaken = true;
      socket.write(serverFrame({ event: 'websocket_connected' }));
    }
    const frame = decodeClientFrame(buffer);
    if (!frame) return;
    buffer = frame.rest;
    const request = JSON.parse(frame.payload) as { id: string; method: string; params?: Record<string, unknown> };
    const params = record(request.params);
    const input = record(params.input);
    if (request.method === 'session.events.subscribe') {
      socket.write(serverFrame({ event: 'session_events_subscription_started', request_id: request.id }));
      return;
    }
    if (request.method === 'session.health') {
      socket.write(serverFrame({ event: 'session_health', request_id: request.id, status: 'healthy' }));
      return;
    }
    if (request.method === 'carrier.input.deliver') {
      socket.write(serverFrame({
        event: 'session_event',
        payload: {
          event: 'input_event_queued',
          request_id: request.id,
          input_event_id: input.event_id,
          queue_state: 'queued_for_turn_boundary',
        },
      }));
    }
  });
}

function serverFrame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function decodeClientFrame(buffer: Buffer): { payload: string; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const lengthByte = buffer[1];
  let length = lengthByte & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if ((lengthByte & 0x80) === 0 || buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { payload: payload.toString('utf8'), rest: buffer.subarray(offset + 4 + length) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
