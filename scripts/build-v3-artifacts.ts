import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefinedSurface, SurfaceDescriptorV3 } from '@narada2/mcp-fabric-contracts';
import { registrarSurfaceDefinition } from '../packages/mcp-registrar/src/main.js';
import { NATIVE_SURFACE_DEFINITIONS } from '../packages/mcp-registrar/src/native-catalog.js';
import {
  buildV3Artifact,
  buildV3RuntimeProxyArtifact,
} from '@narada2/mcp-runtime-proxy/carrier-materialization';
import {
  planConflictFreeWaves,
  runConflictFreeWave,
  typescriptBuildWriteSet,
} from './v3-artifact-build-scheduler.js';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const surfacesRoot = join(workspaceRoot, 'packages');
const artifactStore = resolve(
  process.env.NARADA_MCP_ARTIFACT_STORE
    ?? join(workspaceRoot, '.ai', 'runtime', 'artifact-store-v3'),
);
const requested = new Set(
  process.argv.slice(2).flatMap((argument, index, values) =>
    argument === '--surface' && values[index + 1] ? [values[index + 1]!] : []),
);
const concurrencyArgumentIndex = process.argv.indexOf('--concurrency');
const configuredConcurrency = Number(
  concurrencyArgumentIndex >= 0
    ? process.argv[concurrencyArgumentIndex + 1]
    : process.env.NARADA_MCP_ARTIFACT_BUILD_CONCURRENCY ?? '2',
);
if (
  !Number.isSafeInteger(configuredConcurrency)
  || configuredConcurrency < 1
  || configuredConcurrency > 4
) {
  throw new Error(`v3_artifact_concurrency_invalid:${configuredConcurrency}`);
}
const definitions: DefinedSurface[] = [
  ...Object.values(NATIVE_SURFACE_DEFINITIONS),
  registrarSurfaceDefinition(),
].sort((left, right) =>
  left.descriptor.surface_id.localeCompare(right.descriptor.surface_id));

async function withHeartbeat<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
    process.stderr.write(`still ${label} (${elapsedSeconds}s elapsed)\n`);
  }, 30_000);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
  }
}

function packageRoot(descriptor: SurfaceDescriptorV3): string {
  const packageDirectory = descriptor.package.replace(/^@narada2\//u, '');
  const direct = join(surfacesRoot, packageDirectory);
  if (existsSync(join(direct, 'package.json'))) return direct;
  const shared = join(surfacesRoot, 'shared', packageDirectory);
  if (existsSync(join(shared, 'package.json'))) return shared;
  throw new Error(`v3_artifact_package_root_missing:${descriptor.package}`);
}

const selected = requested.size === 0
  ? definitions
  : definitions.filter((definition) => requested.has(definition.descriptor.surface_id));
if (requested.size > 0 && selected.length !== requested.size) {
  const found = new Set(selected.map((definition) => definition.descriptor.surface_id));
  throw new Error(`v3_artifact_unknown_surface:${[...requested].filter((id) => !found.has(id)).join(',')}`);
}

const selectedWithIndex = selected.map((definition, index) => ({
  definition,
  index,
  package_root: packageRoot(definition.descriptor),
}));
const packageGroupMap = new Map<string, typeof selectedWithIndex>();
for (const entry of selectedWithIndex) {
  const group = packageGroupMap.get(entry.package_root) ?? [];
  group.push(entry);
  packageGroupMap.set(entry.package_root, group);
}
const packageGroups = [...packageGroupMap.values()].map((entries) => ({
  entries,
  write_roots: typescriptBuildWriteSet(entries[0]!.package_root),
}));
const buildWaves = planConflictFreeWaves(
  packageGroups.map((group) => ({ value: group, write_roots: group.write_roots })),
  configuredConcurrency,
);
process.stderr.write(
  `artifact build planned ${selected.length} surface(s) in ${buildWaves.length} conflict-free wave(s)`
  + ` with concurrency ${configuredConcurrency}\n`,
);
process.stderr.write('sealing runtime proxy\n');
const proxy = await withHeartbeat('sealing runtime proxy', () =>
  buildV3RuntimeProxyArtifact({
    package_root: join(surfacesRoot, 'shared', 'mcp-runtime-proxy'),
    workspace_root: workspaceRoot,
    artifact_store: artifactStore,
  }));
process.stderr.write(`sealed runtime proxy ${proxy.closure.closure_digest}\n`);
const results = new Array<{
  surface_id: string;
  package: string;
  closure_digest: string;
  receipt_digest: string;
  reused_closure: boolean;
  channel_changed: boolean;
}>(selected.length);
const buildGroup = async (group: typeof packageGroups[number]) => {
  for (const { definition, index, package_root: root } of group.entries) {
    process.stderr.write(`sealing ${definition.descriptor.surface_id}\n`);
    const result = await withHeartbeat(
      `sealing ${definition.descriptor.surface_id}`,
      () => buildV3Artifact({
        descriptor: definition.descriptor,
        package_root: root,
        workspace_root: workspaceRoot,
        artifact_store: artifactStore,
      }),
    );
    results[index] = {
      surface_id: definition.descriptor.surface_id,
      package: definition.descriptor.package,
      closure_digest: result.closure.closure_digest,
      receipt_digest: result.receipt.receipt_digest,
      reused_closure: result.reused_closure,
      channel_changed: result.channel_changed,
    };
    process.stderr.write(`sealed ${definition.descriptor.surface_id} ${result.closure.closure_digest}\n`);
  }
};
for (const [index, wave] of buildWaves.entries()) {
  process.stderr.write(
    `starting artifact build wave ${index + 1}/${buildWaves.length}: `
    + wave.flatMap((scheduled) =>
      scheduled.value.entries.map((entry) => entry.definition.descriptor.surface_id)).join(', ')
    + '\n',
  );
  await runConflictFreeWave(wave, (scheduled) => buildGroup(scheduled.value));
}

process.stdout.write(`${JSON.stringify({
  schema: 'narada.mcp_artifact_build.v3',
  status: 'sealed',
  artifact_store: artifactStore,
  runtime_proxy: {
    closure_digest: proxy.closure.closure_digest,
    receipt_digest: proxy.receipt.receipt_digest,
    reused_closure: proxy.reused_closure,
    channel_changed: proxy.channel_changed,
  },
  scheduler: {
    configured_concurrency: configuredConcurrency,
    wave_count: buildWaves.length,
    waves: buildWaves.map((wave) => wave.map((scheduled) =>
      scheduled.value.entries.map((entry) => entry.definition.descriptor.surface_id))),
  },
  surfaces: results,
}, null, 2)}\n`);
