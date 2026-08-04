import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareWorkspaceBuild } from '../scripts/prepare-workspace-build.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('routine workspace build never invokes destructive dist cleanup', () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const build = packageJson.scripts?.build ?? '';
  assert.match(build, /prepare-workspace-build\.ts/u);
  assert.match(build, /tsc -b --force/u);
  assert.doesNotMatch(build, /clean-workspace-dist|tsc -b --clean|rimraf|(?:^|\s)rm\s/u);
  assert.equal(existsSync(join(repositoryRoot, 'scripts', 'clean-workspace-dist.ts')), false);
});

test('failed build preparation preserves the last successful runtime artifact', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'mcp-surfaces-build-preparation-'));
  try {
    const projectRoot = join(fixture, 'packages', 'example-mcp');
    const sentinel = join(projectRoot, 'dist', 'src', 'main.js');
    mkdirSync(join(projectRoot, 'dist', 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{}\n');
    writeFileSync(join(fixture, 'tsconfig.json'), '{"files":[],"references":[]}\n');
    writeFileSync(sentinel, 'last-successful-generation\n');

    assert.throws(
      () => prepareWorkspaceBuild(fixture),
      /workspace_tsconfig_reference_missing:packages\/example-mcp/u,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'last-successful-generation\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('successful build preparation is read-only and reports the availability posture', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'mcp-surfaces-build-preparation-'));
  try {
    const projectRoot = join(fixture, 'packages', 'example-mcp');
    const sentinel = join(projectRoot, 'dist', 'src', 'main.js');
    mkdirSync(join(projectRoot, 'dist', 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{}\n');
    writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({
      files: [],
      references: [{ path: './packages/example-mcp' }],
    }));
    writeFileSync(sentinel, 'last-successful-generation\n');

    assert.deepEqual(prepareWorkspaceBuild(fixture), {
      schema: 'narada.workspace_build_preparation.v1',
      status: 'ready',
      project_count: 1,
      artifact_posture: 'preserve_last_successful_dist',
    });
    assert.equal(readFileSync(sentinel, 'utf8'), 'last-successful-generation\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
