import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  pruneArtifactStore,
  type ArtifactSelector,
  type Sha256Digest,
} from '@narada2/artifact-integrity';
import { canonicalJson, stableDigest } from '@narada2/mcp-fabric-contracts';
import {
  buildCarrierActivationMarker,
  readCarrierGeneration,
  writeCarrierActivationMarkerImmutable,
} from '@narada2/mcp-runtime-proxy/carrier-generation';
import {
  defaultRuntimeDiagnosticsDir,
  processIsAlive,
  terminateRecordedRuntimeInstances,
} from '@narada2/mcp-runtime-proxy/runtime-lifecycle';

export const HARD_CUTOVER_JOURNAL_SCHEMA = 'narada.mcp_hard_cutover.journal.v3' as const;

export type HardCutoverState =
  | 'prepared'
  | 'prepared_validated'
  | 'predecessor_disabled'
  | 'processes_terminated'
  | 'configs_replaced'
  | 'activated'
  | 'reclaimed';

export type HardCutoverTarget = {
  carrier_id: string;
  config_path: string;
  prior_config_digest: Sha256Digest | null;
  staged_config_path: string;
  config_digest: Sha256Digest;
  generation_path: string;
  generation_digest: Sha256Digest;
};

export type HardCutoverCoordinator = {
  node_executable: string;
  entrypoint_path: string;
  artifact_entrypoint: string;
  artifact_selector: ArtifactSelector;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
  source: {
    package_root: string;
    workspace_root: string;
  };
};

export type HardCutoverJournal = {
  schema: typeof HARD_CUTOVER_JOURNAL_SCHEMA;
  cutover_id: string;
  state: HardCutoverState;
  created_at: string;
  updated_at: string;
  attempt_count: number;
  last_error: Record<string, unknown> | null;
  staging_root: string;
  generation_root: string;
  artifact_store: string;
  activation: {
    marker_path: string;
    activation_token: string;
    token_digest: Sha256Digest;
  };
  diagnostics_dir: string;
  legacy_runtime_root: string;
  legacy_paths: string[];
  coordinator: HardCutoverCoordinator;
  targets: HardCutoverTarget[];
  active_selectors: ArtifactSelector[];
  journal_digest: Sha256Digest;
};

export class HardCutoverError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HardCutoverError';
    this.code = code;
    this.details = details;
  }
}

function assertPinnedFileDigest(
  path: string,
  expectedDigest: Sha256Digest,
  code: string,
  message: string,
  details: Record<string, unknown>,
): void {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new HardCutoverError(code, message, { ...details, path });
  }
  const content = readFileSync(path, 'utf8');
  const actualDigest = digestText(content);
  if (actualDigest !== expectedDigest) {
    throw new HardCutoverError(code, message, {
      ...details,
      path,
      expected_digest: expectedDigest,
      actual_digest: actualDigest,
    });
  }
}

/**
 * Validate every input that will be consumed after the destructive boundary.
 * This is deliberately a separate durable state: a failed validation leaves
 * the predecessor intact, while a validated journal is forward-only.
 */
