import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '..', '..', '..');
const projectPath = join(workspaceRoot, 'packages', 'local-filesystem-mcp', 'native-dotnet', 'FilesystemMcp.csproj');
const publishDirectory = join(workspaceRoot, 'packages', 'local-filesystem-mcp', 'native-dotnet', 'publish');
const executable = join(publishDirectory, 'narada-filesystem-dotnet.exe');

if (process.platform !== 'win32') {
  process.stdout.write(JSON.stringify({
    schema: 'narada.local_filesystem.dotnet_native_build.v1',
    status: 'skipped',
    reason: 'windows_only',
    platform: process.platform,
  }) + '\n');
  process.exit(0);
}

if (!existsSync(projectPath)) {
  throw new Error('dotnet_filesystem_project_missing:' + projectPath);
}

const sdkCheck = spawnSync('dotnet', ['--list-sdks'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (sdkCheck.error?.code === 'ENOENT' || sdkCheck.status !== 0 || !sdkCheck.stdout?.trim()) {
  process.stdout.write(JSON.stringify({
    schema: 'narada.local_filesystem.dotnet_native_build.v1',
    status: 'skipped',
    reason: 'dotnet_sdk_unavailable',
    platform: process.platform,
  }) + '\n');
  process.exit(0);
}

mkdirSync(publishDirectory, { recursive: true });
const result = spawnSync('dotnet', [
  'publish',
  projectPath,
  '--configuration',
  'Release',
  '--runtime',
  'win-x64',
  '--self-contained',
  'true',
  '--output',
  publishDirectory,
], {
  cwd: workspaceRoot,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error?.code === 'ENOENT') {
  process.stdout.write(JSON.stringify({
    schema: 'narada.local_filesystem.dotnet_native_build.v1',
    status: 'skipped',
    reason: 'dotnet_sdk_unavailable',
    platform: process.platform,
  }) + '\n');
  process.exit(0);
}
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('dotnet_filesystem_native_build_failed:' + (result.status ?? 'signal'));
if (!existsSync(executable)) throw new Error('dotnet_filesystem_native_artifact_missing:' + executable);

process.stdout.write(JSON.stringify({
  schema: 'narada.local_filesystem.dotnet_native_build.v1',
  status: 'built',
  executable,
  platform: process.platform,
  architecture: process.arch,
}) + '\n');
