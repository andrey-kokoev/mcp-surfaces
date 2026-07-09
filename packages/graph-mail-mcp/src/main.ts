#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { assertAttachmentUploadUrlAllowed, buildGraphUrl, graphMailboxPath, graphRequest, graphTop, messagePatchFromArgs, recipients, requiredString } from './graph-client.js';
import { decideDraftSend, decideMailboxOrganizationWrite, loadGraphMailPolicy, recordGraphMailAudit } from './policy.js';
import { buildGraphMailTelemetryDeclaration, emitTelemetryEvent, telemetryErrorCodeFromUnknown, telemetryRefusalCodeFromResult, type TelemetryDeclaration, type TelemetryEventKind } from '@narada2/mcp-telemetry';
import { buildBoundedToolResult, outputShow } from '@narada2/mcp-transport';

const SERVER_NAME = 'narada-graph-mail-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const ATTACHMENT_UPLOAD_CHUNK_GRANULARITY = 320 * 1024;
const DEFAULT_ATTACHMENT_UPLOAD_CHUNK_SIZE = 10 * ATTACHMENT_UPLOAD_CHUNK_GRANULARITY;
const SURFACE_ID = 'graph-mail';
const GRAPH_MAIL_TELEMETRY_TOOL_NAMES = new Set([
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
]);

type GraphMailRecord = Record<string, unknown>;
type GraphMailServerState = GraphMailRecord & {
  siteRoot: string;
  serverName: string;
  accessToken: string | null;
  authMode: 'access_token' | 'client_credentials' | 'missing';
  tenantId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  tokenEndpoint: string | null;
  tokenCache: { accessToken: string; expiresAtMs: number } | null;
  fetchImpl: typeof fetch;
};
type DeviceCodeFlowState = {
  schema: 'narada.graph_mail_mcp.device_code_flow.v1';
  flow_id: string;
  tenant_id: string;
  client_id: string;
  scope: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_at_ms: number;
  interval_seconds: number;
  created_at: string;
};
type DelegatedTokenState = {
  schema: 'narada.graph_mail_mcp.delegated_token.v1';
  auth_mode: 'delegated_device_code';
  tenant_id: string;
  client_id: string;
  scope: string;
  access_token: string;
  expires_at_ms: number;
  acquired_at: string;
};

function asRecord(value: unknown): GraphMailRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as GraphMailRecord : {};
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export async function runStdioServer(options: unknown): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let requests: GraphMailRecord[];
    if (buffer.includes('Content-Length:')) {
      sawFramedInput = true;
      const drained = drainJsonRpcFrames(buffer);
      buffer = drained.remaining;
      requests = drained.requests;
    } else {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      requests = lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line)));
    }
    for (const request of requests) {
      if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) continue;
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

export function createServerState(options: unknown = {}): GraphMailServerState {
  const optionsRecord = asRecord(options);
  const siteRoot = resolve(String(optionsRecord.siteRoot ?? process.cwd()));
  const env = loadGraphMailEnvironment(siteRoot);
  const explicitAccessToken = stringOption(optionsRecord.accessToken) ?? env.GRAPH_ACCESS_TOKEN ?? null;
  const tenantId = stringOption(optionsRecord.tenantId) ?? env.GRAPH_TENANT_ID ?? null;
  const clientId = stringOption(optionsRecord.clientId) ?? env.GRAPH_CLIENT_ID ?? null;
  const clientSecret = stringOption(optionsRecord.clientSecret) ?? env.GRAPH_CLIENT_SECRET ?? null;
  const hasClientCredentials = !!(tenantId && clientId && clientSecret);
  const accessToken = explicitAccessToken ?? (hasClientCredentials ? null : env.MS_GRAPH_ACCESS_TOKEN ?? null);
  return {
    siteRoot,
    serverName: String(optionsRecord.serverName ?? SERVER_NAME),
    accessToken,
    authMode: accessToken ? 'access_token' : hasClientCredentials ? 'client_credentials' : 'missing',
    tenantId,
    clientId,
    clientSecret,
    tokenEndpoint: stringOption(optionsRecord.tokenEndpoint) ?? env.GRAPH_TOKEN_ENDPOINT ?? null,
    tokenCache: null,
    fetchImpl: typeof optionsRecord.fetchImpl === 'function' ? optionsRecord.fetchImpl as typeof fetch : fetch,
  };
}

export async function handleRequest(request: GraphMailRecord, state: GraphMailServerState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

async function dispatchMethod(method: string, params: GraphMailRecord, state: GraphMailServerState) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {}, completions: {}, logging: {} },
        serverInfo: { name: state.serverName, version: SERVER_VERSION },
      };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return callTool(params, state);
    case 'prompts/list':
      return { prompts: listPrompts() };
    case 'prompts/get':
      return promptGet(params);
    case 'completion/complete':
      return completeArgument(params);
    case 'logging/setLevel':
      return {};
    default:
      throw new Error(`unsupported_mcp_method: ${method}`);
  }
}

function listPrompts() {
  return [{ name: 'graph_mail_draft_workflow', title: 'Graph Mail Draft Workflow', description: 'Guidance for live Graph mail reads and draft management.', arguments: [] }];
}

function promptGet(params: GraphMailRecord) {
  const name = String(params.name ?? '');
  if (name !== 'graph_mail_draft_workflow') throw new Error(`unknown_prompt: ${name}`);
  return {
    description: 'Guidance for live Graph mail reads and draft management.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Prefer local mailbox-mcp for routine reads. Use graph_mail_query or graph_mail_message_show when live Graph state is needed. Create or update drafts for outbound work. Send only with explicit policy opt-in, confirm_send=true, and any configured approval token.' } }],
  };
}

