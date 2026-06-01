import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTrustedProjectRootsFromTrustConfig, resolveAllowedPath } from '../src/policy.mjs';
import { createServerState, handleRequest, listTools } from '../src/main.mjs';

const tempRoot = mkdtempSync(join(tmpdir(), 'local-filesystem-mcp-'));
try {
  const trusted = join(tempRoot, 'trusted');
  const other = join(tempRoot, 'other');
  mkdirSync(trusted, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(trusted, 'a.txt'), 'alpha\nbeta\n', 'utf8');
  const revolutionRoot = join(trusted, 'OneDrive - Global Maxima LLC', '!Business', '!Clients', '!Revolution', '.narada');
  mkdirSync(join(revolutionRoot, 'config'), { recursive: true });
  writeFileSync(join(revolutionRoot, 'config', 'config.json'), '{"site":"revolution"}\n', 'utf8');
  writeFileSync(join(revolutionRoot, 'config', 'settings.yaml'), 'site: revolution\n', 'utf8');
  const configPath = join(tempRoot, 'config.toml');
  writeFileSync(configPath, `
[projects.'${trusted.replace(/\\/g, '\\\\')}']
trust_level = "trusted"

[projects.'${other.replace(/\\/g, '\\\\')}']
trust_level = "untrusted"
`, 'utf8');

  const roots = parseTrustedProjectRootsFromTrustConfig(configPath);
  assert.deepEqual(roots, [resolve(trusted)]);
  assert.equal(resolveAllowedPath(join(trusted, 'a.txt'), roots).path, resolve(join(trusted, 'a.txt')));
  assert.throws(() => resolveAllowedPath(join(other, 'x.txt'), roots), /path_outside_allowed_roots/);

  const readToolNames = listTools('read').map((tool) => tool.name);
  assert.ok(readToolNames.includes('fs_read_file'));
  assert.ok(readToolNames.includes('fs_read_file_range'));
  assert.ok(readToolNames.includes('fs_grep_search'));
  assert.ok(readToolNames.includes('mcp_output_show'));
  assert.equal(readToolNames.includes('fs_write_file'), false);

  const writeToolNames = listTools('write').map((tool) => tool.name);
  assert.ok(writeToolNames.includes('fs_write_file'));
  assert.ok(writeToolNames.includes('fs_str_replace_file'));
  assert.ok(writeToolNames.includes('fs_replace_range'));
  assert.ok(writeToolNames.includes('fs_apply_patch'));
  assert.ok(writeToolNames.includes('fs_move_path'));
  assert.equal(writeToolNames.includes('fs_read_file'), false);

  const readState = createServerState({ mode: 'read', rootsFromCodexConfig: configPath, outputRoot: tempRoot });
  const readResponse = handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'fs_read_file', arguments: { path: join(trusted, 'a.txt'), limit: 1 } },
  }, readState);
  const readPayload = JSON.parse(readResponse.result.content[0].text);
  assert.equal(readPayload.content, 'alpha');
  const rangeResponse = handleRequest({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'fs_read_file_range', arguments: { path: join(trusted, 'a.txt'), start_line: 2, end_line: 2 } },
  }, readState);
  assert.equal(JSON.parse(rangeResponse.result.content[0].text).content, 'beta');
  const revolutionConfigPath = join(revolutionRoot, 'config', 'config.json');
  const revolutionReadResponse = handleRequest({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'fs_read_file', arguments: { path: revolutionConfigPath } },
  }, readState);
  assert.equal(JSON.parse(revolutionReadResponse.result.content[0].text).relative_path.endsWith('!Revolution/.narada/config/config.json'), true);
  for (const [id, pattern] of [[13, '**/*config*'], [14, '**/*.json'], [15, '**/*.{json,yaml,yml}']]) {
    const globResponse = handleRequest({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'fs_glob_search', arguments: { directory: revolutionRoot, pattern } },
    }, readState);
    const globPayload = JSON.parse(globResponse.result.content[0].text);
    assert.equal(globPayload.matches.some((match) => match.replace(/\\/g, '/').endsWith('config/config.json')), true, `${pattern} should find config/config.json`);
  }

  const blockedWrite = handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'fs_write_file', arguments: { path: join(trusted, 'b.txt'), content: 'x' } },
  }, readState);
  assert.match(blockedWrite.error.message, /tool_not_available_in_read_mode/);

  const auditDir = join(tempRoot, 'audit');
  const writeState = createServerState({ mode: 'write', rootsFromCodexConfig: configPath, auditLogDir: auditDir, outputRoot: tempRoot });
  const writeResponse = handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'fs_write_file', arguments: { path: join(trusted, 'b.txt'), content: 'created' } },
  }, writeState);
  assert.equal(JSON.parse(writeResponse.result.content[0].text).status, 'written');
  assert.match(readFileSync(join(auditDir, 'filesystem-mcp-audit.jsonl'), 'utf8'), /fs_write_file/);
  const replaceRangeResponse = handleRequest({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: { name: 'fs_replace_range', arguments: { path: join(trusted, 'b.txt'), start_line: 1, end_line: 1, replacement: 'range-edited' } },
  }, writeState);
  assert.equal(JSON.parse(replaceRangeResponse.result.content[0].text).status, 'replaced_range');
  assert.equal(readFileSync(join(trusted, 'b.txt'), 'utf8'), 'range-edited');
  writeFileSync(join(trusted, 'patch.txt'), 'one\ntwo\n', 'utf8');
  const patchResponse = handleRequest({
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: { name: 'fs_apply_patch', arguments: { patch: `--- patch.txt\n+++ patch.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+patched\n` } },
  }, writeState);
  assert.equal(JSON.parse(patchResponse.result.content[0].text).status, 'patched');
  assert.equal(readFileSync(join(trusted, 'patch.txt'), 'utf8'), 'one\npatched\n');

  const moveResponse = handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'fs_move_path', arguments: { from: join(trusted, 'b.txt'), to: join(trusted, 'renamed.txt') } },
  }, writeState);
  const movePayload = JSON.parse(moveResponse.result.content[0].text);
  assert.equal(movePayload.status, 'moved');
  assert.match(readFileSync(join(auditDir, 'filesystem-mcp-audit.jsonl'), 'utf8'), /fs_move_path/);

  const overwriteBlocked = handleRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'fs_move_path', arguments: { from: join(trusted, 'renamed.txt'), to: join(trusted, 'a.txt') } },
  }, writeState);
  assert.match(overwriteBlocked.error.message, /move_destination_exists/);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('local filesystem MCP tests passed');
