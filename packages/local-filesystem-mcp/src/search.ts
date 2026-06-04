import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const READ_BUFFER_BYTES = 64 * 1024;

export function runRipgrepPage(args, { operation, noMatchStatus, offset, limit, diagnosticError }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-filesystem-rg-'));
  const outputPath = join(tempDir, 'matches.txt');
  const outputFd = openSync(outputPath, 'w');
  try {
    const result = spawnSync('rg', args, {
      encoding: 'utf8',
      stdio: ['ignore', outputFd, 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    closeSync(outputFd);
    assertRipgrepOk(result, { operation, noMatchStatus, diagnosticError });
    return readLinePage(outputPath, { offset, limit });
  } finally {
    try { closeSync(outputFd); } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function grepMatchObject(match, mode) {
  if (mode === 'count_matches') {
    const countMatch = String(match).match(/^(.*):(\d+)$/);
    return {
      path: countMatch ? countMatch[1] : match,
      count: countMatch ? Number(countMatch[2]) : null,
      raw: match,
    };
  }
  if (mode === 'content') {
    const contentMatch = String(match).match(/^(.*):(\d+):(.*)$/);
    return {
      path: contentMatch ? contentMatch[1] : match,
      line: contentMatch ? Number(contentMatch[2]) : null,
      text: contentMatch ? contentMatch[3] : '',
      raw: match,
    };
  }
  return { path: match, raw: match };
}

function assertRipgrepOk(result, { operation, noMatchStatus, diagnosticError }) {
  if (result.error) {
    throw diagnosticError(`${operation}_failed`, `${operation}_failed: ${result.error.message}`, {
      operation,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: String(result.stderr ?? ''),
      error: result.error.message,
    });
  }
  if (result.status === 0 || result.status === noMatchStatus) return;
  throw diagnosticError(`${operation}_failed`, `${operation}_failed: ${String(result.stderr || '').trim() || `status ${result.status}`}`, {
    operation,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stderr: String(result.stderr ?? ''),
  });
}

function readLinePage(path, { offset, limit }) {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const matches = [];
  let count = 0;
  let pending = '';
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = pending + buffer.toString('utf8', 0, bytesRead);
      const lines = chunk.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (count >= offset && matches.length < limit) matches.push(line);
        count += 1;
      }
    }
    if (pending.trim()) {
      if (count >= offset && matches.length < limit) matches.push(pending);
      count += 1;
    }
    return { matches, count };
  } finally {
    closeSync(fd);
  }
}