function completeArgument(params: GraphMailRecord) {
  const argumentName = String(asRecord(asRecord(params).argument).name ?? '');
  const values = argumentName === 'name' ? listTools().map((tool: any) => tool.name).filter(Boolean).slice(0, 100) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

export function listTools(): unknown[] {
  return [
    guidanceToolDefinition(),
    tool('graph_mail_doctor', 'Inspect Microsoft Graph mail MCP readiness and policy.', {}),
    tool('graph_mail_auth_device_code_start', 'Start an operator-approved Microsoft Graph device-code auth flow. Disabled unless site policy opts in.', {
      scope: { type: 'string', description: 'Space-separated Microsoft Graph scopes. Must exactly match one configured allowed scope set.' },
    }),
    tool('graph_mail_auth_device_code_poll', 'Poll an existing device-code auth flow and store a delegated access token when approved.', {
      flow_id: { type: 'string', description: 'Flow id returned by graph_mail_auth_device_code_start.' },
    }, ['flow_id']),
    tool('graph_mail_auth_status', 'Inspect delegated Graph auth metadata without exposing access tokens.', {}),
    tool('graph_mail_auth_clear', 'Clear stored delegated Graph auth token and pending device-code flows for this site.', {
      confirm_clear: { type: 'boolean', default: false, description: 'Must be true to clear delegated auth material.' },
    }),
    tool('graph_mail_query', 'Query live Microsoft Graph messages for an allowed mailbox.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      folder_id: { type: 'string', description: 'Optional mail folder id. Defaults to messages across mailbox.' },
      query: { type: 'string', description: 'Optional Graph $search string.' },
      filter: { type: 'string', description: 'Optional Graph $filter expression.' },
      select: { type: 'string', description: 'Optional comma-separated Graph $select list.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum messages.' },
    }),
    tool('graph_mail_message_show', 'Read one live Microsoft Graph message.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      message_id: { type: 'string', description: 'Graph message id.' },
      select: { type: 'string', description: 'Optional comma-separated Graph $select list.' },
    }, ['message_id']),
    tool('graph_mail_folder_list', 'List live Microsoft Graph mail folders for an allowed mailbox.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      parent_folder_id: { type: 'string', description: 'Optional parent folder id. When set, lists child folders under that folder.' },
      select: { type: 'string', description: 'Optional comma-separated Graph $select list.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Maximum folders.' },
    }),
    tool('graph_mail_folder_create', 'Create a live Microsoft Graph mail folder under an allowed mailbox.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      display_name: { type: 'string', description: 'Folder display name.' },
      parent_folder_id: { type: 'string', description: 'Optional parent folder id. When set, creates a child folder under that folder.' },
      confirm_write: { type: 'boolean', default: false, description: 'Must be true for folder create attempts.' },
      approval_token: { type: 'string', description: 'Optional site-configured mailbox organization approval token.' },
    }, ['display_name']),
    tool('graph_mail_message_move', 'Move a live Microsoft Graph message to a destination folder.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      message_id: { type: 'string', description: 'Graph message id.' },
      destination_folder_id: { type: 'string', description: 'Destination folder id or well-known folder name accepted by Microsoft Graph.' },
      confirm_write: { type: 'boolean', default: false, description: 'Must be true for message move attempts.' },
      approval_token: { type: 'string', description: 'Optional site-configured mailbox organization approval token.' },
    }, ['message_id', 'destination_folder_id']),
    tool('graph_mail_attachment_list', 'List attachments for a live message or draft.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      message_id: { type: 'string', description: 'Message id or draft id.' },
      draft_id: { type: 'string', description: 'Draft id alias for message_id.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum attachments to return.' },
      top: { type: 'integer', minimum: 1, maximum: 100, description: 'Explicit Graph $top override.' },
    }),
    tool('graph_mail_attachment_get', 'Read one attachment and optionally strip content bytes.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      message_id: { type: 'string', description: 'Message id or draft id.' },
      draft_id: { type: 'string', description: 'Draft id alias for message_id.' },
      attachment_id: { type: 'string', description: 'Attachment id.' },
      include_content: { type: 'boolean', default: true, description: 'When false, strip contentBytes/content from the returned attachment.' },
    }, ['attachment_id']),
    tool('graph_mail_attachment_add', 'Add a file attachment to a live message or draft.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      message_id: { type: 'string', description: 'Message id or draft id.' },
      draft_id: { type: 'string', description: 'Draft id alias for message_id.' },
      name: { type: 'string', description: 'Attachment file name.' },
      content_type: { type: 'string', description: 'Attachment MIME content type.' },
      content_base64: { type: 'string', description: 'Base64-encoded file bytes.' },
      is_inline: { type: 'boolean', description: 'Marks the attachment as inline when true.' },
      content_id: { type: 'string', description: 'Optional inline content id.' },
    }, ['name', 'content_type', 'content_base64']),
    tool('graph_mail_attachment_upload_session_create', 'Create an upload session for a large file attachment.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      message_id: { type: 'string', description: 'Message id or draft id.' },
      draft_id: { type: 'string', description: 'Draft id alias for message_id.' },
      name: { type: 'string', description: 'Attachment file name.' },
      size: { type: 'integer', minimum: 1, description: 'Attachment size in bytes.' },
      content_type: { type: 'string', description: 'Optional attachment MIME content type.' },
      is_inline: { type: 'boolean', description: 'Marks the attachment as inline when true.' },
      content_id: { type: 'string', description: 'Optional inline content id.' },
    }, ['name', 'size']),
    tool('graph_mail_attachment_upload_chunk', 'Upload one chunk to a guarded attachment upload URL.', {
      upload_url: { type: 'string', description: 'Opaque upload URL returned by createUploadSession.' },
      content_base64: { type: 'string', description: 'Base64-encoded chunk bytes.' },
      range_start: { type: 'integer', minimum: 0, description: 'Inclusive byte range start.' },
      range_end: { type: 'integer', minimum: 0, description: 'Inclusive byte range end.' },
      total_size: { type: 'integer', minimum: 1, description: 'Total attachment size in bytes.' },
    }, ['upload_url', 'content_base64', 'range_start', 'range_end', 'total_size']),
    tool('graph_mail_attachment_upload_file', 'Attach a local file to a live message or draft using a guarded upload session.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      message_id: { type: 'string', description: 'Message id or draft id.' },
      draft_id: { type: 'string', description: 'Draft id alias for message_id.' },
      file_path: { type: 'string', description: 'Local file path under an allowed attachment root.' },
      name: { type: 'string', description: 'Optional attachment name. Defaults to the local file name.' },
      content_type: { type: 'string', description: 'Optional attachment MIME content type.' },
      is_inline: { type: 'boolean', description: 'Marks the attachment as inline when true.' },
      content_id: { type: 'string', description: 'Optional inline content id.' },
      chunk_size: { type: 'integer', minimum: 327680, maximum: 10485760, default: DEFAULT_ATTACHMENT_UPLOAD_CHUNK_SIZE, description: 'Upload chunk size in bytes. Must be a multiple of 320 KiB.' },
    }, ['file_path']),
    tool('graph_mail_attachment_delete', 'Delete one attachment from a live message or draft.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      message_id: { type: 'string', description: 'Message id or draft id.' },
      draft_id: { type: 'string', description: 'Draft id alias for message_id.' },
      attachment_id: { type: 'string', description: 'Attachment id.' },
    }, ['attachment_id']),
    tool('graph_mail_draft_create', 'Create a new draft message in an allowed mailbox.', draftMessageProperties(), []),
    tool('graph_mail_reply_draft_create', 'Create a reply draft for an existing message.', replyDraftProperties(), ['message_id']),
    tool('graph_mail_reply_all_draft_create', 'Create a reply-all draft for an existing message.', replyDraftProperties(), ['message_id']),
    tool('graph_mail_forward_draft_create', 'Create a forward draft for an existing message.', forwardDraftProperties(), ['message_id']),
    tool('graph_mail_reply_all_to_last_in_thread_draft_create', 'Create a reply-all draft addressed to the last message in a conversation thread.', replyAllToThreadProperties(), ['conversation_id']),
    tool('graph_mail_draft_update', 'Update an existing draft message.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      draft_id: { type: 'string', description: 'Draft message id.' },
      ...draftMessageProperties(),
    }, ['draft_id']),
    tool('graph_mail_draft_discard', 'Delete an existing draft message.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      draft_id: { type: 'string', description: 'Draft message id.' },
    }, ['draft_id']),
    tool('graph_mail_draft_send', 'Send an existing draft message when explicitly allowed by policy.', {
      mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
      draft_id: { type: 'string', description: 'Draft message id.' },
      confirm_send: { type: 'boolean', default: false, description: 'Must be true for send attempts.' },
      approval_token: { type: 'string', description: 'Optional site-configured approval token.' },
    }, ['draft_id']),
    tool('graph_mail_output_show', 'Read a materialized Graph Mail MCP output ref with offset/limit paging.', {
      ref: { type: 'string' },
      output_ref: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 0 },
    }),
  ];
}

function draftMessageProperties() {
  return {
    mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
    subject: { type: 'string', description: 'Draft subject.' },
    body_text: { type: 'string', description: 'Plain text body.' },
    body_html: { type: 'string', description: 'HTML body.' },
    to_recipients: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses or Graph recipient objects.' },
    cc_recipients: { type: 'array', items: { type: 'string' }, description: 'Cc addresses or Graph recipient objects.' },
    bcc_recipients: { type: 'array', items: { type: 'string' }, description: 'Bcc addresses or Graph recipient objects.' },
    importance: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Message importance.' },
  };
}

function replyDraftProperties() {
  return {
    mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
    message_id: { type: 'string', description: 'Original message id.' },
    comment: { type: 'string', description: 'Optional reply comment.' },
    body_text: { type: 'string', description: 'Optional replacement body text.' },
    body_html: { type: 'string', description: 'Optional replacement body HTML.' },
  };
}

