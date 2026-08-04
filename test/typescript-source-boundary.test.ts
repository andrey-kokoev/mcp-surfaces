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
const directSqliteImports = roots.flatMap((root) => findDirectSqliteImports(root));

assert.deepEqual(
  offenders,
  [],
  [
    'mcp-surfaces source boundary violation: authored JavaScript and @ts-nocheck are not allowed.',
    ...offenders.map((path) => relative(repositoryRoot, path)),
  ].join('\n')
);

console.log('mcp-surfaces strict TypeScript source boundary ok');

assert.deepEqual(
  directSqliteImports,
  [],
  [
    'mcp-surfaces SQLite boundary violation: import SQLite through @narada-core/sqlite.',
    ...directSqliteImports.map((path) => relative(repositoryRoot, path)),
  ].join('\n')
);

console.log('mcp-surfaces SQLite import boundary ok');

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

function findDirectSqliteImports(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) files.push(...findDirectSqliteImports(join(directory, entry.name)));
      continue;
    }
    if (!entry.isFile() || !/\.tsx?$/iu.test(entry.name)) continue;
    const filePath = join(directory, entry.name);
    if (filePath === fileURLToPath(import.meta.url)) continue;
    if (/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]node:sqlite['"]/u.test(readFileSync(filePath, 'utf8'))) {
      files.push(filePath);
    }
  }
  return files;
}
