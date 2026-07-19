import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('mailbox-site-fabric-e2e');
const outsideRoot = createTemporaryE2eRoot('mailbox-outside-e2e');
const mailboxDir = `${siteRoot}/.ai/mailboxes/support@example.test`;
mkdirSync(mailboxDir, { recursive: true });
const outsideMailboxDir = `${outsideRoot}/.ai/mailboxes/foreign@example.test`;
mkdirSync(outsideMailboxDir, { recursive: true });
writeFileSync(`${outsideMailboxDir}/messages.jsonl`, JSON.stringify({ id: 'foreign-message', subject: 'Must stay outside the bound Site', text: 'foreign' }), 'utf8');
const longBody = `${'bounded mailbox body '.repeat(500)}END_OF_MAILBOX_BODY`;
writeFileSync(`${mailboxDir}/messages.jsonl`, [
  JSON.stringify({
    id: 'msg-site-fabric-1',
    conversationId: 'thread-site-fabric',
    mailbox_id: 'support@example.test',
    folder: 'Inbox',
    subject: 'Site fabric mailbox fixture',
    from: { address: 'customer@example.test', name: 'Fixture Customer' },
    to: [{ address: 'support@example.test' }],
    receivedDateTime: '2026-07-10T16:00:00.000Z',
    isRead: false,
    bodyPreview: 'Controlled mailbox fixture.',
    body: { contentType: 'text', content: 'Controlled message body.' },
    attachments: [{ name: 'fixture.txt', size: 12 }],
  }),
  JSON.stringify({
    id: 'msg-site-fabric-2',
    conversationId: 'thread-site-fabric',
    mailbox_id: 'support@example.test',
    folder: 'Sent Items',
    subject: 'Re: Site fabric mailbox fixture',
    from: { address: 'support@example.test' },
    to: [{ address: 'customer@example.test' }],
    sentDateTime: '2026-07-10T17:00:00.000Z',
    isRead: true,
    text: 'Controlled response.',
  }),
  JSON.stringify({
    id: 'msg-site-fabric-3',
    conversationId: 'thread-site-fabric',
    mailbox_id: 'support@example.test',
    folder: 'Inbox',
    subject: 'Large output fixture',
    receivedDateTime: '2026-07-10T18:00:00.000Z',
    isRead: false,
    body: { contentType: 'text', content: longBody },
  }),
].join('\n'), 'utf8');

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--site-root', siteRoot], {
  cwd: siteRoot,
  env: siteFabricChildEnv(siteRoot, { NARADA_SITE_ID: 'fixture-site' }),
  label: 'mailbox site-fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  return (response.result as JsonRecord)?.structuredContent as JsonRecord ?? response.result as JsonRecord;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'narada-mailbox-mcp',
    requiredTools: ['mailbox_doctor', 'mailbox_accounts_list', 'mailbox_messages_list', 'mailbox_message_show', 'mailbox_search', 'mailbox_thread_show', 'mailbox_output_show'],
  });

  const doctor = structured(await server.client.request(1, 'tools/call', {
    name: 'mailbox_doctor',
    arguments: {},
  }));
  assert.equal(doctor.message_count, 3, JSON.stringify(doctor));
  assert.equal(doctor.invalid_count, 0, JSON.stringify(doctor));

  const accounts = structured(await server.client.request(2, 'tools/call', {
    name: 'mailbox_accounts_list',
    arguments: {},
  }));
  assert.equal(accounts.count, 1, JSON.stringify(accounts));
  assert.equal((accounts.accounts as JsonRecord[])[0]?.mailbox_id, 'support@example.test');

  const listed = structured(await server.client.request(3, 'tools/call', {
    name: 'mailbox_messages_list',
    arguments: { mailbox_id: 'support@example.test', unread: true, query: 'fixture', limit: 10 },
  }));
  assert.equal(listed.count, 2, JSON.stringify(listed));
  assert.deepEqual((listed.messages as JsonRecord[]).map((item) => item.message_id), ['msg-site-fabric-3', 'msg-site-fabric-1']);
  assert.equal((listed.messages as JsonRecord[])[0]?.body_text, undefined);

  const shown = structured(await server.client.request(4, 'tools/call', {
    name: 'mailbox_message_show',
    arguments: { message_id: 'msg-site-fabric-1', mailbox_id: 'support@example.test' },
  }));
  const message = shown.message as JsonRecord;
  assert.equal(message.status, undefined);
  assert.equal(message.message_id, 'msg-site-fabric-1');
  assert.equal((message.attachments as JsonRecord[])[0]?.name, 'fixture.txt');
  assert.equal(message.body_text, 'Controlled message body.');

  const large = structured(await server.client.request(5, 'tools/call', {
    name: 'mailbox_message_show',
    arguments: { message_id: 'msg-site-fabric-3', mailbox_id: 'support@example.test' },
  }));
  assert.match(String(large.output_ref), /^mcp_output:/, JSON.stringify(large));
  const firstPage = structured(await server.client.request(6, 'tools/call', {
    name: 'mailbox_output_show',
    arguments: { ref: large.output_ref, offset: 0, limit: 1000 },
  }));
  assert.equal(firstPage.schema, 'narada.mcp_output_page.v1', JSON.stringify(firstPage));
  assert.ok(Number(firstPage.next_offset) > 0, JSON.stringify(firstPage));
  const secondPage = structured(await server.client.request(7, 'tools/call', {
    name: 'mailbox_output_show',
    arguments: { ref: large.output_ref, offset: firstPage.next_offset, limit: 1000 },
  }));
  assert.equal(secondPage.offset, firstPage.next_offset, JSON.stringify(secondPage));

  const searched = structured(await server.client.request(8, 'tools/call', {
    name: 'mailbox_search',
    arguments: { query: 'Controlled response', limit: 10, include_body: true },
  }));
  assert.equal(searched.count, 1, JSON.stringify(searched));
  assert.equal((searched.messages as JsonRecord[])[0]?.message_id, 'msg-site-fabric-2');

  const thread = structured(await server.client.request(9, 'tools/call', {
    name: 'mailbox_thread_show',
    arguments: { thread_id: 'thread-site-fabric', mailbox_id: 'support@example.test', limit: 10, include_body: false },
  }));
  assert.equal(thread.count, 3, JSON.stringify(thread));

  const foreign = structured(await server.client.request(10, 'tools/call', {
    name: 'mailbox_message_show',
    arguments: { message_id: 'foreign-message' },
  }));
  assert.equal(foreign.status, 'not_found', JSON.stringify(foreign));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'mailbox.site-fabric.projection-and-thread-read',
    site_root: siteRoot,
    output_boundary: 'verified_by_bounded_server_responses',
    cleanup: 'pending_until_finally',
  }));
} finally {
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
  assert.equal(removeTemporaryE2eRoot(outsideRoot), true);
}

console.log('mailbox Site fabric e2e ok');
