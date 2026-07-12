import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('git-site-fabric-e2e');
const repo = join(siteRoot, 'repo');
const remote = join(siteRoot, 'remote.git');
mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'ignore' });
execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'MCP E2E'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo, stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), 'site fabric git e2e\n', 'utf8');

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--allowed-root', siteRoot, '--mode', 'write'], {
  cwd: siteRoot,
  label: 'git Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  return (response.result as JsonRecord)?.structuredContent as JsonRecord ?? response.result as JsonRecord;
}

try {
  await runMcpProtocolSmoke(server.client, {
    requiredTools: ['git_policy_inspect', 'git_status', 'git_diff', 'git_add', 'git_commit', 'git_push', 'git_log'],
  });

  const policy = structured(await server.client.request(1, 'tools/call', { name: 'git_policy_inspect', arguments: {} }));
  assert.equal(policy.mode, 'write', JSON.stringify(policy));

  const initial = structured(await server.client.request(2, 'tools/call', {
    name: 'git_status', arguments: { working_directory: repo },
  }));
  assert.deepEqual(initial.untracked, ['README.md']);

  const diff = structured(await server.client.request(3, 'tools/call', {
    name: 'git_diff', arguments: { working_directory: repo, scope: 'working', pathspecs: ['README.md'], include_untracked: true, limit: 2000 },
  }));
  assert.equal(diff.schema, 'narada.git.diff.v1', JSON.stringify(diff));
  assert.match(String(diff.diff), /site fabric git e2e/);

  const added = structured(await server.client.request(4, 'tools/call', {
    name: 'git_add', arguments: { working_directory: repo, paths: ['README.md'] },
  }));
  assert.deepEqual((added.post_status as JsonRecord).staged, ['README.md'], JSON.stringify(added));

  const committed = structured(await server.client.request(4, 'tools/call', {
    name: 'git_commit', arguments: { working_directory: repo, message: 'Site fabric E2E commit' },
  }));
  assert.match(String(committed.commit), /^[0-9a-f]{40}$/);

  const pushed = structured(await server.client.request(5, 'tools/call', {
    name: 'git_push', arguments: { working_directory: repo, remote: 'origin', branch: 'main' },
  }));
  assert.equal(pushed.status, 'ok', JSON.stringify(pushed));
  assert.match(String(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, encoding: 'utf8' })).trim(), /^[0-9a-f]{40}$/);

  const log = structured(await server.client.request(6, 'tools/call', {
    name: 'git_log', arguments: { working_directory: repo, limit: 5 },
  }));
  assert.equal((log.commits as JsonRecord[])[0].subject, 'Site fabric E2E commit');

  const refused = await server.client.request(7, 'tools/call', {
    name: 'git_add', arguments: { working_directory: repo, paths: ['.'] },
  });
  assert.equal((refused.error?.data as JsonRecord)?.code, 'git_broad_path_not_allowed', JSON.stringify(refused));

  console.log(JSON.stringify({ status: 'passed', test_id: 'git.site-fabric.commit-push-policy', cleanup: 'completed_after_finally' }));
} finally {
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
  rmSync(remote, { recursive: true, force: true });
}

console.log('git Site fabric e2e ok');
