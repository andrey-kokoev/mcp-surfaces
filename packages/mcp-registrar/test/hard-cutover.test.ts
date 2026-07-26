import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  buildHardCutoverJournal,
  discardPreparedHardCutover,
  digestText,
  parseHardCutoverJournal,
  readHardCutoverJournal,
  runHardCutoverCoordinator,
  writeHardCutoverJournal,
  writeStagedCutoverFile,
} from '../src/hard-cutover.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-hard-cutover-'));
  const stagingRoot = join(root, 'cutovers', 'cutover-1');
  const journalPath = join(root, 'cutovers', 'active.json');
  const generationRoot = join(root, 'generations');
  const artifactStore = join(root, 'artifact-store');
  const activeGeneration = join(generationRoot, 'carrier-a', 'active.json');
  const oldGeneration = join(generationRoot, 'carrier-a', 'old.json');
  const configPath = join(root, 'carrier', 'config.json');
  const stagedConfig = join(stagingRoot, 'configs', 'carrier-a.config');
  const activationPath = join(root, 'activations', 'cutover-1.json');
  const legacyPath = `${configPath}.narada-generation.json`;
  const activeGenerationContent = '{"generation":"active"}\n';
  const content = '{"mcpServers":{"sealed":true}}\n';
  mkdirSync(dirname(activeGeneration), { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(activeGeneration, activeGenerationContent);
  writeFileSync(oldGeneration, '{"generation":"old"}\n');
  const priorContent = '{"mcpServers":{"legacy":true}}\n';
  writeFileSync(configPath, priorContent);
  writeFileSync(legacyPath, '{"legacy":true}\n');
  const configDigest = writeStagedCutoverFile(stagedConfig, content);
  const now = '2026-07-25T20:00:00.000Z';
  const journal = buildHardCutoverJournal({
    cutover_id: 'cutover-1',
    state: 'prepared',
    created_at: now,
    updated_at: now,
    attempt_count: 0,
    last_error: null,
    staging_root: stagingRoot,
    generation_root: generationRoot,
    artifact_store: artifactStore,
    activation: {
      marker_path: activationPath,
      activation_token: 'activation-token',
      token_digest: digestText('activation-token'),
    },
    diagnostics_dir: join(root, 'diagnostics'),
    legacy_runtime_root: root,
    legacy_paths: [legacyPath],
    coordinator: {
      node_executable: process.execPath,
      entrypoint_path: join(artifactStore, 'closures', 'fixture', 'dist', 'src', 'cutover-coordinator.js'),
      artifact_entrypoint: 'dist/src/cutover-coordinator.js',
      artifact_selector: {
        mode: 'latest_compatible',
        store_root: artifactStore,
        package_name: '@narada2/mcp-registrar',
        compatibility: {
          descriptor_digest: `sha256:${'2'.repeat(64)}`,
          interface_digest: `sha256:${'3'.repeat(64)}`,
          artifact_profile: 'mcp-surface-v3',
        },
        source_policy: 'require_fresh',
      },
      closure_digest: `sha256:${'4'.repeat(64)}`,
      receipt_digest: `sha256:${'5'.repeat(64)}`,
      source: {
        package_root: join(root, 'source', 'mcp-registrar'),
        workspace_root: join(root, 'source'),
      },
    },
    targets: [{
      carrier_id: 'carrier-a',
      config_path: configPath,
      prior_config_digest: digestText(priorContent),
      staged_config_path: stagedConfig,
      config_digest: configDigest,
      generation_path: activeGeneration,
      generation_digest: digestText(activeGenerationContent),
    }],
    active_selectors: [],
  });
  writeHardCutoverJournal(journalPath, journal, true);
  return {
    root,
    journalPath,
    stagingRoot,
    configPath,
    stagedConfig,
    content,
    activeGeneration,
    oldGeneration,
    activationPath,
    legacyPath,
    priorContent,
  };
}

test('external coordinator performs one forward-only activation and reclaims old state', async () => {
  const input = fixture();
  try {
    assert.equal(existsSync(input.activationPath), false);
    const result = await runHardCutoverCoordinator(input.journalPath);
    assert.equal(result.status, 'complete');
    assert.equal(readFileSync(input.configPath, 'utf8'), input.content);
    assert.equal(existsSync(input.legacyPath), true);
    assert.equal(existsSync(input.oldGeneration), false);
    assert.equal(existsSync(input.activeGeneration), true);
    assert.equal(existsSync(input.activationPath), true);
    assert.equal(existsSync(input.journalPath), false);
    assert.equal(existsSync(input.stagingRoot), false);
    assert.equal(
      existsSync(`${input.configPath}.backup-2026-07-25`),
      false,
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('failed preflight retains the predecessor and a resumable journal', async () => {
  const input = fixture();
  try {
    writeFileSync(input.stagedConfig, 'corrupt\n');
    await assert.rejects(runHardCutoverCoordinator(input.journalPath));
    const failed = readHardCutoverJournal(input.journalPath);
    assert.equal(failed.state, 'prepared');
    assert.equal(failed.last_error?.code, 'hard_cutover_staged_config_corrupt');
    assert.equal(readFileSync(input.configPath, 'utf8'), '{"mcpServers":{"legacy":true}}\n');
    assert.equal(existsSync(input.legacyPath), false);

    writeFileSync(input.stagedConfig, input.content);
    const resumed = await runHardCutoverCoordinator(input.journalPath);
    assert.equal(resumed.status, 'complete');
    assert.equal(readFileSync(input.configPath, 'utf8'), input.content);
    assert.equal(existsSync(input.journalPath), false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('coordinator refuses to overwrite a carrier config changed after preparation', async () => {
  const input = fixture();
  try {
    const changed = '{"user_setting":"changed-after-prepare"}\n';
    writeFileSync(input.configPath, changed);
    await assert.rejects(
      runHardCutoverCoordinator(input.journalPath),
      (error: unknown) => (
        error instanceof Error
        && (error as Error & { code?: string }).code === 'hard_cutover_target_config_changed'
      ),
    );
    const failed = readHardCutoverJournal(input.journalPath);
    assert.equal(failed.state, 'prepared');
    assert.equal(failed.last_error?.code, 'hard_cutover_target_config_changed');
    assert.equal(readFileSync(input.configPath, 'utf8'), changed);
    assert.equal(existsSync(input.legacyPath), true);
    assert.equal(existsSync(input.activationPath), false);

    writeFileSync(input.configPath, input.priorContent);
    const resumed = await runHardCutoverCoordinator(input.journalPath);
    assert.equal(resumed.status, 'complete');
    assert.equal(readFileSync(input.configPath, 'utf8'), input.content);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('journal parser rejects malformed structure and unknown states with one stable error', () => {
  assert.throws(
    () => parseHardCutoverJournal({ journal_digest: `sha256:${'0'.repeat(64)}` }),
    (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code === 'hard_cutover_journal_invalid'
    ),
  );

  const input = fixture();
  try {
    const valid = readHardCutoverJournal(input.journalPath);
    assert.throws(
      () => buildHardCutoverJournal({ ...valid, state: 'unknown' as never }),
      (error: unknown) => (
        error instanceof Error
        && (error as Error & { code?: string }).code === 'hard_cutover_journal_invalid'
      ),
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('coordinator refuses a journal lock owned by a live process', async () => {
  const input = fixture();
  const lockPath = `${input.journalPath}.lock`;
  try {
    writeFileSync(lockPath, `${JSON.stringify({
      schema: 'narada.mcp_hard_cutover.lock.v3',
      pid: process.pid,
      token: 'other-coordinator',
      acquired_at: new Date().toISOString(),
    })}\n`);
    await assert.rejects(
      runHardCutoverCoordinator(input.journalPath),
      (error: unknown) => (
        error instanceof Error
        && (error as Error & { code?: string }).code === 'hard_cutover_coordinator_locked'
      ),
    );
    assert.equal(existsSync(input.journalPath), true);
    assert.equal(readHardCutoverJournal(input.journalPath).state, 'prepared');
  } finally {
    rmSync(lockPath, { force: true });
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('discard removes only inert preparation state before cutover begins', () => {
  const input = fixture();
  try {
    const result = discardPreparedHardCutover(input.journalPath);
    assert.equal(result.status, 'discarded');
    assert.equal(readFileSync(input.configPath, 'utf8'), input.priorContent);
    assert.equal(existsSync(input.legacyPath), true);
    assert.equal(existsSync(input.activationPath), false);
    assert.equal(existsSync(input.activeGeneration), false);
    assert.equal(existsSync(input.stagingRoot), false);
    assert.equal(existsSync(input.journalPath), false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});
