#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, unknown>;
type PendingRequest = {
  id: string | number;
  method: string;
  framed: boolean;
};

const STDERR_TAIL_LIMIT = 8000;

function parseArgs(argv: string[]): { entrypoint: string; childArgs: string[]; surfaceId: string | null } {
  let entrypoint = '';
  let surfaceId: string | null = null;
  let passthroughIndex = argv.indexOf('--');
  if (passthroughIndex < 0) passthroughIndex = argv.length;
  const prelude = argv.slice(0, passthroughIndex);
  for (let index = 0; index < prelude.length; index += 1) {
    const arg = prelude[index];
    if (arg === '--entrypoint' && prelude[index + 1]) entrypoint = prelude[++index];
    else if (arg === '--surface-id' && prelude[index + 1]) surfaceId = prelude[++index];
  }
  if (!entrypoint) throw new Error('mcp_runtime_proxy_missing_entrypoint');
  return { entrypoint: resolve(entrypoint), childArgs: argv.slice(Math.min(passthroughIndex + 1, argv.length)), surfaceId };
}

export async function runProxy(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (!existsSync(options.entrypoint)) {
    process.stderr.write(`mcp_runtime_proxy_entrypoint_not_found:${options.entrypoint}\n`);
  }

  const pending = new Map<string | number, PendingRequest>();
  let parentBuffer = '';
  let childBuffer = '';
  let stderrTail = '';
  let childClosed = false;

  const child = spawn(process.execPath, [options.entrypoint, ...options.childArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    shell: false,
    windowsHide: true,
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (!child.stdin.destroyed) child.stdin.write(chunk);
    parentBuffer += chunk;
    const drained = parentBuffer.includes('Content-Length:') ? drainJsonRpcFrames(parentBuffer) : drainJsonLines(parentBuffer);
    parentBuffer = drained.remaining;
    for (const request of drained.requests) {
      const id = request.id;
      if ((typeof id === 'string' || typeof id === 'number') && typeof request.method === 'string') {
        pending.set(id, { id, method: request.method, framed: drained.framed });
      }
    }
  });

  process.stdin.on('end', () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    childBuffer += chunk;
    const drained = childBuffer.includes('Content-Length:') ? drainJsonRpcFrames(childBuffer) : drainJsonLines(childBuffer);
    childBuffer = drained.remaining;
    for (const response of drained.requests) {
      const id = response.id;
      if (typeof id === 'string' || typeof id === 'number') pending.delete(id);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrTail = tail(`${stderrTail}${chunk}`, STDERR_TAIL_LIMIT);
    process.stderr.write(chunk);
  });

  child.on('error', (error) => {
    stderrTail = tail(`${stderrTail}${error.message}\n`, STDERR_TAIL_LIMIT);
    flushPendingErrors(pending, options, {
      code: 'child_spawn_error',
      message: error.message,
      stderrTail,
      exitCode: null,
      signal: null,
    });
  });

  child.on('close', (code, signal) => {
    childClosed = true;
    if (pending.size > 0) {
      flushPendingErrors(pending, options, {
        code: 'child_exited_before_response',
        message: `child_exited_before_response:${code ?? signal ?? 'unknown'}`,
        stderrTail,
        exitCode: code,
        signal,
      });
    }
    process.exitCode = typeof code === 'number' ? code : 1;
  });

  await new Promise<void>((resolveDone) => {
    child.on('close', () => resolveDone());
    process.stdin.on('end', () => {
      if (childClosed) resolveDone();
    });
  });
}

function flushPendingErrors(
  pending: Map<string | number, PendingRequest>,
  options: { entrypoint: string; surfaceId: string | null },
  diagnostic: { code: string; message: string; stderrTail: string; exitCode: number | null; signal: NodeJS.Signals | null },
): void {
  for (const request of pending.values()) {
    writeJsonRpcMessage({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32000,
        message: diagnostic.message,
        data: {
          schema: 'narada.mcp_runtime_proxy.error.v1',
          code: diagnostic.code,
          method: request.method,
          surface_id: options.surfaceId,
          entrypoint: options.entrypoint,
          exit_code: diagnostic.exitCode,
          signal: diagnostic.signal,
          stderr_tail: diagnostic.stderrTail,
        },
      },
    }, request.framed);
  }
  pending.clear();
}

function drainJsonLines(buffer: string): { framed: boolean; remaining: string; requests: JsonRecord[] } {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return { framed: false, remaining, requests: lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as JsonRecord) };
}

function drainJsonRpcFrames(buffer: string): { framed: boolean; remaining: string; requests: JsonRecord[] } {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    const alternateHeaderEnd = remaining.indexOf('\n\n');
    const end = headerEnd >= 0 ? headerEnd : alternateHeaderEnd;
    const separatorLength = headerEnd >= 0 ? 4 : 2;
    if (end < 0) break;
    const header = remaining.slice(0, end);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const start = end + separatorLength;
    const finish = start + length;
    if (remaining.length < finish) break;
    requests.push(JSON.parse(remaining.slice(start, finish)) as JsonRecord);
    remaining = remaining.slice(finish);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcMessage(message: JsonRecord, framed: boolean): void {
  const json = JSON.stringify(message);
  if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  else process.stdout.write(`${json}\n`);
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runProxy().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