function validatePreparedCutover(journal: HardCutoverJournal): void {
  assertTargetsUnchanged(journal);
  if (existsSync(journal.activation.marker_path)) {
    throw new HardCutoverError(
      'hard_cutover_activation_already_present',
      'The prepared cutover already has an activation marker.',
      { marker_path: journal.activation.marker_path },
    );
  }
  for (const target of journal.targets) {
    assertPinnedFileDigest(
      target.staged_config_path,
      target.config_digest,
      'hard_cutover_staged_config_corrupt',
      'Staged carrier configuration is missing or does not match its prepared digest.',
      { carrier_id: target.carrier_id, staged_config_path: target.staged_config_path },
    );
    assertPinnedFileDigest(
      target.generation_path,
      target.generation_digest,
      'hard_cutover_generation_corrupt',
      'Prepared carrier generation is missing or does not match its prepared digest.',
      { carrier_id: target.carrier_id, generation_path: target.generation_path },
    );
  }
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${stableDigest(value)}`;
}

export function digestText(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function journalUnsigned(
  journal: Omit<HardCutoverJournal, 'journal_digest'>,
): Omit<HardCutoverJournal, 'journal_digest'> {
  return {
    ...journal,
    legacy_paths: [...new Set(journal.legacy_paths.map((path) => resolve(path)))].sort(),
    targets: [...journal.targets].sort((left, right) =>
      left.carrier_id.localeCompare(right.carrier_id)),
    active_selectors: [...journal.active_selectors].sort((left, right) =>
      `${left.package_name}:${stableDigest(left.compatibility)}`
        .localeCompare(`${right.package_name}:${stableDigest(right.compatibility)}`)),
  };
}

export function buildHardCutoverJournal(
  input: Omit<HardCutoverJournal, 'schema' | 'journal_digest'>,
): HardCutoverJournal {
  const { journal_digest: _discardedDigest, schema: _discardedSchema, ...rest } =
    input as unknown as HardCutoverJournal;
  const unsigned = journalUnsigned({
    ...rest,
    schema: HARD_CUTOVER_JOURNAL_SCHEMA,
  } as Omit<HardCutoverJournal, 'journal_digest'>);
  validateHardCutoverJournal(unsigned);
  return { ...unsigned, journal_digest: digest(unsigned) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const HARD_CUTOVER_STATES = new Set<HardCutoverState>([
  'prepared',
  'prepared_validated',
  'predecessor_disabled',
  'processes_terminated',
  'configs_replaced',
  'activated',
  'reclaimed',
]);

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value);
}

function validateHardCutoverJournal(
  journal: Omit<HardCutoverJournal, 'journal_digest'>,
): void {
  const activation = isRecord(journal.activation) ? journal.activation : null;
  const coordinator = isRecord(journal.coordinator) ? journal.coordinator : null;
  const coordinatorSource = coordinator && isRecord(coordinator.source)
    ? coordinator.source
    : null;
  const coordinatorSelector = coordinator && isRecord(coordinator.artifact_selector)
    ? coordinator.artifact_selector
    : null;
  if (
    journal.schema !== HARD_CUTOVER_JOURNAL_SCHEMA
    || typeof journal.cutover_id !== 'string'
    || !journal.cutover_id.trim()
    || !HARD_CUTOVER_STATES.has(journal.state)
    || typeof journal.created_at !== 'string'
    || !Number.isFinite(Date.parse(journal.created_at))
    || typeof journal.updated_at !== 'string'
    || !Number.isFinite(Date.parse(journal.updated_at))
    || !Number.isSafeInteger(journal.attempt_count)
    || journal.attempt_count < 0
    || (journal.last_error !== null && !isRecord(journal.last_error))
    || !Array.isArray(journal.targets)
    || journal.targets.length === 0
    || !journal.targets.every(isRecord)
    || !Array.isArray(journal.legacy_paths)
    || !journal.legacy_paths.every((path) => typeof path === 'string')
    || !Array.isArray(journal.active_selectors)
    || !journal.active_selectors.every(isRecord)
    || !isAbsolutePath(journal.staging_root)
    || !isAbsolutePath(journal.generation_root)
    || !isAbsolutePath(journal.artifact_store)
    || !activation
    || !isAbsolutePath(activation.marker_path)
    || typeof activation.activation_token !== 'string'
    || !activation.activation_token
    || !isDigest(activation.token_digest)
    || !isAbsolutePath(journal.diagnostics_dir)
    || !isAbsolutePath(journal.legacy_runtime_root)
    || activation.token_digest !== digestText(activation.activation_token)
    || !coordinator
    || !isAbsolutePath(coordinator.node_executable)
    || !isAbsolutePath(coordinator.entrypoint_path)
    || !pathInside(journal.artifact_store, coordinator.entrypoint_path)
    || typeof coordinator.artifact_entrypoint !== 'string'
    || !coordinator.artifact_entrypoint
    || isAbsolute(coordinator.artifact_entrypoint)
    || coordinator.artifact_entrypoint.replace(/\\/gu, '/').split('/').includes('..')
    || !coordinator.entrypoint_path.replace(/\\/gu, '/')
      .endsWith(`/${coordinator.artifact_entrypoint.replace(/\\/gu, '/')}`)
    || !isDigest(coordinator.closure_digest)
    || !isDigest(coordinator.receipt_digest)
    || !coordinatorSource
    || !isAbsolutePath(coordinatorSource.package_root)
    || !isAbsolutePath(coordinatorSource.workspace_root)
    || !coordinatorSelector
  ) {
    throw new HardCutoverError(
      'hard_cutover_journal_invalid',
      'Hard-cutover journal is incomplete or inconsistent.',
    );
  }
  const coordinatorCompatibility = isRecord(coordinatorSelector.compatibility)
    ? coordinatorSelector.compatibility
    : null;
  if (
    coordinatorSelector.mode !== 'latest_compatible'
    || coordinatorSelector.source_policy !== 'require_fresh'
    || resolve(String(coordinatorSelector.store_root)) !== resolve(journal.artifact_store)
    || typeof coordinatorSelector.package_name !== 'string'
    || !coordinatorSelector.package_name
    || !coordinatorCompatibility
    || !isDigest(coordinatorCompatibility.descriptor_digest)
    || !isDigest(coordinatorCompatibility.interface_digest)
    || typeof coordinatorCompatibility.artifact_profile !== 'string'
    || !coordinatorCompatibility.artifact_profile
  ) {
    throw new HardCutoverError(
      'hard_cutover_journal_invalid',
      'Hard-cutover coordinator artifact identity is invalid.',
    );
  }
  const carrierIds = new Set<string>();
  const configPaths = new Set<string>();
  const generationPaths = new Set<string>();
  for (const target of journal.targets) {
    if (
      typeof target.carrier_id !== 'string'
      || !target.carrier_id.trim()
      || carrierIds.has(target.carrier_id)
      || !isAbsolutePath(target.config_path)
      || !isAbsolutePath(target.staged_config_path)
      || !isAbsolutePath(target.generation_path)
      || configPaths.has(resolve(target.config_path))
      || generationPaths.has(resolve(target.generation_path))
      || !pathInside(journal.staging_root, target.staged_config_path)
      || !pathInside(journal.generation_root, target.generation_path)
      || (
        target.prior_config_digest !== null
        && !isDigest(target.prior_config_digest)
      )
      || !isDigest(target.config_digest)
      || !isDigest(target.generation_digest)
    ) {
      throw new HardCutoverError(
        'hard_cutover_journal_invalid',
        'Hard-cutover target is duplicated or outside its admitted roots.',
        { carrier_id: target.carrier_id },
      );
    }
    carrierIds.add(target.carrier_id);
    configPaths.add(resolve(target.config_path));
    generationPaths.add(resolve(target.generation_path));
  }
  if (!pathInside(dirname(journal.generation_root), journal.activation.marker_path)) {
    throw new HardCutoverError(
      'hard_cutover_journal_invalid',
      'Activation marker is outside the runtime V3 authority root.',
      { marker_path: journal.activation.marker_path },
    );
  }
  const configDirectories = journal.targets.map((target) => dirname(resolve(target.config_path)));
  for (const legacyPath of journal.legacy_paths) {
    if (
      !pathInside(journal.legacy_runtime_root, legacyPath)
      && !configDirectories.some((directory) => pathInside(directory, legacyPath))
    ) {
      throw new HardCutoverError(
        'hard_cutover_cleanup_path_refused',
        'Legacy cleanup path is outside the admitted runtime and carrier roots.',
        { legacy_path: legacyPath },
      );
    }
  }
  for (const selector of journal.active_selectors) {
    const compatibility = isRecord(selector.compatibility) ? selector.compatibility : null;
    if (
      selector.mode !== 'latest_compatible'
      || selector.source_policy !== 'require_fresh'
      || !isAbsolutePath(selector.store_root)
      || typeof selector.package_name !== 'string'
      || !selector.package_name.trim()
      || !compatibility
      || !isDigest(compatibility.descriptor_digest)
      || !isDigest(compatibility.interface_digest)
      || typeof compatibility.artifact_profile !== 'string'
      || !compatibility.artifact_profile
      || resolve(selector.store_root) !== resolve(journal.artifact_store)
    ) {
      throw new HardCutoverError(
        'hard_cutover_journal_invalid',
        'An active artifact selector is invalid or belongs to another artifact store.',
        { package_name: selector.package_name },
      );
    }
  }
}

export function parseHardCutoverJournal(value: unknown): HardCutoverJournal {
  if (!isRecord(value) || typeof value.journal_digest !== 'string') {
    throw new HardCutoverError(
      'hard_cutover_journal_invalid',
      'Hard-cutover journal is not an object with a digest.',
    );
  }
  const unsigned = { ...value };
  delete unsigned.journal_digest;
  const journal = unsigned as unknown as Omit<HardCutoverJournal, 'journal_digest'>;
  validateHardCutoverJournal(journal);
  const expected = digest(journalUnsigned(journal));
  if (value.journal_digest !== expected) {
    throw new HardCutoverError(
      'hard_cutover_journal_invalid',
      'Hard-cutover journal digest does not match its contents.',
    );
  }
  return { ...journalUnsigned(journal), journal_digest: expected };
}

function syncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    // Windows does not support fsync on directory handles; EPERM is that
    // platform capability refusal, while all other errors remain fatal.
    if (!['EINVAL', 'EISDIR', 'EBADF', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(code)) {
      throw error;
    }
  }
}

function atomicDurableWrite(path: string, content: string, createOnly = false): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const targetMode = existsSync(target) ? statSync(target).mode : null;
  let descriptor = openSync(temporary, 'wx');
  try {
    writeFileSync(descriptor, content, 'utf8');
    if (targetMode !== null) fchmodSync(descriptor, targetMode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = -1;
    if (createOnly) {
      try {
        linkSync(temporary, target);
      } catch (error) {
        if (existsSync(target)) {
          throw new HardCutoverError(
            'hard_cutover_already_active',
            'Another hard cutover already has an active journal.',
            { journal_path: target },
            { cause: error },
          );
        }
        throw error;
      }
    } else {
      renameSync(temporary, target);
    }
    syncDirectory(dirname(target));
  } catch (error) {
    throw error;
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function writeStagedCutoverFile(path: string, content: string): Sha256Digest {
  atomicDurableWrite(path, content, true);
  return digestText(content);
}

export function writeHardCutoverJournal(
  path: string,
  journalValue: HardCutoverJournal,
  createOnly = false,
): void {
  const journal = parseHardCutoverJournal(journalValue);
  atomicDurableWrite(path, `${canonicalJson(journal)}\n`, createOnly);
}

export function readHardCutoverJournal(path: string): HardCutoverJournal {
  try {
    return parseHardCutoverJournal(JSON.parse(readFileSync(resolve(path), 'utf8')));
  } catch (error) {
    if (error instanceof HardCutoverError) throw error;
    throw new HardCutoverError(
      'hard_cutover_journal_missing',
      'Hard-cutover journal is missing or unreadable.',
      { journal_path: resolve(path) },
      { cause: error },
    );
  }
}

function replaceTargetFromStage(target: HardCutoverTarget): void {
  const stagedContent = readFileSync(target.staged_config_path, 'utf8');
  if (digestText(stagedContent) !== target.config_digest) {
    throw new HardCutoverError(
      'hard_cutover_staged_config_corrupt',
      'Staged carrier configuration digest does not match.',
      { carrier_id: target.carrier_id, staged_config_path: target.staged_config_path },
    );
  }
  if (
    existsSync(target.config_path)
    && digestText(readFileSync(target.config_path, 'utf8')) === target.config_digest
  ) {
    return;
  }
  const currentDigest = existsSync(target.config_path)
    ? digestText(readFileSync(target.config_path, 'utf8'))
    : null;
  if (currentDigest !== target.prior_config_digest) {
    throw new HardCutoverError(
      'hard_cutover_target_config_changed',
      'Carrier configuration changed after hard-cutover preparation; refusing to overwrite it.',
      {
        carrier_id: target.carrier_id,
        config_path: target.config_path,
        prepared_from_digest: target.prior_config_digest,
        current_digest: currentDigest,
      },
    );
  }
  atomicDurableWrite(target.config_path, stagedContent);
}

function assertTargetsUnchanged(journal: HardCutoverJournal): void {
  for (const target of journal.targets) {
    const currentDigest = existsSync(target.config_path)
      ? digestText(readFileSync(target.config_path, 'utf8'))
      : null;
    if (
      currentDigest !== target.prior_config_digest
      && currentDigest !== target.config_digest
    ) {
      throw new HardCutoverError(
        'hard_cutover_target_config_changed',
        'Carrier configuration changed after hard-cutover preparation; refusing to begin cutover.',
        {
          carrier_id: target.carrier_id,
          config_path: target.config_path,
          prepared_from_digest: target.prior_config_digest,
          current_digest: currentDigest,
        },
      );
    }
  }
}

function pruneReplacedCarrierGenerations(
  journal: HardCutoverJournal,
  retainedPaths: string[],
): {
  removed_generation_paths: string[];
  removed_activation_marker_paths: string[];
} {
  const generationRoot = resolve(journal.generation_root);
  const retained = new Set(retainedPaths.map((path) => resolve(path)));
  const removable: string[] = [];
  const candidateActivationMarkers = new Set<string>();
  const carrierDirectories = new Set(
    retainedPaths
      .map((path) => dirname(resolve(path)))
      .filter((path) => pathInside(generationRoot, path)),
  );
  for (const directory of carrierDirectories) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith('.json') && !retained.has(resolve(path))) {
        try {
          candidateActivationMarkers.add(resolve(readCarrierGeneration(path).activation.marker_path));
        } catch {
          // An invalid inert generation has no trusted marker reference to reclaim.
        }
        removable.push(resolve(path));
      }
    }
  }
  const activationMarkersRemoved = pruneUnreferencedActivationMarkers(
    journal,
    [...candidateActivationMarkers],
    new Set(removable),
  );
  for (const path of removable) rmSync(path, { force: true });
  for (const directory of carrierDirectories) syncDirectory(directory);
  return {
    removed_generation_paths: removable.sort(),
    removed_activation_marker_paths: activationMarkersRemoved,
  };
}

function collectReferencedActivationMarkers(
  root: string,
  excludedGenerationPaths: Set<string>,
): Set<string> {
  const referenced = new Set<string>();
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        if (excludedGenerationPaths.has(resolve(path))) continue;
        try {
          referenced.add(resolve(readCarrierGeneration(path).activation.marker_path));
        } catch {
          // Ignore non-generation JSON and invalid inert records.
        }
      }
    }
  };
  visit(resolve(root));
  return referenced;
}

function pruneUnreferencedActivationMarkers(
  journal: HardCutoverJournal,
  candidates: string[],
  excludedGenerationPaths: Set<string>,
): string[] {
  const activationRoot = dirname(resolve(journal.activation.marker_path));
  const referenced = collectReferencedActivationMarkers(
    journal.generation_root,
    excludedGenerationPaths,
  );
  const removed: string[] = [];
  for (const candidate of candidates) {
    const markerPath = resolve(candidate);
    if (
      markerPath === resolve(journal.activation.marker_path)
      || !pathInside(activationRoot, markerPath)
      || referenced.has(markerPath)
      || !existsSync(markerPath)
    ) {
      continue;
    }
    rmSync(markerPath, { force: true });
    removed.push(markerPath);
  }
  if (removed.length > 0) syncDirectory(activationRoot);
  return removed.sort();
}

function deleteLegacyPaths(journal: HardCutoverJournal): string[] {
  const removed: string[] = [];
  const changedDirectories = new Set<string>();
  for (const path of journal.legacy_paths) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    rmSync(path, { recursive: stat.isDirectory(), force: true });
    removed.push(path);
    changedDirectories.add(dirname(resolve(path)));
  }
  for (const directory of changedDirectories) syncDirectory(directory);
  return removed;
}

function transition(
  path: string,
  journal: HardCutoverJournal,
  state: HardCutoverState,
): HardCutoverJournal {
  const next = buildHardCutoverJournal({
    ...journal,
    state,
    updated_at: new Date().toISOString(),
  });
  writeHardCutoverJournal(path, next);
  return next;
}

function hardCutoverLockPath(journalPath: string): string {
  return `${resolve(journalPath)}.lock`;
}

function acquireHardCutoverLock(journalPath: string): () => void {
  const lockPath = hardCutoverLockPath(journalPath);
  const token = randomUUID();
  const content = `${canonicalJson({
    schema: 'narada.mcp_hard_cutover.lock.v3',
    pid: process.pid,
    token,
    acquired_at: new Date().toISOString(),
  })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      atomicDurableWrite(lockPath, content, true);
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
          if (current.token === token && current.pid === process.pid) {
            rmSync(lockPath, { force: true });
            syncDirectory(dirname(lockPath));
          }
        } catch {
          // Never remove a lock whose ownership can no longer be proven.
        }
      };
    } catch (error) {
      if (!existsSync(lockPath)) throw error;
      let ownerPid: number | null = null;
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
        ownerPid = Number.isSafeInteger(current.pid) && Number(current.pid) > 0
          ? Number(current.pid)
          : null;
      } catch {
        // A corrupt lock is not safe to reclaim automatically.
      }
      if (ownerPid === null || processIsAlive(ownerPid)) {
        throw new HardCutoverError(
          'hard_cutover_coordinator_locked',
          'Another coordinator owns the hard-cutover journal, or its lock identity is unreadable.',
          { lock_path: lockPath, owner_pid: ownerPid },
          { cause: error },
        );
      }
      rmSync(lockPath, { force: true });
      syncDirectory(dirname(lockPath));
    }
  }
  throw new HardCutoverError(
    'hard_cutover_coordinator_locked',
    'The hard-cutover coordinator lock could not be acquired.',
    { lock_path: lockPath },
  );
}

