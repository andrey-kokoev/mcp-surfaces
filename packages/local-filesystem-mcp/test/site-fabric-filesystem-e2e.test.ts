import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('local-filesystem-site-fabric-e2e');
const outsideRoot = createTemporaryE2eRoot('local-filesystem-outside-e2e');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [
  serverPath,
  '--mode', 'write',
  '--allowed-root', siteRoot,
  '--output-root', siteRoot,
], {
  cwd: siteRoot,
  label: 'local-filesystem Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  return (response.result as JsonRecord)?.structuredContent as JsonRecord ?? response.result as JsonRecord;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'local-filesystem-write',
    requiredTools: ['fs_doctor', 'fs_read_file', 'fs_read_file_range', 'fs_write_file', 'fs_stat', 'fs_glob_search'],
  });

  const doctor = structured(await server.client.request(1, 'tools/call', { name: 'fs_doctor', arguments: {} }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  assert.equal((doctor.allowed_root_entries as JsonRecord[]).some((item) => String(item.root).replaceAll('\\\\', '/') === siteRoot.replaceAll('\\\\', '/')), true, JSON.stringify(doctor));

  const filePath = join(siteRoot, 'fixture.txt');
  const written = structured(await server.client.request(2, 'tools/call', {
    name: 'fs_write_file',
    arguments: { path: filePath, content: 'alpha\nbeta\n' },
  }));
  assert.equal(written.status, 'written', JSON.stringify(written));
  assert.equal(readFileSync(filePath, 'utf8'), 'alpha\nbeta\n');

  const read = structured(await server.client.request(3, 'tools/call', {
    name: 'fs_read_file',
    arguments: { path: filePath, limit: 1 },
  }));
  assert.equal(read.content, 'alpha');
  assert.equal(read.next_offset, 2);
  assert.equal(read.line_window_complete, false);

  const range = structured(await server.client.request(4, 'tools/call', {
    name: 'fs_read_file_range',
    arguments: { path: filePath, start_line: 2, end_line: 2 },
  }));
  assert.equal(range.content, 'beta');
  assert.equal(range.total_lines_exact, true);

  const stat = structured(await server.client.request(5, 'tools/call', {
    name: 'fs_stat',
    arguments: { path: filePath },
  }));
  assert.equal(stat.type, 'file');
  assert.equal(stat.path, filePath);

  const glob = structured(await server.client.request(6, 'tools/call', {
    name: 'fs_glob_search',
    arguments: { path: siteRoot, pattern: '*.txt', limit: 10 },
  }));
  assert.equal((glob.matches as string[]).some((item) => item.endsWith('fixture.txt')), true);

  const outside = await server.client.request(7, 'tools/call', {
    name: 'fs_read_file',
    arguments: { path: join(outsideRoot, 'not-admitted.txt') },
  });
  assert.equal((outside.error?.data as JsonRecord)?.code, 'path_outside_allowed_roots', JSON.stringify(outside));

  console.log(JSON.stringify({ status: 'passed', test_id: 'local-filesystem.site-fabric.governed-read-write', cleanup: existsSync(filePath) ? 'completed_after_finally' : 'completed' }));
} finally {
  await server.close();
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
  assert.equal(removeTemporaryE2eRoot(outsideRoot), true);
}

console.log('local-filesystem Site fabric e2e ok');
