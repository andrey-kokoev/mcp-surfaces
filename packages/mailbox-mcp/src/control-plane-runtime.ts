import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type JsonRecord = Record<string, unknown>;

export interface SourceProvenance {
  sourceId: string;
  observedAt: string;
  sourceVersion?: string;
}

export interface SourceRecord {
  recordId: string;
  ordinal?: string;
  payload: unknown;
  provenance: SourceProvenance;
}

export interface SourceBatch {
  records: SourceRecord[];
  priorCheckpoint?: string | null;
  nextCheckpoint?: string;
  hasMore: boolean;
  fetchedAt: string;
}

export interface Source {
  readonly sourceId: string;
  pull(checkpoint?: string | null): Promise<SourceBatch>;
}

export interface MailAdmissionConfig {
  included_folder_refs?: string[];
  excluded_folder_refs?: string[];
  allowed_sender_addresses?: string[];
  allowed_sender_domains?: string[];
  unknown_sender_behavior?: 'ignore' | 'admit';
  predicates?: JsonRecord;
}

export interface ScopeConfig {
  scope_id: string;
  root_dir: string;
  sources: Array<JsonRecord & { type: string; user_id?: string; base_url?: string; prefer_immutable_ids?: boolean; tenant_id?: string; client_id?: string; client_secret?: string }>;
  graph?: {
    auth_mode?: 'delegated_token_store' | 'control_plane_default';
    tenant_id?: string;
    client_id?: string;
    client_secret?: string;
    user_id: string;
    base_url?: string;
    prefer_immutable_ids: boolean;
  };
  scope: {
    included_container_refs: string[];
    included_item_kinds: string[];
  };
  normalize: {
    attachment_policy: string;
    body_policy: string;
    include_headers: boolean;
    tombstones_enabled: boolean;
  };
  runtime: {
    polling_interval_ms: number;
    acquire_lock_timeout_ms: number;
    cleanup_tmp_on_startup: boolean;
    rebuild_views_after_sync: boolean;
    rebuild_search_after_sync: boolean;
  };
  admission?: { mail?: MailAdmissionConfig };
}

export interface Fact {
  fact_id: string;
  fact_type: string;
  provenance: {
    source_id: string;
    source_record_id: string;
    source_version?: string | null;
    source_cursor?: string | null;
    observed_at: string;
  };
  payload_json: string;
  created_at: string;
}

export interface FactStore {
  readonly db: Database;
  initSchema(): void;
  ingest(fact: Omit<Fact, 'created_at'>): { fact: Fact; isNew: boolean };
  getById(factId: string): Fact | undefined;
  getBySourceRecord(sourceId: string, sourceRecordId: string): Fact | undefined;
  getFactsForCursor(sourceId: string, sourceCursor: string): Fact[];
  getUnadmittedFacts(sourceId?: string, limit?: number): Fact[];
  markAdmitted(factIds: string[]): void;
  getFactsByScope(scopeId: string, selector?: unknown): Fact[];
  close(): void;
}

export interface Database {
  pragma(source: string): unknown;
}

export interface SyncResult {
  status: 'success' | 'retryable_failure' | 'fatal_failure';
  error?: string;
  prior_cursor?: string | null;
  next_cursor?: string;
  event_count: number;
  applied_count: number;
  skipped_count: number;
  duration_ms: number;
}

export interface MailAdmissionDecision {
  admitted: boolean;
  reason: string;
  fact_type: string;
  folder_refs: string[];
  sender_email: string | null;
}

export interface ControlPlaneRuntime {
  loadConfig(options: { path: string }): Promise<{ scopes: ScopeConfig[] }>;
  buildGraphTokenProvider(options: JsonRecord): unknown;
  GraphHttpClient: new (options: JsonRecord) => unknown;
  DefaultGraphAdapter: new (options: JsonRecord) => unknown;
  ExchangeSource: new (options: { adapter: unknown; sourceId: string }) => Source;
  DefaultProjector: new (options: { rootDir: string; tombstonesEnabled: boolean }) => {
    applyRecord(record: SourceRecord): Promise<{
      event_id: string;
      message_id: string;
      applied: boolean;
      dirty_views: {
        by_thread: string[];
        by_folder: string[];
        unread_changed: boolean;
        flagged_changed: boolean;
      };
    }>;
  };
  DefaultSyncRunner: new (options: JsonRecord) => { syncOnce(): Promise<SyncResult> };
  FileApplyLogStore: new (options: { rootDir: string }) => {
    hasApplied(recordId: string): Promise<boolean>;
    markApplied(recordId: string, payload?: unknown): Promise<void>;
  };
  FileCursorStore: new (options: { rootDir: string; scopeId: string }) => {
    read(): Promise<string | null>;
    commit(nextCursor: string): Promise<void>;
  };
  FileLock: new (options: {
    rootDir: string;
    acquireTimeoutMs: number;
    staleAfterMs: number;
  }) => { acquire(): Promise<() => Promise<void>> };
  Database: new (path: string) => Database;
  SqliteFactStore: new (options: { db: Database }) => FactStore;
  cleanupTmp(options: { rootDir: string }): Promise<unknown>;
  evaluateMailFactAdmission(fact: Fact, admission?: MailAdmissionConfig): MailAdmissionDecision;
  normalizeFlagged(value: unknown): unknown;
  normalizeFolderRef(value: unknown): unknown;
  sourceRecordToFact(record: SourceRecord, sourceCursor: string | null): Omit<Fact, 'created_at'>;
}

let cached: { entrypoint: string; runtime: ControlPlaneRuntime } | null = null;

