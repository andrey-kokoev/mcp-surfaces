import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_MAILBOX_ROOTS = [
  '.ai/mailboxes',
  '.ai/synced-mailboxes',
  'operator-surfaces/mailboxes',
];
const CONFIG_PATH = '.ai/mailbox-mcp.json';
const MAX_SCAN_FILES = 5000;
const MAX_JSON_BYTES = 10 * 1024 * 1024;

type MailboxRecord = Record<string, unknown>;

export type MailboxMessage = {
  message_id: string;
  mailbox_id: string;
  folder: string | null;
  thread_id: string | null;
  subject: string;
  from: unknown;
  to: unknown[];
  cc: unknown[];
  received_at: string | null;
  sent_at: string | null;
  unread: boolean | null;
  importance: string | null;
  categories: string[];
  preview: string | null;
  body_text: string | null;
  body_html: string | null;
  attachments: unknown[];
  source_path: string;
  raw: MailboxRecord;
};

export type MailboxScan = {
  schema: string;
  status: string;
  site_root: string;
  roots: string[];
  scanned_files: number;
  skipped_non_message_records: number;
  invalid_count: number;
  invalid_records: unknown[];
  messages: MailboxMessage[];
};

function asRecord(value: unknown): MailboxRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MailboxRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function boolValue(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return normalized === '' ? null : normalized;
}

function previewFromText(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  return text.replace(/\s+/g, ' ').slice(0, 500);
}

function configuredRoots(siteRoot: string): string[] {
  const configPath = join(siteRoot, CONFIG_PATH);
  if (!existsSync(configPath)) return DEFAULT_MAILBOX_ROOTS.map((root) => join(siteRoot, root));
  const config = asRecord(JSON.parse(readFileSync(configPath, 'utf8')));
  const roots = Array.isArray(config.roots) ? config.roots : DEFAULT_MAILBOX_ROOTS;
  return roots
    .filter((root): root is string => typeof root === 'string' && root.trim() !== '')
    .map((root) => resolve(siteRoot, root));
}

