import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const roots = ['packages', 'scripts', 'test', 'tools']
  .map((relativeRoot) => join(repositoryRoot, relativeRoot))
  .filter((root): root is string => existsSync(root));

const ignoredDirectoryNames = new Set([
  '.ai',
  '.cache',
  '.git',
  '.narada',
  '.tmp',
  '.tmp-tests',
  'build',
  'coverage',
  'dist',
  'legacy',
  'node_modules',
  'scripts-dist',
  'target',
  'test-results',
]);

const offenders = roots.flatMap((root) => walk(root));

assert.deepEqual(
  offenders,
  [],
  [
    'mcp-surfaces source boundary violation: authored JavaScript and @ts-nocheck are not allowed.',
    ...offenders.map((path) => relative(repositoryRoot, path)),
  ].join('\n')
);

console.log('mcp-surfaces strict TypeScript source boundary ok');

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) files.push(...walk(join(directory, entry.name)));
      continue;
    }
    if (entry.isFile()) {
      const filePath = join(directory, entry.name);
      if (filePath === fileURLToPath(import.meta.url)) continue;
      if (/\.(?:cjs|js|mjs)$/iu.test(entry.name) || (/\.tsx?$/iu.test(entry.name) && readFileSync(filePath, 'utf8').includes('@ts-nocheck'))) {
        files.push(filePath);
      }
    }
  }
  return files;
}
