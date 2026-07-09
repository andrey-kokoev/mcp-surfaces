import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  result: DynamicTestValue;
};

type CapturedRequest = { url: string; init: DynamicTestValue };
type MockResponse = { body?: unknown; ok?: boolean; status?: number; statusText?: string; text?: string };

const rpc = handleRequest as unknown as (...args: Parameters<typeof handleRequest>) => Promise<JsonRpcTestResponse>;

function mockFetch(calls: CapturedRequest[], responses: MockResponse[] = []) {
  return async (url: string, init: DynamicTestValue = {}) => {
    calls.push({ url, init });
    const response = responses.shift() ?? {};
    const status = response.status ?? 200;
    const ok = response.ok ?? (status >= 200 && status < 300);
    const text = response.text ?? JSON.stringify(response.body ?? {});
    return {
      status,
      ok,
      statusText: response.statusText ?? 'OK',
      text: async () => text,
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

  const attachmentCalls: CapturedRequest[] = [];
  const attachmentState = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(attachmentCalls, [
      { body: { value: [{ id: 'att-list-1' }] } },
      { body: { id: 'att-get-1', name: 'report.pdf', contentBytes: 'YWJj', content: 'legacy-content' } },
      { body: { id: 'att-added-1', name: 'report.pdf' } },
      { body: { id: 'upload-session-1', uploadUrl: 'https://outlook.office.com/upload/abc', expirationDateTime: '2026-06-08T20:00:00Z' } },
      { body: { id: 'upload-session-2', uploadUrl: 'https://outlook.office365.com/upload/file-abc', expirationDateTime: '2026-06-08T20:00:00Z' } },
      { status: 202, text: '' },
      { status: 201, body: { id: 'att-uploaded-1', name: 'local.bin' } },
      { status: 204, text: '' },
    ]),
  });

  const doctor = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'graph_mail_doctor', arguments: {} },
  }, attachmentState);
  assert.equal(doctor.error, undefined);
  assert.equal(doctor.result.structuredContent.has_access_token, true);
  assert.equal(doctor.result.structuredContent.auth_mode, 'access_token');
  assert.equal(doctor.result.structuredContent.allow_device_code_auth, false);
  assert.equal(doctor.result.structuredContent.device_code_tenant_configured, false);
  assert.equal(doctor.result.structuredContent.device_code_client_configured, false);
  assert.deepEqual(doctor.result.structuredContent.device_code_allowed_scopes, []);
  assert.equal(doctor.result.structuredContent.delegated_token.status, 'missing');
  assert.equal(doctor.result.structuredContent.allow_send_draft, false);
  assert.equal(doctor.result.structuredContent.allow_folder_create, false);
  assert.equal(doctor.result.structuredContent.allow_message_move, false);
  assert.equal(doctor.result.structuredContent.mailbox_organization_approval_token_configured, false);
  assert.deepEqual(doctor.result.structuredContent.allowed_attachment_roots, [root]);

  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, attachmentState);
  assert.equal(tools.error, undefined);
  const toolRows = tools.result.tools;
  assert.deepEqual(toolRows.map((tool: DynamicTestValue) => tool.name), [
    'graph_mail_guidance',
    'graph_mail_doctor',
    'graph_mail_auth_device_code_start',
    'graph_mail_auth_device_code_poll',
    'graph_mail_auth_status',
    'graph_mail_auth_clear',
    'graph_mail_query',
    'graph_mail_message_show',
    'graph_mail_folder_list',
    'graph_mail_folder_create',
    'graph_mail_message_move',
    'graph_mail_attachment_list',
    'graph_mail_attachment_get',
    'graph_mail_attachment_add',
    'graph_mail_attachment_upload_session_create',
    'graph_mail_attachment_upload_chunk',
    'graph_mail_attachment_upload_file',
    'graph_mail_attachment_delete',
    'graph_mail_draft_create',
    'graph_mail_reply_draft_create',
    'graph_mail_reply_all_draft_create',
    'graph_mail_forward_draft_create',
    'graph_mail_reply_all_to_last_in_thread_draft_create',
    'graph_mail_draft_update',
    'graph_mail_draft_discard',
    'graph_mail_draft_send',
    'graph_mail_output_show',
  ]);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_attachment_list')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_attachment_delete')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_auth_device_code_start')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_auth_status')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_auth_clear')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_folder_list')?.annotations.readOnlyHint, true);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_folder_create')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_message_move')?.annotations.destructiveHint, true);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_attachment_upload_chunk')?.annotations.readOnlyHint, false);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_folder_list')?.inputSchema.properties.limit.default, 50);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_folder_create')?.inputSchema.properties.confirm_write.default, false);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_message_move')?.inputSchema.properties.confirm_write.default, false);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_auth_clear')?.inputSchema.properties.confirm_clear.default, false);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_attachment_get')?.inputSchema.properties.include_content.default, true);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_attachment_list')?.inputSchema.properties.limit.default, 20);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_folder_create')?.inputSchema.required.join(','), 'display_name');
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_message_move')?.inputSchema.required.join(','), 'message_id,destination_folder_id');
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_attachment_upload_session_create')?.inputSchema.properties.size.minimum, 1);
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_attachment_upload_chunk')?.inputSchema.required.join(','), 'upload_url,content_base64,range_start,range_end,total_size');
  assert.equal(toolRows.find((tool: DynamicTestValue) => tool.name === 'graph_mail_attachment_upload_file')?.inputSchema.required.join(','), 'file_path');

  const blockedFolderCalls: CapturedRequest[] = [];
  const blockedFolderState = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(blockedFolderCalls, [{ body: { value: [{ id: 'folder-1', displayName: 'Inbox' }] } }]),
  });

  const folderList = await rpc({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'graph_mail_folder_list',
      arguments: {
        mailbox_id: 'support@example.test',
        parent_folder_id: 'archive',
        select: 'id,displayName',
        limit: 10,
      },
    },
  }, blockedFolderState);
  assert.equal(folderList.error, undefined);
  assert.equal(blockedFolderCalls[0].init.method, 'GET');
  assert.equal(blockedFolderCalls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(blockedFolderCalls[0].url, 'https://graph.example.test/v1.0/users/support%40example.test/mailFolders/archive/childFolders?%24top=10&%24select=id%2CdisplayName');
  assert.equal(folderList.result.structuredContent.folders.value[0].id, 'folder-1');

  const blockedFolderCreate = await rpc({
    jsonrpc: '2.0',
    id: 34,
    method: 'tools/call',
    params: {
      name: 'graph_mail_folder_create',
      arguments: {
        mailbox_id: 'support@example.test',
        parent_folder_id: 'archive',
        display_name: 'Customers',
        confirm_write: true,
      },
    },
  }, blockedFolderState);
  assert.equal(blockedFolderCreate.error, undefined);
  assert.equal(blockedFolderCreate.result.structuredContent.status, 'refused');
  assert.equal(blockedFolderCreate.result.structuredContent.reason, 'folder_create_disallowed_by_policy');

  const blockedMessageMove = await rpc({
    jsonrpc: '2.0',
    id: 35,
    method: 'tools/call',
    params: {
      name: 'graph_mail_message_move',
      arguments: {
        mailbox_id: 'support@example.test',
        message_id: 'message-1',
        destination_folder_id: 'folder-2',
        confirm_write: true,
      },
    },
  }, blockedFolderState);
  assert.equal(blockedMessageMove.error, undefined);
  assert.equal(blockedMessageMove.result.structuredContent.status, 'refused');
  assert.equal(blockedMessageMove.result.structuredContent.reason, 'message_move_disallowed_by_policy');
  assert.equal(blockedFolderCalls.length, 1);
  const blockedMailboxOrganizationAudit = readFileSync(join(root, '.ai', 'audit', 'graph-mail-mcp.jsonl'), 'utf8');
  assert.match(blockedMailboxOrganizationAudit, /folder_create_refused/);
  assert.match(blockedMailboxOrganizationAudit, /message_move_refused/);

  const blockedAuth = await rpc({
    jsonrpc: '2.0',
    id: 38,
    method: 'tools/call',
    params: {
      name: 'graph_mail_auth_device_code_start',
      arguments: { scope: 'https://graph.microsoft.com/Mail.ReadWrite' },
    },
  }, blockedFolderState);
  assert.equal(blockedAuth.error, undefined);
  assert.equal(blockedAuth.result.structuredContent.status, 'refused');
  assert.equal(blockedAuth.result.structuredContent.reason, 'device_code_auth_disallowed_by_policy');

  writeFileSync(join(root, '.ai', 'graph-mail-mcp.json'), JSON.stringify({
    graph_base_url: 'https://graph.example.test/v1.0',
    allowed_mailboxes: ['support@example.test'],
    allow_device_code_auth: true,
    device_code_tenant_id: 'tenant-1',
    device_code_client_id: 'client-1',
    device_code_allowed_scopes: ['https://graph.microsoft.com/Mail.ReadWrite'],
  }));
  const authCalls: CapturedRequest[] = [];
  const authState = createServerState({
    siteRoot: root,
    clientSecret: 'client-credentials-secret-must-not-be-used-for-device-code',
    fetchImpl: mockFetch(authCalls, [
      {
        body: {
          device_code: 'secret-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
          message: 'Open the verification URL and enter the code.',
        },
      },
      { ok: false, status: 400, text: '{"error":"authorization_pending"}' },
      { body: { access_token: 'delegated-token-1', expires_in: 3600 } },
      { body: { value: [{ id: 'folder-delegated', displayName: 'Inbox' }] } },
    ]),
  });

  const authStart = await rpc({
    jsonrpc: '2.0',
    id: 39,
    method: 'tools/call',
    params: {
      name: 'graph_mail_auth_device_code_start',
      arguments: { scope: 'https://graph.microsoft.com/Mail.ReadWrite' },
    },
  }, authState);
  assert.equal(authStart.error, undefined);
  assert.equal(authStart.result.structuredContent.status, 'authorization_pending');
  assert.equal(authStart.result.structuredContent.user_code, 'ABCD-EFGH');
  assert.equal(authStart.result.structuredContent.device_code, undefined);
  const flowId = String(authStart.result.structuredContent.flow_id);
  assert.equal(authCalls[0].url, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/devicecode');
  assert.match(String(authCalls[0].init.body), /client_id=client-1/);

  const authPending = await rpc({
    jsonrpc: '2.0',
    id: 40,
    method: 'tools/call',
    params: {
      name: 'graph_mail_auth_device_code_poll',
      arguments: { flow_id: flowId },
    },
  }, authState);
  assert.equal(authPending.error, undefined);
  assert.equal(authPending.result.structuredContent.status, 'authorization_pending');
  assert.doesNotMatch(String(authCalls[1].init.body), /client_secret=/);

  const authPoll = await rpc({
    jsonrpc: '2.0',
    id: 41,
    method: 'tools/call',
    params: {
      name: 'graph_mail_auth_device_code_poll',
      arguments: { flow_id: flowId },
    },
  }, authState);
  assert.equal(authPoll.error, undefined);
  assert.equal(authPoll.result.structuredContent.status, 'authorized');
  assert.equal(authPoll.result.structuredContent.access_token, undefined);

  const authStatus = await rpc({
    jsonrpc: '2.0',
    id: 42,
    method: 'tools/call',
    params: { name: 'graph_mail_auth_status', arguments: {} },
  }, authState);
  assert.equal(authStatus.error, undefined);
  assert.equal(authStatus.result.structuredContent.delegated_token.status, 'available');
  assert.equal(authStatus.result.structuredContent.delegated_token.access_token, undefined);

  const delegatedFolderList = await rpc({
    jsonrpc: '2.0',
    id: 43,
    method: 'tools/call',
    params: {
      name: 'graph_mail_folder_list',
      arguments: { mailbox_id: 'support@example.test' },
    },
  }, authState);
  assert.equal(delegatedFolderList.error, undefined);
  assert.equal(authCalls[3].init.headers.Authorization, 'Bearer delegated-token-1');

  const authClearRefused = await rpc({
    jsonrpc: '2.0',
    id: 44,
    method: 'tools/call',
    params: { name: 'graph_mail_auth_clear', arguments: {} },
  }, authState);
  assert.equal(authClearRefused.error, undefined);
  assert.equal(authClearRefused.result.structuredContent.status, 'refused');
  assert.equal(authClearRefused.result.structuredContent.reason, 'confirm_clear_required');

  const authClear = await rpc({
    jsonrpc: '2.0',
    id: 45,
    method: 'tools/call',
    params: { name: 'graph_mail_auth_clear', arguments: { confirm_clear: true } },
  }, authState);
  assert.equal(authClear.error, undefined);
  assert.equal(authClear.result.structuredContent.status, 'cleared');

  const invalidClientCalls: CapturedRequest[] = [];
  const invalidClientState = createServerState({
    siteRoot: root,
    clientSecret: 'client-credentials-secret-must-not-be-used-for-device-code',
    fetchImpl: mockFetch(invalidClientCalls, [
      {
        body: {
          device_code: 'secret-device-code-2',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        },
      },
      {
        ok: false,
        status: 401,
        text: JSON.stringify({
          error: 'invalid_client',
          error_description: "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'.",
        }),
      },
    ]),
  });
  const invalidStart = await rpc({
    jsonrpc: '2.0',
    id: 46,
    method: 'tools/call',
    params: {
      name: 'graph_mail_auth_device_code_start',
      arguments: { scope: 'https://graph.microsoft.com/Mail.ReadWrite' },
    },
  }, invalidClientState);
  const invalidPoll = await rpc({
    jsonrpc: '2.0',
    id: 47,
    method: 'tools/call',
    params: {
      name: 'graph_mail_auth_device_code_poll',
      arguments: { flow_id: String(invalidStart.result.structuredContent.flow_id) },
    },
  }, invalidClientState);
  assert.equal(invalidPoll.error, undefined);
  assert.equal(invalidPoll.result.structuredContent.status, 'refused');
  assert.equal(invalidPoll.result.structuredContent.reason, 'device_code_client_must_be_public_client');
  assert.doesNotMatch(String(invalidClientCalls[1].init.body), /client_secret=/);

  writeFileSync(join(root, '.ai', 'graph-mail-mcp.json'), JSON.stringify({
    graph_base_url: 'https://graph.example.test/v1.0',
    allowed_mailboxes: ['support@example.test'],
    allow_folder_create: true,
    allow_message_move: true,
    mailbox_organization_approval_token: 'organize-123',
  }));
  const folderCalls: CapturedRequest[] = [];
  const folderState = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(folderCalls, [
      { body: { id: 'folder-2', displayName: 'Customers' } },
      { body: { id: 'message-2', parentFolderId: 'folder-2' } },
    ]),
  });

  const folderCreateMissingToken = await rpc({
    jsonrpc: '2.0',
    id: 36,
    method: 'tools/call',
    params: {
      name: 'graph_mail_folder_create',
      arguments: {
        mailbox_id: 'support@example.test',
        display_name: 'Customers',
        confirm_write: true,
      },
    },
  }, folderState);
  assert.equal(folderCreateMissingToken.error, undefined);
  assert.equal(folderCreateMissingToken.result.structuredContent.status, 'refused');
  assert.equal(folderCreateMissingToken.result.structuredContent.reason, 'mailbox_organization_approval_token_required');

  const messageMoveMissingConfirm = await rpc({
    jsonrpc: '2.0',
    id: 37,
    method: 'tools/call',
    params: {
      name: 'graph_mail_message_move',
      arguments: {
        mailbox_id: 'support@example.test',
        message_id: 'message-1',
        destination_folder_id: 'folder-2',
        approval_token: 'organize-123',
      },
    },
  }, folderState);
  assert.equal(messageMoveMissingConfirm.error, undefined);
  assert.equal(messageMoveMissingConfirm.result.structuredContent.status, 'refused');
  assert.equal(messageMoveMissingConfirm.result.structuredContent.reason, 'confirm_write_required');
  assert.equal(folderCalls.length, 0);

  const folderCreate = await rpc({
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: {
      name: 'graph_mail_folder_create',
      arguments: {
        mailbox_id: 'support@example.test',
        parent_folder_id: 'archive',
        display_name: 'Customers',
        confirm_write: true,
        approval_token: 'organize-123',
      },
    },
  }, folderState);
  assert.equal(folderCreate.error, undefined);
  assert.equal(folderCalls[0].init.method, 'POST');
  assert.equal(folderCalls[0].url, 'https://graph.example.test/v1.0/users/support%40example.test/mailFolders/archive/childFolders');
  assert.equal(JSON.parse(folderCalls[0].init.body).displayName, 'Customers');
  assert.equal(folderCreate.result.structuredContent.folder.id, 'folder-2');

  const messageMove = await rpc({
    jsonrpc: '2.0',
    id: 33,
    method: 'tools/call',
    params: {
      name: 'graph_mail_message_move',
      arguments: {
        mailbox_id: 'support@example.test',
        message_id: 'message-1',
        destination_folder_id: 'folder-2',
        confirm_write: true,
        approval_token: 'organize-123',
      },
    },
  }, folderState);
  assert.equal(messageMove.error, undefined);
  assert.equal(folderCalls[1].init.method, 'POST');
  assert.equal(folderCalls[1].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/message-1/move');
  assert.equal(JSON.parse(folderCalls[1].init.body).destinationId, 'folder-2');
  assert.equal(messageMove.result.structuredContent.message.id, 'message-2');
  const allowedMailboxOrganizationAudit = readFileSync(join(root, '.ai', 'audit', 'graph-mail-mcp.jsonl'), 'utf8');
  assert.match(allowedMailboxOrganizationAudit, /folder_create_completed/);
  assert.match(allowedMailboxOrganizationAudit, /message_move_completed/);

  const attachmentList = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_list',
      arguments: {
        message_id: 'message-1',
        limit: 3,
      },
    },
  }, attachmentState);
  assert.equal(attachmentList.error, undefined);
  assert.equal(attachmentCalls[0].init.method, 'GET');
  assert.equal(attachmentCalls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(attachmentCalls[0].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/message-1/attachments?%24top=3');
  assert.equal(attachmentList.result.structuredContent.attachments.value[0].id, 'att-list-1');

  const attachmentGet = await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_get',
      arguments: {
        message_id: 'message-1',
        attachment_id: 'att-get-1',
        include_content: false,
      },
    },
  }, attachmentState);
  assert.equal(attachmentGet.error, undefined);
  assert.equal(attachmentCalls[1].init.method, 'GET');
  assert.equal(attachmentCalls[1].init.headers.Authorization, 'Bearer test-token');
  assert.equal(attachmentCalls[1].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/message-1/attachments/att-get-1');
  assert.equal(attachmentGet.result.structuredContent.attachment.id, 'att-get-1');
  assert.equal(attachmentGet.result.structuredContent.attachment.contentBytes, undefined);
  assert.equal(attachmentGet.result.structuredContent.attachment.content, undefined);

  const attachmentAdd = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_add',
      arguments: {
        message_id: 'message-1',
        name: 'report.pdf',
        content_type: 'application/pdf',
        content_base64: Buffer.from('attachment-body').toString('base64'),
        is_inline: true,
        content_id: 'cid-123',
      },
    },
  }, attachmentState);
  assert.equal(attachmentAdd.error, undefined);
  assert.equal(attachmentCalls[2].init.method, 'POST');
  assert.equal(attachmentCalls[2].init.headers.Authorization, 'Bearer test-token');
  assert.equal(attachmentCalls[2].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/message-1/attachments');
  const attachmentAddBody = JSON.parse(attachmentCalls[2].init.body);
  assert.equal(attachmentAddBody['@odata.type'], '#microsoft.graph.fileAttachment');
  assert.equal(attachmentAddBody.name, 'report.pdf');
  assert.equal(attachmentAddBody.contentType, 'application/pdf');
  assert.equal(attachmentAddBody.contentBytes, Buffer.from('attachment-body').toString('base64'));
  assert.equal(attachmentAddBody.isInline, true);
  assert.equal(attachmentAddBody.contentId, 'cid-123');

  const oversizedSmallAttachment = await rpc({
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_add',
      arguments: {
        message_id: 'message-1',
        name: 'too-large.bin',
        content_type: 'application/octet-stream',
        content_base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64'),
      },
    },
  }, attachmentState);
  assert.match(oversizedSmallAttachment.error.message, /attachment_small_file_too_large/);

  const uploadSessionCreate = await rpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_upload_session_create',
      arguments: {
        draft_id: 'draft-1',
        name: 'video.mp4',
        size: 42,
        content_type: 'video/mp4',
        is_inline: false,
        content_id: 'cid-video',
      },
    },
  }, attachmentState);
  assert.equal(uploadSessionCreate.error, undefined);
  assert.equal(attachmentCalls[3].init.method, 'POST');
  assert.equal(attachmentCalls[3].init.headers.Authorization, 'Bearer test-token');
  assert.equal(attachmentCalls[3].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/draft-1/attachments/createUploadSession');
  const uploadSessionBody = JSON.parse(attachmentCalls[3].init.body);
  assert.equal(uploadSessionBody.AttachmentItem.attachmentType, 'file');
  assert.equal(uploadSessionBody.AttachmentItem.name, 'video.mp4');
  assert.equal(uploadSessionBody.AttachmentItem.size, 42);
  assert.equal(uploadSessionBody.AttachmentItem.contentType, 'video/mp4');
  assert.equal(uploadSessionBody.AttachmentItem.isInline, false);
  assert.equal(uploadSessionBody.AttachmentItem.contentId, 'cid-video');

  const localAttachmentBytes = Buffer.concat([Buffer.alloc(327680, 1), Buffer.from('tail')]);
  writeFileSync(join(root, 'local.bin'), localAttachmentBytes);
  const uploadFile = await rpc({
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_upload_file',
      arguments: {
        draft_id: 'draft-1',
        file_path: 'local.bin',
        chunk_size: 327680,
      },
    },
  }, attachmentState);
  assert.equal(uploadFile.error, undefined);
  assert.equal(attachmentCalls[4].init.method, 'POST');
  assert.equal(attachmentCalls[4].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/draft-1/attachments/createUploadSession');
  const uploadFileSessionBody = JSON.parse(attachmentCalls[4].init.body);
  assert.equal(uploadFileSessionBody.AttachmentItem.name, 'local.bin');
  assert.equal(uploadFileSessionBody.AttachmentItem.size, localAttachmentBytes.byteLength);
  assert.equal(uploadFileSessionBody.AttachmentItem.contentType, 'application/octet-stream');
  assert.equal(attachmentCalls[5].init.method, 'PUT');
  assert.equal(attachmentCalls[5].url, 'https://outlook.office365.com/upload/file-abc');
  assert.equal(attachmentCalls[5].init.headers['Content-Range'], `bytes 0-327679/${localAttachmentBytes.byteLength}`);
  assert.equal(Buffer.from(attachmentCalls[5].init.body).byteLength, 327680);
  assert.equal(attachmentCalls[6].init.headers['Content-Range'], `bytes 327680-${localAttachmentBytes.byteLength - 1}/${localAttachmentBytes.byteLength}`);
  assert.equal(Buffer.from(attachmentCalls[6].init.body).toString('utf8'), 'tail');
  assert.equal(uploadFile.result.structuredContent.status, 'uploaded');
  assert.equal(uploadFile.result.structuredContent.name, 'local.bin');
  assert.equal(uploadFile.result.structuredContent.size, localAttachmentBytes.byteLength);
  assert.equal(uploadFile.result.structuredContent.chunk_count, 2);
  assert.equal(uploadFile.result.structuredContent.sha256, createHash('sha256').update(localAttachmentBytes).digest('hex'));
  assert.equal(uploadFile.result.structuredContent.attachment.id, 'att-uploaded-1');

  const attachmentDelete = await rpc({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_delete',
      arguments: {
        draft_id: 'draft-1',
        attachment_id: 'att-delete-1',
      },
    },
  }, attachmentState);
  assert.equal(attachmentDelete.error, undefined);
  assert.equal(attachmentCalls[7].init.method, 'DELETE');
  assert.equal(attachmentCalls[7].init.headers.Authorization, 'Bearer test-token');
  assert.equal(attachmentCalls[7].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/draft-1/attachments/att-delete-1');

  const uploadCalls: CapturedRequest[] = [];
  const uploadState = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(uploadCalls, [{ status: 202, text: '' }]),
  });

  const uploadChunk = await rpc({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_upload_chunk',
      arguments: {
        upload_url: 'https://outlook.office.com/upload/abc',
        content_base64: Buffer.from('chunk-bytes').toString('base64'),
        range_start: 0,
        range_end: 10,
        total_size: 11,
      },
    },
  }, uploadState);
  assert.equal(uploadChunk.error, undefined);
  assert.equal(uploadCalls[0].init.method, 'PUT');
  assert.equal(uploadCalls[0].init.headers.Authorization, undefined);
  assert.equal(uploadCalls[0].init.headers['Content-Length'], '11');
  assert.equal(uploadCalls[0].init.headers['Content-Range'], 'bytes 0-10/11');
  assert.equal(uploadCalls[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(Buffer.from(uploadCalls[0].init.body).toString('utf8'), 'chunk-bytes');

  const forbiddenHttpUpload = await rpc({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_upload_chunk',
      arguments: {
        upload_url: 'http://outlook.office.com/upload/abc',
        content_base64: Buffer.from('x').toString('base64'),
        range_start: 0,
        range_end: 0,
        total_size: 1,
      },
    },
  }, uploadState);
  assert.match(forbiddenHttpUpload.error.message, /attachment_upload_url_must_be_https/);

  const forbiddenHostUpload = await rpc({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_upload_chunk',
      arguments: {
        upload_url: 'https://evil.example/upload/abc',
        content_base64: Buffer.from('x').toString('base64'),
        range_start: 0,
        range_end: 0,
        total_size: 1,
      },
    },
  }, uploadState);
  assert.match(forbiddenHostUpload.error.message, /attachment_upload_url_host_not_allowed/);
  assert.equal(uploadCalls.length, 1);

  const invalidUploadUrl = await rpc({
    jsonrpc: '2.0',
    id: 19,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_upload_chunk',
      arguments: {
        upload_url: 'not a url',
        content_base64: Buffer.from('x').toString('base64'),
        range_start: 0,
        range_end: 0,
        total_size: 1,
      },
    },
  }, uploadState);
  assert.match(invalidUploadUrl.error.message, /attachment_upload_url_invalid/);
  assert.doesNotMatch(invalidUploadUrl.error.message, /not a url/);

  const failedUploadCalls: CapturedRequest[] = [];
  const failedUploadState = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(failedUploadCalls, [{ status: 400, text: 'failed https://outlook.office.com/upload/secret-token' }]),
  });
  const failedUpload = await rpc({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_upload_chunk',
      arguments: {
        upload_url: 'https://outlook.office.com/upload/secret-token',
        content_base64: Buffer.from('x').toString('base64'),
        range_start: 0,
        range_end: 0,
        total_size: 1,
      },
    },
  }, failedUploadState);
  assert.match(failedUpload.error.message, /attachment_upload_failed:400:failed \[redacted-upload-url\]/);
  assert.doesNotMatch(failedUpload.error.message, /secret-token/);

  const clientCredentialCalls: CapturedRequest[] = [];
  const clientCredentialState = createServerState({
    siteRoot: root,
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    tokenEndpoint: 'https://login.example.test/token',
    fetchImpl: mockFetch(clientCredentialCalls, [
      { text: JSON.stringify({ access_token: 'app-token', expires_in: 3600 }) },
      { body: { value: [{ id: 'msg-app-1' }] } },
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

  const draftCalls: CapturedRequest[] = [];
  const draftState = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(draftCalls, [
      { body: { value: [{ id: 'msg-1' }] } },
      { body: { id: 'draft-1', subject: 'Customer follow-up' } },
    ]),
  });

  const query = await rpc({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: {
      name: 'graph_mail_query',
      arguments: {
        mailbox_id: 'support@example.test',
        query: 'follow up',
        limit: 5,
      },
    },
  }, draftState);
  assert.equal(query.error, undefined);
  assert.match(draftCalls[0].url, /^https:\/\/graph\.example\.test\/v1\.0\/users\/support%40example\.test\/messages\?/);
  assert.match(draftCalls[0].url, /%24top=5/);
  assert.match(draftCalls[0].url, /%24search=%22follow\+up%22/);
  assert.equal(draftCalls[0].init.headers.Authorization, 'Bearer test-token');

  const create = await rpc({
    jsonrpc: '2.0',
    id: 14,
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
  }, draftState);
  assert.equal(create.error, undefined);
  assert.equal(draftCalls[1].init.method, 'POST');
  assert.equal(draftCalls[1].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages');
  const createBody = JSON.parse(draftCalls[1].init.body);
  assert.equal(createBody.subject, 'Customer follow-up');
  assert.equal(createBody.body.contentType, 'Text');
  assert.equal(createBody.toRecipients[0].emailAddress.address, 'customer@example.test');

  const blockedMailbox = await rpc({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'graph_mail_query', arguments: { mailbox_id: 'blocked@example.test' } },
  }, draftState);
  assert.match(blockedMailbox.error.message, /mailbox_not_allowed/);

  const policyCalls: CapturedRequest[] = [];
  const policyState = createServerState({ siteRoot: root, accessToken: 'test-token', fetchImpl: mockFetch(policyCalls, [{ status: 204, text: '' }]) });

  const refused = await rpc({
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: {
      name: 'graph_mail_draft_send',
      arguments: {
        mailbox_id: 'support@example.test',
        draft_id: 'draft-1',
        confirm_send: true,
      },
    },
  }, policyState);
  assert.equal(refused.error, undefined);
  assert.equal(refused.result.structuredContent.status, 'refused');
  assert.equal(refused.result.structuredContent.reason, 'send_draft_disallowed_by_policy');
  assert.equal(policyCalls.length, 0);
  const auditPath = join(root, '.ai', 'audit', 'graph-mail-mcp.jsonl');
  assert.equal(existsSync(auditPath), true);
  assert.match(readFileSync(auditPath, 'utf8'), /draft_send_refused/);

  writeFileSync(join(root, '.ai', 'graph-mail-mcp.json'), JSON.stringify({
    graph_base_url: 'https://graph.example.test/v1.0',
    allowed_mailboxes: ['support@example.test'],
    allow_send_draft: true,
    send_approval_token: 'approve-123',
  }));

  const deniedNoToken = await rpc({
    jsonrpc: '2.0',
    id: 17,
    method: 'tools/call',
    params: {
      name: 'graph_mail_draft_send',
      arguments: {
        mailbox_id: 'support@example.test',
        draft_id: 'draft-1',
        confirm_send: true,
      },
    },
  }, policyState);
  assert.equal(deniedNoToken.result.structuredContent.status, 'refused');
  assert.equal(deniedNoToken.result.structuredContent.reason, 'send_approval_token_required');

  const sent = await rpc({
    jsonrpc: '2.0',
    id: 18,
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
  }, policyState);
  assert.equal(sent.error, undefined);
  assert.equal(sent.result.structuredContent.status, 'sent');
  assert.equal(policyCalls[0].init.method, 'POST');
  assert.equal(policyCalls[0].url, 'https://graph.example.test/v1.0/users/support%40example.test/messages/draft-1/send');

  writeFileSync(join(root, '.ai', 'mcp-telemetry.json'), JSON.stringify({
    enabled: true,
    level: 'all',
    surfaces: {
      'graph-mail': { enabled: true, level: 'all' },
    },
  }, null, 2), 'utf8');

  const telemetryCalls: CapturedRequest[] = [];
  const telemetryState = createServerState({
    siteRoot: root,
    accessToken: 'test-token',
    fetchImpl: mockFetch(telemetryCalls, [
      { body: { id: 'draft-telemetry-1', subject: 'Telemetry subject sentinel' } },
      { status: 202, text: '' },
      { body: { id: 'attachment-telemetry-1' } },
    ]),
  });
  const telemetryDraft = await rpc({
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: {
      name: 'graph_mail_draft_create',
      arguments: {
        mailbox_id: 'support@example.test',
        subject: 'Telemetry subject sentinel',
        body_text: 'Telemetry body sentinel',
      },
    },
  }, telemetryState);
  assert.equal(telemetryDraft.error, undefined);

  const telemetryUploadChunk = await rpc({
    jsonrpc: '2.0',
    id: 24,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_upload_chunk',
      arguments: {
        upload_url: 'https://outlook.office.com/upload/telemetry-upload-sentinel',
        content_base64: Buffer.from('telemetry').toString('base64'),
        range_start: 0,
        range_end: 8,
        total_size: 9,
      },
    },
  }, telemetryState);
  assert.equal(telemetryUploadChunk.error, undefined);

  const telemetryAttachmentAdd = await rpc({
    jsonrpc: '2.0',
    id: 25,
    method: 'tools/call',
    params: {
      name: 'graph_mail_attachment_add',
      arguments: {
        mailbox_id: 'support@example.test',
        draft_id: 'draft-telemetry-1',
        name: 'telemetry.txt',
        content_type: 'text/plain',
        content_base64: Buffer.from('Telemetry attachment add sentinel').toString('base64'),
      },
    },
  }, telemetryState);
  assert.equal(telemetryAttachmentAdd.error, undefined);

  const telemetryPath = join(root, '.ai', 'telemetry', 'graph-mail.jsonl');
  const telemetryLines = readFileSync(telemetryPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(telemetryLines.length >= 1);
  const telemetryEvents = telemetryLines.map((line) => JSON.parse(line));
  assert.equal(telemetryEvents.some((event: DynamicTestValue) => event.tool_name === 'graph_mail_draft_create'), true);
  assert.equal(telemetryEvents.some((event: DynamicTestValue) => event.tool_name === 'graph_mail_attachment_upload_chunk'), true);
  assert.equal(telemetryEvents.some((event: DynamicTestValue) => event.tool_name === 'graph_mail_attachment_add'), true);
  for (const telemetryEvent of telemetryEvents as DynamicTestValue[]) {
    assert.equal(telemetryEvent.surface_id, 'graph-mail');
    assert.equal(JSON.stringify(telemetryEvent).includes('Telemetry subject sentinel'), false);
    assert.equal(JSON.stringify(telemetryEvent).includes('Telemetry body sentinel'), false);
    assert.equal(JSON.stringify(telemetryEvent).includes('telemetry-upload-sentinel'), false);
    assert.equal(JSON.stringify(telemetryEvent).includes('Telemetry attachment base64 sentinel'), false);
    assert.equal(JSON.stringify(telemetryEvent).includes('Telemetry attachment add sentinel'), false);
  }

  console.log('graph-mail-mcp behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
