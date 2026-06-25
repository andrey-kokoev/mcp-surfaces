import { assertMailboxAllowed, CalendarPolicy } from './policy.js';

type CalendarRecord = Record<string, unknown>;
type FetchLike = (input: string, init?: CalendarRecord) => Promise<{
  ok?: boolean;
  status: number;
  statusText?: string;
  text?: () => Promise<string>;
}>;

export type CalendarClientOptions = {
  policy: CalendarPolicy;
  accessToken: string;
  fetchImpl: FetchLike;
};

export type CalendarRequest = {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
};

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function mailboxPrefix(mailboxId: string): string {
  return mailboxId === 'me' ? '/me' : `/users/${encodeURIComponent(mailboxId)}`;
}

export function graphCalendarPath(mailboxIdInput: unknown, suffix: string, policy: CalendarPolicy): string {
  const mailboxId = typeof mailboxIdInput === 'string' && mailboxIdInput.trim() !== ''
    ? mailboxIdInput
    : policy.allowed_mailboxes.length === 1
      ? policy.allowed_mailboxes[0]
      : 'me';
  assertMailboxAllowed(policy, mailboxId);
  return `${mailboxPrefix(mailboxId)}/${trimSlashes(suffix)}`;
}

export function buildGraphUrl(policy: CalendarPolicy, path: string, query: CalendarRequest['query'] = {}): string {
  const url = new URL(`${policy.graph_base_url}/${trimSlashes(path)}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function graphRequest(options: CalendarClientOptions, request: CalendarRequest): Promise<unknown> {
  const method = String(request.method ?? 'GET').toUpperCase();
  const url = buildGraphUrl(options.policy, request.path, request.query);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    Accept: 'application/json',
  };
  const init: CalendarRecord = { method, headers };
  if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(request.body);
  }
  const response = await options.fetchImpl(url, init);
  const text = typeof response.text === 'function' ? await response.text() : '';
  if ((!response.ok && response.status < 200) || response.status >= 300) {
    throw new Error(`graph_request_failed:${response.status}:${text || response.statusText || 'unknown_error'}`);
  }
  if (response.status === 202 || response.status === 204 || text.trim() === '') {
    return { status: 'accepted', http_status: response.status };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { status: 'ok', text };
  }
}

export function graphTop(value: unknown, fallback = 20): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

export function requiredString(args: unknown, key: string): string {
  const record = args && typeof args === 'object' && !Array.isArray(args) ? args as CalendarRecord : {};
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key}_required`);
  return value;
}
