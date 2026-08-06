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
const executableNames = ['narada-mcp-runtime.exe', 'narada-mcp-rhai-filesystem.exe'];
const artifacts = executableNames.map((name) => ({
  source: join(nativeRoot, 'target', 'release', name),
  destination: join(packageRoot, 'dist', 'native', name),
}));

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
for (const artifact of artifacts) {
  if (!existsSync(artifact.source)) throw new Error(`mcp_runtime_proxy_native_artifact_missing:${artifact.source}`);
}

mkdirSync(dirname(artifacts[0].destination), { recursive: true });
for (const artifact of artifacts) {
  const temporary = `${artifact.destination}.tmp-${process.pid}`;
  copyFileSync(artifact.source, temporary);
  try {
    if (existsSync(artifact.destination)) rmSync(artifact.destination, { force: true });
    renameSync(temporary, artifact.destination);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

process.stdout.write(`${JSON.stringify({
  schema: 'narada.mcp_runtime_proxy.native_build.v1',
  executable: artifacts[0].destination,
  executables: artifacts.map((artifact) => artifact.destination),
  platform: process.platform,
  architecture: process.arch,
})}\n`);
