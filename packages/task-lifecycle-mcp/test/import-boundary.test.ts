import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(packageRoot, 'src');
const forbidden = [
  '@narada2/task-governance/',
  '@narada2/task-governance\'',
  '@narada2/task-governance"',
  '@narada2/task-lifecycle-kernel',
  '@narada2/control-plane',
];

for (const file of walk(srcRoot)) {
  if (!file.endsWith('.js')) continue;
  const text = readFileSync(file, 'utf8');
  for (const specifier of forbidden) {
    assert.equal(text.includes(specifier), false, `${relative(packageRoot, file)} imports forbidden package ${specifier}`);
  }
}

console.log('task-lifecycle-mcp import boundary ok');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}
