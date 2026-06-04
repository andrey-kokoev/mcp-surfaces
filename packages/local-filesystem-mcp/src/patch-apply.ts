export function parsePatch(patch, context = {}) {
  const contextRecord = context as { diagnosticError?: unknown };
  const diagnosticError = typeof contextRecord.diagnosticError === 'function' ? contextRecord.diagnosticError : defaultDiagnosticError;
  const firstNonEmptyLine = splitLines(patch)[0] ?? '';
  if (firstNonEmptyLine === '*** Begin Patch') return parseCodexApplyPatch(patch, { diagnosticError });
  return parseUnifiedPatch(patch, { diagnosticError });
}

export function applyFilePatch(before, filePatch, { diagnosticError }) {
  if (filePatch.kind === 'codex_add') return applyCodexAddPatch(filePatch, { diagnosticError });
  if (filePatch.kind === 'codex_update') return applyCodexUpdatePatch(before, filePatch, { diagnosticError });
  const hadTrailingNewline = /\r?\n$/.test(before);
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const source = before.length === 0 ? [] : before.replace(/\r?\n$/, '').split(/\r?\n/);
  const output = [];
  let sourceIndex = 0;
  for (const hunk of filePatch.hunks) {
    const hunkStart = hunk.oldStart - 1;
    while (sourceIndex < hunkStart) output.push(source[sourceIndex++]);
    for (const line of hunk.lines) {
      const kind = line[0];
      const text = line.slice(1);
      if (kind === ' ') {
        if (source[sourceIndex] !== text) throw diagnosticError('patch_context_mismatch', `patch_context_mismatch: expected ${JSON.stringify(text)} got ${JSON.stringify(source[sourceIndex])}`, { expected: text, actual: source[sourceIndex] ?? null });
        output.push(source[sourceIndex++]);
      } else if (kind === '-') {
        if (source[sourceIndex] !== text) throw diagnosticError('patch_remove_mismatch', `patch_remove_mismatch: expected ${JSON.stringify(text)} got ${JSON.stringify(source[sourceIndex])}`, { expected: text, actual: source[sourceIndex] ?? null });
        sourceIndex += 1;
      } else if (kind === '+') {
        output.push(text);
      } else {
        throw diagnosticError('patch_line_kind_unsupported', `patch_line_kind_unsupported: ${kind}`, { kind });
      }
    }
  }
  while (sourceIndex < source.length) output.push(source[sourceIndex++]);
  return `${output.join(newline)}${hadTrailingNewline ? newline : ''}`;
}

export function applyDeletePatch(before, filePatch, { diagnosticError }) {
  if (filePatch.kind === 'codex_delete') return null;
  const source = before.length === 0 ? [] : before.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const hunk of filePatch.hunks) {
    const hunkStart = hunk.oldStart - 1;
    let sourceIndex = hunkStart;
    for (const line of hunk.lines) {
      const kind = line[0];
      const text = line.slice(1);
      if (kind === '-' || kind === ' ') {
        if (source[sourceIndex] !== text) {
          throw diagnosticError('patch_delete_content_mismatch', `patch_delete_content_mismatch: expected ${JSON.stringify(text)} got ${JSON.stringify(source[sourceIndex])}`, {
            expected: text,
            actual: source[sourceIndex] ?? null,
          });
        }
        sourceIndex += 1;
      } else if (kind === '+') {
        throw diagnosticError('patch_delete_content_mismatch', 'patch_delete_content_mismatch: delete patch contains added lines');
      }
    }
  }
  const removedLineCount = filePatch.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('-') || line.startsWith(' ')).length, 0);
  if (removedLineCount !== source.length) {
    throw diagnosticError('patch_delete_content_mismatch', 'patch_delete_content_mismatch: delete patch does not cover full file', {
      removed_lines: removedLineCount,
      total_lines: source.length,
    });
  }
  return null;
}

