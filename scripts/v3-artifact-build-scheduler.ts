import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';

export type BuildConflictGroup<T> = {
  value: T;
  write_roots: ReadonlySet<string>;
};

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = canonicalPath(leftPath);
  const right = canonicalPath(rightPath);
  if (left === right) return true;
  const leftPrefix = left.endsWith(sep) ? left : `${left}${sep}`;
  const rightPrefix = right.endsWith(sep) ? right : `${right}${sep}`;
  return left.startsWith(rightPrefix) || right.startsWith(leftPrefix);
}

function referencedConfigPath(configPath: string, referencePath: string): string {
  const candidate = resolve(dirname(configPath), referencePath);
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return join(candidate, 'tsconfig.json');
  }
  if (existsSync(candidate)) return candidate;
  const jsonCandidate = `${candidate}.json`;
  return existsSync(jsonCandidate) ? jsonCandidate : join(candidate, 'tsconfig.json');
}

export function typescriptBuildWriteSet(packageRoot: string): ReadonlySet<string> {
  const roots = new Set<string>([canonicalPath(packageRoot)]);
  const visitedConfigs = new Set<string>();
  const visit = (rawConfigPath: string) => {
    const configPath = canonicalPath(rawConfigPath);
    if (visitedConfigs.has(configPath) || !existsSync(configPath)) return;
    visitedConfigs.add(configPath);
    roots.add(canonicalPath(dirname(configPath)));
    const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
    if (parsed.error) {
      throw new Error(
        `v3_artifact_tsconfig_unreadable:${configPath}:`
        + ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'),
      );
    }
    const references = Array.isArray(parsed.config?.references)
      ? parsed.config.references
      : [];
    for (const reference of references) {
      if (typeof reference?.path !== 'string' || !reference.path.trim()) continue;
      visit(referencedConfigPath(configPath, reference.path));
    }
  };
  visit(join(packageRoot, 'tsconfig.json'));
  return roots;
}

export function planConflictFreeWaves<T>(
  groups: Array<BuildConflictGroup<T>>,
  concurrency: number,
): Array<Array<BuildConflictGroup<T>>> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`v3_artifact_concurrency_invalid:${concurrency}`);
  }
  const waves: Array<Array<BuildConflictGroup<T>>> = [];
  const waveWriteRoots: Array<Set<string>> = [];
  for (const group of groups) {
    let selectedWave = -1;
    for (let index = 0; index < waves.length; index += 1) {
      const wave = waves[index]!;
      const roots = waveWriteRoots[index]!;
      if (
        wave.length < concurrency
        && [...group.write_roots].every((root) =>
          [...roots].every((scheduledRoot) => !pathsOverlap(root, scheduledRoot)))
      ) {
        selectedWave = index;
        break;
      }
    }
    if (selectedWave < 0) {
      selectedWave = waves.length;
      waves.push([]);
      waveWriteRoots.push(new Set());
    }
    waves[selectedWave]!.push(group);
    for (const root of group.write_roots) {
      waveWriteRoots[selectedWave]!.add(canonicalPath(root));
    }
  }
  return waves;
}

export async function runConflictFreeWave<T>(
  groups: Array<BuildConflictGroup<T>>,
  run: (group: BuildConflictGroup<T>) => Promise<void>,
): Promise<void> {
  const settled = await Promise.allSettled(groups.map(run));
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}
