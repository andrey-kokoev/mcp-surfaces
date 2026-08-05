import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  process.stdout.write(`${JSON.stringify({
    schema: 'narada.mcp_runtime_proxy.native_build.v1',
    status: 'skipped',
    reason: 'windows_only',
    platform: process.platform,
    architecture: process.arch,
  })}\n`);
  process.exit(0);
}
const nativeRoot = join(packageRoot, 'native');
const executableName = 'narada-mcp-runtime.exe';
const source = join(nativeRoot, 'target', 'release', executableName);
const destination = join(packageRoot, 'dist', 'native', executableName);
const temporary = `${destination}.tmp-${process.pid}`;

const result = spawnSync('cargo', [
  'build',
  '--release',
  '--locked',
  '--manifest-path',
  join(nativeRoot, 'Cargo.toml'),
], {
  cwd: packageRoot,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`mcp_runtime_proxy_native_build_failed:${result.status ?? 'signal'}`);
if (!existsSync(source)) throw new Error(`mcp_runtime_proxy_native_artifact_missing:${source}`);

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, temporary);
try {
  if (existsSync(destination)) rmSync(destination, { force: true });
  renameSync(temporary, destination);
} finally {
  if (existsSync(temporary)) rmSync(temporary, { force: true });
}

process.stdout.write(`${JSON.stringify({
  schema: 'narada.mcp_runtime_proxy.native_build.v1',
  executable: destination,
  platform: process.platform,
  architecture: process.arch,
})}\n`);
