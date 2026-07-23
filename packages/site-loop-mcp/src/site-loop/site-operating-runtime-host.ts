import { resolve } from 'node:path';
import {
  claimSiteOperatingLoopRuntimeHost,
  DEFAULT_SITE_OPERATING_LOOP_ID,
  DEFAULT_SITE_OPERATING_LOOP_OWNER_ID,
  getSiteOperatingLoopRuntimeHost,
  assertSiteOperatingLoopRuntimeHostAuthority,
  heartbeatSiteOperatingLoopRuntimeHost,
  transitionSiteOperatingLoopRuntimeHost,
} from '@narada2/site-operating-loop/site-loop-store';
import { loadSiteLoopConfig } from './site-loop-config.js';
import { openSiteLoopStore } from './site-loop-store.js';

export const SITE_LOOP_MCP_RUNTIME_HOST_ADAPTER_SCHEMA = 'narada.site_loop_mcp.runtime_host_adapter.v1';

type RuntimeHostOptions = Record<string, unknown>;
type RuntimeHostStore = { db: unknown };

function stringOption(options: RuntimeHostOptions, ...keys: string[]) {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function numberOption(options: RuntimeHostOptions, fallback: number, ...keys: string[]) {
  for (const key of keys) {
    const value = Number(options[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function canonicalStore(db: unknown): RuntimeHostStore {
  return { db };
}

export function openSiteOperatingRuntimeHost(cwd: string, options: RuntimeHostOptions = {}) {
  const siteRoot = resolve(cwd);
  const configured = loadSiteLoopConfig(siteRoot).config;
  const loopId = stringOption(options, 'loopId', 'loop_id')
    ?? configured.loop_id
    ?? DEFAULT_SITE_OPERATING_LOOP_ID;
  const ownerId = stringOption(options, 'ownerId', 'owner_id')
    ?? `${configured.site_id ?? 'site'}:${DEFAULT_SITE_OPERATING_LOOP_OWNER_ID}`;
  const runtimeId = stringOption(options, 'runtimeId', 'runtime_id');
  const leaseTtlMs = numberOption(options, 5 * 60_000, 'runtimeLeaseTtlMs', 'runtime_lease_ttl_ms');
  const metadata = {
    ...(options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata) ? options.metadata : {}),
    adapter: SITE_LOOP_MCP_RUNTIME_HOST_ADAPTER_SCHEMA,
    site_root: siteRoot,
    loop_id: loopId,
    owner_id: ownerId,
  };
  let host: Record<string, unknown> | null = null;
  let closed = false;

  function invoke<T>(write: boolean, operation: (store: RuntimeHostStore) => T): T {
    if (closed) throw new Error('site_operating_runtime_host_adapter_closed');
    const siteStore = openSiteLoopStore(siteRoot, { write });
    try {
      return operation(canonicalStore(siteStore.db));
    } finally {
      siteStore.close();
    }
  }

  function updateHost(nextHost: Record<string, unknown> | null) {
    host = nextHost;
    return host;
  }

  function requireHost() {
    if (!host) throw new Error('site_operating_runtime_host_not_claimed');
    return host;
  }

  const binding = {
    schema: SITE_LOOP_MCP_RUNTIME_HOST_ADAPTER_SCHEMA,
    site_root: siteRoot,
    loop_id: loopId,
    owner_id: ownerId,
    claim() {
      const receipt = invoke(true, (store) => claimSiteOperatingLoopRuntimeHost(store, {
        loopId,
        ownerId,
        runtimeId,
        leaseTtlMs,
        metadata,
      }));
      updateHost(receipt.host);
      return receipt;
    },
    transition(nextState: string, details: RuntimeHostOptions = {}) {
      const current = requireHost();
      const receipt = invoke(true, (store) => transitionSiteOperatingLoopRuntimeHost(store, {
        loopId,
        runtimeId: current.runtime_id,
        authorityEpoch: current.authority_epoch,
        ownerId,
        nextState,
        details,
        leaseTtlMs,
      }));
      updateHost(receipt.host);
      return receipt;
    },
    assertAuthority() {
      const current = requireHost();
      const currentHost = invoke(false, (store) => assertSiteOperatingLoopRuntimeHostAuthority(store, {
        loopId,
        runtimeId: current.runtime_id,
        authorityEpoch: current.authority_epoch,
        ownerId,
      }));
      return updateHost(currentHost);
    },
    heartbeat() {
      const current = requireHost();
      const currentHost = invoke(true, (store) => heartbeatSiteOperatingLoopRuntimeHost(store, {
        loopId,
        runtimeId: current.runtime_id,
        authorityEpoch: current.authority_epoch,
        ownerId,
        leaseTtlMs,
      }));
      return updateHost(currentHost);
    },
    snapshot() {
      const current = invoke(false, (store) => getSiteOperatingLoopRuntimeHost(store, loopId));
      return updateHost(current);
    },
    close() {
      closed = true;
    },
  };

  return binding;
}

export async function runSiteLoopWithCanonicalRuntimeHost(
  cwd: string,
  operation: (context: { runtimeHost: ReturnType<typeof openSiteOperatingRuntimeHost> }) => Promise<unknown> | unknown,
  options: RuntimeHostOptions = {},
) {
  const runtimeHost = openSiteOperatingRuntimeHost(cwd, options);
  const events: unknown[] = [];
  const leaseTtlMs = numberOption(options, 5 * 60_000, 'runtimeLeaseTtlMs', 'runtime_lease_ttl_ms');
  const heartbeatEveryMs = Math.max(1_000, Math.floor(leaseTtlMs / 3));
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const originalTransition = runtimeHost.transition.bind(runtimeHost);
  const transition = (nextState: string, details: RuntimeHostOptions = {}) => {
    const receipt = originalTransition(nextState, details);
    if (receipt?.event) events.push(receipt.event);
    return receipt;
  };
  try {
    const claim = runtimeHost.claim();
    if (claim?.event) events.push(claim.event);
    transition('binding', { reason: 'mcp_surface_runtime_host_binding_started' });
    transition('ready', {
      reason: 'mcp_surface_runtime_host_binding_ready',
      projection_attachment: 'external',
    });
    transition('serving', { reason: 'bounded_site_loop_operation_started' });
    runtimeHost.assertAuthority();
    heartbeatTimer = setInterval(() => {
      try {
        runtimeHost.heartbeat();
      } catch {
        // The bounded operation remains governed by the durable lease. A transient
        // SQLite write-lock collision is retried on the next heartbeat tick.
      }
    }, heartbeatEveryMs);
    heartbeatTimer.unref?.();
    const result = await operation({ runtimeHost });
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    transition('closing', { reason: 'bounded_site_loop_operation_completed' });
    transition('stopped', { reason: 'bounded_site_loop_operation_stopped' });
    const snapshot = runtimeHost.snapshot();
    return {
      ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { result }),
      runtime_host: snapshot,
      runtime_host_events: events,
    };
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    try {
      const state = runtimeHost.snapshot()?.runtime_host_state;
      if (['created', 'binding', 'ready', 'serving', 'closing'].includes(String(state))) {
        transition('failed', { reason: 'bounded_site_loop_operation_failed' });
      }
      if (runtimeHost.snapshot()?.runtime_host_state === 'failed') transition('stopped', { reason: 'bounded_site_loop_operation_stopped_after_failure' });
    } catch {}
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    runtimeHost.close();
  }
}
