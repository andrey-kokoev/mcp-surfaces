import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TREE_HASH_ALGORITHM = 'sha256-tree-v1';
const BUILD_MANIFEST_SCHEMA = 'narada.worker.build_identity.v2';
const BUILD_MANIFEST_FILE = 'worker-delegation-build-identity.json';
const DEFAULT_REVALIDATION_INTERVAL_MS = 1_000;

type TreeFingerprint = {
  status: 'ok' | 'unavailable';
  sha256: string | null;
  file_count: number;
  error_code: string | null;
};

type SourceObservation = TreeFingerprint | {
  status: 'not_available';
  sha256: null;
  file_count: 0;
  error_code: null;
};

type RuntimeDependencyIdentity = {
  name: string;
  package_version: string | null;
  runtime_tree_sha256: string;
  runtime_file_count: number;
};

type RuntimeDependencyGraph = {
  status: 'ok' | 'unavailable';
  dependencies: RuntimeDependencyIdentity[];
  sha256: string | null;
  error_code: string | null;
};

type BuildIdentityManifest = {
  schema: typeof BUILD_MANIFEST_SCHEMA;
  package_name: '@narada2/worker-delegation-mcp';
  identity_algorithm: typeof TREE_HASH_ALGORITHM;
  source_root: 'src';
  source_tree_sha256: string;
  source_file_count: number;
  artifact_root: 'dist/src';
  artifact_tree_sha256: string;
  artifact_file_count: number;
  runtime_dependencies: RuntimeDependencyIdentity[];
  implementation_graph_sha256: string;
};

type BuildManifestRead =
  | { status: 'ok'; value: BuildIdentityManifest }
  | { status: 'missing' | 'invalid'; value: null; error_code: string | null };

type IdentityOptions = {
  modulePath?: string;
  now?: () => Date;
  manifestPath?: string;
  sourceRoot?: string;
  revalidationIntervalMs?: number;
};

type ManifestWriteOptions = {
  packageRoot?: string;
  manifestPath?: string;
};

type IdentityObservation = {
  observed_at: Date;
  artifact: TreeFingerprint;
  source: SourceObservation;
  dependencies: RuntimeDependencyGraph;
};

