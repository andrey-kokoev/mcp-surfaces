import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTrustedProjectRootsFromTrustConfig, resolveAllowedPath } from '../src/policy.js';
import { createServerState, handleRequest, listTools } from '../src/main.js';

function call(state, id, name, args = {}) {
  return handleRequest({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  }, state);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'local-filesystem-mcp-'));
try {
  const trusted = join(tempRoot, 'trusted');
  const other = join(tempRoot, 'other');
  mkdirSync(trusted, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(trusted, 'a.txt'), 'alpha\nbeta\n', 'utf8');
  writeFileSync(join(trusted, 'grep-one.txt'), 'alpha\nneedle one\n', 'utf8');
  writeFileSync(join(trusted, 'grep-two.txt'), 'needle two\nplain\n', 'utf8');

  const revolutionRoot = join(trusted, 'OneDrive - Global Maxima LLC', '!Business', '!Clients', '!Revolution', '.narada');
  mkdirSync(join(revolutionRoot, 'config'), { recursive: true });
  writeFileSync(join(revolutionRoot, 'config', 'config.json'), '{"site":"revolution"}\n', 'utf8');
  writeFileSync(join(revolutionRoot, 'config', 'settings.yaml'), 'site: revolution\n', 'utf8');

  const largeRoot = join(trusted, 'large-search');
  mkdirSync(largeRoot, { recursive: true });
  for (let i = 0; i < 120; i += 1) {
    writeFileSync(join(largeRoot, `very-long-file-name-${String(i).padStart(3, '0')}-${'x'.repeat(60)}.txt`), 'needle\n', 'utf8');
  }

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
  assert.ok(writeToolNames.includes('fs_read_file'));
  assert.ok(writeToolNames.includes('mcp_output_show'));
  assert.ok(writeToolNames.includes('fs_write_file'));
  assert.ok(writeToolNames.includes('fs_str_replace_file'));
  assert.ok(writeToolNames.includes('fs_replace_range'));
  assert.ok(writeToolNames.includes('fs_apply_patch'));
  assert.ok(writeToolNames.includes('fs_move_path'));

  const readState = createServerState({ mode: 'read', rootsFromCodexConfig: configPath, outputRoot: tempRoot });
  const readResponse = call(readState, 1, 'fs_read_file', { path: join(trusted, 'a.txt'), limit: 1 });
  assert.equal(readResponse.result.structuredContent.content, 'alpha');
  assert.equal(readResponse.result.structuredContent.next_offset, 2);
  assert.equal(JSON.parse(readResponse.result.content[0].text).content, 'alpha');

  const rangeResponse = call(readState, 11, 'fs_read_file_range', { path: join(trusted, 'a.txt'), start_line: 2, end_line: 2 });
  assert.equal(rangeResponse.result.structuredContent.content, 'beta');
  assert.equal(rangeResponse.result.structuredContent.next_offset, 3);

  const revolutionConfigPath = join(revolutionRoot, 'config', 'config.json');
  const revolutionReadResponse = call(readState, 12, 'fs_read_file', { path: revolutionConfigPath });
  assert.equal(revolutionReadResponse.result.structuredContent.relative_path.endsWith('!Revolution/.narada/config/config.json'), true);

  for (const [id, pattern] of [[13, '**/*config*'], [14, '**/*.json'], [15, '**/*.{json,yaml,yml}']]) {
    const globResponse = call(readState, id, 'fs_glob_search', { directory: revolutionRoot, pattern });
    const globPayload = globResponse.result.structuredContent;
    assert.equal(globPayload.matches.some((match) => match.replace(/\\/g, '/').endsWith('config/config.json')), true, `${pattern} should find config/config.json`);
    assert.equal(globPayload.offset, 0);
    assert.equal(globPayload.limit, 100);
  }

  const pagedGlob = call(readState, 16, 'fs_glob_search', { directory: largeRoot, pattern: '**/*.txt', limit: 5 });
  assert.equal(pagedGlob.result.structuredContent.returned, 5);
  assert.equal(pagedGlob.result.structuredContent.truncated, true);
  assert.equal(pagedGlob.result.structuredContent.next_offset, 5);
  const pagedGlobSecond = call(readState, 17, 'fs_glob_search', { directory: largeRoot, pattern: '**/*.txt', offset: 5, limit: 5 });
  assert.equal(pagedGlobSecond.result.structuredContent.offset, 5);
  assert.equal(pagedGlobSecond.result.structuredContent.returned, 5);

  const largeGlob = call(readState, 18, 'fs_glob_search', { directory: largeRoot, pattern: '**/*.txt', limit: 120 });
  assert.equal(largeGlob.result.structuredContent.truncated, true);
  assert.match(largeGlob.result.structuredContent.output_ref, /^mcp_output:/);
  assert.equal(largeGlob.result.structuredContent.reader_tool, 'mcp_output_show');
  assert.equal(largeGlob.result.content[0].text.includes('content'), false);
  const shownLargeGlob = call(readState, 19, 'mcp_output_show', { ref: largeGlob.result.structuredContent.output_ref, output_limit: 50000 });
  const shownGlobPayload = JSON.parse(shownLargeGlob.result.structuredContent.output_text);
  assert.equal(shownGlobPayload.schema, 'local.filesystem.glob.v1');
  assert.equal(shownGlobPayload.matches.length, 120);

  const grepFiles = call(readState, 20, 'fs_grep_search', { path: trusted, pattern: 'needle', output_mode: 'files_with_matches', limit: 10 });
  assert.equal(grepFiles.result.structuredContent.schema, 'local.filesystem.grep.v1');
  assert.equal(grepFiles.result.structuredContent.matches.some((match) => match.includes('grep-one.txt')), true);
  const grepContent = call(readState, 21, 'fs_grep_search', { path: trusted, pattern: 'needle one', output_mode: 'content', limit: 10 });
  assert.equal(grepContent.result.structuredContent.matches.some((match) => match.includes('needle one')), true);
  const grepCounts = call(readState, 22, 'fs_grep_search', { path: trusted, pattern: 'needle', output_mode: 'count_matches', limit: 10 });
  assert.equal(grepCounts.result.structuredContent.matches.some((match) => /grep-one\.txt.*1/.test(match.replace(/\\/g, '/'))), true);
  const badGrepMode = call(readState, 23, 'fs_grep_search', { path: trusted, pattern: 'needle', output_mode: 'bad_mode' });
  assert.match(badGrepMode.error.message, /grep_output_mode_unsupported/);

  const blockedWrite = call(readState, 2, 'fs_write_file', { path: join(trusted, 'b.txt'), content: 'x' });
  assert.match(blockedWrite.error.message, /tool_not_available_in_read_mode/);

  const auditDir = join(tempRoot, 'audit');
  const writeState = createServerState({ mode: 'write', rootsFromCodexConfig: configPath, auditLogDir: auditDir, outputRoot: tempRoot });
  const writeResponse = call(writeState, 3, 'fs_write_file', { path: join(trusted, 'b.txt'), content: 'created' });
  assert.equal(writeResponse.result.structuredContent.status, 'written');
  assert.match(readFileSync(join(auditDir, 'filesystem-mcp-audit.jsonl'), 'utf8'), /fs_write_file/);
  const verifyWriteRead = call(writeState, 30, 'fs_read_file', { path: join(trusted, 'b.txt') });
  assert.equal(verifyWriteRead.result.structuredContent.content, 'created');

  const replaceRangeResponse = call(writeState, 31, 'fs_replace_range', { path: join(trusted, 'b.txt'), start_line: 1, end_line: 1, replacement: 'range-edited' });
  assert.equal(replaceRangeResponse.result.structuredContent.status, 'replaced_range');
  assert.equal(readFileSync(join(trusted, 'b.txt'), 'utf8'), 'range-edited');

  writeFileSync(join(trusted, 'patch.txt'), 'one\ntwo\n', 'utf8');
  const patchResponse = call(writeState, 32, 'fs_apply_patch', { patch: `--- patch.txt\n+++ patch.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+patched\n` });
  assert.equal(patchResponse.result.structuredContent.status, 'patched');
  assert.equal(readFileSync(join(trusted, 'patch.txt'), 'utf8'), 'one\npatched\n');

  writeFileSync(join(trusted, 'patch-a.txt'), 'one\ntwo\n', 'utf8');
  writeFileSync(join(trusted, 'patch-b.txt'), 'red\nblue\n', 'utf8');
  const badPatch = call(writeState, 33, 'fs_apply_patch', { patch: `--- patch-a.txt\n+++ patch-a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+changed\n--- patch-b.txt\n+++ patch-b.txt\n@@ -1,2 +1,2 @@\n red\n-missing\n+changed\n` });
  assert.match(badPatch.error.message, /patch_remove_mismatch/);
  assert.equal(readFileSync(join(trusted, 'patch-a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(readFileSync(join(trusted, 'patch-b.txt'), 'utf8'), 'red\nblue\n');

  const moveResponse = call(writeState, 4, 'fs_move_path', { from: join(trusted, 'b.txt'), to: join(trusted, 'renamed.txt') });
  assert.equal(moveResponse.result.structuredContent.status, 'moved');
  assert.match(readFileSync(join(auditDir, 'filesystem-mcp-audit.jsonl'), 'utf8'), /fs_move_path/);

  const overwriteBlocked = call(writeState, 5, 'fs_move_path', { from: join(trusted, 'renamed.txt'), to: join(trusted, 'a.txt') });
  assert.match(overwriteBlocked.error.message, /move_destination_exists/);
  writeFileSync(join(trusted, 'overwrite-source.txt'), 'source', 'utf8');
  writeFileSync(join(trusted, 'overwrite-dest.txt'), 'dest', 'utf8');
  const overwriteMove = call(writeState, 6, 'fs_move_path', { from: join(trusted, 'overwrite-source.txt'), to: join(trusted, 'overwrite-dest.txt'), overwrite: true });
  assert.equal(overwriteMove.result.structuredContent.overwrite, true);
  assert.equal(readFileSync(join(trusted, 'overwrite-dest.txt'), 'utf8'), 'source');

  const sameMove = call(writeState, 7, 'fs_move_path', { from: join(trusted, 'overwrite-dest.txt'), to: join(trusted, 'overwrite-dest.txt') });
  assert.match(sameMove.error.message, /move_source_and_destination_same/);
  mkdirSync(join(trusted, 'dir-source'), { recursive: true });
  writeFileSync(join(trusted, 'dir-source', 'child.txt'), 'child', 'utf8');
  const insideMove = call(writeState, 8, 'fs_move_path', { from: join(trusted, 'dir-source'), to: join(trusted, 'dir-source', 'nested') });
  assert.match(insideMove.error.message, /move_destination_inside_source/);
  mkdirSync(join(trusted, 'dir-dest'), { recursive: true });
  writeFileSync(join(trusted, 'file-source.txt'), 'file', 'utf8');
  const typeMismatchMove = call(writeState, 9, 'fs_move_path', { from: join(trusted, 'file-source.txt'), to: join(trusted, 'dir-dest'), overwrite: true });
  assert.match(typeMismatchMove.error.message, /move_destination_type_mismatch/);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('local filesystem MCP tests passed');
