import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packagesRoot = join(repositoryRoot, 'packages');
const forbiddenRendererPackages = [
  '@narada2/agent-web-ui',
  '@narada2/ui',
  '@narada2/ui-vue',
  '@tailwindcss/vite',
  'react',
  'react-dom',
  'svelte',
  'shadcn-vue',
  'solid-js',
  'tailwindcss',
  'vue',
];

for (const packageRoot of walkDirectories(packagesRoot)) {
  const manifestPath = join(packageRoot, 'package.json');
  if (statSafe(manifestPath)?.isFile()) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const packageName of Object.keys(manifest[field] || {})) {
        assert.equal(
          isForbiddenRendererPackage(packageName),
          false,
          relative(repositoryRoot, manifestPath) + ' declares forbidden renderer dependency ' + packageName
        );
      }
    }
  }

  const sourceRoot = join(packageRoot, 'src');
  if (!statSafe(sourceRoot)?.isDirectory()) continue;
  for (const file of walkFiles(sourceRoot)) {
    if (/\.(?:css|scss|sass|less)$/i.test(file)) {
      assert.fail(relative(repositoryRoot, file) + ' contains forbidden stylesheet source file');
    }
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    const importPattern = /\b(?:from|import|require)\s*(?:\(\s*)?['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      assert.equal(
        isForbiddenRendererPackage(specifier) || /\.(?:css|scss|sass|less)$/i.test(specifier),
        false,
        relative(repositoryRoot, file) + ' imports renderer or stylesheet module ' + specifier
      );
    }
  }
}

console.log('mcp-surfaces UI-neutral boundary ok');

function isForbiddenRendererPackage(specifier) {
  return forbiddenRendererPackages.some((packageName) => specifier === packageName || specifier.startsWith(packageName + '/'));
}

function* walkDirectories(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'coverage') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'src') continue;
      yield path;
      yield* walkDirectories(path);
    }
  }
}

function* walkFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else yield path;
  }
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
