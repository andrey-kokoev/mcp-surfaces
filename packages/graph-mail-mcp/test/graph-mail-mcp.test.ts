import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

type CapturedRequest = { url: string; init: DynamicTestValue };

const rpc = handleRequest as unknown as (...args: Parameters<typeof handleRequest>) => Promise<JsonRpcTestResponse>;

function mockFetch(calls: CapturedRequest[], responses: unknown[] = []) {
  return async (url: string, init: DynamicTestValue = {}) => {
    calls.push({ url, init });
    const body = responses.shift() ?? { id: 'draft-1', subject: 'Created draft' };
    return {
      status: init.method === 'DELETE' || String(url).endsWith('/send') ? 202 : 200,
      ok: true,
      text: async () => init.method === 'DELETE' || String(url).endsWith('/send') ? '' : JSON.stringify(body),
    };
  };
}

function mockTextFetch(calls: CapturedRequest[], responses: Array<{ status?: number; ok?: boolean; text?: string }> = []) {
  return async (url: string, init: DynamicTestValue = {}) => {
    calls.push({ url, init });
    const response = responses.shift() ?? { text: '{}' };
    return {
      status: response.status ?? 200,
      ok: response.ok ?? true,
      text: async () => response.text ?? '{}',
    };
  };
}

const root = mkdtempSync(join(tmpdir(), 'graph-mail-mcp-'));

try {
  mkdirSync(join(root, '.ai'), { recursive: true });
  writeFileSync(join(root, '.ai', 'graph-mail-mcp.json'), JSON.stringify({
    graph_base_url: 'https://graph.example.test/v1.0',
    allowed_mailboxes: ['support@example.test'],
  }));

  const calls: CapturedRequest[] = [];
  const state = createServerState({ siteRoot: root, accessToken: 'test-token', fetchImpl: mockFetch(calls, [{ value: [{ id: 'msg-1' }] }]) });

  const doctor = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'graph_mail_doctor', arguments: {} },
  }, state);
  assert.equal(doctor.error, undefined);
  assert.equal(doctor.result.structuredContent.has_access_token, true);
  assert.equal(doctor.result.structuredContent.auth_mode, 'access_token');
  assert.equal(doctor.result.structuredContent.allow_send_draft, false);

  const clientCredentialCalls: CapturedRequest[] = [];
  const clientCredentialState = createServerState({
    siteRoot: root,
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    tokenEndpoint: 'https://login.example.test/token',
    fetchImpl: mockTextFetch(clientCredentialCalls, [
      { text: JSON.stringify({ access_token: 'app-token', expires_in: 3600 }) },
      { text: JSON.stringify({ value: [{ id: 'msg-app-1' }] }) },
    ]),
  });

  const clientCredentialDoctor = await rpc({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'graph_mail_doctor', arguments: {} },
  }, clientCredentialState);
  assert.equal(clientCredentialDoctor.error, undefined);
  assert.equal(clientCredentialDoctor.result.structuredContent.has_access_token, true);
  assert.equal(clientCredentialDoctor.result.structuredContent.auth_mode, 'client_credentials');
  assert.equal(clientCredentialCalls.length, 0);

  const clientCredentialQuery = await rpc({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'graph_mail_query', arguments: { mailbox_id: 'support@example.test', limit: 1 } },
  }, clientCredentialState);
  assert.equal(clientCredentialQuery.error, undefined);
  assert.equal(clientCredentialCalls[0].url, 'https://login.example.test/token');
  assert.equal(clientCredentialCalls[0].init.method, 'POST');
  assert.match(clientCredentialCalls[1].url, /^https:\/\/graph\.example\.test\/v1\.0\/users\/support%40example\.test\/messages\?/);
  assert.equal(clientCredentialCalls[1].init.headers.Authorization, 'Bearer app-token');

  const query = await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'graph_mail_query',
      arguments: {
        mailbox_id: 'support@example.test',
        query: 'follow up',
        limit: 5,
      },
    },
  }, state);
  assert.equal(query.error, undefined);
  assert.match(calls[0].url, /^https:\/\/graph\.example\.test\/v1\.0\/users\/support%40example\.test\/messages\?/);
  assert.match(calls[0].url, /%24top=5/);
  assert.match(calls[0].url, /%24search=%22follow\+up%22/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');

  const create = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'graph_mail_draft_create',
      arguments: {
        mailbox_id: 'support@example.test',
        subject: 'Customer follow-up',
        body_text: 'Draft body',
        to_recipients: ['customer@example.test'],
      },
    },
  }, state);
  assert.equal(create.error, undefined);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages');
  const createBody = JSON.parse(calls[1].init.body);
  assert.equal(createBody.subject, 'Customer follow-up');
  assert.equal(createBody.body.contentType, 'Text');
  assert.equal(createBody.toRecipients[0].emailAddress.address, 'customer@example.test');

  const refused = await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'graph_mail_draft_send',
      arguments: {
        mailbox_id: 'support@example.test',
        draft_id: 'draft-1',
        confirm_send: true,
      },
    },
  }, state);
  assert.equal(refused.error, undefined);
  assert.equal(refused.result.structuredContent.status, 'refused');
  assert.equal(refused.result.structuredContent.reason, 'send_draft_disallowed_by_policy');
  assert.equal(calls.length, 2);
  const auditPath = join(root, '.ai', 'audit', 'graph-mail-mcp.jsonl');
  assert.equal(existsSync(auditPath), true);
  assert.match(readFileSync(auditPath, 'utf8'), /draft_send_refused/);

  const blockedMailbox = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'graph_mail_query', arguments: { mailbox_id: 'blocked@example.test' } },
  }, state);
  assert.match(blockedMailbox.error.message, /mailbox_not_allowed/);

  writeFileSync(join(root, '.ai', 'graph-mail-mcp.json'), JSON.stringify({
    graph_base_url: 'https://graph.example.test/v1.0',
    allowed_mailboxes: ['support@example.test'],
    allow_send_draft: true,
    send_approval_token: 'approve-123',
  }));

  const deniedNoToken = await rpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'graph_mail_draft_send',
      arguments: {
        mailbox_id: 'support@example.test',
        draft_id: 'draft-1',
        confirm_send: true,
      },
    },
  }, state);
  assert.equal(deniedNoToken.result.structuredContent.status, 'refused');
  assert.equal(deniedNoToken.result.structuredContent.reason, 'send_approval_token_required');

  const sent = await rpc({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'graph_mail_draft_send',
      arguments: {
        mailbox_id: 'support@example.test',
        draft_id: 'draft-1',
        confirm_send: true,
        approval_token: 'approve-123',
      },
    },
  }, state);
  assert.equal(sent.error, undefined);
  assert.equal(sent.result.structuredContent.status, 'sent');
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(calls[2].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/draft-1/send');

  console.log('graph-mail-mcp behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
