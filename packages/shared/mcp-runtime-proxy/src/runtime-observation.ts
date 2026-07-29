import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  MCP_FABRIC_SCHEMA_VERSION,
  parseRuntimeObservationV2,
  RuntimeServerObservationV2Schema,
  type RuntimeObservationV2,
  type RuntimeServerObservationV2,
} from '@narada2/mcp-fabric-contracts';
import type {
  GenerationObservationEvent,
  GenerationObservationSink,
  GenerationSnapshot,
} from './generation-manager.js';

export type RuntimeObservationStoreOptions = {
  root: string;
  site_id: string;
  carrier_kind: string;
  manifest_digest: string | null;
};

export class AtomicRuntimeObservationStore {
  readonly root: string;

  constructor(private readonly options: RuntimeObservationStoreOptions) {
    this.root = resolve(options.root);
  }

  writeServer(serverValue: RuntimeServerObservationV2): string {
    const server = RuntimeServerObservationV2Schema.parse(serverValue);
    const path = this.serverPath(server.logical_connection_id);
    atomicWriteJson(path, server);
    return path;
  }

  readServer(logicalConnectionId: string): RuntimeServerObservationV2 | null {
    const path = this.serverPath(logicalConnectionId);
    if (!existsSync(path)) return null;
    return RuntimeServerObservationV2Schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  }

  observe(observedAt = new Date().toISOString()): RuntimeObservationV2 {
    const directory = join(this.root, 'connections');
    const servers = existsSync(directory)
      ? readdirSync(directory)
          .filter((name) => name.endsWith('.json'))
          .map((name) => RuntimeServerObservationV2Schema.parse(
            JSON.parse(readFileSync(join(directory, name), 'utf8')),
          ))
          .map((server) => classifyExpiredLeases(server, observedAt))
          .sort((left, right) => left.server_name.localeCompare(right.server_name))
      : [];
    return parseRuntimeObservationV2({
      schema_version: MCP_FABRIC_SCHEMA_VERSION,
      observation_id: `observation-${Date.parse(observedAt)}`,
      observed_at: observedAt,
      site_id: this.options.site_id,
      carrier_kind: this.options.carrier_kind,
      runtime_state_root: this.root,
      manifest_digest: this.options.manifest_digest,
      servers,
    });
  }

  private serverPath(logicalConnectionId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(logicalConnectionId)) {
      throw new Error(`mcp_runtime_observation_invalid_connection_id: ${logicalConnectionId}`);
    }
    return join(this.root, 'connections', `${logicalConnectionId}.json`);
  }
}

export function createRuntimeObservationSink(input: {
  store: AtomicRuntimeObservationStore;
  server_name: string;
  surface_id: string;
  projection_id: string;
  lifecycle: RuntimeServerObservationV2['lifecycle'];
  recovery_actions: RuntimeServerObservationV2['recovery_actions'];
}): GenerationObservationSink {
  return (event) => {
    const current = input.store.readServer(event.logical_connection_id);
    const generations = new Map<string, GenerationSnapshot>();
    if (current?.active_generation) {
      generations.set(current.active_generation.generation_id, snapshotFromRecord(current.active_generation));
    }
    for (const generation of current?.draining_generations ?? []) {
      generations.set(generation.generation_id, snapshotFromRecord(generation));
    }
    generations.set(event.generation.generation_id, event.generation);
    const values = [...generations.values()];
    const active = values.find((generation) => generation.state === 'active') ?? null;
    const draining = values
      .filter((generation) => generation.state === 'draining')
      .map(recordFromSnapshot)
      .sort((left, right) => left.started_at.localeCompare(right.started_at));
    input.store.writeServer({
      server_name: input.server_name,
      surface_id: input.surface_id,
      projection_id: input.projection_id,
      logical_connection_id: event.logical_connection_id,
      lifecycle: input.lifecycle,
      active_generation: active ? recordFromSnapshot(active) : null,
      draining_generations: draining,
      recovery_actions: input.recovery_actions,
      detail: `last_event=${event.event}; observed_at=${event.observed_at}`,
    });
  };
}

function recordFromSnapshot(snapshot: GenerationSnapshot) {
  return {
    generation_id: snapshot.generation_id,
    state: snapshot.state,
    started_at: snapshot.started_at,
    activated_at: snapshot.activated_at,
    heartbeat_at: snapshot.heartbeat_at,
    lease_expires_at: snapshot.lease_expires_at,
    freshness: snapshot.freshness,
    health: snapshot.health,
    descriptor_digest: snapshot.descriptor_digest,
    tool_contract_digest: snapshot.tool_contract_digest,
    inflight: snapshot.inflight,
    ...(snapshot.failure ? { detail: snapshot.failure } : {}),
  };
}

function snapshotFromRecord(
  record: NonNullable<RuntimeServerObservationV2['active_generation']>,
): GenerationSnapshot {
  return {
    generation_id: record.generation_id,
    state: record.state,
    transport: 'stdio',
    inflight: record.inflight,
    started_at: record.started_at,
    activated_at: record.activated_at ?? null,
    drain_deadline: null,
    heartbeat_at: record.heartbeat_at,
    lease_expires_at: record.lease_expires_at,
    freshness: record.freshness,
    health: record.health,
    descriptor_digest: record.descriptor_digest ?? null,
    tool_contract_digest: record.tool_contract_digest ?? null,
    failure: record.detail ?? null,
  };
}

function classifyExpiredLeases(
  server: RuntimeServerObservationV2,
  observedAt: string,
): RuntimeServerObservationV2 {
  const now = Date.parse(observedAt);
  const classify = (
    generation: NonNullable<RuntimeServerObservationV2['active_generation']>,
  ) => Date.parse(generation.lease_expires_at) <= now
    ? { ...generation, freshness: 'stale' as const, health: 'unreachable' as const }
    : generation;
  return {
    ...server,
    active_generation: server.active_generation ? classify(server.active_generation) : null,
    draining_generations: server.draining_generations.map(classify),
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporary, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(temporary, path);
  }
}