function isInsideSite(siteRoot: string, path: string): boolean {
  const rel = relative(siteRoot, path);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`) && !isAbsolute(rel));
}

function collectFiles(root: string, files: string[], invalidRecords: unknown[]): void {
  if (files.length >= MAX_SCAN_FILES || !existsSync(root)) return;
  const stat = statSync(root);
  if (stat.isFile()) {
    if (/\.(json|jsonl)$/i.test(root)) files.push(root);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (files.length >= MAX_SCAN_FILES) {
      invalidRecords.push({ root, reason: 'scan_file_limit_reached', limit: MAX_SCAN_FILES });
      return;
    }
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    collectFiles(join(root, entry.name), files, invalidRecords);
  }
}

function recordsFromFile(filePath: string): MailboxRecord[] {
  const stat = statSync(filePath);
  if (stat.size > MAX_JSON_BYTES) throw new Error('file_too_large');
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  if (filePath.toLowerCase().endsWith('.jsonl')) {
    return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line)));
  }
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.map(asRecord);
  const doc = asRecord(parsed);
  if (Array.isArray(doc.messages)) return doc.messages.map((message) => ({ ...asRecord(message), mailbox_id: doc.mailbox_id ?? doc.mailboxId ?? asRecord(message).mailbox_id }));
  if (Array.isArray(doc.value)) return doc.value.map((message) => ({ ...asRecord(message), mailbox_id: doc.mailbox_id ?? doc.mailboxId ?? asRecord(message).mailbox_id }));
  return [doc];
}

function mailboxIdFromPath(siteRoot: string, sourcePath: string): string {
  const rel = relative(siteRoot, dirname(sourcePath)).split(/[\\/]/).filter(Boolean);
  const marker = rel.findIndex((part) => part === 'mailboxes' || part === 'synced-mailboxes');
  if (marker >= 0 && rel[marker + 1]) return rel[marker + 1];
  return basename(dirname(sourcePath)) || 'default';
}

function hasMessageIdentity(raw: MailboxRecord): boolean {
  return stringValue(raw.message_id, raw.messageId, raw.internetMessageId, raw.internet_message_id, raw.id, raw.entryId) != null;
}

function hasMailboxMessageShape(record: unknown): boolean {
  const raw = asRecord(record);
  if (!hasMessageIdentity(raw)) return false;
  const body = asRecord(raw.body);
  return [
    raw.subject,
    raw.title,
    raw.body_text,
    raw.bodyText,
    raw.text,
    raw.body_html,
    raw.bodyHtml,
    raw.html,
    body.content,
    raw.preview,
    raw.body_preview,
    raw.bodyPreview,
    raw.snippet,
    raw.from,
    raw.sender,
    raw.to,
    raw.toRecipients,
    raw.received_at,
    raw.receivedAt,
    raw.receivedDateTime,
    raw.sent_at,
    raw.sentAt,
    raw.sentDateTime,
    raw.conversation_id,
    raw.conversationId,
    raw.thread_id,
    raw.threadId,
  ].some((value) => value != null);
}

function sourcePreference(siteRoot: string, sourcePath: string): number {
  const parts = relative(siteRoot, sourcePath).split(/[\\/]/).map((part) => part.toLowerCase());
  if (parts.includes('messages')) return 0;
  if (parts.includes('views')) return 10;
  return 5;
}

export function normalizeMailboxMessage(record: unknown, context: { siteRoot: string; sourcePath: string }): MailboxMessage | null {
  const raw = asRecord(record);
  const body = asRecord(raw.body);
  const messageId = stringValue(raw.message_id, raw.messageId, raw.internetMessageId, raw.internet_message_id, raw.id, raw.entryId);
  if (!messageId) return null;
  const bodyText = normalizeText(raw.body_text ?? raw.bodyText ?? raw.text ?? body.text ?? body.content);
  const bodyHtml = normalizeText(raw.body_html ?? raw.bodyHtml ?? raw.html ?? (body.contentType === 'html' ? body.content : null));
  const preview = previewFromText(raw.preview ?? raw.body_preview ?? raw.bodyPreview ?? raw.snippet ?? bodyText ?? bodyHtml);
  const receivedAt = stringValue(raw.received_at, raw.receivedAt, raw.receivedDateTime, raw.date, raw.created_at);
  const sentAt = stringValue(raw.sent_at, raw.sentAt, raw.sentDateTime);
  return {
    message_id: messageId,
    mailbox_id: stringValue(raw.mailbox_id, raw.mailboxId, raw.account, raw.account_id) ?? mailboxIdFromPath(context.siteRoot, context.sourcePath),
    folder: stringValue(raw.folder, raw.folder_id, raw.folderId, raw.mailFolder),
    thread_id: stringValue(raw.thread_id, raw.threadId, raw.conversation_id, raw.conversationId, raw.conversationIndex),
    subject: stringValue(raw.subject, raw.title) ?? '(no subject)',
    from: raw.from ?? raw.sender ?? null,
    to: asArray(raw.to ?? raw.toRecipients),
    cc: asArray(raw.cc ?? raw.ccRecipients),
    received_at: receivedAt,
    sent_at: sentAt,
    unread: boolValue(raw.unread, raw.isUnread) ?? (typeof raw.isRead === 'boolean' ? !raw.isRead : null),
    importance: stringValue(raw.importance, raw.priority),
    categories: asArray(raw.categories).filter((value): value is string => typeof value === 'string'),
    preview,
    body_text: bodyText,
    body_html: bodyHtml,
    attachments: asArray(raw.attachments),
    source_path: context.sourcePath,
    raw,
  };
}

export function readMailboxProjection(siteRootInput: string): MailboxScan {
  const siteRoot = resolve(siteRootInput);
  const invalidRecords: unknown[] = [];
  let skippedNonMessageRecords = 0;
  const roots = configuredRoots(siteRoot).filter((root) => isInsideSite(siteRoot, root));
  const files: string[] = [];
  for (const root of roots) collectFiles(root, files, invalidRecords);
  const messagesById = new Map<string, MailboxMessage>();
  for (const filePath of files) {
    try {
      for (const record of recordsFromFile(filePath)) {
        if (!hasMailboxMessageShape(record)) {
          skippedNonMessageRecords += 1;
          continue;
        }
        const message = normalizeMailboxMessage(record, { siteRoot, sourcePath: filePath });
        if (!message) {
          invalidRecords.push({ file_path: filePath, reason: 'missing_message_id' });
          continue;
        }
        const messageKey = `${message.mailbox_id}\u0000${message.message_id}`;
        const existing = messagesById.get(messageKey);
        if (!existing || sourcePreference(siteRoot, filePath) < sourcePreference(siteRoot, existing.source_path)) messagesById.set(messageKey, message);
      }
    } catch (error) {
      invalidRecords.push({ file_path: filePath, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const messages = [...messagesById.values()].sort((left, right) => String(right.received_at ?? right.sent_at ?? '').localeCompare(String(left.received_at ?? left.sent_at ?? '')));
  return {
    schema: 'narada.mailbox_projection.v1',
    status: 'ok',
    site_root: siteRoot,
    roots,
    scanned_files: files.length,
    skipped_non_message_records: skippedNonMessageRecords,
    invalid_count: invalidRecords.length,
    invalid_records: invalidRecords.slice(0, 100),
    messages,
  };
}

export function summarizeMessage(message: MailboxMessage, options: { includeBody?: boolean; includeRaw?: boolean; includeHtml?: boolean } = {}): MailboxRecord {
  const summary: MailboxRecord = {
    message_id: message.message_id,
    mailbox_id: message.mailbox_id,
    folder: message.folder,
    thread_id: message.thread_id,
    subject: message.subject,
    from: message.from,
    to: message.to,
    cc: message.cc,
    received_at: message.received_at,
    sent_at: message.sent_at,
    unread: message.unread,
    importance: message.importance,
    categories: message.categories,
    preview: message.preview,
    attachments: message.attachments,
    source_path: message.source_path,
  };
  if (options.includeBody) summary.body_text = message.body_text;
  if (options.includeHtml) summary.body_html = message.body_html;
  if (options.includeRaw) summary.raw = message.raw;
  return summary;
}

export function messageMatchesQuery(message: MailboxMessage, query: unknown): boolean {
  if (typeof query !== 'string' || query.trim() === '') return true;
  const needle = query.toLowerCase();
  const haystack = [
    message.subject,
    message.preview,
    message.body_text,
    JSON.stringify(message.from ?? ''),
    JSON.stringify(message.to ?? []),
    JSON.stringify(message.cc ?? []),
    message.categories.join(' '),
  ].join('\n').toLowerCase();
  return haystack.includes(needle);
}
