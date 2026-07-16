import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const RIPGREP_FIELD_SEPARATOR = '\u001f';
const SEARCH_HELPER_TIMEOUT_MS = 60_000;
const SEARCH_CACHE_MAX_ENTRIES = 8;
const SEARCH_CACHE_MAX_MATCH_BYTES = 2 * 1024 * 1024;
const completeSearchCache = new Map();
const completeSearchCacheBySnapshotId = new Map();

export function runRipgrepPage(args, { operation, noMatchStatus, offset, limit, timeoutMs, freshness, cachePolicy = 'auto', snapshotId = null, diagnosticError, env = undefined }) {
  const effectiveTimeoutMs = clampTimeout(timeoutMs);
  const cacheKey = searchCacheKey({ args, freshness });
  if (snapshotId) {
    const snapshot = completeSearchCacheBySnapshotId.get(snapshotId);
    if (!snapshot || snapshot.cacheKey !== cacheKey) {
      throw diagnosticError(`${operation}_snapshot_not_found`, `${operation}_snapshot_not_found: ${snapshotId}`, {
        operation,
        snapshot_id: snapshotId,
        cache_policy: cachePolicy,
      });
    }
    return pageFromComplete(snapshot, { offset, limit, cachePolicy, requestedSnapshotId: snapshotId });
  }
  if (cachePolicy !== 'bypass' && cachePolicy !== 'refresh') {
    const cached = completeSearchCache.get(cacheKey);
    if (cached) return pageFromComplete(cached, { offset, limit, cachePolicy });
  }
  const complete = cachePolicy === 'snapshot' || cachePolicy === 'refresh';
  const runnerPath = fileURLToPath(new URL('./search-runner.js', import.meta.url));
  const result = spawnSync(process.execPath, [runnerPath], {
    input: JSON.stringify({ args, offset, limit, complete, max_match_bytes: SEARCH_CACHE_MAX_MATCH_BYTES, timeout_ms: effectiveTimeoutMs }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
    timeout: effectiveTimeoutMs,
    env,
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
      ...(timedOut ? timeoutDiagnostics({ operation, args, offset, limit, complete, cachePolicy, snapshotId }) : {}),
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
  if (page.timed_out) {
    throw diagnosticError(`${operation}_timed_out`, `${operation}_timed_out: ${page.error ?? 'ETIMEDOUT'}`, {
      operation,
      status: page.status ?? null,
      signal: page.signal ?? null,
      stderr: String(page.stderr ?? ''),
      error: page.error ?? 'ETIMEDOUT',
      timeout_ms: effectiveTimeoutMs,
      ...timeoutDiagnostics({ operation, args, offset, limit, complete, cachePolicy, snapshotId }),
    });
  }
  assertRipgrepOk(page, { operation, noMatchStatus, diagnosticError });
  if (page.count_exact) {
    if (cachePolicy !== 'bypass') rememberCompleteSearch(cacheKey, page.matches, { freshness, timeoutMs: effectiveTimeoutMs });
    const cachedComplete = completeSearchCache.get(cacheKey);
    if (cachedComplete && cachePolicy !== 'bypass') return pageFromComplete(cachedComplete, { offset, limit, cachePolicy, cacheHit: cachePolicy !== 'refresh' });
    const pageMatches = page.matches.slice(offset, offset + limit);
    return {
      ...page,
      matches: pageMatches,
      has_more: offset + pageMatches.length < page.matches.length,
      snapshot_id: null,
      snapshot_complete: true,
      cache_hit: false,
      cache_policy: cachePolicy,
      cache_memory_bytes: estimateMatchesBytes(page.matches),
      timeout_ms: effectiveTimeoutMs,
    };
  }
  page.timeout_ms = effectiveTimeoutMs;
  page.snapshot_id = null;
  page.snapshot_complete = false;
  page.cache_memory_bytes = null;
  page.cache_policy = cachePolicy;
  return page;
}

export async function runRipgrepPageAsync(args, { operation, noMatchStatus, offset, limit, timeoutMs, freshness, cachePolicy = 'auto', snapshotId = null, diagnosticError, abortSignal = null, env = undefined }) {
  const effectiveTimeoutMs = clampTimeout(timeoutMs);
  const cacheKey = searchCacheKey({ args, freshness });
  if (snapshotId) {
    const snapshot = completeSearchCacheBySnapshotId.get(snapshotId);
    if (!snapshot || snapshot.cacheKey !== cacheKey) {
      throw diagnosticError(`${operation}_snapshot_not_found`, `${operation}_snapshot_not_found: ${snapshotId}`, {
        operation,
        snapshot_id: snapshotId,
        cache_policy: cachePolicy,
      });
    }
    return pageFromComplete(snapshot, { offset, limit, cachePolicy, requestedSnapshotId: snapshotId });
  }
  if (cachePolicy !== 'bypass' && cachePolicy !== 'refresh') {
    const cached = completeSearchCache.get(cacheKey);
    if (cached) return pageFromComplete(cached, { offset, limit, cachePolicy });
  }
  const complete = cachePolicy === 'snapshot' || cachePolicy === 'refresh';
  const runnerPath = fileURLToPath(new URL('./search-runner.js', import.meta.url));
  const result = await runSearchHelper(process.execPath, [runnerPath], {
    input: JSON.stringify({ args, offset, limit, complete, max_match_bytes: SEARCH_CACHE_MAX_MATCH_BYTES, timeout_ms: effectiveTimeoutMs }),
    timeoutMs: effectiveTimeoutMs,
    abortSignal,
    env,
  });
  if (result.error) {
    throw diagnosticError(result.cancelled ? `${operation}_cancelled` : result.timedOut ? `${operation}_timed_out` : `${operation}_failed`, `${result.cancelled ? `${operation}_cancelled` : result.timedOut ? `${operation}_timed_out` : `${operation}_failed`}: ${result.error}`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: result.stderr,
      error: result.error,
      timeout_ms: effectiveTimeoutMs,
      cancelled: result.cancelled,
      ...(result.timedOut ? timeoutDiagnostics({ operation, args, offset, limit, complete, cachePolicy, snapshotId }) : {}),
    });
  }
  if (result.status !== 0) {
    throw diagnosticError(`${operation}_failed`, `${operation}_failed: ${String(result.stderr || '').trim() || `status ${result.status}`}`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: result.stderr,
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
      stderr: result.stderr,
      output_preview: result.stdout.slice(0, 500),
      parse_error: error instanceof Error ? error.message : String(error),
    });
  }
  if (page.timed_out) {
    throw diagnosticError(`${operation}_timed_out`, `${operation}_timed_out: ${page.error ?? 'ETIMEDOUT'}`, {
      operation,
      status: page.status ?? null,
      signal: page.signal ?? null,
      stderr: String(page.stderr ?? ''),
      error: page.error ?? 'ETIMEDOUT',
      timeout_ms: effectiveTimeoutMs,
      ...timeoutDiagnostics({ operation, args, offset, limit, complete, cachePolicy, snapshotId }),
    });
  }
  assertRipgrepOk(page, { operation, noMatchStatus, diagnosticError });
  if (page.count_exact) {
    if (cachePolicy !== 'bypass') rememberCompleteSearch(cacheKey, page.matches, { freshness, timeoutMs: effectiveTimeoutMs });
    const cachedComplete = completeSearchCache.get(cacheKey);
    if (cachedComplete && cachePolicy !== 'bypass') return pageFromComplete(cachedComplete, { offset, limit, cachePolicy, cacheHit: cachePolicy !== 'refresh' });
    const pageMatches = page.matches.slice(offset, offset + limit);
    return {
      ...page,
      matches: pageMatches,
      has_more: offset + pageMatches.length < page.matches.length,
      snapshot_id: null,
      snapshot_complete: true,
      cache_hit: false,
      cache_policy: cachePolicy,
      cache_memory_bytes: estimateMatchesBytes(page.matches),
      timeout_ms: effectiveTimeoutMs,
    };
  }
  page.timeout_ms = effectiveTimeoutMs;
  page.snapshot_id = null;
  page.snapshot_complete = false;
  page.cache_memory_bytes = null;
  page.cache_policy = cachePolicy;
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

function pageFromComplete(matches, { offset, limit, cachePolicy = 'auto', requestedSnapshotId = null, cacheHit = true }) {
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
    scanned_unit: 'matched_entries',
    has_more: offset + pageMatches.length < record.matches.length,
    cache_hit: cacheHit,
    cache_policy: cachePolicy,
    snapshot_id: record.snapshotId,
    requested_snapshot_id: requestedSnapshotId,
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
  const previous = completeSearchCache.get(cacheKey);
  if (previous?.snapshotId) completeSearchCacheBySnapshotId.delete(previous.snapshotId);
  completeSearchCache.delete(cacheKey);
  const record = {
    cacheKey,
    matches,
    memoryBytes,
    freshness,
    timeoutMs,
    snapshotId: createHash('sha256').update(`${cacheKey}:${matches.length}:${memoryBytes}`).digest('hex').slice(0, 24),
  };
  completeSearchCache.set(cacheKey, record);
  completeSearchCacheBySnapshotId.set(record.snapshotId, record);
  while (completeSearchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = completeSearchCache.keys().next().value;
    const oldest = completeSearchCache.get(oldestKey);
    completeSearchCache.delete(oldestKey);
    if (oldest?.snapshotId) completeSearchCacheBySnapshotId.delete(oldest.snapshotId);
  }
}

function runSearchHelper(command, args, { input, timeoutMs, abortSignal, env }): Promise<any> {
  return new Promise((resolvePromise) => {
    if (abortSignal?.aborted) {
      resolvePromise({ status: null, signal: null, stdout: '', stderr: '', error: 'cancelled', timedOut: false, cancelled: true });
      return;
    }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', abortHandler);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      settle({ status: null, signal: null, stdout, stderr, error: 'ETIMEDOUT', timedOut, cancelled });
    }, timeoutMs);
    const abortHandler = () => {
      cancelled = true;
      child.kill();
      settle({ status: null, signal: null, stdout, stderr, error: 'cancelled', timedOut, cancelled });
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > 1024 * 1024) {
        child.kill();
        settle({ status: null, signal: null, stdout: stdout.slice(0, 1024 * 1024), stderr, error: 'maxBuffer exceeded', timedOut, cancelled });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, 'utf8') > 1024 * 1024) {
        child.kill();
        settle({ status: null, signal: null, stdout, stderr: stderr.slice(0, 1024 * 1024), error: 'maxBuffer exceeded', timedOut, cancelled });
      }
    });
    child.on('error', (error) => {
      settle({ status: null, signal: null, stdout, stderr, error: error.message, timedOut, cancelled });
    });
    child.on('close', (code, signal) => {
      settle({ status: code, signal, stdout, stderr, error: null, timedOut, cancelled });
    });
    child.stdin.end(input, 'utf8');
  });
}

