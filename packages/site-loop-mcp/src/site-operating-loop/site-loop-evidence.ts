import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  requireSiteLoopConfig,
  type SiteLoopConfig,
} from '../site-loop/site-loop-config.js';

export const SITE_LOOP_EVIDENCE_SCHEMA = 'narada.site_loop.evidence.v1';
export const SITE_LOOP_EVIDENCE_REF_PREFIX = 'site_loop_evidence:';

export type SiteLoopEvidenceRef = {
  ref: string;
  sha256: string;
  relative_path: string;
  compressed_bytes: number;
};

export type SiteLoopEvidenceStore = {
  siteRoot: string;
  root: string;
  persistenceSchema: string;
  rawRetentionDays: number;
  summaryRetentionDays: number;
  inlineSummaryBytes: number;
};

export class SiteLoopEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteLoopEvidenceError';
  }
}

export function removeSiteLoopEvidence(store: SiteLoopEvidenceStore | null, ref: unknown): void {
  if (!store || typeof ref !== 'string' || ref.length === 0) return;
  const sha256 = parseEvidenceRef(ref);
  const absolutePath = resolve(store.root, sha256.slice(0, 2), `${sha256}.json.gz`);
  try {
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
  } catch {
    // Retention maintenance remains the final orphan cleanup path.
  }
}

export type SiteLoopEvidencePruneOptions = {
  maxFiles?: number;
  cursor?: string | null;
};

export function pruneSiteLoopEvidence(
  store: SiteLoopEvidenceStore,
  now = new Date(),
  { maxFiles = 5000, cursor = null }: SiteLoopEvidencePruneOptions = {},
): { deleted_count: number; scanned_count: number; complete: boolean; next_cursor: string | null } {
  if (!existsSync(store.root)) return { deleted_count: 0, scanned_count: 0, complete: true, next_cursor: null };
  const cutoff = now.getTime() - store.rawRetentionDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  let scannedCount = 0;
  let lastCursor = cursor;
  let stopped = false;
  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (stopped) return;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.name.endsWith('.json.gz') && !entry.name.endsWith('.tmp')) continue;
      const relativePath = relative(store.root, absolutePath).replaceAll('\\', '/');
      if (cursor && relativePath <= cursor) continue;
      if (scannedCount >= Math.max(1, Math.floor(maxFiles))) {
        stopped = true;
        return;
      }
      scannedCount += 1;
      lastCursor = relativePath;
      try {
        if (statSync(absolutePath).mtimeMs < cutoff) {
          unlinkSync(absolutePath);
          deletedCount += 1;
        }
      } catch {
        // Concurrent writers or already-removed artifacts are harmless.
      }
    }
  };
  visit(store.root);
  return {
    deleted_count: deletedCount,
    scanned_count: scannedCount,
    complete: !stopped,
    next_cursor: stopped ? lastCursor : null,
  };
}

export function createSiteLoopEvidenceStore(siteRoot: string, config?: SiteLoopConfig): SiteLoopEvidenceStore {
  const resolvedSiteRoot = resolve(siteRoot);
  const siteLoopConfig = config ?? requireSiteLoopConfig(resolvedSiteRoot);
  const persistence = siteLoopConfig.persistence;
  const configuredRoot = String(persistence.evidence_root);
  if (isAbsolute(configuredRoot)) {
    throw new SiteLoopEvidenceError('site_loop_evidence_root_must_be_relative');
  }
  const root = resolve(resolvedSiteRoot, configuredRoot);
  const siteRelative = relative(resolvedSiteRoot, root);
  if (siteRelative === '..' || siteRelative.startsWith(`..${'\\'}`) || isAbsolute(siteRelative)) {
    throw new SiteLoopEvidenceError('site_loop_evidence_root_escapes_site_root');
  }
  return {
    siteRoot: resolvedSiteRoot,
    root,
    persistenceSchema: String(persistence.schema),
    rawRetentionDays: Number(persistence.raw_retention_days),
    summaryRetentionDays: Number(persistence.summary_retention_days),
    inlineSummaryBytes: Number(persistence.inline_summary_bytes),
  };
}

