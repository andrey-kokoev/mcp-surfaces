import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

type DynamicTestValue = any & {
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

const root = mkdtempSync(join(tmpdir(), 'mailbox-mcp-'));

try {
  const mailboxDir = join(root, '.ai', 'mailboxes', 'support@example.test');
  mkdirSync(mailboxDir, { recursive: true });
  writeFileSync(join(mailboxDir, 'messages.jsonl'), [
    JSON.stringify({
      id: 'msg-1',
      conversationId: 'thread-1',
      mailbox_id: 'support@example.test',
      folder: 'Inbox',
      subject: 'Ticket needs follow-up',
      from: { address: 'customer@example.test', name: 'Customer' },
      to: [{ address: 'support@example.test' }],
      receivedDateTime: '2026-06-04T16:00:00.000Z',
      isRead: false,
      bodyPreview: 'Can you send an update?',
      body: { contentType: 'text', content: 'Can you send an update on the open ticket?' },
      attachments: [{ name: 'screenshot.png', size: 1234 }],
    }),
    JSON.stringify({
      id: 'msg-2',
      conversationId: 'thread-1',
      mailbox_id: 'support@example.test',
      folder: 'Sent Items',
      subject: 'Re: Ticket needs follow-up',
      from: { address: 'support@example.test' },
      to: [{ address: 'customer@example.test' }],
      sentDateTime: '2026-06-04T17:00:00.000Z',
      isRead: true,
      text: 'We are checking the deployment state.',
    }),
  ].join('\n'));
  writeFileSync(join(mailboxDir, 'bad.json'), '{not json');

  const state = createServerState({ siteRoot: root });
  const doctor = rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'mailbox_doctor', arguments: {} },
  }, state);
  assert.equal(doctor.error, undefined);
  assert.equal(doctor.result.structuredContent.message_count, 2);
  assert.equal(doctor.result.structuredContent.invalid_count, 1);

  const accounts = rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'mailbox_accounts_list', arguments: {} },
  }, state);
  assert.equal(accounts.error, undefined);
  assert.equal(accounts.result.structuredContent.count, 1);
  assert.equal(accounts.result.structuredContent.accounts[0].unread_count, 1);

  const unread = rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'mailbox_messages_list', arguments: { unread: true, query: 'update' } },
  }, state);
  assert.equal(unread.error, undefined);
  assert.equal(unread.result.structuredContent.count, 1);
  assert.equal(unread.result.structuredContent.messages[0].message_id, 'msg-1');
  assert.equal(unread.result.structuredContent.messages[0].body_text, undefined);

  const show = rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'mailbox_message_show', arguments: { message_id: 'msg-1' } },
  }, state);
  assert.equal(show.error, undefined);
  assert.equal(show.result.structuredContent.message.body_text, 'Can you send an update on the open ticket?');
  assert.equal(show.result.structuredContent.message.attachments[0].name, 'screenshot.png');

  const thread = rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'mailbox_thread_show', arguments: { thread_id: 'thread-1' } },
  }, state);
  assert.equal(thread.error, undefined);
  assert.equal(thread.result.structuredContent.count, 2);
  assert.deepEqual(thread.result.structuredContent.messages.map((message: DynamicTestValue) => message.message_id), ['msg-1', 'msg-2']);

  const rejected = rpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'mailbox_message_show', arguments: {} },
  }, state);
  assert.match(rejected.error.message, /message_id_required/);

  console.log('mailbox-mcp behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
