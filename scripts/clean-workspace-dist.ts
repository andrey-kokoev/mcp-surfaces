import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagesRoot = join(workspaceRoot, 'packages');
const projectRoots = [
  ...directProjectRoots(packagesRoot),
  ...directProjectRoots(join(packagesRoot, 'shared')),
].sort();
const rootConfig = JSON.parse(readFileSync(join(workspaceRoot, 'tsconfig.json'), 'utf8')) as {
  references?: Array<{ path?: string }>;
};
const referenced = new Set((rootConfig.references ?? [])
  .map((entry) => typeof entry.path === 'string' ? resolve(workspaceRoot, entry.path) : '')
  .filter(Boolean));
const missingReferences = projectRoots.filter((projectRoot) => !referenced.has(projectRoot));
if (missingReferences.length > 0) {
  throw new Error(`workspace_tsconfig_reference_missing:${missingReferences
    .map((projectRoot) => relative(workspaceRoot, projectRoot).replace(/\\/g, '/'))
    .join(',')}`);
}

let removed = 0;
for (const projectRoot of projectRoots) {
  const dist = resolve(projectRoot, 'dist');
  const relativeDist = relative(packagesRoot, dist);
  if (
    basename(dist) !== 'dist'
    || relativeDist.startsWith('..')
    || relativeDist.includes(':')
    || dirname(dist) !== projectRoot
  ) {
    throw new Error(`workspace_dist_cleanup_target_invalid:${dist}`);
  }
  if (!existsSync(dist)) continue;
  await rm(dist, { recursive: true, force: true, maxRetries: 3 });
  removed += 1;
}

process.stdout.write(`${JSON.stringify({
  schema: 'narada.workspace_dist_cleanup.v1',
  status: 'completed',
  project_count: projectRoots.length,
  removed_dist_count: removed,
})}\n`);

function directProjectRoots(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'tsconfig.json')))
    .map((entry) => resolve(directory, entry.name));
}
