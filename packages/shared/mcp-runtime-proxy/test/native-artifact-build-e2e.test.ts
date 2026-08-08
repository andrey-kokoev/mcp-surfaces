import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MCP_RUNTIME_CONTRACT_VERSION } from '../src/materialization-contract.js';
import { resolveNativeArtifact } from '../src/native-artifact.js';
import { fingerprintWorkspaceArtifactManifest } from '../src/workspace-artifact-manifest.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const nativeExecutable = resolveNativeArtifact(packageRoot, 'narada-mcp-runtime.exe');
const buildScript = join(packageRoot, 'scripts', 'build-native.ts');

test('native build publishes while the current native proxy is running', { skip: process.platform !== 'win32' || !nativeExecutable || !existsSync(buildScript) }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-artifact-build-e2e-'));
  let proxy: ChildProcessWithoutNullStreams | null = null;
  try {
    const childPath = join(root, 'child.mjs');
    const manifestPath = join(root, 'workspace-artifact-manifest.json');
    const diagnosticsPath = join(root, 'diagnostics');
    mkdirSync(diagnosticsPath, { recursive: true });
    writeFileSync(childPath, 'process.stdin.resume();\n', 'utf8');
    const bytes = readFileSync(childPath);
    const stat = statSync(childPath);
    const artifact = {
      path: childPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: stat.size,
      mtime_ms: stat.mtimeMs,
    };
    const unsigned = {
      schema: 'narada.workspace_artifact_manifest.v1',
      generated_at: '2026-08-07T00:00:00.000Z',
      workspace_root: root,
      packages: [],
      artifacts: [artifact],
    };
    writeFileSync(manifestPath, JSON.stringify({ ...unsigned, manifest_fingerprint: fingerprintWorkspaceArtifactManifest(unsigned) }) + '\n', 'utf8');

    proxy = spawn(nativeExecutable!, [
      'proxy',
      '--surface-id', 'native-artifact-build-e2e',
      '--artifact-manifest', manifestPath,
      '--runtime-contract-version', String(MCP_RUNTIME_CONTRACT_VERSION),
      '--child-command', process.execPath,
      '--entrypoint', childPath,
      '--diagnostics-dir', diagnosticsPath,
      '--orphan-grace-ms', '1000',
      '--',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    proxy.stderr.setEncoding('utf8');
    proxy.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    assert.equal(proxy.exitCode, null, stderr);

    const builder = spawn('bun', [buildScript], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let buildStderr = '';
    builder.stdout.setEncoding('utf8');
    builder.stderr.setEncoding('utf8');
    builder.stdout.on('data', (chunk) => { stdout += chunk; });
    builder.stderr.on('data', (chunk) => { buildStderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        builder.kill();
        rejectWait(new Error('native_artifact_build_e2e_timeout:' + buildStderr));
      }, 180_000);
      builder.once('error', (error) => {
        clearTimeout(timer);
        rejectWait(error);
      });
      builder.once('close', (code) => {
        clearTimeout(timer);
        resolveWait(code);
      });
    });
    assert.equal(exitCode, 0, buildStderr + '\n' + stdout);
    const buildRecord = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)!);
    assert.equal(buildRecord.schema, 'narada.mcp_runtime_proxy.native_build.v1');
    assert.equal(typeof buildRecord.build_fingerprint, 'string');
    assert.ok(buildRecord.executable.includes(join('dist', 'native', 'versions')));
  } finally {
    if (proxy) {
      proxy.stdin.end();
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(() => {
          proxy?.kill();
          resolveWait();
        }, 5_000);
        proxy?.once('close', () => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
