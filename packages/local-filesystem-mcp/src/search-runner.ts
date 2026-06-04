#!/usr/bin/env node
import { spawn } from 'node:child_process';

const STDERR_LIMIT = 64 * 1024;

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

async function run() {
  const input = JSON.parse(await readStdin());
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const offset = Math.max(0, Number(input.offset ?? 0));
  const limit = Math.max(1, Number(input.limit ?? 1));
  const result = await collectRipgrepPage(args, { offset, limit });
  process.stdout.write(JSON.stringify(result));
}

function collectRipgrepPage(args: string[], { offset, limit }: { offset: number; limit: number }) {
  return new Promise((resolvePromise) => {
    const child = spawn('rg', args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const matches = [];
    let seen = 0;
    let pending = '';
    let stderr = '';
    let stoppedEarly = false;
    let childError = null;

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
    });
    child.on('close', (status, signal) => {
      if (pending.trim() && !stoppedEarly) consumeLine(pending);
      const hasMore = matches.length > limit;
      resolvePromise({
        status,
        signal,
        stderr,
        error: childError ? childError.message : null,
        stopped_early: stoppedEarly,
        count: stoppedEarly ? null : seen,
        count_exact: !stoppedEarly,
        scanned: seen,
        has_more: hasMore,
        matches: matches.slice(0, limit),
      });
    });

    function consumeLine(line: string) {
      if (!line.trim()) return;
      if (seen >= offset && matches.length <= limit) matches.push(line);
      seen += 1;
      if (matches.length > limit && !stoppedEarly) {
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

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
