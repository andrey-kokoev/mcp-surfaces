import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export function runRipgrepLines(args, { operation, noMatchStatus }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-filesystem-rg-'));
  const stdoutPath = join(tempDir, 'stdout.txt');
  const stdoutFd = openSync(stdoutPath, 'w');
  try {
    const result = spawnSync('rg', args, {
      encoding: 'utf8',
      stdio: ['ignore', stdoutFd, 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    closeSync(stdoutFd);
    assertRipgrepOk(result, { operation, noMatchStatus });
    return splitLines(readFileSync(stdoutPath, 'utf8')).sort(comparePathText);
  } finally {
    try { closeSync(stdoutFd); } catch {}
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

function assertRipgrepOk(result, { operation, noMatchStatus }) {
  if (result.error) {
    throw new Error(`${operation}_failed: ${result.error.message}`);
  }
  if (result.status === 0 || result.status === noMatchStatus) return;
  throw new Error(`${operation}_failed: ${String(result.stderr || '').trim() || `status ${result.status}`}`);
}

function splitLines(value) {
  return String(value ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function comparePathText(left, right) {
  return normalizePathText(left).localeCompare(normalizePathText(right), 'en');
}

function normalizePathText(value) {
  return String(value ?? '').replace(/\\/g, '/').toLowerCase();
}