function parseUnifiedPatch(patch, { diagnosticError }) {
  const lines = patch.split(/\r?\n/);
  const files = [];
  let current = null;
  let currentHunk = null;
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      current = { oldPath: parsePatchHeaderPath(line.slice(4)), newPath: null, hunks: [] };
      files.push(current);
      currentHunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current) throw diagnosticError('patch_new_file_without_old_file_header', patch, {
        expected_format: 'unified_diff_or_codex_apply_patch',
        expected_headers: ['--- <path>', '+++ <path>', '@@ -old,+new @@'],
      });
      current.newPath = parsePatchHeaderPath(line.slice(4));
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (!current?.newPath) throw diagnosticError('patch_hunk_without_file_header', patch, {
        expected_format: 'unified_diff_or_codex_apply_patch',
        expected_headers: ['--- <path>', '+++ <path>', '@@ -old,+new @@'],
      });
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? '1'),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? '1'),
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk && (/^[ +\-]/.test(line) || line === '\\ No newline at end of file')) {
      if (line !== '\\ No newline at end of file') currentHunk.lines.push(line);
    }
  }
  return files
    .filter((file) => file.newPath && (file.hunks.length > 0 || file.newPath === '/dev/null'))
    .map((file) => ({ ...file, deleteFile: file.newPath === '/dev/null' }));
}

function parseCodexApplyPatch(patch, { diagnosticError }) {
  const lines = patch.split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  const files = [];
  let current = null;
  let currentHunk = null;
  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (line === '' && lineNumber === lines.length) continue;
    if (line.trim().length === 0 && lineNumber - 1 < firstContentIndex) continue;
    if (line === '*** Begin Patch') {
      if (lineNumber - 1 !== firstContentIndex) throw codexLineDiagnostic(diagnosticError, 'patch_begin_marker_not_first', patch, line, lineNumber);
      continue;
    }
    if (line === '*** End Patch') {
      if (lineNumber !== lines.length && !(lineNumber === lines.length - 1 && lines[lineNumber] === '')) {
        throw codexLineDiagnostic(diagnosticError, 'patch_trailing_content_after_end_patch', patch, line, lineNumber);
      }
      continue;
    }
    if (line === '*** End of File') {
      if (!current || current.kind !== 'codex_update') throw codexLineDiagnostic(diagnosticError, 'patch_end_of_file_without_update_file', patch, line, lineNumber);
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      current = { kind: 'codex_add', oldPath: '/dev/null', newPath: normalizePatchPath(line.slice(14).trim()), hunks: [{ kind: 'codex_add', lines: [] }], deleteFile: false };
      currentHunk = current.hunks[0];
      files.push(current);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      current = { kind: 'codex_delete', oldPath: normalizePatchPath(line.slice(17).trim()), newPath: '/dev/null', hunks: [], deleteFile: true };
      currentHunk = null;
      files.push(current);
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      current = { kind: 'codex_update', oldPath: normalizePatchPath(line.slice(17).trim()), newPath: normalizePatchPath(line.slice(17).trim()), hunks: [], deleteFile: false };
      currentHunk = null;
      files.push(current);
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (!current || current.kind !== 'codex_update') throw diagnosticError('patch_move_without_update_file', patch, {
        expected_format: 'codex_apply_patch',
        expected_headers: ['*** Begin Patch', '*** Update File: <path>', '*** Move to: <path>', '*** End Patch'],
      });
      current.newPath = normalizePatchPath(line.slice(13).trim());
      continue;
    }
    if (line === '@@' || line.startsWith('@@ ')) {
      if (!current || current.kind !== 'codex_update') throw diagnosticError('patch_hunk_without_file_header', patch, {
        expected_format: 'unified_diff_or_codex_apply_patch',
        expected_headers: ['--- <path>', '+++ <path>', '@@ -old,+new @@', '*** Begin Patch', '*** Update File: <path>'],
      });
      currentHunk = { kind: 'codex_update', lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) throw codexLineDiagnostic(diagnosticError, 'patch_unexpected_line_outside_hunk', patch, line, lineNumber);
    if (current.kind === 'codex_add') {
      if (!line.startsWith('+')) throw codexLineDiagnostic(diagnosticError, 'patch_add_line_kind_unsupported', patch, line, lineNumber);
      currentHunk.lines.push(line);
      continue;
    }
    if (/^[ +\-]/.test(line)) {
      currentHunk.lines.push(line);
      continue;
    }
    throw codexLineDiagnostic(diagnosticError, 'patch_line_kind_unsupported', patch, line, lineNumber);
  }
  return files.filter((file) => file.deleteFile || file.hunks.length > 0);
}