function replyAllToThreadProperties() {
  return {
    mailbox_id: { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' },
    conversation_id: { type: 'string', description: 'Conversation/thread id.' },
    comment: { type: 'string', description: 'Optional reply comment.' },
    body_text: { type: 'string', description: 'Optional replacement body text.' },
    body_html: { type: 'string', description: 'Optional replacement body HTML.' },
  };
}

function forwardDraftProperties() {
  return {
    ...replyDraftProperties(),
    to_recipients: { type: 'array', items: { type: 'string' }, description: 'Forward recipient addresses or Graph recipient objects.' },
  };
}

function attachmentMessageId(args: GraphMailRecord): string {
  const draftId = stringOption(args.draft_id);
  if (draftId) return draftId;
  const messageId = stringOption(args.message_id);
  if (messageId) return messageId;
  throw new Error('message_id_required');
}

function attachmentTop(args: GraphMailRecord): number {
  return graphTop(args.top ?? args.limit, 20);
}

function attachmentObject(value: unknown): GraphMailRecord {
  return asRecord(value);
}

function stripAttachmentContent(attachment: GraphMailRecord): GraphMailRecord {
  const copy = { ...attachment };
  delete copy.contentBytes;
  delete copy.content;
  return copy;
}

function fileAttachmentBody(args: GraphMailRecord): GraphMailRecord {
  const contentBytes = requiredString(args, 'content_base64');
  const decoded = Buffer.from(contentBytes, 'base64');
  if (decoded.byteLength > 3 * 1024 * 1024) throw new Error('attachment_small_file_too_large');
  const body: GraphMailRecord = {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: requiredString(args, 'name'),
    contentType: requiredString(args, 'content_type'),
    contentBytes,
  };
  if (typeof args.is_inline === 'boolean') body.isInline = args.is_inline;
  if (typeof args.content_id === 'string' && args.content_id.trim() !== '') body.contentId = args.content_id;
  return body;
}

function uploadSessionBody(args: GraphMailRecord): GraphMailRecord {
  const attachmentItem: GraphMailRecord = {
    attachmentType: 'file',
    name: requiredString(args, 'name'),
    size: requiredPositiveNumber(args, 'size'),
  };
  if (typeof args.content_type === 'string' && args.content_type.trim() !== '') attachmentItem.contentType = args.content_type;
  if (typeof args.is_inline === 'boolean') attachmentItem.isInline = args.is_inline;
  if (typeof args.content_id === 'string' && args.content_id.trim() !== '') attachmentItem.contentId = args.content_id;
  return { AttachmentItem: attachmentItem };
}

function uploadChunkSize(args: GraphMailRecord): number {
  const raw = Number(args.chunk_size ?? DEFAULT_ATTACHMENT_UPLOAD_CHUNK_SIZE);
  if (!Number.isFinite(raw) || raw < ATTACHMENT_UPLOAD_CHUNK_GRANULARITY || raw > 10 * 1024 * 1024) {
    throw new Error('attachment_upload_chunk_size_invalid');
  }
  const size = Math.trunc(raw);
  if (size % ATTACHMENT_UPLOAD_CHUNK_GRANULARITY !== 0) {
    throw new Error('attachment_upload_chunk_size_must_be_multiple_of_320kib');
  }
  return size;
}

function inferContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function pathInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child);
  const normalizedParent = resolve(parent);
  const comparableChild = process.platform === 'win32' ? normalizedChild.toLowerCase() : normalizedChild;
  const comparableParent = process.platform === 'win32' ? normalizedParent.toLowerCase() : normalizedParent;
  return comparableChild === comparableParent || comparableChild.startsWith(`${comparableParent}${process.platform === 'win32' ? '\\' : '/'}`);
}

function resolveAttachmentFilePath(args: GraphMailRecord, policySiteRoot: string, allowedRoots: string[]): string {
  const input = requiredString(args, 'file_path');
  const candidate = resolve(policySiteRoot, input);
  const roots = allowedRoots.length > 0 ? allowedRoots : [policySiteRoot];
  if (!roots.some((root) => pathInside(candidate, root))) {
    throw new Error('attachment_file_path_not_allowed');
  }
  const stat = statSync(candidate);
  if (!stat.isFile()) throw new Error('attachment_file_path_not_file');
  if (stat.size <= 0) throw new Error('attachment_file_empty');
  return candidate;
}

function requiredNumber(args: GraphMailRecord, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${key}_required`);
  return value;
}

function requiredPositiveNumber(args: GraphMailRecord, key: string): number {
  const value = requiredNumber(args, key);
  if (value <= 0) throw new Error(`${key}_required`);
  return value;
}

function redactUploadUrlText(text: string, uploadUrl: string): string {
  return text.split(uploadUrl).join('[redacted-upload-url]');
}

function decodeUploadChunk(args: GraphMailRecord): { bytes: Buffer; contentRange: string; uploadUrl: string } {
  const uploadUrl = requiredString(args, 'upload_url');
  assertAttachmentUploadUrlAllowed(uploadUrl);
  const contentBase64 = requiredString(args, 'content_base64');
  const start = requiredNumber(args, 'range_start');
  const end = requiredNumber(args, 'range_end');
  const total = requiredNumber(args, 'total_size');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (end < start || total <= end || bytes.byteLength !== end - start + 1) {
    throw new Error('attachment_upload_content_range_invalid');
  }
  const contentRange = `bytes ${start}-${end}/${total}`;
  return { bytes, contentRange, uploadUrl };
}

async function uploadAttachmentBytes(uploadUrl: string, bytes: Buffer, rangeStart: number, rangeEnd: number, totalSize: number, fetchImpl: typeof fetch): Promise<GraphMailRecord> {
  const init: RequestInit = {
    method: 'PUT',
    headers: {
      'Content-Length': String(bytes.byteLength),
      'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${totalSize}`,
      'Content-Type': 'application/octet-stream',
    },
    body: bytes as unknown as BodyInit,
  };
  const response = await fetchImpl(uploadUrl, init);
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (!response.ok && response.status < 200 || response.status >= 300) {
    const diagnostic = redactUploadUrlText(text || response.statusText || 'unknown_error', uploadUrl);
    throw new Error(`attachment_upload_failed:${response.status}:${diagnostic}`);
  }
  if (response.status === 202 || response.status === 204) {
    return { schema: 'narada.graph_mail_mcp.attachment_upload_chunk.v1', status: 'accepted', http_status: response.status };
  }
  if (text.trim() === '') {
    return { schema: 'narada.graph_mail_mcp.attachment_upload_chunk.v1', status: 'ok', http_status: response.status, result: {} };
  }
  try {
    return { schema: 'narada.graph_mail_mcp.attachment_upload_chunk.v1', status: 'ok', http_status: response.status, result: JSON.parse(text) };
  } catch {
    return { schema: 'narada.graph_mail_mcp.attachment_upload_chunk.v1', status: 'ok', http_status: response.status, result: { text } };
  }
}

