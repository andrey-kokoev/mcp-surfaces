#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { verifyArtifactPin } from '@narada2/artifact-integrity';
import {
  HardCutoverError,
  readHardCutoverJournal,
  runHardCutoverCoordinator,
} from './hard-cutover.js';

function journalArgument(argv: string[]): string {
  const index = argv.indexOf('--journal');
  const value = index >= 0 ? argv[index + 1] : null;
  if (!value) throw new Error('hard_cutover_requires_journal');
  return resolve(value);
}

export async function runCutoverCoordinator(argv = process.argv.slice(2)): Promise<void> {
  const journalPath = journalArgument(argv);
  const journal = readHardCutoverJournal(journalPath);
  const currentEntrypoint = resolve(fileURLToPath(import.meta.url));
  if (
    resolve(process.execPath) !== resolve(journal.coordinator.node_executable)
    || currentEntrypoint !== resolve(journal.coordinator.entrypoint_path)
  ) {
    throw new HardCutoverError(
      'hard_cutover_coordinator_identity_mismatch',
      'Hard cutover must run through the exact sealed coordinator recorded during preparation.',
      {
        expected_node_executable: journal.coordinator.node_executable,
        actual_node_executable: process.execPath,
        expected_entrypoint: journal.coordinator.entrypoint_path,
        actual_entrypoint: currentEntrypoint,
      },
    );
  }
  const artifact = await verifyArtifactPin({
    store_root: journal.coordinator.artifact_selector.store_root,
    package_name: journal.coordinator.artifact_selector.package_name,
    compatibility: journal.coordinator.artifact_selector.compatibility,
    closure_digest: journal.coordinator.closure_digest,
    receipt_digest: journal.coordinator.receipt_digest,
  });
  const resolvedEntrypoint = resolve(
    join(
      artifact.closure_path,
      ...journal.coordinator.artifact_entrypoint.replace(/\\/gu, '/').split('/'),
    ),
  );
  if (
    artifact.closure.closure_digest !== journal.coordinator.closure_digest
    || artifact.receipt.receipt_digest !== journal.coordinator.receipt_digest
    || resolvedEntrypoint !== currentEntrypoint
  ) {
    throw new HardCutoverError(
      'hard_cutover_coordinator_artifact_mismatch',
      'The selected coordinator artifact differs from the sealed preparation identity.',
      {
        expected_closure_digest: journal.coordinator.closure_digest,
        actual_closure_digest: artifact.closure.closure_digest,
        expected_receipt_digest: journal.coordinator.receipt_digest,
        actual_receipt_digest: artifact.receipt.receipt_digest,
        expected_entrypoint: currentEntrypoint,
        actual_entrypoint: resolvedEntrypoint,
      },
    );
  }
  const result = await runHardCutoverCoordinator(journalPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runCutoverCoordinator().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      schema: 'narada.mcp_hard_cutover.error.v3',
      code: typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'hard_cutover_failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