export function siteLoopEvidenceStoreFromDb(db: any): SiteLoopEvidenceStore | null {
  try {
    const rows: any[] = db.prepare('PRAGMA database_list').all();
    const main = rows.find((row: any) => String(row.name ?? '') === 'main') ?? rows[0];
    const dbPath = String(main?.file ?? '');
    if (!dbPath || dbPath === ':memory:') return null;
    return createSiteLoopEvidenceStore(dirname(dirname(dbPath)));
  } catch {
    return null;
  }
}

export function writeSiteLoopEvidence(
  store: SiteLoopEvidenceStore,
  kind: string,
  value: unknown,
  metadata: Record<string, unknown> = {},
): SiteLoopEvidenceRef {
  const envelope = {
    schema: SITE_LOOP_EVIDENCE_SCHEMA,
    kind,
    metadata: canonicalize(metadata),
    value,
  };
  const json = canonicalJson(envelope);
  const sha256 = createHash('sha256').update(json).digest('hex');
  const relativePath = join(sha256.slice(0, 2), `${sha256}.json.gz`);
  const absolutePath = resolve(store.root, relativePath);
  const directory = dirname(absolutePath);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(absolutePath)) {
    const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
    const temporaryPath = join(directory, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, compressed, { flag: 'wx' });
      try {
        renameSync(temporaryPath, absolutePath);
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        rmSync(temporaryPath, { force: true });
      }
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  return {
    ref: `${SITE_LOOP_EVIDENCE_REF_PREFIX}${sha256}`,
    sha256,
    relative_path: relativePath.replaceAll('\\', '/'),
    compressed_bytes: statSync(absolutePath).size,
  };
}

export function readSiteLoopEvidence(store: SiteLoopEvidenceStore, ref: string): unknown {
  const sha256 = parseEvidenceRef(ref);
  const absolutePath = resolve(store.root, sha256.slice(0, 2), `${sha256}.json.gz`);
  if (!existsSync(absolutePath)) {
    throw new SiteLoopEvidenceError(`site_loop_evidence_unavailable:${ref}`);
  }
  let json: string;
  try {
    json = gunzipSync(readFileSync(absolutePath)).toString('utf8');
  } catch {
    throw new SiteLoopEvidenceError(`site_loop_evidence_corrupt:${ref}`);
  }
  const actualSha256 = createHash('sha256').update(json).digest('hex');
  if (actualSha256 !== sha256) {
    throw new SiteLoopEvidenceError(`site_loop_evidence_digest_mismatch:${ref}`);
  }
  let envelope: any;
  try {
    envelope = JSON.parse(json);
  } catch {
    throw new SiteLoopEvidenceError(`site_loop_evidence_corrupt:${ref}`);
  }
  if (envelope?.schema !== SITE_LOOP_EVIDENCE_SCHEMA) {
    throw new SiteLoopEvidenceError(`site_loop_evidence_schema_mismatch:${ref}`);
  }
  return envelope.value;
}

export function readSiteLoopEvidenceIfAvailable(store: SiteLoopEvidenceStore | null, ref: unknown): unknown | null {
  if (!store || typeof ref !== 'string' || ref.length === 0) return null;
  try {
    return readSiteLoopEvidence(store, ref);
  } catch {
    return null;
  }
}

export function recordSiteLoopPayload(
  store: any,
  kind: string,
  value: unknown,
  metadata: Record<string, unknown> = {},
  { forceEvidence = false }: { forceEvidence?: boolean } = {},
): { summary: unknown; evidence: SiteLoopEvidenceRef | null } {
  if (value === null || value === undefined) return { summary: null, evidence: null };
  const evidenceStore = evidenceStoreForStore(store);
  const inlineSummaryBytes = evidenceStore?.inlineSummaryBytes ?? 16_384;
  const oversized = Buffer.byteLength(canonicalJson(value), 'utf8') > inlineSummaryBytes;
  if ((forceEvidence || oversized) && !evidenceStore) {
    throw new SiteLoopEvidenceError(`site_loop_evidence_store_unavailable:${kind}`);
  }
  const evidence = (forceEvidence || oversized) && evidenceStore
    ? writeSiteLoopEvidence(evidenceStore, kind, value, metadata)
    : null;
  return {
    summary: boundedSiteLoopSummary(value, evidence?.ref ?? null, inlineSummaryBytes),
    evidence,
  };
}

