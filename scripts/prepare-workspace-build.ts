import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type WorkspaceBuildPreparation = {
  schema: 'narada.workspace_build_preparation.v1';
  status: 'ready';
  project_count: number;
  artifact_posture: 'preserve_last_successful_dist';
};

export function prepareWorkspaceBuild(workspaceRoot: string): WorkspaceBuildPreparation {
  const root = resolve(workspaceRoot);
  const packagesRoot = join(root, 'packages');
  const projectRoots = [
    ...directProjectRoots(packagesRoot),
    ...directProjectRoots(join(packagesRoot, 'shared')),
  ].sort();
  const rootConfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as {
    references?: Array<{ path?: string }>;
  };
  const referenced = new Set((rootConfig.references ?? [])
    .map((entry) => typeof entry.path === 'string' ? resolve(root, entry.path) : '')
    .filter(Boolean));
  const missingReferences = projectRoots.filter((projectRoot) => !referenced.has(projectRoot));
  if (missingReferences.length > 0) {
    throw new Error(`workspace_tsconfig_reference_missing:${missingReferences
      .map((projectRoot) => relative(root, projectRoot).replace(/\\/g, '/'))
      .join(',')}`);
  }

  return {
    schema: 'narada.workspace_build_preparation.v1',
    status: 'ready',
    project_count: projectRoots.length,
    artifact_posture: 'preserve_last_successful_dist',
  };
}

function directProjectRoots(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'tsconfig.json')))
    .map((entry) => resolve(directory, entry.name));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  process.stdout.write(`${JSON.stringify(prepareWorkspaceBuild(workspaceRoot))}\n`);
}
