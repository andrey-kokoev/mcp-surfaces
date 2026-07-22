import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const files = [...walk(join(packageRoot, 'src')), ...walk(join(packageRoot, 'test'))]
  .filter((file) => file.endsWith('.js'))
  .filter((file) => !file.endsWith('syntax-check-all.js'));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(`syntax check failed: ${relative(packageRoot, file)}\n`);
    process.stderr.write(result.stderr || result.stdout || '');
    process.exit(result.status ?? 1);
  }
}

console.log(`task-lifecycle-mcp syntax ok (${files.length} files)`);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}
