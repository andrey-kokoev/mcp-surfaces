type GitStatusEntry = {
  x: string;
  y: string;
  path: string;
  original_path: string | null;
  display_path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
};

export function parseStatus(output: string): Record<string, unknown> {
  const entries = output.split('\0').filter(Boolean);
  const branchLine = entries[0]?.startsWith('## ') ? entries.shift()!.slice(3) : '';
  const branchInfo = parseBranchLine(branchLine);
  const statusEntries: GitStatusEntry[] = [];
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicts: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? '';
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const rawPath = entry.slice(3);
    const originalPath = x === 'R' || x === 'C' ? entries[i + 1] ?? null : null;
    const path = rawPath;
    const displayPath = originalPath ? `${originalPath} <- ${path}` : path;
    if (x === 'R' || x === 'C') i += 1;
    const isUntracked = x === '?' && y === '?';
    const isConflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    const isStaged = x !== ' ' && x !== '?';
    const isUnstaged = y !== ' ' && y !== '?';
    statusEntries.push({
      x,
      y,
      path,
      original_path: originalPath,
      display_path: displayPath,
      staged: isStaged,
      unstaged: isUnstaged,
      untracked: isUntracked,
      conflict: isConflict,
    });
    if (isUntracked) {
      untracked.push(displayPath);
      continue;
    }
    if (isConflict) conflicts.push(displayPath);
    if (isStaged) staged.push(displayPath);
    if (isUnstaged) unstaged.push(displayPath);
  }
  return { ...branchInfo, status_entries: statusEntries, staged, unstaged, untracked, conflicts, clean: staged.length + unstaged.length + untracked.length + conflicts.length === 0 };
}

function parseBranchLine(line: string): Record<string, unknown> {
  const unbornMatch = line.match(/^No commits yet on (.+)$/);
  if (unbornMatch) return { branch: unbornMatch[1], upstream: null, ahead: 0, behind: 0, unborn: true };
  const flagsMatch = line.match(/ \[(.+)\]$/);
  const flags = flagsMatch?.[1] ?? '';
  const withoutFlags = flagsMatch ? line.slice(0, -flagsMatch[0].length) : line;
  const [branch = '', upstream = null] = withoutFlags.split('...', 2);
  const ahead = Number(flags.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(flags.match(/behind (\d+)/)?.[1] ?? 0);
  return { branch: branch || null, upstream, ahead, behind };
}