export function createWorkerImplementationIdentityReader(options: IdentityOptions = {}): () => Record<string, unknown> {
  const modulePath = options.modulePath ?? fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(dirname(modulePath));
  const artifactRoot = dirname(modulePath);
  const artifactRelativePath = normalizePath(relative(packageRoot, artifactRoot)) || '.';
  const artifactKind = artifactRelativePath.startsWith('dist/') ? 'compiled' : 'source';
  const sourceRoot = options.sourceRoot ?? join(packageRoot, 'src');
  const manifestPath = options.manifestPath ?? join(packageRoot, 'dist', BUILD_MANIFEST_FILE);
  const now = options.now ?? (() => new Date());
  const revalidationIntervalMs = normalizeRevalidationInterval(options.revalidationIntervalMs);
  const materializedAt = now();
  const materializedArtifact = fingerprintTree(artifactRoot);
  const materializedDependencies = runtimeDependencyGraph(packageRoot);
  const materializedIdentity = implementationGraphIdentity(materializedArtifact, materializedDependencies);
  const buildManifest = artifactKind === 'compiled' ? readBuildManifest(manifestPath) : null;
  let cachedObservation: IdentityObservation | null = null;

  return () => {
    const observation = currentObservation();
    const observedIdentity = implementationGraphIdentity(observation.artifact, observation.dependencies);
    const dependencyDrift = buildManifest?.status === 'ok'
      ? runtimeDependencyDrift(buildManifest.value.runtime_dependencies, observation.dependencies)
      : [];
    return {
      schema: 'narada.worker.implementation_identity.v4',
      surface_id: 'worker-delegation-mcp',
      package_name: '@narada2/worker-delegation-mcp',
      identity_algorithm: TREE_HASH_ALGORITHM,
      implementation_graph_scope: 'surface_artifact_plus_direct_runtime_dependencies',
      implementation_identity: materializedIdentity === null ? null : `sha256:${materializedIdentity}`,
      observed_implementation_identity: observedIdentity === null ? null : `sha256:${observedIdentity}`,
      module_file: basename(modulePath),
      artifact_kind: artifactKind,
      artifact_root: artifactRelativePath,
      materialized_at: materializedAt.toISOString(),
      observed_at: observation.observed_at.toISOString(),
      revalidation_interval_ms: revalidationIntervalMs,
      materialized_artifact_tree_sha256: materializedArtifact.sha256,
      materialized_artifact_file_count: materializedArtifact.file_count,
      observed_artifact_tree_sha256: observation.artifact.sha256,
      observed_artifact_file_count: observation.artifact.file_count,
      runtime_dependencies: runtimeDependencyReadback(materializedDependencies, observation.dependencies),
      expected_build: buildAttestation(buildManifest, materializedArtifact, observation.artifact, observation.source, observation.dependencies, dependencyDrift, packageRoot, manifestPath),
      stale_server_risk: resolveStaleServerRisk({
        artifactKind,
        materializedArtifact,
        observedArtifact: observation.artifact,
        materializedDependencies,
        observedDependencies: observation.dependencies,
        source: observation.source,
        buildManifest,
        dependencyDrift,
      }),
    };
  };

  function currentObservation(): IdentityObservation {
    const observedAt = now();
    if (
      cachedObservation
      && revalidationIntervalMs > 0
      && observedAt.getTime() - cachedObservation.observed_at.getTime() < revalidationIntervalMs
    ) return cachedObservation;
    cachedObservation = {
      observed_at: observedAt,
      artifact: fingerprintTree(artifactRoot),
      source: observeSourceTree(sourceRoot),
      dependencies: runtimeDependencyGraph(packageRoot),
    };
    return cachedObservation;
  }
}

function resolveRuntimeDependency(name: string, resolveFromPackage: NodeRequire, packageRoot: string): string {
  try {
    return resolveFromPackage.resolve(name);
  } catch (requireError) {
    const dependencyRoot = join(packageRoot, 'node_modules', name);
    const dependencyManifestPath = join(dependencyRoot, 'package.json');
    if (existsSync(dependencyManifestPath)) {
      const dependencyManifest = readPackageJson(dependencyManifestPath);
      const exportTarget = resolvePackageExportTarget(dependencyManifest);
      if (exportTarget) return join(dependencyRoot, exportTarget);
    }
    const importResolve = (import.meta as ImportMeta & {
      resolve?: (specifier: string, parent?: string) => string;
    }).resolve;
    if (typeof importResolve !== 'function') throw requireError;
    return fileURLToPath(importResolve(name, pathToFileURL(join(packageRoot, 'package.json')).href));
  }
}

function resolvePackageExportTarget(manifest: Record<string, unknown>): string | null {
  const exportsValue = manifest.exports;
  const exportsRecord = asRecord(exportsValue);
  const rootExport = Object.prototype.hasOwnProperty.call(exportsRecord, '.') ? exportsRecord['.'] : exportsValue;
  return resolveConditionalPackageTarget(rootExport);
}

function resolveConditionalPackageTarget(value: unknown): string | null {
  if (typeof value === 'string') return value.startsWith('./') ? value : null;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = resolveConditionalPackageTarget(candidate);
      if (target) return target;
    }
    return null;
  }
  const record = asRecord(value);
  for (const condition of ['import', 'node', 'default']) {
    const target = resolveConditionalPackageTarget(record[condition]);
    if (target) return target;
  }
  return null;
}