async function callTool(params: GraphMailRecord, state: GraphMailServerState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  const startedAt = Date.now();
  try {
    let result: unknown;
    switch (name) {
      case 'graph_mail_guidance':
        result = buildGuidanceResult(args);
        break;
      case 'graph_mail_doctor':
        result = await graphMailDoctor(state);
        break;
      case 'graph_mail_auth_device_code_start':
        result = await graphMailAuthDeviceCodeStart(args, state);
        break;
      case 'graph_mail_auth_device_code_poll':
        result = await graphMailAuthDeviceCodePoll(args, state);
        break;
      case 'graph_mail_auth_status':
        result = graphMailAuthStatus(state);
        break;
      case 'graph_mail_auth_clear':
        result = graphMailAuthClear(args, state);
        break;
      case 'graph_mail_query':
        result = await graphMailQuery(args, state);
        break;
      case 'graph_mail_message_show':
        result = await graphMailMessageShow(args, state);
        break;
      case 'graph_mail_folder_list':
        result = await graphMailFolderList(args, state);
        break;
      case 'graph_mail_folder_create':
        result = await graphMailFolderCreate(args, state);
        break;
      case 'graph_mail_message_move':
        result = await graphMailMessageMove(args, state);
        break;
      case 'graph_mail_attachment_list':
        result = await graphMailAttachmentList(args, state);
        break;
      case 'graph_mail_attachment_get':
        result = await graphMailAttachmentGet(args, state);
        break;
      case 'graph_mail_attachment_add':
        result = await graphMailAttachmentAdd(args, state);
        break;
      case 'graph_mail_attachment_upload_session_create':
        result = await graphMailAttachmentUploadSessionCreate(args, state);
        break;
      case 'graph_mail_attachment_upload_chunk':
        result = await graphMailAttachmentUploadChunk(args, state);
        break;
      case 'graph_mail_attachment_upload_file':
        result = await graphMailAttachmentUploadFile(args, state);
        break;
      case 'graph_mail_attachment_delete':
        result = await graphMailAttachmentDelete(args, state);
        break;
      case 'graph_mail_draft_create':
        result = await graphMailDraftCreate(args, state);
        break;
      case 'graph_mail_reply_draft_create':
        result = await graphMailDerivedDraftCreate(args, state, 'createReply');
        break;
      case 'graph_mail_reply_all_draft_create':
        result = await graphMailDerivedDraftCreate(args, state, 'createReplyAll');
        break;
      case 'graph_mail_forward_draft_create':
        result = await graphMailDerivedDraftCreate(args, state, 'createForward');
        break;
      case 'graph_mail_reply_all_to_last_in_thread_draft_create':
        result = await graphMailReplyAllToLastInThreadDraftCreate(args, state);
        break;
      case 'graph_mail_draft_update':
        result = await graphMailDraftUpdate(args, state);
        break;
      case 'graph_mail_draft_discard':
        result = await graphMailDraftDiscard(args, state);
        break;
      case 'graph_mail_draft_send':
        result = await graphMailDraftSend(args, state);
        break;
      case 'graph_mail_output_show':
        result = outputShow({ siteRoot: state.siteRoot, args });
        break;
      default:
        throw new Error(`unknown_tool: ${name}`);
    }
    emitGraphMailTelemetry(name, asRecord(result), state, startedAt);
    return buildBoundedToolResult({
      siteRoot: state.siteRoot,
      toolName: name,
      value: result,
      limit: 6000,
      readerTool: 'graph_mail_output_show',
    });
  } catch (error) {
    emitGraphMailTelemetry(name, {}, state, startedAt, error);
    throw error;
  }
}

function emitGraphMailTelemetry(toolName: string, result: GraphMailRecord, state: GraphMailServerState, startedAt: number, error?: unknown): void {
  if (!GRAPH_MAIL_TELEMETRY_TOOL_NAMES.has(toolName)) return;
  const declaration = graphMailTelemetryDeclaration(toolName);
  if (!declaration) return;
  const status = error ? 'error' : String(result.status ?? 'ok');
  const eventKind: TelemetryEventKind = error ? 'tool_failed' : status === 'refused' ? 'tool_refused' : 'tool_completed';
  try {
    emitTelemetryEvent({
      context: {
        siteRoot: state.siteRoot,
        siteId: process.env.NARADA_SITE_ID ?? null,
        surfaceId: SURFACE_ID,
        agentId: process.env.NARADA_AGENT_ID ?? null,
        carrierSessionId: process.env.NARADA_CARRIER_SESSION_ID ?? null,
      },
      declaration,
      event: {
        toolName,
        eventKind,
        status,
        startedAt,
        completedAt: Date.now(),
        refusalCode: telemetryRefusalCodeFromResult(result),
        errorCode: error ? telemetryErrorCodeFromUnknown(error) : null,
        policyDecision: asRecord(result.decision ?? null),
      },
    });
  } catch (telemetryError) {
    process.stderr.write(`graph_mail_telemetry_error:${telemetryError instanceof Error ? telemetryError.message : String(telemetryError)}\n`);
  }
}

function graphMailTelemetryDeclaration(toolName: string): TelemetryDeclaration | null {
  if (!GRAPH_MAIL_TELEMETRY_TOOL_NAMES.has(toolName)) return null;
  const highSensitivity = /attachment|draft|message_show|query|auth/.test(toolName);
  const lowSensitivity = /doctor/.test(toolName);
  return buildGraphMailTelemetryDeclaration({
    sensitivity: lowSensitivity ? 'low' : highSensitivity ? 'high' : 'medium',
    policyDecision: /draft_send|folder_create|message_move/.test(toolName),
  });
}

async function graphMailDoctor(state: GraphMailServerState): Promise<GraphMailRecord> {
  const policy = loadGraphMailPolicy(state.siteRoot);
  const auth = await resolveAccessToken(state, { probeOnly: true });
  return {
    schema: 'narada.graph_mail_mcp.doctor.v1',
    status: 'ok',
    site_root: policy.site_root,
    graph_base_url: policy.graph_base_url,
    has_access_token: auth.available,
    auth_mode: auth.authMode,
    allowed_mailboxes: policy.allowed_mailboxes,
    allowed_attachment_roots: policy.allowed_attachment_roots.length > 0 ? policy.allowed_attachment_roots : [policy.site_root],
    allow_device_code_auth: policy.allow_device_code_auth,
    device_code_tenant_configured: !!policy.device_code_tenant_id || !!state.tenantId,
    device_code_client_configured: !!policy.device_code_client_id || !!state.clientId,
    device_code_allowed_scopes: policy.device_code_allowed_scopes,
    delegated_token: delegatedTokenSummary(state.siteRoot),
    allow_send_draft: policy.allow_send_draft,
    send_approval_token_configured: !!policy.send_approval_token,
    allow_folder_create: policy.allow_folder_create,
    allow_message_move: policy.allow_message_move,
    mailbox_organization_approval_token_configured: !!policy.mailbox_organization_approval_token,
    server_name: state.serverName,
  };
}

