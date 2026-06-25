import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CONFIG_PATH = '.ai/calendar-mcp.json';
const AUDIT_PATH = '.ai/audit/calendar-mcp.jsonl';
const DEFAULT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

type CalendarRecord = Record<string, unknown>;

export type CalendarPolicy = {
  site_root: string;
  graph_base_url: string;
  allowed_mailboxes: string[];
  allow_event_writes: boolean;
  write_approval_token: string | null;
};

function asRecord(value: unknown): CalendarRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CalendarRecord : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

export function loadCalendarPolicy(siteRootInput: string): CalendarPolicy {
  const siteRoot = resolve(siteRootInput);
  const path = join(siteRoot, CONFIG_PATH);
  const config = existsSync(path) ? asRecord(JSON.parse(readFileSync(path, 'utf8'))) : {};
  return {
    site_root: siteRoot,
    graph_base_url: typeof config.graph_base_url === 'string' && config.graph_base_url.trim() !== ''
      ? config.graph_base_url.replace(/\/+$/, '')
      : DEFAULT_GRAPH_BASE_URL,
    allowed_mailboxes: asStringArray(config.allowed_mailboxes ?? config.allowedMailboxes),
    allow_event_writes: config.allow_event_writes === true || config.allowEventWrites === true,
    write_approval_token: typeof config.write_approval_token === 'string'
      ? config.write_approval_token
      : typeof config.writeApprovalToken === 'string'
        ? config.writeApprovalToken
        : null,
  };
}

export function assertMailboxAllowed(policy: CalendarPolicy, mailboxId: string): void {
  if (policy.allowed_mailboxes.length === 0) return;
  if (!policy.allowed_mailboxes.includes(mailboxId)) {
    throw new Error(`mailbox_not_allowed: ${mailboxId}`);
  }
}

export function decideEventWrite(policy: CalendarPolicy, args: CalendarRecord): { status: 'allowed' | 'refused'; reason?: string } {
  if (!policy.allow_event_writes) return { status: 'refused', reason: 'event_writes_disallowed_by_policy' };
  if (args.confirm_write !== true && args.confirmWrite !== true) return { status: 'refused', reason: 'confirm_write_required' };
  if (policy.write_approval_token && args.approval_token !== policy.write_approval_token) {
    return { status: 'refused', reason: 'write_approval_token_required' };
  }
  return { status: 'allowed' };
}

export function recordCalendarAudit(siteRootInput: string, event: CalendarRecord): void {
  const siteRoot = resolve(siteRootInput);
  const auditPath = join(siteRoot, AUDIT_PATH);
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(auditPath, `${JSON.stringify({
    schema: 'narada.calendar_mcp.audit.v1',
    recorded_at: new Date().toISOString(),
    ...event,
  })}\n`);
}
