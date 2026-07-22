import { existsSync, readFileSync } from 'node:fs';

export type CarrierHeartbeatRecord = Record<string, unknown>;

export function classifyResidentCarrierLiveness({
  heartbeat,
  process_count: processCount,
  session_readiness: sessionReadiness,
}: {
  heartbeat: CarrierHeartbeatRecord;
  process_count: number;
  session_readiness: CarrierHeartbeatRecord;
}) {
  const count = Number.isFinite(Number(processCount)) ? Number(processCount) : 0;
  if (Boolean(heartbeat.fresh) && Boolean(sessionReadiness.ready) && count > 0) {
    return {
      live: true,
      reason: 'fresh_heartbeat_session_ready_process_present',
      process_count: count,
      heartbeat,
      session_readiness: sessionReadiness,
    };
  }
  return count > 0
    ? { live: false, reason: heartbeat.fresh ? 'session_not_ready_process_present' : 'stale_carrier_heartbeat_process_present', process_count: count, heartbeat, session_readiness: sessionReadiness }
    : { live: false, reason: 'carrier_session_not_found_in_process_command_line', heartbeat, session_readiness: sessionReadiness };
}

export function readCarrierSessionReadiness(path: string, carrierSessionId: string) {
  if (!existsSync(path)) return { status: 'missing', ready: false, path };
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    let latestLifecycle = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: CarrierHeartbeatRecord;
      try {
        event = JSON.parse(line) as CarrierHeartbeatRecord;
      } catch {
        continue;
      }
      if (
        event.event === 'session_lifecycle_transition'
        && event.session_id === carrierSessionId
      ) {
        latestLifecycle = {
          lifecycle_state: event.lifecycle_state ?? null,
          event_sequence: event.event_sequence ?? event.sequence ?? null,
          timestamp: event.timestamp ?? null,
        };
      } else if (
        event.session_id === carrierSessionId
        && ['session_closed', 'session_stopped', 'session_terminated', 'session_failed'].includes(String(event.event))
      ) {
        latestLifecycle = {
          lifecycle_state: String(event.event).replace(/^session_/, ''),
          event_sequence: event.event_sequence ?? event.sequence ?? null,
          timestamp: event.timestamp ?? null,
        };
      }
    }
    const ready = latestLifecycle?.lifecycle_state === 'ready';
    return {
      status: ready ? 'ready' : latestLifecycle ? 'not_ready' : 'missing_lifecycle_state',
      ready,
      path,
      latest_lifecycle_state: latestLifecycle?.lifecycle_state ?? null,
      event_sequence: latestLifecycle?.event_sequence ?? null,
      timestamp: latestLifecycle?.timestamp ?? null,
    };
  } catch (error) {
    return {
      status: 'unreadable',
      ready: false,
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readCarrierHeartbeatRecord(
  path: string,
  carrierSessionId: string,
  staleAfterMs: number,
) {
  if (!existsSync(path)) return { status: 'missing', fresh: false, live: false, path };
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as CarrierHeartbeatRecord;
    if (record.status === 'stopped') {
      return {
        status: 'stopped',
        fresh: false,
        live: false,
        age_ms: null,
        stale_after_ms: staleAfterMs,
        path,
        record,
      };
    }
    const heartbeatMs = Date.parse(typeof record.heartbeat_at === 'string' ? record.heartbeat_at : '');
    const age_ms = Number.isFinite(heartbeatMs) ? Date.now() - heartbeatMs : null;
    const observedSessionId = record.session_id ?? record.carrier_session_id;
    const matches = observedSessionId === carrierSessionId;
    const fresh = matches && record.status === 'alive' && age_ms !== null && age_ms <= staleAfterMs;
    return {
      status: fresh ? 'fresh' : 'stale',
      fresh,
      live: fresh,
      age_ms,
      stale_after_ms: staleAfterMs,
      path,
      record,
    };
  } catch (error) {
    return {
      status: 'unreadable',
      fresh: false,
      live: false,
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