export function writeWorkerImplementationBuildManifest(options: ManifestWriteOptions = {}): BuildIdentityManifest {
  const packageRoot = options.packageRoot ?? findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const source = fingerprintTree(join(packageRoot, 'src'));
  const artifact = fingerprintTree(join(packageRoot, 'dist', 'src'));
  const dependencies = runtimeDependencyGraph(packageRoot);
  if (source.status !== 'ok') throw new Error(`worker_build_identity_source_unavailable:${source.error_code ?? 'unknown'}`);
  if (artifact.status !== 'ok') throw new Error(`worker_build_identity_artifact_unavailable:${artifact.error_code ?? 'unknown'}`);
  if (dependencies.status !== 'ok') throw new Error(`worker_build_identity_dependencies_unavailable:${dependencies.error_code ?? 'unknown'}`);
  const implementationGraph = implementationGraphIdentity(artifact, dependencies);
  if (!implementationGraph) throw new Error('worker_build_identity_implementation_graph_unavailable');
  const manifest: BuildIdentityManifest = {
    schema: BUILD_MANIFEST_SCHEMA,
    package_name: '@narada2/worker-delegation-mcp',
    identity_algorithm: TREE_HASH_ALGORITHM,
    source_root: 'src',
    source_tree_sha256: source.sha256,
    source_file_count: source.file_count,
    artifact_root: 'dist/src',
    artifact_tree_sha256: artifact.sha256,
    artifact_file_count: artifact.file_count,
    runtime_dependencies: dependencies.dependencies,
    implementation_graph_sha256: implementationGraph,
  };
  const manifestPath = options.manifestPath ?? join(packageRoot, 'dist', BUILD_MANIFEST_FILE);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function resolveStaleServerRisk(input: {
  artifactKind: string;
  materializedArtifact: TreeFingerprint;
  observedArtifact: TreeFingerprint;
  materializedDependencies: RuntimeDependencyGraph;
  observedDependencies: RuntimeDependencyGraph;
  source: SourceObservation;
  buildManifest: BuildManifestRead | null;
  dependencyDrift: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const { artifactKind, materializedArtifact, observedArtifact, materializedDependencies, observedDependencies, source, buildManifest, dependencyDrift } = input;
  if (materializedArtifact.status !== 'ok' || observedArtifact.status !== 'ok') {
    return unavailableIdentity('artifact', { materialized_artifact_error: materializedArtifact.error_code, observed_artifact_error: observedArtifact.error_code });
  }
  if (materializedDependencies.status !== 'ok' || observedDependencies.status !== 'ok') {
    return unavailableIdentity('runtime_dependencies', { materialized_dependency_error: materializedDependencies.error_code, observed_dependency_error: observedDependencies.error_code });
  }
  if (materializedArtifact.sha256 !== observedArtifact.sha256) {
    return {
      status: 'artifact_changed_since_materialization',
      remediation: 'Restart or rematerialize the worker-delegation MCP server so loaded code matches the changed artifact tree.',
      evidence: { materialized_artifact_tree_sha256: materializedArtifact.sha256, observed_artifact_tree_sha256: observedArtifact.sha256 },
    };
  }
  if (materializedDependencies.sha256 !== observedDependencies.sha256) {
    return {
      status: 'runtime_dependency_changed_since_materialization',
      remediation: 'Restart or rematerialize the worker-delegation MCP server so its loaded direct runtime dependencies match the observed dependency graph.',
      evidence: runtimeDependencyDrift(materializedDependencies.dependencies, observedDependencies),
    };
  }
  if (artifactKind !== 'compiled') {
    return { status: 'not_observed', evidence: { materialized_implementation_identity: implementationGraphIdentity(materializedArtifact, materializedDependencies) } };
  }
  if (!buildManifest || buildManifest.status !== 'ok') {
    return unavailableIdentity('build_manifest', { build_manifest_status: buildManifest?.status ?? 'missing', build_manifest_error: buildManifest?.status === 'ok' ? null : buildManifest?.error_code ?? null });
  }
  if (buildManifest.value.artifact_tree_sha256 !== materializedArtifact.sha256) {
    return {
      status: 'loaded_artifact_not_declared_build',
      remediation: 'Rebuild @narada2/worker-delegation-mcp and restart the MCP server; the loaded artifact does not match its declared build manifest.',
      evidence: { expected_artifact_tree_sha256: buildManifest.value.artifact_tree_sha256, materialized_artifact_tree_sha256: materializedArtifact.sha256 },
    };
  }
  if (source.status === 'unavailable') return unavailableIdentity('source', { source_error: source.error_code });
  if (source.status === 'ok' && source.sha256 !== buildManifest.value.source_tree_sha256) {
    return {
      status: 'source_changed_since_build',
      remediation: 'Rebuild @narada2/worker-delegation-mcp and restart the MCP server so the loaded compiled artifact matches current source.',
      evidence: { expected_source_tree_sha256: buildManifest.value.source_tree_sha256, observed_source_tree_sha256: source.sha256 },
    };
  }
  if (dependencyDrift.length > 0) {
    return {
      status: 'runtime_dependency_changed_since_build',
      remediation: 'Rebuild @narada2/worker-delegation-mcp and restart the MCP server so its direct runtime dependency graph matches the declared build.',
      evidence: dependencyDrift,
    };
  }
  return { status: 'not_observed', evidence: { materialized_implementation_identity: implementationGraphIdentity(materializedArtifact, materializedDependencies) } };
}

function unavailableIdentity(scope: string, evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'identity_unavailable',
    remediation: 'Restore the unreadable identity input, rebuild @narada2/worker-delegation-mcp, then restart or rematerialize the MCP server.',
    evidence: { scope, ...evidence },
  };
}

function buildAttestation(buildManifest: BuildManifestRead | null, materializedArtifact: TreeFingerprint, observedArtifact: TreeFingerprint, source: SourceObservation, dependencies: RuntimeDependencyGraph, dependencyDrift: Array<Record<string, unknown>>, packageRoot: string, manifestPath: string): Record<string, unknown> {
  if (!buildManifest) return { status: 'source_runtime' };
  if (buildManifest.status !== 'ok') {
    return { status: 'unavailable', manifest_path: normalizePath(relative(packageRoot, manifestPath)), error_code: buildManifest.error_code };
  }
  const status = buildManifest.value.artifact_tree_sha256 !== materializedArtifact.sha256
    ? 'artifact_mismatch'
    : observedArtifact.status !== 'ok'
      ? 'artifact_unavailable'
      : source.status === 'ok' && source.sha256 !== buildManifest.value.source_tree_sha256
        ? 'source_changed_since_build'
        : dependencies.status !== 'ok'
          ? 'runtime_dependencies_unavailable'
          : dependencyDrift.length > 0
            ? 'runtime_dependency_changed_since_build'
            : source.status === 'not_available'
              ? 'artifact_and_dependencies_verified_source_not_available'
              : source.status === 'unavailable'
                ? 'source_unavailable'
                : 'matched';
  return {
    status,
    manifest_path: normalizePath(relative(packageRoot, manifestPath)),
    expected_artifact_tree_sha256: buildManifest.value.artifact_tree_sha256,
    expected_source_tree_sha256: buildManifest.value.source_tree_sha256,
    expected_implementation_graph_sha256: buildManifest.value.implementation_graph_sha256,
    observed_source_tree_sha256: source.sha256,
    runtime_dependency_drift: dependencyDrift,
  };
}

function runtimeDependencyReadback(materialized: RuntimeDependencyGraph, observed: RuntimeDependencyGraph): Record<string, unknown> {
  return {
    status: materialized.status === 'ok' && observed.status === 'ok'
      ? materialized.sha256 === observed.sha256 ? 'unchanged_since_materialization' : 'changed_since_materialization'
      : 'unavailable',
    materialized_graph_sha256: materialized.sha256,
    observed_graph_sha256: observed.sha256,
    dependencies: observed.dependencies,
    drift: runtimeDependencyDrift(materialized.dependencies, observed),
    error_code: materialized.error_code ?? observed.error_code,
  };
}

function runtimeDependencyGraph(packageRoot: string): RuntimeDependencyGraph {
  try {
    const packageManifest = readPackageJson(join(packageRoot, 'package.json'));
    const dependencyNames = Object.keys(asRecord(packageManifest.dependencies)).sort((left, right) => left.localeCompare(right));
    const resolveFromPackage = createRequire(join(packageRoot, 'package.json'));
    const dependencies = dependencyNames.map((name) => runtimeDependencyIdentity(name, resolveFromPackage, packageRoot));
    if (dependencies.some((dependency) => dependency === null)) return { status: 'unavailable', dependencies: [], sha256: null, error_code: 'runtime_dependency_identity_unavailable' };
    const resolved = dependencies.filter((dependency): dependency is RuntimeDependencyIdentity => dependency !== null);
    return { status: 'ok', dependencies: resolved, sha256: hashJson(resolved), error_code: null };
  } catch (error) {
    return { status: 'unavailable', dependencies: [], sha256: null, error_code: errorCode(error) };
  }
}

function runtimeDependencyIdentity(name: string, resolveFromPackage: NodeRequire, packageRoot: string): RuntimeDependencyIdentity | null {
  try {
    const entrypoint = resolveRuntimeDependency(name, resolveFromPackage, packageRoot);
    const dependencyRoot = findPackageRoot(dirname(entrypoint));
    const packageManifest = readPackageJson(join(dependencyRoot, 'package.json'));
    const runtimeTree = fingerprintTree(dependencyRoot, includeRuntimePackagePath);
    if (runtimeTree.status !== 'ok' || runtimeTree.sha256 === null) return null;
    return {
      name,
      package_version: typeof packageManifest.version === 'string' ? packageManifest.version : null,
      runtime_tree_sha256: runtimeTree.sha256,
      runtime_file_count: runtimeTree.file_count,
    };
  } catch {
    return null;
  }
}

function runtimeDependencyDrift(expected: RuntimeDependencyIdentity[], observed: RuntimeDependencyGraph): Array<Record<string, unknown>> {
  if (observed.status !== 'ok') return [{ reason: 'observed_runtime_dependency_graph_unavailable', error_code: observed.error_code }];
  const expectedByName = new Map(expected.map((dependency) => [dependency.name, dependency]));
  const observedByName = new Map(observed.dependencies.map((dependency) => [dependency.name, dependency]));
  const drift: Array<Record<string, unknown>> = [];
  for (const [name, expectedDependency] of expectedByName) {
    const observedDependency = observedByName.get(name);
    if (!observedDependency) {
      drift.push({ name, reason: 'dependency_missing_from_observed_graph' });
      continue;
    }
    if (expectedDependency.package_version !== observedDependency.package_version || expectedDependency.runtime_tree_sha256 !== observedDependency.runtime_tree_sha256 || expectedDependency.runtime_file_count !== observedDependency.runtime_file_count) {
      drift.push({ name, reason: 'dependency_identity_changed', expected_runtime_tree_sha256: expectedDependency.runtime_tree_sha256, observed_runtime_tree_sha256: observedDependency.runtime_tree_sha256 });
    }
  }
  for (const dependency of observed.dependencies) {
    if (!expectedByName.has(dependency.name)) drift.push({ name: dependency.name, reason: 'unexpected_dependency_in_observed_graph' });
  }
  return drift;
}

function implementationGraphIdentity(artifact: TreeFingerprint, dependencies: RuntimeDependencyGraph): string | null {
  if (artifact.status !== 'ok' || artifact.sha256 === null || dependencies.status !== 'ok' || dependencies.sha256 === null) return null;
  return hashJson({ artifact_tree_sha256: artifact.sha256, runtime_dependency_graph_sha256: dependencies.sha256 });
}

function readBuildManifest(path: string): BuildManifestRead {
  if (!existsSync(path)) return { status: 'missing', value: null, error_code: null };
  try {
    const value = readPackageJson(path);
    const dependencies = normalizeRuntimeDependencyList(value.runtime_dependencies);
    if (value.schema !== BUILD_MANIFEST_SCHEMA || value.package_name !== '@narada2/worker-delegation-mcp' || value.identity_algorithm !== TREE_HASH_ALGORITHM || value.source_root !== 'src' || value.artifact_root !== 'dist/src' || !sha256(value.source_tree_sha256) || !sha256(value.artifact_tree_sha256) || !nonNegativeInteger(value.source_file_count) || !nonNegativeInteger(value.artifact_file_count) || dependencies === null || !sha256(value.implementation_graph_sha256)) {
      return { status: 'invalid', value: null, error_code: 'build_manifest_shape_invalid' };
    }
    return {
      status: 'ok',
      value: {
        schema: BUILD_MANIFEST_SCHEMA,
        package_name: '@narada2/worker-delegation-mcp',
        identity_algorithm: TREE_HASH_ALGORITHM,
        source_root: 'src',
        source_tree_sha256: value.source_tree_sha256,
        source_file_count: value.source_file_count,
        artifact_root: 'dist/src',
        artifact_tree_sha256: value.artifact_tree_sha256,
        artifact_file_count: value.artifact_file_count,
        runtime_dependencies: dependencies,
        implementation_graph_sha256: value.implementation_graph_sha256,
      },
    };
  } catch (error) {
    return { status: 'invalid', value: null, error_code: errorCode(error) };
  }
}

function normalizeRuntimeDependencyList(value: unknown): RuntimeDependencyIdentity[] | null {
  if (!Array.isArray(value)) return null;
  const dependencies: RuntimeDependencyIdentity[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (typeof record.name !== 'string' || (record.package_version !== null && typeof record.package_version !== 'string') || !sha256(record.runtime_tree_sha256) || !nonNegativeInteger(record.runtime_file_count)) return null;
    dependencies.push({ name: record.name, package_version: record.package_version as string | null, runtime_tree_sha256: record.runtime_tree_sha256, runtime_file_count: record.runtime_file_count });
  }
  return dependencies.sort((left, right) => left.name.localeCompare(right.name));
}

function observeSourceTree(root: string): SourceObservation {
  if (!existsSync(root)) return { status: 'not_available', sha256: null, file_count: 0, error_code: null };
  return fingerprintTree(root);
}

function findPackageRoot(start: string): string {
  let current = start;
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function fingerprintTree(root: string, includePath: (relativePath: string) => boolean = () => true): TreeFingerprint {
  try {
    const hash = createHash('sha256');
    let fileCount = 0;
    for (const path of listFiles(root)) {
      const relativePath = normalizePath(relative(root, path));
      if (!includePath(relativePath)) continue;
      hash.update(relativePath);
      hash.update('\0');
      hash.update(readFileSync(path));
      hash.update('\0');
      fileCount += 1;
    }
    return { status: 'ok', sha256: hash.digest('hex'), file_count: fileCount, error_code: null };
  } catch (error) {
    return { status: 'unavailable', sha256: null, file_count: 0, error_code: errorCode(error) };
  }
}

function includeRuntimePackagePath(relativePath: string): boolean {
  if (relativePath === 'package.json') return true;
  const segments = relativePath.split('/');
  if (segments.some((segment) => ['node_modules', 'src', 'test', 'tests', 'docs', '.git'].includes(segment))) return false;
  return /\.(?:c?js|mjs|json|node)$/i.test(relativePath);
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function readPackageJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package_json_object_required');
  return value as Record<string, unknown>;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeRevalidationInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REVALIDATION_INTERVAL_MS;
  return Math.max(0, Math.min(60_000, Math.floor(value)));
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'filesystem_error';
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}
