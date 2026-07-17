import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('nars-session-site-fabric-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'nars-session.site-fabric.discovery-health-input-status.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'nars-session.site-fabric.discovery-health-input-status', authority: 'A0', external_authority: 'not_run', provider_boundary: 'controlled_nars_session_fixture' });
const healthServer = createServer((request, response) => {
  const status = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('status') ?? 'healthy';
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status, authority_epoch: 3 }));
});

function encodeServerFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  if (body.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  throw new Error('fixture_websocket_frame_too_large');
}

function decodeClientFrames(input: Buffer): { frames: Array<{ text: string }>; rest: Buffer } {
  const frames: Array<{ text: string }> = [];
  let buffer = input;
  while (buffer.length >= 2) {
    const second = buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      throw new Error('fixture_websocket_64bit_frame_unsupported');
    }
    const maskOffset = (second & 0x80) ? 4 : 0;
    if (buffer.length < offset + maskOffset + length) break;
    const mask = maskOffset ? buffer.subarray(offset, offset + 4) : null;
    const payloadOffset = offset + maskOffset;
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    buffer = buffer.subarray(payloadOffset + length);
    frames.push({ text: payload.toString('utf8') });
  }
  return { frames, rest: buffer };
}

function installInputStatusEventEndpoint() {
  const sockets: Array<{ destroy(): void }> = [];
  healthServer.on('upgrade', (request, socket) => {
    if (request.url?.split('?')[0] !== '/events') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const key = String(request.headers['sec-websocket-key'] ?? '');
    if (!key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    sockets.push(socket);
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const decoded = decodeClientFrames(pending);
      pending = decoded.rest;
      for (const frame of decoded.frames) {
        const message = JSON.parse(frame.text) as JsonRecord;
        if (message.method === 'session.events.subscribe') {
          socket.write(encodeServerFrame(JSON.stringify({
            schema: 'narada.nars.events.subscription.v1',
            event: 'session_events_subscription_started',
            request_id: message.id ?? null,
            subscription_id: (message.params as JsonRecord | undefined)?.subscription_id ?? null,
            transport: 'websocket',
            replay_count: 0,
            event_count: 0,
            has_more: false,
          })));
          continue;
        }
        if (message.method === 'carrier.input.deliver') {
          const params = (message.params as JsonRecord | undefined) ?? {};
          const input = (params.input as JsonRecord | undefined) ?? {};
          socket.write(encodeServerFrame(JSON.stringify({
            schema: 'narada.carrier.input_event.v1',
            event: 'input_admitted_to_turn',
            request_id: message.id ?? null,
            payload: {
              input_event_id: input.event_id ?? null,
              queue_state: 'active_turn_admitted',
            },
          })));
          continue;
        }
        if (message.method === 'session.events.read') {
          const params = (message.params as JsonRecord | undefined) ?? {};
          const filters = (params.filters as JsonRecord | undefined) ?? {};
          const anyOf = (filters.any_of as JsonRecord | undefined) ?? {};
          assert.equal(anyOf.request_id, 'request-1');
          socket.write(encodeServerFrame(JSON.stringify({
            schema: 'narada.nars.events.page.v1',
            event: 'session_events_read',
            request_id: message.id ?? null,
            transport: 'websocket',
            source: 'events_jsonl',
            event_count: 3,
            has_more: false,
            corrupt_line_count: 0,
            cursor: { before_sequence: 1, after_sequence: 3, last_sequence: 3, next_sequence: 4 },
            events: [
              { event: 'input_event_started', request_id: 'request-1', input_event_id: 'input-1' },
              { event: 'session_control_rejected', request_id: 'request-1', code: 'request_dispatch_failed', error: 'provider unavailable' },
              { event: 'runtime_request_state_transition', request_id: 'request-1', method: 'session.submit', request_state: 'failed', terminal_state: 'failed' },
            ],
          })));
        }
      }
    });
    socket.on('close', () => {
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    });
  });
  return sockets;
}

