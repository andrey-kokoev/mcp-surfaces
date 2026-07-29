import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createTemporaryE2eRoot, removeTemporaryE2eRoot } from '@narada2/mcp-e2e-harness';
import { materializeKimiCarrierConfig } from './kimi-carrier-test-support.js';

const enabled = process.env.NARADA_KIMI_CARRIER_LIVE_E2E === '1';

if (!enabled) {
  console.log('Kimi carrier live E2E skipped; set NARADA_KIMI_CARRIER_LIVE_E2E=1 with operator approval');
} else {
  const temporaryRoot = createTemporaryE2eRoot('kimi-carrier-live');
  try {
    // Kimi Code reads project-local MCP declarations from .kimi-code/mcp.json.
    // There is no supported --mcp-config-file CLI option, so keep the generated
    // carrier projection isolated in the temporary project instead of passing a
    // stale flag that newer Kimi versions reject.
    const configPath = join(temporaryRoot, '.kimi-code', 'mcp.json');
    const config = await materializeKimiCarrierConfig(configPath);
    const serverCount = Object.keys(config.mcpServers).length;
    const command = process.env.NARADA_KIMI_COMMAND ?? 'kimi';
    const timeoutMs = positiveInteger(process.env.NARADA_KIMI_LIVE_TIMEOUT_MS, 120_000);
    const result = await run(command, [
      '-p', 'Reply with exactly KIMI_MCP_CARRIER_SMOKE_OK and nothing else.',
      '--output-format=stream-json',
    ], temporaryRoot, timeoutMs);

    assert.equal(result.code, 0, `Kimi exited with ${result.code}; stderr=${result.stderr.slice(-4_000)}`);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(combined, /tools\.function\.parameters|moonshot flavored json schema|MCP server[^\n]*(?:failed|error)|failed to (?:connect|load)[^\n]*MCP/i);
    assert.match(result.stdout, /KIMI_MCP_CARRIER_SMOKE_OK/);
    console.log(`Kimi carrier live E2E ok: completed one provider turn with ${serverCount} configured MCP servers`);
  } finally {
    assert.equal(removeTemporaryE2eRoot(temporaryRoot), true, `failed to remove ${temporaryRoot}`);
  }
}

async function run(command: string, args: string[], workingDirectory: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: workingDirectory,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Kimi live E2E timed out after ${timeoutMs}ms; stderr=${stderr.slice(-4_000)}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