export async function loadControlPlaneRuntime(siteRoot: string): Promise<ControlPlaneRuntime> {
  let entrypoint: string;
  try {
    entrypoint = await resolveControlPlaneEntrypoint(siteRoot);
  } catch (error) {
    throw new Error(`mailbox_control_plane_runtime_unavailable:${boundedError(error)}`);
  }
  if (cached?.entrypoint === entrypoint) return cached.runtime;
  const loaded = await import(pathToFileURL(entrypoint).href) as unknown;
  const runtime = validateRuntime(loaded);
  cached = { entrypoint, runtime };
  return runtime;
}

type DelegatedGraphToken = {
  schema: 'narada.graph_mail_mcp.delegated_token.v1';
  tenant_id: string;
  client_id: string;
  scope: string;
  access_token: string;
  refresh_token?: string;
  expires_at_ms: number;
  acquired_at: string;
};

export function buildDelegatedGraphTokenProvider(siteRoot: string): { getAccessToken(): Promise<string>; invalidateAccessToken(): void } {
  const tokenPath = join(resolve(siteRoot), '.ai', 'runtime', 'graph-mail-mcp', 'delegated-token.json');
  if (!existsSync(tokenPath)) throw new Error(`mailbox_graph_delegated_token_missing:${tokenPath}`);
  return {
    async getAccessToken(): Promise<string> {
      const token = await readDelegatedGraphToken(tokenPath);
      if (token.expires_at_ms > Date.now() + 60_000) return token.access_token;
      if (!token.refresh_token) throw new Error('mailbox_graph_delegated_token_expired_reauthorization_required');
      return refreshDelegatedGraphToken(tokenPath, token);
    },
    invalidateAccessToken(): void {
      // Durable state is re-read on every request; no in-memory token cache exists.
    },
  };
}

async function readDelegatedGraphToken(path: string): Promise<DelegatedGraphToken> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Partial<DelegatedGraphToken>;
  if (
    value.schema !== 'narada.graph_mail_mcp.delegated_token.v1'
    || typeof value.tenant_id !== 'string'
    || typeof value.client_id !== 'string'
    || typeof value.scope !== 'string'
    || typeof value.access_token !== 'string'
    || typeof value.expires_at_ms !== 'number'
  ) throw new Error('mailbox_graph_delegated_token_invalid');
  return value as DelegatedGraphToken;
}

async function refreshDelegatedGraphToken(path: string, token: DelegatedGraphToken): Promise<string> {
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(token.tenant_id)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: token.client_id,
    refresh_token: token.refresh_token!,
    scope: token.scope,
  });
  const response = await fetch(endpoint, { method: 'POST', body });
  const text = await response.text();
  if (!response.ok) throw new Error(`mailbox_graph_delegated_token_refresh_failed:${response.status}`);
  const payload = JSON.parse(text) as JsonRecord;
  if (typeof payload.access_token !== 'string' || payload.access_token.trim() === '') {
    throw new Error('mailbox_graph_delegated_token_refresh_response_invalid');
  }
  const expiresIn = Number(payload.expires_in ?? 3599);
  const refreshed: DelegatedGraphToken = {
    ...token,
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : token.refresh_token,
    expires_at_ms: Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 3599) * 1000,
    acquired_at: new Date().toISOString(),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(refreshed)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path);
  return refreshed.access_token;
}

async function resolveControlPlaneEntrypoint(siteRoot: string): Promise<string> {
  let cursor = resolve(siteRoot);
  const root = parse(cursor).root;
  while (true) {
    const packageRoot = join(cursor, 'node_modules', '@narada-core', 'control-plane');
    const manifestPath = join(packageRoot, 'package.json');
    const manifestBytes = await readFile(manifestPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifestBytes !== null) {
      const manifest = JSON.parse(manifestBytes) as unknown;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error(`mailbox_control_plane_manifest_invalid:${manifestPath}`);
      }
      const record = manifest as JsonRecord;
      const exportsRecord = record.exports && typeof record.exports === 'object' && !Array.isArray(record.exports)
        ? record.exports as JsonRecord
        : {};
      const dotExport = exportsRecord['.'] && typeof exportsRecord['.'] === 'object' && !Array.isArray(exportsRecord['.'])
        ? exportsRecord['.'] as JsonRecord
        : {};
      const relativeEntrypoint = typeof dotExport.import === 'string'
        ? dotExport.import
        : typeof record.module === 'string'
          ? record.module
          : typeof record.main === 'string'
            ? record.main
            : null;
      if (!relativeEntrypoint) throw new Error(`mailbox_control_plane_entrypoint_missing:${manifestPath}`);
      return resolve(packageRoot, relativeEntrypoint);
    }
    if (cursor === root) break;
    cursor = dirname(cursor);
  }
  throw new Error(`mailbox_control_plane_package_not_found:${siteRoot}`);
}

function validateRuntime(value: unknown): ControlPlaneRuntime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mailbox_control_plane_runtime_invalid');
  }
  const module = value as JsonRecord;
  const requiredFunctions = [
    'loadConfig',
    'buildGraphTokenProvider',
    'cleanupTmp',
    'evaluateMailFactAdmission',
    'normalizeFlagged',
    'normalizeFolderRef',
    'sourceRecordToFact',
  ];
  const requiredConstructors = [
    'GraphHttpClient',
    'DefaultGraphAdapter',
    'ExchangeSource',
    'DefaultProjector',
    'DefaultSyncRunner',
    'FileApplyLogStore',
    'FileCursorStore',
    'FileLock',
    'Database',
    'SqliteFactStore',
  ];
  for (const name of [...requiredFunctions, ...requiredConstructors]) {
    if (typeof module[name] !== 'function') throw new Error(`mailbox_control_plane_export_missing:${name}`);
  }
  return module as unknown as ControlPlaneRuntime;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 1000 ? value : value.slice(0, 1000);
}
