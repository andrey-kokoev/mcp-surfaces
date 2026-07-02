import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

type JsonValue = unknown;
type JsonRecord = Record<string, JsonValue>;
type JsonRpcTestResponse = {
  error?: { message: string };
  result: {
    structuredContent: JsonRecord;
  };
};
type CapturedRequest = { url: string; init: JsonRecord };
type MockResponse = { body?: JsonValue; ok?: boolean; status?: number; statusText?: string; text?: string };

const rpc = handleRequest as unknown as (...args: Parameters<typeof handleRequest>) => Promise<JsonRpcTestResponse>;

function mockFetch(calls: CapturedRequest[], responses: MockResponse[] = []) {
  return async (url: string, init: JsonRecord = {}) => {
    calls.push({ url, init });
    const response = responses.shift() ?? {};
    const status = response.status ?? 200;
    const ok = response.ok ?? (status >= 200 && status < 300);
    const text = response.text ?? JSON.stringify(response.body ?? {});
    return { status, ok, statusText: response.statusText ?? 'OK', text: async () => text };
  };
}

const root = mkdtempSync(join(tmpdir(), 'calendar-mcp-'));

try {
  mkdirSync(join(root, '.ai'), { recursive: true });
  writeFileSync(join(root, '.ai', 'calendar-mcp.json'), JSON.stringify({
    graph_base_url: 'https://graph.example.test/v1.0',
    allowed_mailboxes: ['calendar@example.test'],
  }));

  const calls: CapturedRequest[] = [];
  const state = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(calls, [
      { body: { value: [{ id: 'cal-1', name: 'Calendar' }] } },
      { body: { value: [{ id: 'event-1', subject: 'Planning' }] } },
      { body: { id: 'event-1', subject: 'Planning' } },
    ]),
  });

  const doctor = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'calendar_doctor', arguments: {} } }, state);
  assert.equal(doctor.error, undefined);
  assert.equal(doctor.result.structuredContent.has_access_token, true);
  assert.equal(doctor.result.structuredContent.auth_mode, 'access_token');
  assert.equal(doctor.result.structuredContent.allow_event_writes, false);
  assert.deepEqual(doctor.result.structuredContent.allowed_mailboxes, ['calendar@example.test']);

  const calendars = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'calendar_list', arguments: { limit: 3 } } }, state);
  assert.equal(calendars.error, undefined);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal((calls[0].init.headers as JsonRecord).Authorization, 'Bearer test-token');
  assert.equal(calls[0].url, 'https://graph.example.test/v1.0/users/calendar%40example.test/calendars?%24top=3');

  const events = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'calendar_event_query',
      arguments: {
        start_datetime: '2026-06-25T10:00:00Z',
        end_datetime: '2026-06-25T11:00:00Z',
        select: 'id,subject,start,end',
        limit: 5,
      },
    },
  }, state);
  assert.equal(events.error, undefined);
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].url, 'https://graph.example.test/v1.0/users/calendar%40example.test/calendarView?startDateTime=2026-06-25T10%3A00%3A00Z&endDateTime=2026-06-25T11%3A00%3A00Z&%24top=5&%24orderby=start%2FdateTime&%24select=id%2Csubject%2Cstart%2Cend');

  const event = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'calendar_event_show', arguments: { event_id: 'event-1' } } }, state);
  assert.equal(event.error, undefined);
  assert.equal(calls[2].url, 'https://graph.example.test/v1.0/users/calendar%40example.test/events/event-1');

  const refused = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'calendar_event_create',
      arguments: {
        subject: 'Blocked write',
        start_datetime: '2026-06-25T10:00:00',
        end_datetime: '2026-06-25T11:00:00',
        time_zone: 'UTC',
        confirm_write: true,
      },
    },
  }, state);
  assert.equal(refused.error, undefined);
  assert.equal(refused.result.structuredContent.status, 'refused');
  assert.equal(refused.result.structuredContent.reason, 'event_writes_disallowed_by_policy');
  assert.equal(calls.length, 3);
  assert.equal(existsSync(join(root, '.ai', 'audit', 'calendar-mcp.jsonl')), true);
  assert.equal(existsSync(join(root, '.ai', 'telemetry', 'calendar.jsonl')), false);

  writeFileSync(join(root, '.ai', 'mcp-telemetry.json'), JSON.stringify({ enabled: true, level: 'all' }));
  const telemetryRefused = await rpc({
    jsonrpc: '2.0',
    id: 51,
    method: 'tools/call',
    params: {
      name: 'calendar_event_create',
      arguments: {
        subject: 'Telemetry blocked write',
        body_text: 'must not be persisted in telemetry',
        start_datetime: '2026-06-25T12:00:00',
        end_datetime: '2026-06-25T13:00:00',
        time_zone: 'UTC',
        confirm_write: true,
      },
    },
  }, state);
  assert.equal(telemetryRefused.error, undefined);
  assert.equal(telemetryRefused.result.structuredContent.status, 'refused');
  const telemetryEvent = JSON.parse(readFileSync(join(root, '.ai', 'telemetry', 'calendar.jsonl'), 'utf8').trim());
  assert.equal(telemetryEvent.schema, 'narada.mcp_telemetry.event.v1');
  assert.equal(telemetryEvent.surface_id, 'calendar');
  assert.equal(telemetryEvent.tool_name, 'calendar_event_create');
  assert.equal(telemetryEvent.event_kind, 'tool_refused');
  assert.equal(telemetryEvent.status, 'refused');
  assert.deepEqual(telemetryEvent.policy_decision, { status: 'refused', code: 'event_writes_disallowed_by_policy' });
  assert.equal('args' in telemetryEvent, false);
  assert.equal('result' in telemetryEvent, false);
  assert.equal(JSON.stringify(telemetryEvent).includes('must not be persisted'), false);

  writeFileSync(join(root, '.ai', 'calendar-mcp.json'), JSON.stringify({
    graph_base_url: 'https://graph.example.test/v1.0',
    allowed_mailboxes: ['calendar@example.test'],
    allow_event_writes: true,
    write_approval_token: 'approve-1',
  }));
  const writeCalls: CapturedRequest[] = [];
  const writeState = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(writeCalls, [{ body: { id: 'created-1', subject: 'Allowed write' } }]),
  });
  const created = await rpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'calendar_event_create',
      arguments: {
        subject: 'Allowed write',
        start_datetime: '2026-06-25T10:00:00',
        end_datetime: '2026-06-25T11:00:00',
        time_zone: 'UTC',
        attendees: ['person@example.test'],
        location: 'Conference Room',
        confirm_write: true,
        approval_token: 'approve-1',
      },
    },
  }, writeState);
  assert.equal(created.error, undefined);
  assert.equal(created.result.structuredContent.status, 'created');
  assert.equal(writeCalls[0].init.method, 'POST');
  assert.equal(writeCalls[0].url, 'https://graph.example.test/v1.0/users/calendar%40example.test/events');
  const createBody = JSON.parse(String(writeCalls[0].init.body));
  assert.equal(createBody.subject, 'Allowed write');
  assert.deepEqual(createBody.start, { dateTime: '2026-06-25T10:00:00', timeZone: 'UTC' });
  assert.deepEqual(createBody.attendees, [{ emailAddress: { address: 'person@example.test' }, type: 'required' }]);

  assert.match(readFileSync(join(root, '.ai', 'audit', 'calendar-mcp.jsonl'), 'utf8'), /event_create_completed/);
  console.log('calendar-mcp behavior tests ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