function searchCacheKey(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function estimateMatchesBytes(matches) {
  return matches.reduce((sum, match) => sum + Buffer.byteLength(String(match), 'utf8'), 0);
}

function timeoutDiagnostics({ operation, args, offset, limit, complete, cachePolicy, snapshotId }) {
  return {
    timeout_kind: 'search_helper_timeout',
    partial_results_returned: false,
    continuation_available: false,
    complete_snapshot_required: complete,
    requested_offset: offset,
    requested_limit: limit,
    requested_cache_policy: cachePolicy,
    requested_snapshot_id: snapshotId,
    search_scope: searchScopeFromArgs(operation, args),
    remediation: [
      'Narrow the directory/path to a package or subdirectory before broad glob/grep searches.',
      'Use a more selective pattern and lower limit for the first page.',
      'Use cache_policy=snapshot or cache_policy=refresh on a scoped search to materialize a reusable complete snapshot, then continue with snapshot_id and offset.',
      'Use cache_policy=bypass when a stale or expensive complete cache rebuild is not needed.',
      'Increase timeout_ms only after narrowing scope and pattern.',
    ],
  };
}

function searchScopeFromArgs(operation, args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  if (operation === 'fs_glob_search') return args.at(-1) ?? null;
  if (operation === 'fs_grep_search') {
    const modeFlags = new Set(['-n', '-c', '-l']);
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const value = args[index];
      if (!modeFlags.has(value)) return value;
    }
  }
  return null;
}

function clampTimeout(value) {
  if (!Number.isInteger(value)) return SEARCH_HELPER_TIMEOUT_MS;
  return Math.min(300_000, Math.max(1, value));
}
