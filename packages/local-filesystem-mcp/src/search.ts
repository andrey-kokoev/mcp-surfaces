import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const RIPGREP_FIELD_SEPARATOR = '\u001f';
const SEARCH_HELPER_TIMEOUT_MS = 60_000;
const SEARCH_CACHE_MAX_ENTRIES = 8;
const SEARCH_CACHE_MAX_MATCH_BYTES = 2 * 1024 * 1024;
const completeSearchCache = new Map();

export function runRipgrepPage(args, { operation, noMatchStatus, offset, limit, timeoutMs, freshness, diagnosticError }) {
  const effectiveTimeoutMs = clampTimeout(timeoutMs);
  const cacheKey = searchCacheKey({ args, freshness });
  const cached = completeSearchCache.get(cacheKey);
  if (cached) return pageFromComplete(cached, { offset, limit });
  const complete = offset > 0;
  const runnerPath = fileURLToPath(new URL('./search-runner.js', import.meta.url));
  const result = spawnSync(process.execPath, [runnerPath], {
    input: JSON.stringify({ args, offset, limit, complete, max_match_bytes: SEARCH_CACHE_MAX_MATCH_BYTES }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
    timeout: effectiveTimeoutMs,
  });
  if (result.error) {
    const timedOut = result.error.name === 'Error' && result.error.message.includes('ETIMEDOUT');
    throw diagnosticError(timedOut ? `${operation}_timed_out` : `${operation}_failed`, `${timedOut ? `${operation}_timed_out` : `${operation}_failed`}: ${result.error.message}`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: String(result.stderr ?? ''),
      error: result.error.message,
      timeout_ms: effectiveTimeoutMs,
    });
  }
  if (result.status !== 0) {
    throw diagnosticError(`${operation}_failed`, `${operation}_failed: ${String(result.stderr || '').trim() || `status ${result.status}`}`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: String(result.stderr ?? ''),
    });
  }
  let page;
  try {
    page = JSON.parse(result.stdout);
  } catch (error) {
    throw diagnosticError(`${operation}_invalid_helper_output`, `${operation}_invalid_helper_output`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: String(result.stderr ?? ''),
      output_preview: String(result.stdout ?? '').slice(0, 500),
      parse_error: error instanceof Error ? error.message : String(error),
    });
  }
  assertRipgrepOk(page, { operation, noMatchStatus, diagnosticError });
  if (page.count_exact) {
    rememberCompleteSearch(cacheKey, page.matches, { freshness, timeoutMs: effectiveTimeoutMs });
    const cachedComplete = completeSearchCache.get(cacheKey);
    if (cachedComplete) return pageFromComplete(cachedComplete, { offset, limit });
    const pageMatches = page.matches.slice(offset, offset + limit);
    return {
      ...page,
      matches: pageMatches,
      has_more: offset + pageMatches.length < page.matches.length,
      snapshot_id: null,
      snapshot_complete: true,
      cache_hit: false,
      cache_memory_bytes: estimateMatchesBytes(page.matches),
      timeout_ms: effectiveTimeoutMs,
    };
  }
  page.timeout_ms = effectiveTimeoutMs;
  page.snapshot_id = null;
  page.snapshot_complete = false;
  page.cache_memory_bytes = null;
  return page;
}

export function grepMatchObject(match, mode) {
  if (mode === 'count_matches') {
    const countMatch = splitRipgrepFields(match, 2) ?? splitTrailingCount(match);
    return {
      path: countMatch ? countMatch[0] : match,
      count: countMatch ? Number(countMatch[1]) : null,
      raw: match,
    };
  }
  if (mode === 'content') {
    const contentMatch = splitRipgrepFields(match, 3);
    return {
      path: contentMatch ? contentMatch[0] : match,
      line: contentMatch ? Number(contentMatch[1]) : null,
      text: contentMatch ? contentMatch[2] : '',
      raw: match,
    };
  }
  return { path: match, raw: match };
}

function assertRipgrepOk(result, { operation, noMatchStatus, diagnosticError }) {
  if (result.error) {
    throw diagnosticError(`${operation}_failed`, `${operation}_failed: ${result.error}`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: String(result.stderr ?? ''),
      error: result.error,
    });
  }
  if (result.stopped_early || result.status === 0 || result.status === noMatchStatus) return;
  throw diagnosticError(`${operation}_failed`, `${operation}_failed: ${String(result.stderr || '').trim() || `status ${result.status}`}`, {
    operation,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stderr: String(result.stderr ?? ''),
  });
}

function splitRipgrepFields(match, fieldCount) {
  const fields = String(match).split(RIPGREP_FIELD_SEPARATOR);
  return fields.length >= fieldCount ? [...fields.slice(0, fieldCount - 1), fields.slice(fieldCount - 1).join(RIPGREP_FIELD_SEPARATOR)] : null;
}

function splitTrailingCount(match) {
  const value = String(match);
  const separatorIndex = value.lastIndexOf(':');
  if (separatorIndex < 0) return null;
  const countText = value.slice(separatorIndex + 1);
  return /^\d+$/.test(countText) ? [value.slice(0, separatorIndex), countText] : null;
}

function pageFromComplete(matches, { offset, limit }) {
  const record = Array.isArray(matches) ? { matches, memoryBytes: estimateMatchesBytes(matches), snapshotId: null, freshness: null, timeoutMs: SEARCH_HELPER_TIMEOUT_MS } : matches;
  const pageMatches = record.matches.slice(offset, offset + limit);
  return {
    status: 0,
    signal: null,
    stderr: '',
    error: null,
    stopped_early: false,
    count: record.matches.length,
    count_exact: true,
    scanned: record.matches.length,
    has_more: offset + pageMatches.length < record.matches.length,
    cache_hit: true,
    snapshot_id: record.snapshotId,
    snapshot_complete: true,
    cache_memory_bytes: record.memoryBytes,
    freshness: record.freshness,
    timeout_ms: record.timeoutMs,
    matches: pageMatches,
  };
}

function rememberCompleteSearch(cacheKey, matches, { freshness, timeoutMs }) {
  const memoryBytes = estimateMatchesBytes(matches);
  if (memoryBytes > SEARCH_CACHE_MAX_MATCH_BYTES) return;
  completeSearchCache.delete(cacheKey);
  completeSearchCache.set(cacheKey, {
    matches,
    memoryBytes,
    freshness,
    timeoutMs,
    snapshotId: createHash('sha256').update(`${cacheKey}:${matches.length}:${memoryBytes}`).digest('hex').slice(0, 24),
  });
  while (completeSearchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = completeSearchCache.keys().next().value;
    completeSearchCache.delete(oldestKey);
  }
}

function searchCacheKey(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function estimateMatchesBytes(matches) {
  return matches.reduce((sum, match) => sum + Buffer.byteLength(String(match), 'utf8'), 0);
}

function clampTimeout(value) {
  if (!Number.isInteger(value)) return SEARCH_HELPER_TIMEOUT_MS;
  return Math.min(300_000, Math.max(1, value));
}