async function graphMailAuthDeviceCodeStart(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const policy = loadGraphMailPolicy(state.siteRoot);
  const deviceAuth = resolveDeviceCodePolicy(policy, state, args);
  if (deviceAuth.status !== 'allowed') {
    recordGraphMailAudit(state.siteRoot, { event_kind: 'device_code_start_refused', reason: deviceAuth.reason });
    return { schema: 'narada.graph_mail_mcp.device_code_start.v1', status: 'refused', reason: deviceAuth.reason };
  }
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(deviceAuth.tenantId)}/oauth2/v2.0/devicecode`;
  const body = new URLSearchParams({ client_id: deviceAuth.clientId, scope: deviceAuth.scope });
  const response = await state.fetchImpl(endpoint, { method: 'POST', body } as any);
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (!response.ok || response.status < 200 || response.status >= 300) {
    throw new Error(`ms_graph_device_code_start_failed:${response.status}:${redactTokenResponse(text || response.statusText || 'unknown_error')}`);
  }
  const payload = asRecord(JSON.parse(text));
  const deviceCode = requiredString(payload, 'device_code');
  const userCode = requiredString(payload, 'user_code');
  const verificationUri = stringOption(payload.verification_uri) ?? stringOption(payload.verification_url);
  if (!verificationUri) throw new Error('ms_graph_device_code_response_missing_verification_uri');
  const expiresInSeconds = positiveInteger(payload.expires_in, 900);
  const intervalSeconds = positiveInteger(payload.interval, 5);
  const flow: DeviceCodeFlowState = {
    schema: 'narada.graph_mail_mcp.device_code_flow.v1',
    flow_id: `flow_${randomUUID()}`,
    tenant_id: deviceAuth.tenantId,
    client_id: deviceAuth.clientId,
    scope: deviceAuth.scope,
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    expires_at_ms: Date.now() + expiresInSeconds * 1000,
    interval_seconds: intervalSeconds,
    created_at: new Date().toISOString(),
  };
  writeJson(flowPath(state.siteRoot, flow.flow_id), flow);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'device_code_start_completed', flow_id: flow.flow_id, scope: flow.scope, expires_at_ms: flow.expires_at_ms });
  return {
    schema: 'narada.graph_mail_mcp.device_code_start.v1',
    status: 'authorization_pending',
    flow_id: flow.flow_id,
    user_code: flow.user_code,
    verification_uri: flow.verification_uri,
    expires_in: expiresInSeconds,
    interval: intervalSeconds,
    message: typeof payload.message === 'string' ? payload.message : null,
  };
}

async function graphMailAuthDeviceCodePoll(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const flowId = requiredString(args, 'flow_id');
  const flow = readDeviceCodeFlow(state.siteRoot, flowId);
  if (!flow) return { schema: 'narada.graph_mail_mcp.device_code_poll.v1', status: 'refused', reason: 'device_code_flow_not_found', flow_id: flowId };
  const policy = loadGraphMailPolicy(state.siteRoot);
  const deviceAuth = resolveDeviceCodePolicy(policy, state, { scope: flow.scope });
  if (deviceAuth.status !== 'allowed') return { schema: 'narada.graph_mail_mcp.device_code_poll.v1', status: 'refused', reason: deviceAuth.reason, flow_id: flowId };
  if (Date.now() >= flow.expires_at_ms) return { schema: 'narada.graph_mail_mcp.device_code_poll.v1', status: 'expired', flow_id: flowId };
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(flow.tenant_id)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: flow.client_id,
    device_code: flow.device_code,
  });
  const response = await state.fetchImpl(endpoint, { method: 'POST', body } as any);
  const text = typeof response.text === 'function' ? await response.text() : '';
  const payload = parseJsonRecord(text);
  if (!response.ok || response.status < 200 || response.status >= 300) {
    const errorCode = stringOption(payload.error);
    if (errorCode === 'authorization_pending' || errorCode === 'slow_down') {
      return {
        schema: 'narada.graph_mail_mcp.device_code_poll.v1',
        status: errorCode,
        flow_id: flowId,
        interval: errorCode === 'slow_down' ? flow.interval_seconds + 5 : flow.interval_seconds,
        expires_at_ms: flow.expires_at_ms,
      };
    }
    if (errorCode === 'invalid_client' && String(payload.error_description ?? '').includes('AADSTS7000218')) {
      recordGraphMailAudit(state.siteRoot, { event_kind: 'device_code_poll_refused', flow_id: flowId, reason: 'device_code_client_must_be_public_client' });
      return {
        schema: 'narada.graph_mail_mcp.device_code_poll.v1',
        status: 'refused',
        reason: 'device_code_client_must_be_public_client',
        flow_id: flowId,
        recovery: 'Configure device_code_client_id to an Entra public-client app with device-code/native-client support. Do not use a confidential client or client secret for device-code auth.',
      };
    }
    throw new Error(`ms_graph_device_code_poll_failed:${response.status}:${redactTokenResponse(text || response.statusText || 'unknown_error')}`);
  }
  const accessToken = requiredString(payload, 'access_token');
  const expiresInSeconds = positiveInteger(payload.expires_in, 3599);
  const token: DelegatedTokenState = {
    schema: 'narada.graph_mail_mcp.delegated_token.v1',
    auth_mode: 'delegated_device_code',
    tenant_id: flow.tenant_id,
    client_id: flow.client_id,
    scope: flow.scope,
    access_token: accessToken,
    expires_at_ms: Date.now() + Math.max(60, expiresInSeconds) * 1000,
    acquired_at: new Date().toISOString(),
  };
  writeJson(delegatedTokenPath(state.siteRoot), token);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'device_code_poll_completed', flow_id: flow.flow_id, scope: flow.scope, expires_at_ms: token.expires_at_ms });
  return {
    schema: 'narada.graph_mail_mcp.device_code_poll.v1',
    status: 'authorized',
    flow_id: flow.flow_id,
    auth_mode: 'delegated_device_code',
    scope: flow.scope,
    expires_at_ms: token.expires_at_ms,
  };
}

function graphMailAuthStatus(state: GraphMailServerState): GraphMailRecord {
  const policy = loadGraphMailPolicy(state.siteRoot);
  return {
    schema: 'narada.graph_mail_mcp.auth_status.v1',
    status: 'ok',
    allow_device_code_auth: policy.allow_device_code_auth,
    device_code_tenant_configured: !!policy.device_code_tenant_id || !!state.tenantId,
    device_code_client_configured: !!policy.device_code_client_id || !!state.clientId,
    device_code_allowed_scopes: policy.device_code_allowed_scopes,
    delegated_token: delegatedTokenSummary(state.siteRoot),
  };
}

function graphMailAuthClear(args: GraphMailRecord, state: GraphMailServerState): GraphMailRecord {
  if (args.confirm_clear !== true && args.confirmClear !== true) {
    return { schema: 'narada.graph_mail_mcp.auth_clear.v1', status: 'refused', reason: 'confirm_clear_required' };
  }
  let removed = 0;
  if (existsSync(delegatedTokenPath(state.siteRoot))) {
    unlinkSync(delegatedTokenPath(state.siteRoot));
    removed += 1;
  }
  recordGraphMailAudit(state.siteRoot, { event_kind: 'device_code_auth_cleared', removed });
  return { schema: 'narada.graph_mail_mcp.auth_clear.v1', status: 'cleared', removed };
}

async function graphMailQuery(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const folderId = typeof args.folder_id === 'string' && args.folder_id.trim() !== '' ? args.folder_id : null;
  const suffix = folderId ? `mailFolders/${encodeURIComponent(folderId)}/messages` : 'messages';
  const path = graphMailboxPath(args.mailbox_id, suffix, policy);
  const query: Record<string, string | number | boolean> = { '$top': graphTop(args.limit, 20) };
  if (typeof args.select === 'string') query['$select'] = args.select;
  if (typeof args.filter === 'string') query['$filter'] = args.filter;
  if (typeof args.query === 'string') query['$search'] = `"${args.query.replace(/"/g, '\\"')}"`;
  if (!query['$search']) query['$orderby'] = 'receivedDateTime desc';
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { path, query });
  return {
    schema: 'narada.graph_mail_mcp.query.v1',
    status: 'ok',
    request_url: buildGraphUrl(policy, path, query),
    result: graph,
  };
}

