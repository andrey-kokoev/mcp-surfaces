#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGraphUrl, graphMailboxPath, graphRequest, graphTop, messagePatchFromArgs, recipients, requiredString } from './graph-client.js';
import { decideDraftSend, loadGraphMailPolicy, recordGraphMailAudit } from './policy.js';

const SERVER_NAME = 'narada-graph-mail-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

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
    tool('graph_mail_doctor', 'Inspect Microsoft Graph mail MCP readiness and policy.', {}),
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
    tool('graph_mail_draft_create', 'Create a new draft message in an allowed mailbox.', draftMessageProperties(), []),
    tool('graph_mail_reply_draft_create', 'Create a reply draft for an existing message.', replyDraftProperties(), ['message_id']),
    tool('graph_mail_reply_all_draft_create', 'Create a reply-all draft for an existing message.', replyDraftProperties(), ['message_id']),
    tool('graph_mail_forward_draft_create', 'Create a forward draft for an existing message.', forwardDraftProperties(), ['message_id']),
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

function forwardDraftProperties() {
  return {
    ...replyDraftProperties(),
    to_recipients: { type: 'array', items: { type: 'string' }, description: 'Forward recipient addresses or Graph recipient objects.' },
  };
}

async function callTool(params: GraphMailRecord, state: GraphMailServerState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: unknown;
  switch (name) {
    case 'graph_mail_doctor':
      result = await graphMailDoctor(state);
      break;
    case 'graph_mail_query':
      result = await graphMailQuery(args, state);
      break;
    case 'graph_mail_message_show':
      result = await graphMailMessageShow(args, state);
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
    case 'graph_mail_draft_update':
      result = await graphMailDraftUpdate(args, state);
      break;
    case 'graph_mail_draft_discard':
      result = await graphMailDraftDiscard(args, state);
      break;
    case 'graph_mail_draft_send':
      result = await graphMailDraftSend(args, state);
      break;
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
  return { content: [assistantTextContent(JSON.stringify(result, null, 2))], structuredContent: result };
}

function assistantTextContent(text: string) {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
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
    allow_send_draft: policy.allow_send_draft,
    send_approval_token_configured: !!policy.send_approval_token,
    server_name: state.serverName,
  };
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
  if (!query['$search'] && !query['$filter']) query['$orderby'] = 'receivedDateTime desc';
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
  const writes = /draft_create|draft_update|draft_discard|draft_send/.test(name);
  return {
    title: name,
    readOnlyHint: !writes,
    destructiveHint: /draft_discard|draft_send/.test(name),
    idempotentHint: /doctor|query|show/.test(name),
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