async function runHardCutoverCoordinatorLocked(
  journalPath: string,
): Promise<Record<string, unknown>> {
  const path = resolve(journalPath);
  let journal = readHardCutoverJournal(path);
  journal = buildHardCutoverJournal({
    ...journal,
    attempt_count: journal.attempt_count + 1,
    last_error: null,
    updated_at: new Date().toISOString(),
  });
  writeHardCutoverJournal(path, journal);
  try {
    if (journal.state === 'prepared') {
      validatePreparedCutover(journal);
      journal = transition(path, journal, 'prepared_validated');
    }
    if (journal.state === 'prepared_validated') {
      deleteLegacyPaths(journal);
      journal = transition(path, journal, 'predecessor_disabled');
    }
    if (journal.state === 'predecessor_disabled') {
      await terminateRecordedRuntimeInstances({
        diagnostics_dir: journal.diagnostics_dir || defaultRuntimeDiagnosticsDir(),
      });
      journal = transition(path, journal, 'processes_terminated');
    }
    if (journal.state === 'processes_terminated') {
      for (const target of journal.targets) replaceTargetFromStage(target);
      journal = transition(path, journal, 'configs_replaced');
    }
    if (journal.state === 'configs_replaced') {
      const marker = buildCarrierActivationMarker({
        cutover_id: journal.cutover_id,
        activation_token: journal.activation.activation_token,
        generation_digests: journal.targets.map((target) => target.generation_digest),
      });
      writeCarrierActivationMarkerImmutable(journal.activation.marker_path, marker);
      journal = transition(path, journal, 'activated');
    }
    let generationPathsRemoved: string[] = [];
    let activationMarkersRemoved: string[] = [];
    let artifactReclamation: Record<string, unknown> = {};
    if (journal.state === 'activated') {
      const generationReclamation = pruneReplacedCarrierGenerations(
        journal,
        journal.targets.map((target) => target.generation_path),
      );
      generationPathsRemoved = generationReclamation.removed_generation_paths;
      activationMarkersRemoved = generationReclamation.removed_activation_marker_paths;
      artifactReclamation = await pruneArtifactStore({
        store_root: journal.artifact_store,
        active_selectors: journal.active_selectors,
      });
      journal = transition(path, journal, 'reclaimed');
    }
    const completion = {
      schema: 'narada.mcp_hard_cutover.completion.v3',
      status: 'complete',
      cutover_id: journal.cutover_id,
      activation_marker_path: journal.activation.marker_path,
      generation_digests: journal.targets.map((target) => target.generation_digest).sort(),
      removed_generation_paths: generationPathsRemoved,
      removed_activation_marker_paths: activationMarkersRemoved,
      artifact_reclamation: artifactReclamation,
    };
    rmSync(journal.staging_root, { recursive: true, force: true });
    rmSync(path, { force: true });
    syncDirectory(dirname(path));
    return completion;
  } catch (error) {
    const failure = {
      code: error instanceof HardCutoverError ? error.code : 'hard_cutover_failed',
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    const failedJournal = buildHardCutoverJournal({
      ...journal,
      last_error: failure,
      updated_at: failure.at,
    });
    writeHardCutoverJournal(path, failedJournal);
    throw error;
  }
}

export async function runHardCutoverCoordinator(
  journalPath: string,
): Promise<Record<string, unknown>> {
  const release = acquireHardCutoverLock(journalPath);
  try {
    return await runHardCutoverCoordinatorLocked(journalPath);
  } finally {
    release();
  }
}

export function discardPreparedHardCutover(
  journalPath: string,
): Record<string, unknown> {
  const path = resolve(journalPath);
  const release = acquireHardCutoverLock(path);
  try {
    const journal = readHardCutoverJournal(path);
    if (journal.state !== 'prepared') {
      throw new HardCutoverError(
        'hard_cutover_discard_refused',
        'Only an inert prepared journal can be discarded; an executing cutover is forward-only.',
        { journal_path: path, state: journal.state },
      );
    }
    if (existsSync(journal.activation.marker_path)) {
      throw new HardCutoverError(
        'hard_cutover_discard_refused',
        'The prepared generation already has an activation marker.',
        {
          journal_path: path,
          activation_marker_path: journal.activation.marker_path,
        },
      );
    }
    for (const target of journal.targets) {
      if (
        existsSync(target.config_path)
        && digestText(readFileSync(target.config_path, 'utf8')) === target.config_digest
      ) {
        throw new HardCutoverError(
          'hard_cutover_discard_refused',
          'A live carrier config already contains the prepared generation.',
          { carrier_id: target.carrier_id, config_path: target.config_path },
        );
      }
    }
    const removedGenerationPaths: string[] = [];
    const changedGenerationDirectories = new Set<string>();
    for (const target of journal.targets) {
      if (!existsSync(target.generation_path)) continue;
      rmSync(target.generation_path, { force: true });
      removedGenerationPaths.push(target.generation_path);
      changedGenerationDirectories.add(dirname(target.generation_path));
    }
    for (const directory of changedGenerationDirectories) syncDirectory(directory);
    rmSync(journal.staging_root, { recursive: true, force: true });
    syncDirectory(dirname(journal.staging_root));
    rmSync(path, { force: true });
    syncDirectory(dirname(path));
    return {
      schema: 'narada.mcp_hard_cutover.discard.v3',
      status: 'discarded',
      cutover_id: journal.cutover_id,
      removed_generation_paths: removedGenerationPaths.sort(),
    };
  } finally {
    release();
  }
}
