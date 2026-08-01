import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildBoundedToolResult } from '@narada-core/mcp-transport';
import { BrowserControlError, BrowserSession } from './browser.js';
import type { JsonRecord } from './tool-definitions.js';

export type BrowserControlState = {
  siteRoot: string;
  sessions: Map<string, BrowserSession>;
};

export function createServerState(options: JsonRecord = {}, env: NodeJS.ProcessEnv = process.env): BrowserControlState {
  const configured = options.site_root ?? options.siteRoot ?? env.NARADA_SITE_ROOT ?? process.cwd();
  if (typeof configured !== 'string' || configured.trim().length === 0 || configured.length > 2_000) {
    throw new BrowserControlError('site_root_invalid', 'site_root must be a bounded non-empty path.');
  }
  return { siteRoot: resolve(configured), sessions: new Map() };
}

export function sessionKey(profileId: string, sessionId: string): string {
  return `${profileId}/${sessionId}`;
}

export function requiredSession(args: JsonRecord, state: BrowserControlState): BrowserSession {
  const profileId = typeof args.profile_id === 'string' ? args.profile_id : '';
  const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
  if (!profileId || !sessionId) throw new BrowserControlError('session_selection_required', 'profile_id and session_id are required for every browser action.');
  const session = state.sessions.get(sessionKey(profileId, sessionId));
  if (!session) throw new BrowserControlError('browser_session_not_attached', 'The explicit profile/session is not attached to this surface.', { profile_id: profileId, session_id: sessionId });
  return session;
}

export function boundedResult(state: BrowserControlState, toolName: string, value: unknown, isError = false): JsonRecord {
  return buildBoundedToolResult({
    siteRoot: state.siteRoot,
    toolName,
    value,
    isError,
    limit: 1_800,
    readerTool: 'mcp_output_show',
  });
}

export function resultValue(status: string, value: JsonRecord = {}): JsonRecord {
  return { schema: 'narada.browser_control.result.v1', status, ...value };
}

function auditPath(state: BrowserControlState): string {
  return resolve(state.siteRoot, '.ai', 'tmp', 'browser-control', 'action-receipts.jsonl');
}

export function actionReceipt(state: BrowserControlState, action: string, session: BrowserSession | null, details: JsonRecord = {}): JsonRecord {
  const record: JsonRecord = {
    schema: 'narada.browser_control.action_receipt.v1',
    action_id: `browser-action-${randomUUID()}`,
    created_at: new Date().toISOString(),
    action,
    profile_id: session?.profileId ?? details.profile_id ?? null,
    session_id: session?.sessionId ?? details.session_id ?? null,
    details,
  };
  const path = auditPath(state);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
  return { ...record, audit_path: relative(state.siteRoot, path).replaceAll('\\\\', '/') };
}

export function errorResult(state: BrowserControlState, toolName: string, error: unknown): JsonRecord {
  const normalized = error instanceof BrowserControlError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'browser_control_internal_error', message: error instanceof Error ? error.message : String(error), details: {} };
  return boundedResult(state, toolName, resultValue('error', { error: normalized }), true);
}
