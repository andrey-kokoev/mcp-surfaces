import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CONFIG_PATH = '.ai/graph-mail-mcp.json';
const AUDIT_PATH = '.ai/audit/graph-mail-mcp.jsonl';
const DEFAULT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

type GraphMailRecord = Record<string, unknown>;

export type GraphMailPolicy = {
  site_root: string;
  graph_base_url: string;
  allowed_mailboxes: string[];
  allow_send_draft: boolean;
  send_approval_token: string | null;
};

function asRecord(value: unknown): GraphMailRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as GraphMailRecord : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

export function loadGraphMailPolicy(siteRootInput: string): GraphMailPolicy {
  const siteRoot = resolve(siteRootInput);
  const path = join(siteRoot, CONFIG_PATH);
  const config = existsSync(path) ? asRecord(JSON.parse(readFileSync(path, 'utf8'))) : {};
  return {
    site_root: siteRoot,
    graph_base_url: typeof config.graph_base_url === 'string' && config.graph_base_url.trim() !== ''
      ? config.graph_base_url.replace(/\/+$/, '')
      : DEFAULT_GRAPH_BASE_URL,
    allowed_mailboxes: asStringArray(config.allowed_mailboxes ?? config.allowedMailboxes),
    allow_send_draft: config.allow_send_draft === true || config.allowSendDraft === true,
    send_approval_token: typeof config.send_approval_token === 'string'
      ? config.send_approval_token
      : typeof config.sendApprovalToken === 'string'
        ? config.sendApprovalToken
        : null,
  };
}

export function assertMailboxAllowed(policy: GraphMailPolicy, mailboxId: string): void {
  if (policy.allowed_mailboxes.length === 0) return;
  if (!policy.allowed_mailboxes.includes(mailboxId)) {
    throw new Error(`mailbox_not_allowed: ${mailboxId}`);
  }
}

export function decideDraftSend(policy: GraphMailPolicy, args: GraphMailRecord): { status: 'allowed' | 'refused'; reason?: string } {
  if (!policy.allow_send_draft) return { status: 'refused', reason: 'send_draft_disallowed_by_policy' };
  if (args.confirm_send !== true && args.confirmSend !== true) return { status: 'refused', reason: 'confirm_send_required' };
  if (policy.send_approval_token && args.approval_token !== policy.send_approval_token) {
    return { status: 'refused', reason: 'send_approval_token_required' };
  }
  return { status: 'allowed' };
}

export function recordGraphMailAudit(siteRootInput: string, event: GraphMailRecord): void {
  const siteRoot = resolve(siteRootInput);
  const auditPath = join(siteRoot, AUDIT_PATH);
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(auditPath, `${JSON.stringify({
    schema: 'narada.graph_mail_mcp.audit.v1',
    recorded_at: new Date().toISOString(),
    ...event,
  })}\n`);
}
