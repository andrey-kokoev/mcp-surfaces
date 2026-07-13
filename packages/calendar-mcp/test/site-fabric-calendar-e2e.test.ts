import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  writeE2eResultArtifact,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('calendar-site-fabric-e2e');
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const resultPath = join(packageRoot, '.tmp', 'e2e-results', 'calendar.site-fabric.external-calendar-lifecycle.json');
let resultStatus: 'passed' | 'not_run' | 'failed' = 'failed';
const startedAt = new Date().toISOString();
const liveRequested = process.env.NARADA_E2E_CALENDAR_LIVE === '1';
const accessToken = process.env.NARADA_E2E_CALENDAR_ACCESS_TOKEN;
const mailbox = process.env.NARADA_E2E_CALENDAR_MAILBOX;
const approvalToken = process.env.NARADA_E2E_CALENDAR_WRITE_APPROVAL_TOKEN;
const liveWriteEnabled = liveRequested && Boolean(accessToken) && Boolean(mailbox) && Boolean(approvalToken);
let missingPrerequisites: string[] = [];
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));

mkdirSync(join(siteRoot, '.ai'), { recursive: true });
writeFileSync(join(siteRoot, '.ai', 'calendar-mcp.json'), JSON.stringify({
  graph_base_url: process.env.NARADA_E2E_CALENDAR_BASE_URL ?? 'https://graph.microsoft.com/v1.0',
  allowed_mailboxes: mailbox ? [mailbox] : [],
  allow_event_writes: liveWriteEnabled,
  ...(approvalToken ? { write_approval_token: approvalToken } : {}),
}, null, 2), 'utf8');

if (accessToken) writeFileSync(join(siteRoot, '.env'), `MS_GRAPH_ACCESS_TOKEN=${accessToken}\n`, 'utf8');

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MS_GRAPH_ACCESS_TOKEN: undefined,
  GRAPH_ACCESS_TOKEN: undefined,
  GRAPH_TENANT_ID: undefined,
  GRAPH_CLIENT_ID: undefined,
  GRAPH_CLIENT_SECRET: undefined,
};
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  env: childEnv,
  label: 'calendar Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'narada-calendar-mcp',
    requiredTools: ['calendar_doctor', 'calendar_list', 'calendar_event_query', 'calendar_event_show', 'calendar_event_create', 'calendar_event_update', 'calendar_event_delete', 'calendar_output_show'],
  });

  const doctor = structured(await server.client.request(3, 'tools/call', {
    name: 'calendar_doctor',
    arguments: {},
  }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  assert.equal(doctor.allow_event_writes, liveWriteEnabled, JSON.stringify(doctor));
  assert.deepEqual(doctor.allowed_mailboxes, mailbox ? [mailbox] : [], JSON.stringify(doctor));

  const prerequisites = [
    ['live_authority_not_enabled', liveRequested],
    ['controlled_access_token_missing', Boolean(accessToken)],
    ['controlled_mailbox_missing', Boolean(mailbox)],
    ['controlled_write_approval_token_missing', Boolean(approvalToken)],
  ] as const;
  missingPrerequisites = prerequisites.filter(([, present]) => !present).map(([reason]) => reason);
  if (missingPrerequisites.length > 0) {
    resultStatus = 'not_run';
    console.log(JSON.stringify({
      status: 'not_run',
      test_id: 'calendar.site-fabric.external-calendar-lifecycle',
      authority: 'A1',
      reason_code: 'controlled_calendar_authority_not_configured',
      missing_prerequisites: missingPrerequisites,
      doctor_auth_mode: doctor.auth_mode,
      cleanup: 'completed_after_finally',
    }));
  } else {
    const calendars = structured(await server.client.request(4, 'tools/call', {
      name: 'calendar_list',
      arguments: { mailbox_id: mailbox, limit: 10 },
    }));
    assert.equal(calendars.status, 'ok', JSON.stringify(calendars));

    const events = structured(await server.client.request(5, 'tools/call', {
      name: 'calendar_event_query',
      arguments: {
        mailbox_id: mailbox,
        start_datetime: new Date(Date.now() - 3600000).toISOString(),
        end_datetime: new Date(Date.now() + 3600000).toISOString(),
        limit: 10,
        select: 'id,subject,start,end',
      },
    }));
    assert.equal(events.status, 'ok', JSON.stringify(events));

    const created = structured(await server.client.request(6, 'tools/call', {
      name: 'calendar_event_create',
      arguments: {
        mailbox_id: mailbox,
        subject: 'Must remain refused',
        start_datetime: new Date(Date.now() + 7200000).toISOString(),
        end_datetime: new Date(Date.now() + 7260000).toISOString(),
        time_zone: 'UTC',
        confirm_write: true,
      },
    }));
    assert.equal(created.status, 'created', JSON.stringify(created));
    const eventId = String((created.event as JsonRecord).id ?? '');
    assert.ok(eventId, JSON.stringify(created));

    try {
      const shown = structured(await server.client.request(7, 'tools/call', {
        name: 'calendar_event_show',
        arguments: { mailbox_id: mailbox, event_id: eventId, select: 'id,subject,start,end' },
      }));
      assert.equal(shown.status, 'ok', JSON.stringify(shown));

      const updated = structured(await server.client.request(8, 'tools/call', {
        name: 'calendar_event_update',
        arguments: {
          mailbox_id: mailbox,
          event_id: eventId,
          subject: 'Controlled MCP E2E updated event',
          body_text: 'Updated controlled calendar event.',
          confirm_write: true,
          approval_token: approvalToken,
        },
      }));
      assert.equal(updated.status, 'updated', JSON.stringify(updated));
    } finally {
      const deleted = structured(await server.client.request(9, 'tools/call', {
        name: 'calendar_event_delete',
        arguments: { mailbox_id: mailbox, event_id: eventId, confirm_write: true, approval_token: approvalToken },
      }));
      assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
    }

    console.log(JSON.stringify({
      status: 'passed',
      test_id: 'calendar.site-fabric.external-calendar-lifecycle',
      authority: 'A1',
      coverage: ['calendar_list', 'event_query', 'event_show', 'event_create', 'event_update', 'event_delete'],
      cleanup: 'completed_after_finally',
    }));
    resultStatus = 'passed';
  }
} finally {
  let cleanupStatus = 'passed';
  try { await server.close(); } catch { cleanupStatus = 'failed'; }
  if (!removeTemporaryE2eRoot(siteRoot)) cleanupStatus = 'failed';
  if (cleanupStatus === 'failed') {
    resultStatus = 'failed';
    process.exitCode = 1;
  }
  writeE2eResultArtifact(resultPath, {
    schema: 'narada.mcp.e2e.result.v1',
    test_id: 'calendar.site-fabric.external-calendar-lifecycle',
    status: resultStatus,
    authority: 'A1',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ...(resultStatus === 'not_run' ? {
      reason_code: 'controlled_calendar_authority_not_configured',
      missing_prerequisites: missingPrerequisites,
    } : {}),
    cleanup: { status: cleanupStatus },
  });
}
