import { spawn } from 'node:child_process';
import { diagnosticError } from './git-errors.js';
import type { GitMcpPolicy } from './policy.js';

export type GitRunResult = {
  exit_code: number | null;
  output_text: string;
  diagnostic_text: string;
  timed_out: boolean;
  output_truncated: boolean;
  diagnostic_truncated: boolean;
};

export function runGit(cwd: string, args: string[], policy: GitMcpPolicy): Promise<GitRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
    let outputText = '';
    let diagnosticText = '';
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let outputTruncated = false;
    let diagnosticTruncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      settled = true;
      resolvePromise({ exit_code: null, output_text: outputText, diagnostic_text: diagnosticText, timed_out: true, output_truncated: outputTruncated, diagnostic_truncated: diagnosticTruncated });
    }, policy.maxTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const appended = appendBoundedUtf8(outputText, outputBytes, String(chunk), policy.maxOutputBytes);
      outputText = appended.text;
      outputBytes = appended.bytes;
      outputTruncated ||= appended.truncated;
    });
    child.stderr.on('data', (chunk) => {
      const appended = appendBoundedUtf8(diagnosticText, diagnosticBytes, String(chunk), policy.maxOutputBytes);
      diagnosticText = appended.text;
      diagnosticBytes = appended.bytes;
      diagnosticTruncated ||= appended.truncated;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      resolvePromise({ exit_code: code, output_text: outputText, diagnostic_text: diagnosticText, timed_out: false, output_truncated: outputTruncated, diagnostic_truncated: diagnosticTruncated });
    });
  });
}

export async function gitText(cwd: string, args: string[], policy: GitMcpPolicy, failureCode: string = 'git_command_failed'): Promise<string> {
  const result = await runGit(cwd, args, policy);
  ensureGitOk(result, failureCode);
  return result.output_text;
}

export function ensureGitOk(result: GitRunResult, code: string): void {
  if (result.exit_code === 0 && !result.timed_out) return;
  throw diagnosticError(code, code, {
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    diagnostic_text: result.diagnostic_text,
    output_preview: result.output_text.slice(0, 1000),
    output_truncated: result.output_truncated,
    diagnostic_truncated: result.diagnostic_truncated,
  });
}

export function combineOutput(result: GitRunResult): string {
  return [result.output_text, result.diagnostic_text].filter(Boolean).join('\n').trim();
}

function appendBoundedUtf8(current: string, currentBytes: number, chunk: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  if (currentBytes >= maxBytes) return { text: current, bytes: currentBytes, truncated: true };
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  if (currentBytes + chunkBytes <= maxBytes) {
    return { text: current + chunk, bytes: currentBytes + chunkBytes, truncated: false };
  }
  const remainingBytes = maxBytes - currentBytes;
  const partial = utf8Prefix(chunk, remainingBytes);
  return { text: current + partial.text, bytes: currentBytes + partial.bytes, truncated: true };
}

function utf8Prefix(value: string, maxBytes: number): { text: string; bytes: number } {
  let text = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    text += char;
    bytes += charBytes;
  }
  return { text, bytes };
}