function applyCodexAddPatch(filePatch, { diagnosticError }) {
  const lines = filePatch.hunks.flatMap((hunk) => hunk.lines.map((line) => {
    if (!line.startsWith('+')) throw diagnosticError('patch_add_line_kind_unsupported', `patch_add_line_kind_unsupported: ${line[0] ?? ''}`, { kind: line[0] ?? null });
    return line.slice(1);
  }));
  return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

function applyCodexUpdatePatch(before, filePatch, { diagnosticError }) {
  const hadTrailingNewline = /\r?\n$/.test(before);
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  let source = before.length === 0 ? [] : before.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const hunk of filePatch.hunks) {
    const oldLines = [];
    const newLines = [];
    for (const line of hunk.lines) {
      const kind = line[0];
      const text = line.slice(1);
      if (kind === ' ') {
        oldLines.push(text);
        newLines.push(text);
      } else if (kind === '-') {
        oldLines.push(text);
      } else if (kind === '+') {
        newLines.push(text);
      } else {
        throw diagnosticError('patch_line_kind_unsupported', `patch_line_kind_unsupported: ${kind}`, { kind });
      }
    }
    const index = findLineBlock(source, oldLines);
    if (index < 0) throw diagnosticError('patch_context_mismatch', 'patch_context_mismatch: codex update hunk did not match file content', { expected_lines: oldLines });
    source = [...source.slice(0, index), ...newLines, ...source.slice(index + oldLines.length)];
  }
  return `${source.join(newline)}${hadTrailingNewline ? newline : ''}`;
}

function findLineBlock(source, block) {
  if (block.length === 0) return 0;
  for (let index = 0; index <= source.length - block.length; index += 1) {
    if (block.every((line, offset) => source[index + offset] === line)) return index;
  }
  return -1;
}

function parsePatchHeaderPath(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '/dev/null') return trimmed;
  const quoted = trimmed.match(/^"((?:\\.|[^"])*)"/);
  if (quoted) return quoted[1].replace(/\\"/g, '"');
  const tabIndex = trimmed.indexOf('\t');
  if (tabIndex >= 0) return trimmed.slice(0, tabIndex);
  return trimmed.split(/\s+/)[0] ?? '';
}

function normalizePatchPath(path) {
  if (/^[A-Za-z]:\//.test(path)) return path;
  if (/^[A-Za-z]:\\/.test(path)) return path.replace(/\\/g, '/');
  return path.replace(/\\/g, '/');
}

function codexLineDiagnostic(diagnosticError, codeName, patch, line, lineNumber) {
  throw diagnosticError(codeName, patch, {
    expected_format: 'codex_apply_patch',
    line,
    line_number: lineNumber,
  });
}

function defaultDiagnosticError(codeName, patch, details = {}) {
  const error = new Error(`${codeName}: invalid patch syntax`) as Error & { codeName?: string; details?: unknown };
  error.name = 'PatchApplyError';
  error.codeName = codeName;
  error.details = {
    ...details,
    patch_length: String(patch ?? '').length,
  };
  return error;
}

function splitLines(value) {
  return String(value ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0);
}