async function graphMailMessageShow(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const messageId = requiredString(args, 'message_id');
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(messageId)}`, policy);
  const query = typeof args.select === 'string' ? { '$select': args.select } : {};
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { path, query });
  return { schema: 'narada.graph_mail_mcp.message.v1', status: 'ok', message: graph };
}

async function graphMailFolderList(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const parentFolderId = stringOption(args.parent_folder_id);
  const suffix = parentFolderId
    ? `mailFolders/${encodeURIComponent(parentFolderId)}/childFolders`
    : 'mailFolders';
  const path = graphMailboxPath(args.mailbox_id, suffix, policy);
  const query: Record<string, string | number | boolean> = { '$top': graphTop(args.limit, 50) };
  if (typeof args.select === 'string') query['$select'] = args.select;
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { path, query });
  return {
    schema: 'narada.graph_mail_mcp.folders.v1',
    status: 'ok',
    request_url: buildGraphUrl(policy, path, query),
    folders: graph,
  };
}

async function graphMailFolderCreate(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const policy = loadGraphMailPolicy(state.siteRoot);
  const displayName = requiredString(args, 'display_name');
  const parentFolderId = stringOption(args.parent_folder_id);
  const decision = decideMailboxOrganizationWrite(policy, args, 'folder_create');
  if (decision.status !== 'allowed') return refusedMailboxOrganizationWrite(state, args, 'folder_create_refused', decision.reason, { parent_folder_id: parentFolderId, display_name: displayName });
  const { accessToken, fetchImpl } = await clientParts(state, policy);
  const suffix = parentFolderId
    ? `mailFolders/${encodeURIComponent(parentFolderId)}/childFolders`
    : 'mailFolders';
  const path = graphMailboxPath(args.mailbox_id, suffix, policy);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'folder_create_requested', mailbox_id: args.mailbox_id ?? 'me', parent_folder_id: parentFolderId, display_name: displayName });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path, body: { displayName } });
  recordGraphMailAudit(state.siteRoot, { event_kind: 'folder_create_completed', mailbox_id: args.mailbox_id ?? 'me', parent_folder_id: parentFolderId, folder_id: asRecord(graph).id ?? null, display_name: asRecord(graph).displayName ?? displayName });
  return { schema: 'narada.graph_mail_mcp.folder.v1', status: 'created', folder: graph };
}

async function graphMailMessageMove(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const policy = loadGraphMailPolicy(state.siteRoot);
  const messageId = requiredString(args, 'message_id');
  const destinationId = requiredString(args, 'destination_folder_id');
  const decision = decideMailboxOrganizationWrite(policy, args, 'message_move');
  if (decision.status !== 'allowed') return refusedMailboxOrganizationWrite(state, args, 'message_move_refused', decision.reason, { message_id: messageId, destination_folder_id: destinationId });
  const { accessToken, fetchImpl } = await clientParts(state, policy);
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(messageId)}/move`, policy);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'message_move_requested', mailbox_id: args.mailbox_id ?? 'me', message_id: messageId, destination_folder_id: destinationId });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path, body: { destinationId } });
  recordGraphMailAudit(state.siteRoot, { event_kind: 'message_move_completed', mailbox_id: args.mailbox_id ?? 'me', message_id: messageId, destination_folder_id: destinationId, moved_message_id: asRecord(graph).id ?? null });
  return { schema: 'narada.graph_mail_mcp.message_move.v1', status: 'moved', message: graph };
}

function refusedMailboxOrganizationWrite(state: GraphMailServerState, args: GraphMailRecord, eventKind: string, reason = 'mailbox_organization_write_refused', extra: GraphMailRecord = {}): GraphMailRecord {
  recordGraphMailAudit(state.siteRoot, { event_kind: eventKind, mailbox_id: args.mailbox_id ?? 'me', reason, ...extra });
  return { schema: 'narada.graph_mail_mcp.mailbox_organization_write.v1', status: 'refused', reason, ...extra };
}

async function graphMailAttachmentList(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const messageId = attachmentMessageId(args);
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(messageId)}/attachments`, policy);
  const query = { '$top': attachmentTop(args) };
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { path, query });
  return { schema: 'narada.graph_mail_mcp.attachments.v1', status: 'ok', attachments: graph };
}

async function graphMailAttachmentGet(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const messageId = attachmentMessageId(args);
  const attachmentId = requiredString(args, 'attachment_id');
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, policy);
  const graph = attachmentObject(await graphRequest({ policy, accessToken, fetchImpl }, { path }));
  const attachment = args.include_content === false ? stripAttachmentContent(graph) : graph;
  return { schema: 'narada.graph_mail_mcp.attachment.v1', status: 'ok', attachment };
}

async function graphMailAttachmentAdd(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const messageId = attachmentMessageId(args);
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(messageId)}/attachments`, policy);
  const body = fileAttachmentBody(args);
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path, body });
  return { schema: 'narada.graph_mail_mcp.attachment.v1', status: 'created', attachment: graph };
}

async function graphMailAttachmentUploadSessionCreate(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const messageId = attachmentMessageId(args);
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`, policy);
  const body = uploadSessionBody(args);
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path, body });
  return { schema: 'narada.graph_mail_mcp.attachment_upload_session.v1', status: 'created', upload_session: graph };
}

async function graphMailAttachmentUploadChunk(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { bytes, contentRange, uploadUrl } = decodeUploadChunk(args);
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  if (!match) throw new Error('attachment_upload_content_range_invalid');
  return uploadAttachmentBytes(uploadUrl, bytes, Number(match[1]), Number(match[2]), Number(match[3]), state.fetchImpl);
}

async function graphMailAttachmentUploadFile(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, fetchImpl } = await clientParts(state);
  const filePath = resolveAttachmentFilePath(args, policy.site_root, policy.allowed_attachment_roots);
  const fileSize = statSync(filePath).size;
  const attachmentName = stringOption(args.name) ?? basename(filePath);
  const contentType = stringOption(args.content_type) ?? inferContentType(attachmentName);
  const chunkSize = uploadChunkSize(args);
  const session = asRecord((await graphMailAttachmentUploadSessionCreate({
    ...args,
    name: attachmentName,
    size: fileSize,
    content_type: contentType,
  }, state)).upload_session);
  const uploadUrl = requiredString(session, 'uploadUrl');
  assertAttachmentUploadUrlAllowed(uploadUrl);
  const hash = createHash('sha256');
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(chunkSize, fileSize));
  let offset = 0;
  let chunkCount = 0;
  let finalResult: GraphMailRecord | null = null;
  try {
    while (offset < fileSize) {
      const bytesToRead = Math.min(chunkSize, fileSize - offset);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) throw new Error('attachment_file_read_failed');
      const bytes = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(bytes);
      const result = await uploadAttachmentBytes(uploadUrl, bytes, offset, offset + bytesRead - 1, fileSize, fetchImpl);
      chunkCount += 1;
      if (result.status === 'ok') finalResult = asRecord(result.result);
      offset += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  const sha256 = hash.digest('hex');
  recordGraphMailAudit(state.siteRoot, { event_kind: 'attachment_upload_file_completed', mailbox_id: args.mailbox_id ?? 'me', message_id: attachmentMessageId(args), name: attachmentName, size: fileSize, sha256, chunk_count: chunkCount });
  return {
    schema: 'narada.graph_mail_mcp.attachment_upload_file.v1',
    status: 'uploaded',
    draft_id: stringOption(args.draft_id) ?? null,
    message_id: attachmentMessageId(args),
    name: attachmentName,
    content_type: contentType,
    size: fileSize,
    chunk_size: chunkSize,
    chunk_count: chunkCount,
    sha256,
    attachment: finalResult ?? null,
  };
}

async function graphMailAttachmentDelete(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const messageId = attachmentMessageId(args);
  const attachmentId = requiredString(args, 'attachment_id');
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, policy);
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'DELETE', path });
  return { schema: 'narada.graph_mail_mcp.attachment_delete.v1', status: 'deleted', result: graph };
}

async function graphMailDraftCreate(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const message = messagePatchFromArgs(args);
  const path = graphMailboxPath(args.mailbox_id, 'messages', policy);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_create_requested', mailbox_id: args.mailbox_id ?? 'me', subject: message.subject ?? null });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path, body: message });
  recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_create_completed', mailbox_id: args.mailbox_id ?? 'me', draft_id: asRecord(graph).id ?? null });
  return { schema: 'narada.graph_mail_mcp.draft.v1', status: 'created', draft: graph };
}

async function graphMailDerivedDraftCreate(args: GraphMailRecord, state: GraphMailServerState, action: 'createReply' | 'createReplyAll' | 'createForward'): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const messageId = requiredString(args, 'message_id');
  const body = derivedDraftBody(args, action);
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(messageId)}/${action}`, policy);
  recordGraphMailAudit(state.siteRoot, { event_kind: `${action}_requested`, mailbox_id: args.mailbox_id ?? 'me', message_id: messageId });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path, body });
  recordGraphMailAudit(state.siteRoot, { event_kind: `${action}_completed`, mailbox_id: args.mailbox_id ?? 'me', message_id: messageId, draft_id: asRecord(graph).id ?? null });
  return { schema: 'narada.graph_mail_mcp.draft.v1', status: 'created', draft: graph };
}

