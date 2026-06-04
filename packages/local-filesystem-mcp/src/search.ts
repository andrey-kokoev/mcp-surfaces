import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const RIPGREP_FIELD_SEPARATOR = '\u001f';
const SEARCH_HELPER_TIMEOUT_MS = 60_000;
const SEARCH_CACHE_MAX_ENTRIES = 8;
const completeSearchCache = new Map();

export function runRipgrepPage(args, { operation, noMatchStatus, offset, limit, diagnosticError }) {
  const cacheKey = searchCacheKey(args);
  const cached = completeSearchCache.get(cacheKey);
  if (cached) return pageFromComplete(cached, { offset, limit });
  const complete = offset > 0;
  const runnerPath = fileURLToPath(new URL('./search-runner.js', import.meta.url));
  const result = spawnSync(process.execPath, [runnerPath], {
    input: JSON.stringify({ args, offset: complete ? 0 : offset, limit, complete }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
    timeout: SEARCH_HELPER_TIMEOUT_MS,
  });
  if (result.error) {
    const timedOut = result.error.name === 'Error' && result.error.message.includes('ETIMEDOUT');
    throw diagnosticError(timedOut ? `${operation}_timed_out` : `${operation}_failed`, `${timedOut ? `${operation}_timed_out` : `${operation}_failed`}: ${result.error.message}`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: String(result.stderr ?? ''),
      error: result.error.message,
      timeout_ms: SEARCH_HELPER_TIMEOUT_MS,
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
    rememberCompleteSearch(cacheKey, page.matches);
    return pageFromComplete(page.matches, { offset, limit });
  }
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
  const pageMatches = matches.slice(offset, offset + limit);
  return {
    status: 0,
    signal: null,
    stderr: '',
    error: null,
    stopped_early: false,
    count: matches.length,
    count_exact: true,
    scanned: matches.length,
    has_more: offset + pageMatches.length < matches.length,
    cache_hit: true,
    matches: pageMatches,
  };
}

function rememberCompleteSearch(cacheKey, matches) {
  completeSearchCache.delete(cacheKey);
  completeSearchCache.set(cacheKey, matches);
  while (completeSearchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = completeSearchCache.keys().next().value;
    completeSearchCache.delete(oldestKey);
  }
}

function searchCacheKey(args) {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}