export function boundedSiteLoopSummary(value: unknown, evidenceRef: string | null = null, maxBytes = 16_384): unknown {
  const maximumBytes = Math.max(1024, Math.floor(Number(maxBytes) || 16_384));
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, 'utf8') <= maximumBytes) return value;
  const summary: any = {
    schema: 'narada.site_loop.evidence_summary.v1',
    value_type: Array.isArray(value) ? 'array' : typeof value,
    char_length: json.length,
    byte_length: Buffer.byteLength(json, 'utf8'),
    evidence_ref: evidenceRef,
    truncated: true,
  };
  if (Array.isArray(value)) {
    summary.count = value.length;
    summary.sample = value.slice(0, 5).map((item: unknown) => boundedSmallValue(item));
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    summary.keys = Object.keys(record).sort();
    summary.fields = importantFields(record);
  } else {
    summary.value = boundedSmallValue(value);
  }
  return shrinkSummary(summary, maximumBytes);
}

function shrinkSummary(summary: any, maximumBytes: number): any {
  if (Buffer.byteLength(canonicalJson(summary), 'utf8') <= maximumBytes) return summary;
  if (Array.isArray(summary.keys)) {
    summary.keys = summary.keys.slice(0, 128);
    summary.keys_truncated = true;
  }
  if (Array.isArray(summary.sample)) {
    summary.sample = summary.sample.slice(0, 2);
    summary.sample_truncated = true;
  }
  if (Buffer.byteLength(canonicalJson(summary), 'utf8') <= maximumBytes) return summary;
  return {
    schema: summary.schema,
    value_type: summary.value_type,
    char_length: summary.char_length,
    byte_length: summary.byte_length,
    evidence_ref: summary.evidence_ref,
    truncated: true,
  };
}

function evidenceStoreForStore(store: any): SiteLoopEvidenceStore | null {
  if (store?.evidenceStore) return store.evidenceStore;
  if (store?.evidence) return store.evidence;
  return siteLoopEvidenceStoreFromDb(store?.db);
}

function parseEvidenceRef(ref: string): string {
  if (!ref.startsWith(SITE_LOOP_EVIDENCE_REF_PREFIX)) {
    throw new SiteLoopEvidenceError(`site_loop_evidence_ref_invalid:${ref}`);
  }
  const sha256 = ref.slice(SITE_LOOP_EVIDENCE_REF_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new SiteLoopEvidenceError(`site_loop_evidence_ref_invalid:${ref}`);
  }
  return sha256;
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  return encoded === undefined ? 'null' : encoded;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

function boundedSmallValue(value: unknown): unknown {
  const json = canonicalJson(value);
  if (json.length <= 240) return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return importantFields(value as Record<string, unknown>);
  }
  return { value_type: Array.isArray(value) ? 'array' : typeof value, char_length: json.length };
}

function importantFields(record: Record<string, unknown>): Record<string, unknown> {
  const names = [
    'status', 'state', 'decision', 'reason', 'code', 'error', 'message', 'severity',
    'evaluated', 'evaluated_count', 'materialized', 'materialized_count',
    'duplicates', 'duplicate_count', 'errors', 'error_count', 'emitted_count',
    'dispatched_count', 'pending_count', 'skipped_count', 'receipt_count',
    'directive_id', 'task_id', 'report_id', 'run_id',
  ];
  const output: Record<string, unknown> = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) output[name] = boundedScalar(record[name]);
  }
  return output;
}

function boundedScalar(value: unknown): unknown {
  if (typeof value === 'string') return value.length <= 240 ? value : `${value.slice(0, 240)}...`;
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return { value_type: 'array', count: value.length };
  if (typeof value === 'object') return { value_type: 'object', keys: Object.keys(value as Record<string, unknown>).sort() };
  return String(value);
}