async function graphMailReplyAllToLastInThreadDraftCreate(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const conversationId = requiredString(args, 'conversation_id');
  const mailboxId = args.mailbox_id ?? 'me';
  const messagesPath = graphMailboxPath(mailboxId, `messages`, policy);
  const filter = `conversationId eq '${conversationId.replace(/'/g, "''")}'`;
  const query = { '$filter': filter, '$orderby': 'receivedDateTime desc', '$top': 1, '$select': 'id,conversationId,receivedDateTime' };
  const messagesResult = await graphRequest({ policy, accessToken, fetchImpl }, { path: messagesPath, query });
  const messages = asRecord(messagesResult).value as unknown[] | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('graph_mail_thread_no_messages');
  }
  const lastMessage = asRecord(messages[0]);
  const messageId = String(lastMessage.id ?? '');
  if (!messageId) {
    throw new Error('graph_mail_thread_last_message_missing_id');
  }
  const body = derivedDraftBody(args, 'createReplyAll');
  const path = graphMailboxPath(mailboxId, `messages/${encodeURIComponent(messageId)}/createReplyAll`, policy);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'createReplyAll_to_last_in_thread_requested', mailbox_id: mailboxId, conversation_id: conversationId, message_id: messageId });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path, body });
  recordGraphMailAudit(state.siteRoot, { event_kind: 'createReplyAll_to_last_in_thread_completed', mailbox_id: mailboxId, conversation_id: conversationId, message_id: messageId, draft_id: asRecord(graph).id ?? null });
  return { schema: 'narada.graph_mail_mcp.draft.v1', status: 'created', source_message_id: messageId, draft: graph };
}

function derivedDraftBody(args: GraphMailRecord, action: 'createReply' | 'createReplyAll' | 'createForward'): GraphMailRecord {
  const message = messagePatchFromArgs(args);
  if (action === 'createForward' && Array.isArray(args.to_recipients)) message.toRecipients = recipients(args.to_recipients);
  const body: GraphMailRecord = {};
  if (typeof args.comment === 'string' && asRecord(message).body) {
    throw new Error('derived_draft_comment_body_conflict: provide comment or body_text/body_html, not both');
  }
  if (typeof args.comment === 'string') body.comment = args.comment;
  if (Object.keys(message).length > 0) body.message = message;
  return body;
}

async function graphMailDraftUpdate(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const draftId = requiredString(args, 'draft_id');
  const patch = messagePatchFromArgs(args);
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(draftId)}`, policy);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_update_requested', mailbox_id: args.mailbox_id ?? 'me', draft_id: draftId });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'PATCH', path, body: patch });
  recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_update_completed', mailbox_id: args.mailbox_id ?? 'me', draft_id: draftId });
  return { schema: 'narada.graph_mail_mcp.draft.v1', status: 'updated', draft: graph };
}

async function graphMailDraftDiscard(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const draftId = requiredString(args, 'draft_id');
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(draftId)}`, policy);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_discard_requested', mailbox_id: args.mailbox_id ?? 'me', draft_id: draftId });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'DELETE', path });
  recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_discard_completed', mailbox_id: args.mailbox_id ?? 'me', draft_id: draftId });
  return { schema: 'narada.graph_mail_mcp.draft_discard.v1', status: 'discarded', result: graph };
}

async function graphMailDraftSend(args: GraphMailRecord, state: GraphMailServerState): Promise<GraphMailRecord> {
  const policy = loadGraphMailPolicy(state.siteRoot);
  const draftId = requiredString(args, 'draft_id');
  const decision = decideDraftSend(policy, args);
  if (decision.status !== 'allowed') {
    recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_send_refused', mailbox_id: args.mailbox_id ?? 'me', draft_id: draftId, reason: decision.reason });
    return { schema: 'narada.graph_mail_mcp.draft_send.v1', status: 'refused', reason: decision.reason, draft_id: draftId };
  }
  const { accessToken, fetchImpl } = await clientParts(state, policy);
  const path = graphMailboxPath(args.mailbox_id, `messages/${encodeURIComponent(draftId)}/send`, policy);
  recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_send_requested', mailbox_id: args.mailbox_id ?? 'me', draft_id: draftId });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path });
  recordGraphMailAudit(state.siteRoot, { event_kind: 'draft_send_completed', mailbox_id: args.mailbox_id ?? 'me', draft_id: draftId });
  return { schema: 'narada.graph_mail_mcp.draft_send.v1', status: 'sent', result: graph };
}

async function clientParts(state: GraphMailServerState, policy = loadGraphMailPolicy(state.siteRoot)) {
  const auth = await resolveAccessToken(state);
  return { policy, accessToken: auth.accessToken, fetchImpl: state.fetchImpl as any };
}

