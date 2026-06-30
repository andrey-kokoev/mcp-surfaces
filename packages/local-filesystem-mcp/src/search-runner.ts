#!/usr/bin/env node
import { spawn } from 'node:child_process';

const STDERR_LIMIT = 64 * 1024;
const PAGE_MATCH_BYTES_LIMIT = 512 * 1024;
const SINGLE_MATCH_BYTES_LIMIT = 16 * 1024;

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

async function run() {
  const input = JSON.parse(await readStdin());
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const offset = Math.max(0, Number(input.offset ?? 0));
  const limit = Math.max(1, Number(input.limit ?? 1));
  const complete = input.complete === true;
  const maxMatchBytes = Math.max(1, Number(input.max_match_bytes ?? 2 * 1024 * 1024));
  const timeoutMs = Math.min(300_000, Math.max(1, Number(input.timeout_ms ?? 60_000)));
  const testDelayMs = Math.max(0, Number(process.env.NARADA_LOCAL_FILESYSTEM_SEARCH_RUNNER_DELAY_MS ?? 0));
  if (testDelayMs > 0) await delay(testDelayMs);
  const result = await collectRipgrepPage(args, { offset, limit, complete, maxMatchBytes, timeoutMs });
  process.stdout.write(JSON.stringify(result));
}

function collectRipgrepPage(args: string[], { offset, limit, complete, maxMatchBytes, timeoutMs }: { offset: number; limit: number; complete: boolean; maxMatchBytes: number; timeoutMs: number }) {
  return new Promise((resolvePromise) => {
    let resolved = false;
    const child = spawn('rg', args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const matches = [];
    const pageMatches = [];
    let seen = 0;
    let pending = '';
    let stderr = '';
    let stoppedEarly = false;
    let completeMemoryExceeded = false;
    let matchBytes = 0;
    let pageMatchBytes = 0;
    let pageMatchesTruncated = 0;
    let childError = null;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      stoppedEarly = true;
      child.kill();
      finish({ status: null, signal: null });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
        if (stoppedEarly) break;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = truncate(`${stderr}${chunk}`, STDERR_LIMIT);
    });
    child.on('error', (error) => {
      childError = error;
      finish({ status: null, signal: null });
    });
    child.on('close', (status, signal) => {
      finish({ status, signal });
    });

    function finish({ status, signal }: { status: number | null; signal: NodeJS.Signals | null }) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (pending.trim() && !stoppedEarly) consumeLine(pending);
      const countExact = !stoppedEarly && !completeMemoryExceeded;
      const outputMatches = complete && !completeMemoryExceeded ? matches : pageMatches.slice(0, limit);
      const hasMore = pageMatches.length > limit || (stoppedEarly && seen >= offset) || (completeMemoryExceeded && stoppedEarly);
      resolvePromise({
        status,
        signal,
        stderr,
        error: timedOut ? 'ETIMEDOUT' : childError ? childError.message : null,
        timed_out: timedOut,
        stopped_early: stoppedEarly,
        page_match_bytes: pageMatchBytes,
        page_match_bytes_limit: PAGE_MATCH_BYTES_LIMIT,
        page_matches_truncated: pageMatchesTruncated,
        count: countExact ? seen : null,
        count_exact: countExact,
        scanned: seen,
        scanned_unit: 'matched_entries',
        has_more: hasMore,
        matches: outputMatches,
      });
    }

    function consumeLine(line: string) {
      if (!line.trim()) return;
      if (seen >= offset && pageMatches.length <= limit) {
        const boundedLine = truncateUtf8(line, SINGLE_MATCH_BYTES_LIMIT);
        if (boundedLine !== line) pageMatchesTruncated += 1;
        const boundedLineBytes = Buffer.byteLength(boundedLine, 'utf8');
        if (pageMatchBytes + boundedLineBytes > PAGE_MATCH_BYTES_LIMIT) {
          stoppedEarly = true;
          child.kill();
        } else {
          pageMatchBytes += boundedLineBytes;
          pageMatches.push(boundedLine);
        }
      }
      if (complete && !completeMemoryExceeded) {
        matchBytes += Buffer.byteLength(line, 'utf8');
        if (matchBytes > maxMatchBytes) {
          completeMemoryExceeded = true;
          matches.length = 0;
        }
      }
      if (complete && !completeMemoryExceeded) {
        matches.push(line);
      }
      seen += 1;
      if ((!complete || completeMemoryExceeded) && pageMatches.length > limit && !stoppedEarly) {
        stoppedEarly = true;
        child.kill();
      }
    }
  });
}

function readStdin() {
  return new Promise<string>((resolvePromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
  });
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return `${value.slice(0, end)}...[truncated]`;
}
