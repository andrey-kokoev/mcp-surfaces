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
const boaManifest = join(nativeRoot, 'boa-fixture', 'Cargo.toml');
const boaArtifact = {
  source: join(nativeRoot, 'boa-fixture', 'target', 'release', 'narada-mcp-boa-fixture.exe'),
  destination: join(packageRoot, 'dist', 'native', 'narada-mcp-boa-fixture.exe'),
};

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

let boaBuild: { status: 'built' | 'skipped'; reason?: string } = { status: 'skipped', reason: 'windows_only' };
if (process.platform === 'win32') {
  const boaResult = spawnSync('cargo', [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    boaManifest,
  ], {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (!boaResult.error && boaResult.status === 0 && existsSync(boaArtifact.source)) {
    const temporary = `${boaArtifact.destination}.tmp-${process.pid}`;
    copyFileSync(boaArtifact.source, temporary);
    try {
      if (existsSync(boaArtifact.destination)) rmSync(boaArtifact.destination, { force: true });
      renameSync(temporary, boaArtifact.destination);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
    boaBuild = { status: 'built' };
  } else {
    if (existsSync(boaArtifact.destination)) rmSync(boaArtifact.destination, { force: true });
    boaBuild = { status: 'skipped', reason: boaResult.error?.code === 'ENOENT' ? 'cargo_unavailable' : 'boa_build_failed' };
  }
}

process.stdout.write(`${JSON.stringify({
  schema: 'narada.mcp_runtime_proxy.native_build.v1',
  executable: artifacts[0].destination,
  executables: artifacts.map((artifact) => artifact.destination),
  boa_fixture: { ...boaBuild, executable: boaBuild.status === 'built' ? boaArtifact.destination : null },
  platform: process.platform,
  architecture: process.arch,
})}\n`);
