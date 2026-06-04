export function renderToolResultText(value, renderContext: Record<string, unknown> = {}) {
  const record = asRecord(value);
  if (record.schema === 'narada.mcp_output_show.v1') return String(record.output_text ?? '');
  if (record.schema === 'narada.mcp_output_locator.v1' || typeof record.output_ref === 'string') {
    return compactLines([
      `status: ${record.status ?? 'ok'}`,
      'result: materialized',
      `output_ref: ${record.output_ref ?? record.ref ?? ''}`,
      `reader_tool: ${record.reader_tool ?? 'mcp_output_show'}`,
      `render_truncated: ${record.render_truncated ?? record.truncated ?? record.original_truncated ?? true}`,
      record.count !== undefined ? `count: ${record.count ?? 'unknown'}` : null,
      record.count_exact !== undefined ? `count_exact: ${record.count_exact}` : null,
      record.scanned !== undefined ? `scanned: ${record.scanned}` : null,
      record.returned !== undefined ? `returned: ${record.returned}` : null,
      record.has_more !== undefined ? `has_more: ${record.has_more}` : null,
      record.next_offset !== undefined ? `next_offset: ${record.next_offset ?? 'null'}` : null,
      record.full_output_char_length !== undefined ? `full_output_char_length: ${record.full_output_char_length}` : null,
    ]);
  }
  if (isReadFileResult(record)) return renderReadFileResult(record);
  if (record.schema === 'local.filesystem.glob.v1') return renderSearchResult('fs_glob_search', record);
  if (record.schema === 'local.filesystem.grep.v1') return renderSearchResult('fs_grep_search', record, renderContext);
  if (record.schema === 'local.filesystem.apply_patch.v1') {
    const changedFiles = Array.isArray(record.changed_files) ? record.changed_files : [];
    return compactLines([
      `fs_apply_patch: ${record.status ?? 'ok'}`,
      `changed_files: ${changedFiles.length}`,
      ...changedFiles.map((file) => {
        const fileRecord = asRecord(file);
        return `- ${fileRecord.relative_path ?? fileRecord.path ?? ''} deleted=${fileRecord.deleted ?? false} before_sha256=${fileRecord.before_sha256 ?? ''} after_sha256=${fileRecord.after_sha256 ?? 'null'}`;
      }),
    ]);
  }
  if (record.schema || record.status || record.path || record.relative_path || record.type) return renderCompactRecord(record);
  return JSON.stringify(value, null, 2);
}

function isReadFileResult(record) {
  return typeof record.path === 'string'
    && typeof record.content === 'string'
    && typeof record.offset === 'number'
    && typeof record.returned_lines === 'number'
    && typeof record.total_lines === 'number';
}

function renderReadFileResult(record) {
  const startLine = Number(record.offset);
  const returnedLines = Number(record.returned_lines);
  const endLine = returnedLines > 0 ? startLine + returnedLines - 1 : startLine - 1;
  return [
    `path: ${record.path}`,
    `lines: ${startLine}-${endLine} of ${record.total_lines}`,
    `returned_lines: ${record.returned_lines}`,
    `next_offset: ${record.next_offset ?? 'null'}`,
    'content:',
    String(record.content ?? ''),
  ].join('\n');
}

function renderSearchResult(toolName, record, renderContext: Record<string, unknown> = {}) {
  const matches = Array.isArray(record.matches) ? record.matches.map(String) : [];
  const mode = toolName === 'fs_grep_search' ? [`mode: ${record.output_mode ?? renderContext.grepOutputMode ?? 'files_with_matches'}`] : [];
  return compactLines([
    `${toolName}: ${record.status ?? 'ok'}`,
    ...mode,
    `count: ${record.count ?? 'unknown'}`,
    `count_exact: ${record.count_exact ?? true}`,
    record.scanned !== undefined ? `scanned: ${record.scanned}` : null,
    `returned: ${record.returned ?? matches.length}`,
    `has_more: ${record.has_more ?? record.truncated ?? false}`,
    `next_offset: ${record.next_offset ?? 'null'}`,
    'matches:',
    ...matches,
  ]);
}

function renderCompactRecord(record) {
  if (record.schema === 'local.filesystem.stat.v1' || record.type) {
    return compactLines([
      'fs_stat: ok',
      `path: ${record.path ?? ''}`,
      record.relative_path !== undefined ? `relative_path: ${record.relative_path}` : null,
      record.type !== undefined ? `type: ${record.type}` : null,
      record.size !== undefined ? `size: ${record.size}` : null,
      record.mtime !== undefined ? `mtime: ${record.mtime}` : null,
    ]);
  }
  const lines = [
    `${filesystemToolLabel(record)}: ${record.status ?? 'ok'}`,
    record.path !== undefined ? `path: ${record.path}` : null,
    record.relative_path !== undefined ? `relative_path: ${record.relative_path}` : null,
    record.size !== undefined ? `size: ${record.size}` : null,
    record.occurrences !== undefined ? `occurrences: ${record.occurrences}` : null,
    record.start_line !== undefined ? `start_line: ${record.start_line}` : null,
    record.end_line !== undefined ? `end_line: ${record.end_line}` : null,
    record.inserted_lines !== undefined ? `inserted_lines: ${record.inserted_lines}` : null,
    record.recursive !== undefined ? `recursive: ${record.recursive}` : null,
    record.created !== undefined ? `created: ${record.created}` : null,
    record.overwrite !== undefined ? `overwrite: ${record.overwrite}` : null,
    record.before_sha256 !== undefined ? `before_sha256: ${record.before_sha256}` : null,
    record.after_sha256 !== undefined ? `after_sha256: ${record.after_sha256}` : null,
  ];
  const from = asRecord(record.from);
  const to = asRecord(record.to);
  if (from.path || from.relative_path) lines.push(`from: ${from.relative_path ?? from.path}`);
  if (to.path || to.relative_path) lines.push(`to: ${to.relative_path ?? to.path}`);
  return compactLines(lines);
}

function filesystemToolLabel(record) {
  const schema = typeof record.schema === 'string' ? record.schema : '';
  const match = schema.match(/^local\.filesystem\.(.+)\.v1$/);
  return match ? `fs_${match[1]}` : 'fs_result';
}

function compactLines(lines) {
  return lines.filter((line) => typeof line === 'string' && line.length > 0).join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