await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
const address = healthServer.address();
assert.ok(address && typeof address === 'object');
const eventSockets = installInputStatusEventEndpoint();

const sessionsRoot = `${siteRoot}/.narada/crew/nars-sessions`;
mkdirSync(`${sessionsRoot}/carrier_fixture`, { recursive: true });
writeFileSync(`${sessionsRoot}/index.json`, JSON.stringify({ sessions: [{ session_id: 'carrier_fixture', site_id: 'fixture-site' }] }), 'utf8');
writeFileSync(`${sessionsRoot}/carrier_fixture/session-index-record.json`, JSON.stringify({
  session_id: 'carrier_fixture',
  site_id: 'fixture-site',
  site_root: siteRoot,
  runtime_kind: 'nars',
  authority_epoch: 3,
  authority_runtime_id: 'authority_fixture',
  source_write_admission: 'active',
  health_endpoint: `http://127.0.0.1:${address.port}/health`,
}), 'utf8');

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath], {
  cwd: siteRoot,
  env: {
    ...process.env,
    NARADA_SITE_ROOT: siteRoot,
    NARADA_SITE_ID: 'fixture-site',
    NARADA_AGENT_ID: 'fixture-agent',
    NARADA_CARRIER_SESSION_ID: 'carrier_fixture',
  },
  label: 'nars-session Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'nars-session-mcp',
    requiredTools: ['nars_session_list', 'nars_session_show', 'nars_session_input_deliver', 'nars_session_input_status'],
  });

  const listed = structured(await server.client.request(1, 'tools/call', {
    name: 'nars_session_list',
    arguments: { include_health: true, limit: 5 },
  }));
  assert.equal(listed.status, 'ok', JSON.stringify(listed));
  assert.equal(listed.count, 1, JSON.stringify(listed));
  assert.equal(((listed.sessions as JsonRecord[])[0].health as JsonRecord).status, 'healthy', JSON.stringify(listed));

  writeFileSync(`${sessionsRoot}/carrier_fixture/session-index-record.json`, JSON.stringify({
    session_id: 'carrier_fixture',
    site_id: 'fixture-site',
    site_root: siteRoot,
    runtime_kind: 'nars',
    authority_epoch: 3,
    authority_runtime_id: 'authority_fixture',
    source_write_admission: 'active',
    health_endpoint: `http://127.0.0.1:${address.port}/health?status=degraded`,
  }), 'utf8');

  const shown = structured(await server.client.request(2, 'tools/call', {
    name: 'nars_session_show',
    arguments: { session_id: 'carrier_fixture', include_health: true },
  }));
  assert.equal(shown.status, 'ok', JSON.stringify(shown));
  assert.equal((shown.session as JsonRecord).session_id, 'carrier_fixture', JSON.stringify(shown));
  assert.equal((shown.authority as JsonRecord).authority_epoch, 3, JSON.stringify(shown));
  assert.equal(((shown.session as JsonRecord).health as JsonRecord).status, 'degraded', JSON.stringify(shown));
  assert.equal((shown.session as JsonRecord).display_state, 'starting_or_degraded', JSON.stringify(shown));

  for (const [healthStatus, expectedDisplayState] of [['unhealthy', 'unhealthy'], ['unavailable', 'unavailable']] as const) {
    writeFileSync(`${sessionsRoot}/carrier_fixture/session-index-record.json`, JSON.stringify({
      session_id: 'carrier_fixture',
      site_id: 'fixture-site',
      site_root: siteRoot,
      runtime_kind: 'nars',
      authority_epoch: 3,
      authority_runtime_id: 'authority_fixture',
      source_write_admission: 'active',
      health_endpoint: `http://127.0.0.1:${address.port}/health?status=${healthStatus}`,
    }), 'utf8');
    const unhealthy = structured(await server.client.request(20 + (healthStatus === 'unavailable' ? 1 : 0), 'tools/call', {
      name: 'nars_session_show',
      arguments: { session_id: 'carrier_fixture', include_health: true },
    }));
    assert.equal(((unhealthy.session as JsonRecord).health as JsonRecord).status, healthStatus, JSON.stringify(unhealthy));
    assert.equal((unhealthy.session as JsonRecord).display_state, expectedDisplayState, JSON.stringify(unhealthy));
    assert.equal((unhealthy.session as JsonRecord).display_state_reason, `health_probe_${healthStatus}`, JSON.stringify(unhealthy));
  }

  const refused = await server.client.request(3, 'tools/call', {
    name: 'nars_session_input_deliver',
    arguments: { session_id: 'carrier_fixture', delivery: 'enqueue', content: 'fixture', idempotency_key: 'fixture-key' },
  });
  assert.equal((refused.error?.data as JsonRecord)?.code, 'session_event_endpoint_missing', JSON.stringify(refused));

  writeFileSync(`${sessionsRoot}/carrier_fixture/session-index-record.json`, JSON.stringify({
    session_id: 'carrier_fixture',
    site_id: 'fixture-site',
    site_root: siteRoot,
    runtime_kind: 'nars',
    authority_epoch: 3,
    authority_runtime_id: 'authority_fixture',
    source_write_admission: 'active',
    health_endpoint: `http://127.0.0.1:${address.port}/health`,
    event_endpoint: `ws://127.0.0.1:${address.port}/events`,
  }), 'utf8');
  const inputStatus = structured(await server.client.request(4, 'tools/call', {
    name: 'nars_session_input_status',
    arguments: { session_id: 'carrier_fixture', request_id: 'request-1' },
  }));
  assert.equal(inputStatus.status, 'admitted_to_turn', JSON.stringify(inputStatus));
  assert.equal(inputStatus.status_semantics, 'admission', JSON.stringify(inputStatus));
  assert.equal(inputStatus.admission_status, 'admitted_to_turn', JSON.stringify(inputStatus));
  assert.equal(inputStatus.request_state, 'failed', JSON.stringify(inputStatus));
  assert.equal(inputStatus.terminal_state, 'failed', JSON.stringify(inputStatus));
  assert.equal(inputStatus.outcome, 'failed', JSON.stringify(inputStatus));
  assert.equal(inputStatus.outcome_reason, 'provider unavailable', JSON.stringify(inputStatus));
  assert.equal(inputStatus.terminal_event, 'runtime_request_state_transition', JSON.stringify(inputStatus));
  assert.equal(inputStatus.evidence_complete, true, JSON.stringify(inputStatus));
  assert.equal(inputStatus.history_truncated, false, JSON.stringify(inputStatus));
  assert.equal((inputStatus.evidence as JsonRecord).source, 'events_jsonl', JSON.stringify(inputStatus));
  assert.deepEqual((inputStatus.evidence as JsonRecord).cursor, { before_sequence: 1, after_sequence: 3, last_sequence: 3, next_sequence: 4 });

  const delivered = structured(await server.client.request(5, 'tools/call', {
    name: 'nars_session_input_deliver',
    arguments: { session_id: 'carrier_fixture', delivery: 'enqueue', content: 'fixture input', idempotency_key: 'fixture-delivery-key' },
  }));
  assert.equal(delivered.status, 'admitted', JSON.stringify(delivered));
  assert.equal(delivered.admission, 'accepted', JSON.stringify(delivered));
  assert.equal((delivered.evidence as JsonRecord).event, 'input_admitted_to_turn', JSON.stringify(delivered));
  assert.equal(delivered.queue_state, 'active_turn_admitted', JSON.stringify(delivered));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'nars-session.site-fabric.discovery-health-input-status',
    authority: 'A0',
    external_authority: 'not_run',
    provider_boundary: 'controlled_nars_session_fixture',
    mutation_performed: false,
    cleanup: 'completed_after_finally',
  }));
  evidence.update({ status: 'passed' });
} finally {
  await server.close();
  for (const socket of eventSockets) socket.destroy();
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  const cleanupOk = removeTemporaryE2eRoot(siteRoot);
  evidence.finalize({ status: cleanupOk ? 'passed' : 'failed', cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}

