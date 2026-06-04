import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const RIPGREP_FIELD_SEPARATOR = '\u001f';

export function runRipgrepPage(args, { operation, noMatchStatus, offset, limit, diagnosticError }) {
  const runnerPath = fileURLToPath(new URL('./search-runner.js', import.meta.url));
  const result = spawnSync(process.execPath, [runnerPath], {
    input: JSON.stringify({ args, offset, limit }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw diagnosticError(`${operation}_failed`, `${operation}_failed: ${result.error.message}`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: String(result.stderr ?? ''),
      error: result.error.message,
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
  const page = JSON.parse(result.stdout);
  assertRipgrepOk(page, { operation, noMatchStatus, diagnosticError });
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