async function resolveAccessToken(state: GraphMailServerState, options: { probeOnly?: boolean } = {}): Promise<{ available: true; accessToken: string; authMode: string } | { available: false; accessToken: null; authMode: 'missing' }> {
  if (state.accessToken) return { available: true, accessToken: state.accessToken, authMode: 'access_token' };
  const delegatedToken = readDelegatedToken(state.siteRoot);
  if (delegatedToken && delegatedToken.expires_at_ms > Date.now() + 60_000) {
    const policy = loadGraphMailPolicy(state.siteRoot);
    if (policy.allow_device_code_auth && scopeAllowed(policy, delegatedToken.scope)) {
      return { available: true, accessToken: options.probeOnly ? '<delegated_device_code_available>' : delegatedToken.access_token, authMode: 'delegated_device_code' };
    }
  }
  if (!state.tenantId || !state.clientId || !state.clientSecret) {
    if (options.probeOnly) return { available: false, accessToken: null, authMode: 'missing' };
    throw new Error('ms_graph_auth_required: set MS_GRAPH_ACCESS_TOKEN or GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET');
  }
  if (state.tokenCache && state.tokenCache.expiresAtMs > Date.now() + 60_000) {
    return { available: true, accessToken: state.tokenCache.accessToken, authMode: 'client_credentials' };
  }
  if (options.probeOnly) return { available: true, accessToken: '<client_credentials_available>', authMode: 'client_credentials' };

  const endpoint = state.tokenEndpoint ?? `https://login.microsoftonline.com/${encodeURIComponent(state.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: state.clientId,
    client_secret: state.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const response = await state.fetchImpl(endpoint, { method: 'POST', body } as any);
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (!response.ok || response.status < 200 || response.status >= 300) {
    throw new Error(`ms_graph_token_request_failed:${response.status}:${redactTokenResponse(text || response.statusText || 'unknown_error')}`);
  }
  let payload: GraphMailRecord;
  try {
    payload = asRecord(JSON.parse(text));
  } catch {
    throw new Error('ms_graph_token_response_invalid_json');
  }
  const accessToken = stringOption(payload.access_token);
  if (!accessToken) throw new Error('ms_graph_token_response_missing_access_token');
  const expiresInSeconds = Number(payload.expires_in ?? 3599);
  const expiresAtMs = Date.now() + Math.max(60, Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3599) * 1000;
  state.tokenCache = { accessToken, expiresAtMs };
  return { available: true, accessToken, authMode: 'client_credentials' };
}

function resolveDeviceCodePolicy(
  policy: ReturnType<typeof loadGraphMailPolicy>,
  state: GraphMailServerState,
  args: GraphMailRecord,
): { status: 'allowed'; tenantId: string; clientId: string; scope: string } | { status: 'refused'; reason: string } {
  if (!policy.allow_device_code_auth) return { status: 'refused', reason: 'device_code_auth_disallowed_by_policy' };
  const tenantId = stringOption(policy.device_code_tenant_id) ?? state.tenantId;
  if (!tenantId) return { status: 'refused', reason: 'device_code_tenant_id_required' };
  const clientId = stringOption(policy.device_code_client_id) ?? state.clientId;
  if (!clientId) return { status: 'refused', reason: 'device_code_client_id_required' };
  const scope = stringOption(args.scope) ?? (policy.device_code_allowed_scopes.length === 1 ? policy.device_code_allowed_scopes[0] : null);
  if (!scope) return { status: 'refused', reason: 'device_code_scope_required' };
  if (!scopeAllowed(policy, scope)) return { status: 'refused', reason: 'device_code_scope_not_allowed' };
  return { status: 'allowed', tenantId, clientId, scope };
}

function scopeAllowed(policy: ReturnType<typeof loadGraphMailPolicy>, scope: string): boolean {
  return policy.device_code_allowed_scopes.includes(scope);
}

function delegatedTokenSummary(siteRoot: string): GraphMailRecord {
  const token = readDelegatedToken(siteRoot);
  if (!token) return { status: 'missing', fresh: false };
  return {
    status: token.expires_at_ms > Date.now() + 60_000 ? 'available' : 'expired',
    fresh: token.expires_at_ms > Date.now() + 60_000,
    auth_mode: token.auth_mode,
    tenant_id: token.tenant_id,
    client_id: token.client_id,
    scope: token.scope,
    acquired_at: token.acquired_at,
    expires_at_ms: token.expires_at_ms,
  };
}

function readDelegatedToken(siteRoot: string): DelegatedTokenState | null {
  const path = delegatedTokenPath(siteRoot);
  if (!existsSync(path)) return null;
  const record = asRecord(JSON.parse(readFileSync(path, 'utf8')));
  if (record.schema !== 'narada.graph_mail_mcp.delegated_token.v1') return null;
  const accessToken = stringOption(record.access_token);
  const tenantId = stringOption(record.tenant_id);
  const clientId = stringOption(record.client_id);
  const scope = stringOption(record.scope);
  const expiresAtMs = Number(record.expires_at_ms);
  if (!accessToken || !tenantId || !clientId || !scope || !Number.isFinite(expiresAtMs)) return null;
  return {
    schema: 'narada.graph_mail_mcp.delegated_token.v1',
    auth_mode: 'delegated_device_code',
    tenant_id: tenantId,
    client_id: clientId,
    scope,
    access_token: accessToken,
    expires_at_ms: expiresAtMs,
    acquired_at: stringOption(record.acquired_at) ?? '',
  };
}

function readDeviceCodeFlow(siteRoot: string, flowId: string): DeviceCodeFlowState | null {
  const path = flowPath(siteRoot, flowId);
  if (!existsSync(path)) return null;
  const record = asRecord(JSON.parse(readFileSync(path, 'utf8')));
  if (record.schema !== 'narada.graph_mail_mcp.device_code_flow.v1') return null;
  const tenantId = stringOption(record.tenant_id);
  const clientId = stringOption(record.client_id);
  const scope = stringOption(record.scope);
  const deviceCode = stringOption(record.device_code);
  const userCode = stringOption(record.user_code);
  const verificationUri = stringOption(record.verification_uri);
  const expiresAtMs = Number(record.expires_at_ms);
  const intervalSeconds = positiveInteger(record.interval_seconds, 5);
  if (!tenantId || !clientId || !scope || !deviceCode || !userCode || !verificationUri || !Number.isFinite(expiresAtMs)) return null;
  return {
    schema: 'narada.graph_mail_mcp.device_code_flow.v1',
    flow_id: flowId,
    tenant_id: tenantId,
    client_id: clientId,
    scope,
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    expires_at_ms: expiresAtMs,
    interval_seconds: intervalSeconds,
    created_at: stringOption(record.created_at) ?? '',
  };
}

function delegatedTokenPath(siteRoot: string): string {
  return join(siteRoot, '.ai', 'runtime', 'graph-mail-mcp', 'delegated-token.json');
}

function flowPath(siteRoot: string, flowId: string): string {
  const safeFlowId = flowId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return join(siteRoot, '.ai', 'runtime', 'graph-mail-mcp', 'device-code-flows', `${safeFlowId}.json`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function parseJsonRecord(text: string): GraphMailRecord {
  try {
    return asRecord(JSON.parse(text || '{}'));
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function loadGraphMailEnvironment(siteRoot: string): Record<string, string> {
  return {
    ...readEnvFile(resolve(siteRoot, '..', '.env')),
    ...readEnvFile(resolve(siteRoot, '.env')),
    ...process.env,
  };
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([^#=\s]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function stringOption(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function redactTokenResponse(text: string): string {
  return text.replace(/("(?:access_token|client_secret|refresh_token)"\s*:\s*")([^"]+)(")/gi, '$1<redacted>$3');
}

const GRAPH_MAIL_MUTATING_TOOLS = new Set([
  'graph_mail_auth_device_code_start',
  'graph_mail_auth_device_code_poll',
  'graph_mail_auth_clear',
  'graph_mail_folder_create',
  'graph_mail_message_move',
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
]);

const GRAPH_MAIL_DESTRUCTIVE_TOOLS = new Set([
  'graph_mail_auth_clear',
  'graph_mail_message_move',
  'graph_mail_attachment_delete',
  'graph_mail_draft_discard',
  'graph_mail_draft_send',
]);

const GRAPH_MAIL_IDEMPOTENT_TOOLS = new Set([
  'graph_mail_guidance',
  'graph_mail_doctor',
  'graph_mail_auth_status',
  'graph_mail_query',
  'graph_mail_message_show',
  'graph_mail_output_show',
  'graph_mail_folder_list',
  'graph_mail_attachment_list',
  'graph_mail_attachment_get',
]);

function tool(name: string, description: string, properties: unknown, required: string[] = []): unknown {
  return {
    name,
    description,
    annotations: toolAnnotations(name),
    inputSchema: {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
    },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

function toolAnnotations(name: string) {
  return {
    title: name,
    readOnlyHint: !GRAPH_MAIL_MUTATING_TOOLS.has(name),
    destructiveHint: GRAPH_MAIL_DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: GRAPH_MAIL_IDEMPOTENT_TOOLS.has(name),
    openWorldHint: true,
  };
}

function parseArgs(argv: string[]): GraphMailRecord {
  const parsed: GraphMailRecord = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function drainJsonRpcFrames(buffer: string): { requests: GraphMailRecord[]; remaining: string } {
  const requests: GraphMailRecord[] = [];
  let rest = buffer;
  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    const separatorLength = headerEnd >= 0 ? 4 : 2;
    const lfHeaderEnd = headerEnd >= 0 ? headerEnd : rest.indexOf('\n\n');
    if (lfHeaderEnd < 0) break;
    const header = rest.slice(0, lfHeaderEnd);
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = lfHeaderEnd + separatorLength;
    if (rest.length < bodyStart + length) break;
    requests.push(asRecord(JSON.parse(rest.slice(bodyStart, bodyStart + length))));
    rest = rest.slice(bodyStart + length);
  }
  return { requests, remaining: rest };
}

function writeJsonRpcResponse(payload: unknown, options: unknown = {}): void {
  const text = JSON.stringify(payload);
  if (asRecord(options).framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(text, 'utf8')}\r\n\r\n${text}`);
  else process.stdout.write(`${text}\n`);
}

function errorDiagnostic(error: unknown): { schema: string; message: string } {
  return {
    schema: 'narada.graph_mail_mcp.error.v1',
    message: error instanceof Error ? error.message : String(error),
  };
}
