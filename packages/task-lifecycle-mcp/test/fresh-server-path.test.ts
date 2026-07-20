import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFreshServerPath } from '../src/task-lifecycle/fresh-server-path.js';

const root = mkdtempSync(join(tmpdir(), 'task-fresh-server-path-'));
try {
  const siteRoot = join(root, 'site');
  const packageRoot = join(root, 'package');
  const runtimeModulePath = join(packageRoot, 'dist', 'src', 'task-lifecycle', 'handler.js');
  const siteServer = join(siteRoot, 'tools', 'server.mjs');
  const packageServer = join(packageRoot, 'dist', 'src', 'task-lifecycle', 'task-mcp-server.js');
  const externalRoot = join(root, 'explicit');
  const externalServer = join(externalRoot, 'server.cjs');
  const refusedServer = join(root, 'outside', 'server.js');
  for (const path of [siteServer, packageServer, externalServer, refusedServer]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'process.stdin.resume();\n', 'utf8');
  }
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@narada2/task-lifecycle-mcp' }), 'utf8');

  const relativeAdmission = resolveFreshServerPath({ siteRoot, serverPath: 'tools/server.mjs', runtimeModulePath, env: {} });
  assert.equal(relativeAdmission.status, 'admitted');
  assert.equal(relativeAdmission.path_kind, 'site_root_relative');
  assert.equal(relativeAdmission.authority_root, siteRoot);

  const packageAdmission = resolveFreshServerPath({ siteRoot, serverPath: packageServer, runtimeModulePath, env: {} });
  assert.equal(packageAdmission.status, 'admitted');
  assert.equal(packageAdmission.path_kind, 'absolute');
  assert.equal(packageAdmission.authority_root, packageRoot);

  const refused = resolveFreshServerPath({ siteRoot, serverPath: refusedServer, runtimeModulePath, env: {} });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, 'server_path_outside_allowed_roots');

  const linkedOutsideDirectory = join(siteRoot, 'tools', 'linked-outside');
  try {
    symlinkSync(join(root, 'outside'), linkedOutsideDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const symlinkEscape = resolveFreshServerPath({
      siteRoot,
      serverPath: 'tools/linked-outside/server.js',
      runtimeModulePath,
      env: {},
    });
    assert.equal(symlinkEscape.status, 'refused');
    assert.equal(symlinkEscape.reason, 'server_path_outside_allowed_roots');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }

  const configured = resolveFreshServerPath({
    siteRoot,
    serverPath: externalServer,
    runtimeModulePath,
    env: { NARADA_TASK_LIFECYCLE_FRESH_SERVER_ALLOWED_ROOTS: externalRoot },
  });
  assert.equal(configured.status, 'admitted');
  assert.equal(configured.authority_root, externalRoot);

  const wrongExtension = join(siteRoot, 'tools', 'server.txt');
  writeFileSync(wrongExtension, 'not executable', 'utf8');
  assert.equal(resolveFreshServerPath({ siteRoot, serverPath: wrongExtension, runtimeModulePath, env: {} }).reason, 'server_path_extension_not_executable_mcp_script');

  console.log('task lifecycle fresh server path policy ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
