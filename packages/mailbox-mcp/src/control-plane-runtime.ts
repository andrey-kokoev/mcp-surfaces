import { readFile } from 'node:fs/promises';
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
