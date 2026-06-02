import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';

export function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      status: 'unreadable',
      path: filePath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildMcpFreshnessStatus({
  siteRoot,
  serverName,
  serverEntryPoint,
  serverBootedAt,
  watchedPaths = [],
  expectedTools = [],
  registeredTools = [],
  restartRequestPath,
  baselinePath,
  selfRestartSupported = false,
  restartToolName,
  testToolName = 'task_lifecycle_test_mcp_tool',
}) {
  const sourceEvidence = collectSourceEvidence({ siteRoot, watchedPaths });
  const restartRequest = readJsonFile(restartRequestPath);
  const baseline = readJsonFile(baselinePath);
  const baselineMtime = Number.isFinite(baseline?.baseline_mtime) ? baseline.baseline_mtime : 0;
  const sourceDigestComparison = compareSourceDigest({ sourceEvidence, baseline });
  const sourceNewerThanBaseline = baselineMtime > 0 && sourceEvidence.current_max_mtime > baselineMtime;
  const sourceChangedSinceBaseline = sourceDigestComparison.source_digest_changed ?? sourceNewerThanBaseline;
  const missingExpectedTools = expectedTools.filter((name) => !registeredTools.includes(name));
  const pendingRestart = Boolean(restartRequest) || sourceNewerThanBaseline === true || missingExpectedTools.length > 0;
  const hostRegistryReference = buildHostRuntimeReference({ serverName, serverEntryPoint, restartRequest });

  return {
    schema: 'narada.mcp.live_freshness.v0',
    server_name: serverName,
    server_entrypoint: serverEntryPoint,
    live_process: {
      booted_at: serverBootedAt,
      pid: process.pid,
      self_restart_supported: selfRestartSupported,
    },
    source: sourceEvidence,
    baseline: {
      path: baselinePath,
      state: baseline ? 'present' : 'missing',
      payload: baseline,
      source_newer_than_baseline: sourceNewerThanBaseline,
      source_digest: sourceDigestComparison.baseline_source_digest,
      source_digest_algorithm: sourceDigestComparison.source_digest_algorithm,
      source_digest_changed: sourceDigestComparison.source_digest_changed,
      freshness_basis: sourceDigestComparison.freshness_basis,
    },
    restart_request: {
      path: restartRequestPath,
      state: restartRequest ? 'restart_requested' : 'no_restart_request',
      payload: restartRequest,
    },
    host_registry_reference: hostRegistryReference,
    tool_surface: {
      expected_count: expectedTools.length,
      registered_count: registeredTools.length,
      missing_expected_tools: missingExpectedTools,
    },
    pending_restart: pendingRestart,
    stale_live_surface_possible: pendingRestart,
    source_digest: sourceEvidence.source_digest,
    baseline_source_digest: sourceDigestComparison.baseline_source_digest,
    source_digest_changed: sourceDigestComparison.source_digest_changed,
    freshness_basis: sourceDigestComparison.freshness_basis,
    remediation: pendingRestart
      ? buildRestartRemediation({ restartToolName, testToolName, serverEntryPoint, selfRestartSupported })
      : [
          'No pending restart signal is recorded for this MCP server.',
          `Use ${testToolName} against ${serverEntryPoint} for fresh one-shot verification after source edits.`,
        ],
  };
}

export function writeMcpRuntimeInstanceObservation({
  siteRoot,
  pcSiteRoot = process.env.NARADA_PC_SITE_ROOT ?? 'C:/ProgramData/Narada/sites/pc/desktop-sunroom-2',
  surfaceId,
  serverName,
  serverEntryPoint,
  serverBootedAt,
  watchedPaths = [],
  restartRequestPath,
  baselinePath,
  freshnessEvidencePath = null,
  transport = { type: 'stdio', runtime_kind: 'node-stdio' },
  now = new Date(),
} = {}) {
  if (!siteRoot) throw new Error('siteRoot is required');
  if (!surfaceId) throw new Error('surfaceId is required');
  const observedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const pcRoot = resolve(pcSiteRoot);
  const registryPath = join(pcRoot, 'runtime', 'mcp-runtime-instances.json');
  const registry = readJsonFile(registryPath) ?? {
    schema: 'narada.pc_runtime.mcp_runtime_instance_registry.v0',
    instances: [],
  };
  const instances = Array.isArray(registry.instances) ? registry.instances : [];
  const sourceEvidence = collectSourceEvidence({ siteRoot, watchedPaths });
  const baseline = readJsonFile(baselinePath);
  const restartRequestPayload = readJsonFile(restartRequestPath);
  const baselineMtime = Number.isFinite(baseline?.baseline_mtime) ? baseline.baseline_mtime : null;
  const sourceDigestComparison = compareSourceDigest({ sourceEvidence, baseline });
  const sourceNewerThanBaseline = Number.isFinite(baselineMtime)
    ? sourceEvidence.current_max_mtime > baselineMtime
    : null;
  const sourceChangedSinceBaseline = sourceDigestComparison.source_digest_changed ?? sourceNewerThanBaseline;
  const inheritedCarrierSession = readInheritedCarrierSession({ pcRoot });
  const entry = {
    surface_id: surfaceId,
    server_name: serverName ?? null,
    site_root: resolve(siteRoot),
    carrier_session_owner: process.env.NARADA_AGENT_ID?.trim() || 'carrier_session_unknown',
    carrier_owner: process.env.NARADA_AGENT_ID?.trim() || 'carrier_session_unknown',
    carrier_session_id: inheritedCarrierSession.carrier_session_id,
    parent_carrier_session_ref: inheritedCarrierSession.parent_carrier_session_ref,
    carrier_session_binding: inheritedCarrierSession.binding,
    process_identity_evidence: {
      schema: 'narada.pc_runtime.mcp_process_identity_evidence.v0',
      pid: process.pid,
      booted_at: serverBootedAt ?? null,
      agent_id: process.env.NARADA_AGENT_ID?.trim() || null,
      agent_start_event_id: process.env.NARADA_AGENT_START_EVENT_ID?.trim() || null,
      codex_admission_id: process.env.NARADA_CODEX_ADMISSION_ID?.trim() || null,
      carrier_session_id: inheritedCarrierSession.carrier_session_id,
      parent_carrier_session_ref: inheritedCarrierSession.parent_carrier_session_ref,
      agent_context_db: process.env.NARADA_AGENT_CONTEXT_DB?.trim() || null,
      site_root: process.env.NARADA_SITE_ROOT?.trim() || null,
      evidence_source: 'mcp_server_inherited_carrier_environment',
      recorded_at: observedAt,
    },
    supervisor_owned: false,
    reload_support: {
      carrier_reload_supported: false,
      reconnect_supported: false,
      source: 'stdio_child_runtime_observation',
    },
    runtime_state_path: registryPath,
    freshness_evidence_path: freshnessEvidencePath,
    last_observed_at: observedAt,
    source: {
      current_max_mtime: sourceEvidence.current_max_mtime,
      current_max_path: sourceEvidence.current_max_path,
      source_digest: sourceEvidence.source_digest,
      source_digest_algorithm: sourceEvidence.source_digest_algorithm,
      source_manifest_paths: sourceEvidence.source_manifest_paths,
      watched_path_summary: watchedPaths.join(', '),
      source_newer_than_baseline: sourceNewerThanBaseline,
      source_digest_changed: sourceDigestComparison.source_digest_changed,
      freshness_basis: sourceDigestComparison.freshness_basis,
    },
    baseline: baseline ? {
      baseline_mtime: baselineMtime,
      source_digest: sourceDigestComparison.baseline_source_digest,
      source_digest_algorithm: sourceDigestComparison.source_digest_algorithm,
      recorded_at: baseline.recorded_at ?? baseline.acknowledged_at ?? baseline.requested_at ?? null,
      payload_schema: baseline.schema ?? null,
    } : null,
    restart_request: restartRequestPayload ? {
      state: 'restart_requested',
      path: restartRequestPath,
      payload: restartRequestPayload,
    } : { state: 'no_restart_request', path: restartRequestPath },
    runtime: {
      pid: process.pid,
      booted_at: serverBootedAt ?? null,
      source_newer_than_baseline: sourceNewerThanBaseline,
      source_digest_changed: sourceChangedSinceBaseline,
      freshness_basis: sourceDigestComparison.freshness_basis,
    },
    transport,
    observation_authority: {
      locus: 'pc_site_runtime',
      source: 'live_mcp_process_self_observation',
      note: 'Carrier identity is accepted only from inherited launcher environment, not from process-list inference.',
    },
  };
  const index = instances.findIndex((candidate) =>
    candidate?.surface_id === surfaceId && sameMcpSiteRoot(candidate, siteRoot)
  );
  const existing = index >= 0 ? instances[index] : null;
  const preserveExistingCarrier = isBoundCarrierObservation(existing) && isUnboundCarrierObservation(entry);
  const mergedEntry = preserveExistingCarrier
    ? preserveBoundCarrierObservation(existing, entry)
    : (existing ? { ...existing, ...entry } : entry);
  const nextInstances = index >= 0
    ? [...instances.slice(0, index), mergedEntry, ...instances.slice(index + 1)]
    : [...instances, entry];
  const nextRegistry = {
    ...registry,
    schema: registry.schema ?? 'narada.pc_runtime.mcp_runtime_instance_registry.v0',
    updated_at: observedAt,
    instances: nextInstances,
  };
  mkdirSync(join(pcRoot, 'runtime'), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(nextRegistry, null, 2), 'utf8');
  return {
    status: preserveExistingCarrier ? 'preserved_bound_carrier_observation' : 'observed',
    registry_path: registryPath,
    surface_id: surfaceId,
    recorded_at: observedAt,
  };
}

function sameMcpSiteRoot(candidate, siteRoot) {
  const left = canonicalMcpSiteRoot(candidate?.site_root ?? candidate?.process_identity_evidence?.site_root);
  const right = canonicalMcpSiteRoot(siteRoot);
  return Boolean(left && right && left === right);
}

function canonicalMcpSiteRoot(value) {
  if (!value || typeof value !== 'string') return null;
  return resolve(value).toLowerCase();
}

export function refreshMcpBaselineFromLiveObservation({
  siteRoot,
  serverName,
  targetSurface,
  targetEntrypoint,
  baselinePath,
  acknowledgedBy,
  reason,
  watchedPaths = [],
  note,
}) {
  const acknowledgedAt = new Date().toISOString();
  const sourceEvidence = collectSourceEvidence({ siteRoot, watchedPaths });
  const baselineMtime = Math.max(Date.now(), Math.ceil(sourceEvidence.current_max_mtime));
  mkdirSync(join(siteRoot, '.ai', 'tmp'), { recursive: true });
  const payload = {
    schema: 'narada.mcp.live_observation_baseline_refresh.v0',
    acknowledged_at: acknowledgedAt,
    acknowledged_by: acknowledgedBy ?? null,
    reason: reason ?? null,
    baseline_mtime: baselineMtime,
    source_digest: sourceEvidence.source_digest,
    source_digest_algorithm: sourceEvidence.source_digest_algorithm,
    source_files_count: sourceEvidence.source_files_count,
    source_manifest_paths: sourceEvidence.source_manifest_paths,
    freshness_basis: 'source_digest',
    surface: targetSurface,
    server_name: serverName,
    target_entrypoint: targetEntrypoint,
    source_max_mtime: sourceEvidence.current_max_mtime,
    source_max_path: sourceEvidence.current_max_path,
    note: note ?? 'Live MCP boot and carrier evidence contradicted stale no-request marker; baseline refreshed.',
  };
  writeFileSync(baselinePath, JSON.stringify(payload, null, 2), 'utf8');
  return {
    status: 'baseline_refreshed_from_live_observation',
    schema: payload.schema,
    baseline_path: baselinePath,
    acknowledged_at: acknowledgedAt,
    baseline: payload,
  };
}

function isBoundCarrierObservation(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const carrierSessionId = entry.carrier_session_id ?? entry.process_identity_evidence?.carrier_session_id ?? null;
  const bindingStatus = entry.carrier_session_binding?.status ?? (carrierSessionId ? 'bound_to_parent_carrier_session' : null);
  return Boolean(carrierSessionId) && ![
    'legacy_unbound',
    'terminal_missing_embodiment_authority',
  ].includes(bindingStatus);
}

function isUnboundCarrierObservation(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const carrierSessionId = entry.carrier_session_id ?? entry.process_identity_evidence?.carrier_session_id ?? null;
  const bindingStatus = entry.carrier_session_binding?.status ?? (carrierSessionId ? 'bound_to_parent_carrier_session' : 'legacy_unbound');
  return !carrierSessionId || [
    'legacy_unbound',
    'terminal_missing_embodiment_authority',
  ].includes(bindingStatus);
}

function preserveBoundCarrierObservation(existing, rejected) {
  const suppressed = Array.isArray(existing.suppressed_unbound_observations)
    ? existing.suppressed_unbound_observations
    : [];
  return {
    ...existing,
    suppressed_unbound_observations: [
      ...suppressed.slice(-9),
      summarizeSuppressedUnboundObservation(rejected),
    ],
    registry_guard: {
      schema: 'narada.pc_runtime.mcp_runtime_registry_guard.v0',
      status: 'preserved_bound_carrier_observation',
      reason: 'unbound_observation_cannot_replace_bound_carrier_session_evidence',
      recorded_at: rejected.last_observed_at ?? new Date().toISOString(),
    },
  };
}

function summarizeSuppressedUnboundObservation(entry) {
  return {
    schema: 'narada.pc_runtime.suppressed_unbound_mcp_observation.v0',
    surface_id: entry.surface_id ?? null,
    server_name: entry.server_name ?? null,
    carrier_session_owner: entry.carrier_session_owner ?? null,
    carrier_session_id: entry.carrier_session_id ?? null,
    carrier_session_binding_status: entry.carrier_session_binding?.status ?? null,
    process_identity_evidence: entry.process_identity_evidence ?? null,
    runtime: entry.runtime ?? null,
    last_observed_at: entry.last_observed_at ?? null,
    observation_authority: entry.observation_authority ?? null,
  };
}

function readInheritedCarrierSession({ pcRoot }) {
  const carrierSessionId = process.env.NARADA_CARRIER_SESSION_ID?.trim() || null;
  if (!carrierSessionId) {
    return {
      carrier_session_id: null,
      parent_carrier_session_ref: null,
      binding: {
        schema: 'narada.pc_runtime.mcp_child_carrier_session_binding.v0',
        status: 'legacy_unbound',
        reason: 'NARADA_CARRIER_SESSION_ID not inherited by MCP child process.',
        verification_source: 'mcp_server_inherited_carrier_environment',
        migration_guidance: {
          schema: 'narada.pc_runtime.carrier_session_migration_guidance.v0',
          status: 'legacy_unbound',
          authority_missing: 'NARADA_CARRIER_SESSION_ID',
          allowed_observation_scope: 'observation_only_degraded',
          migration_path: 'relaunch_through_registered_agent_start_path_to_inherit_NARADA_CARRIER_SESSION_ID',
          operator_guidance: 'Legacy unbound observation may continue as degraded evidence, but restart or readiness claims require relaunch through a registered carrier session.',
          forbidden_inference_sources: ['pid', 'window_title', 'window_order', 'user_memory'],
        },
      },
    };
  }
  const recordPath = join(pcRoot, 'runtime', 'carrier-sessions', `${carrierSessionId}.json`);
  const record = readJsonFile(recordPath);
  return {
    carrier_session_id: carrierSessionId,
    parent_carrier_session_ref: {
      schema: 'narada.pc_runtime.parent_carrier_session_ref.v0',
      carrier_session_id: carrierSessionId,
      record_path: recordPath,
      record_status: record && record.status !== 'unreadable' ? 'found' : 'missing_or_unreadable',
      verification_source: 'NARADA_CARRIER_SESSION_ID',
    },
    binding: {
      schema: 'narada.pc_runtime.mcp_child_carrier_session_binding.v0',
      status: record && record.status !== 'unreadable' ? 'bound_to_parent_carrier_session' : 'inherited_id_record_missing',
      carrier_session_id: carrierSessionId,
      record_path: recordPath,
      verification_source: 'mcp_server_inherited_carrier_environment',
      record_summary: record && record.status !== 'unreadable' ? {
        status: record.status ?? null,
        verified_agent_identity: record.verified_agent_identity ?? null,
        agent_start_event_id: record.agent_start_event_id ?? null,
        started_at: record.started_at ?? null,
        restart_handle: record.restart_handle ?? null,
      } : null,
    },
  };
}

export function writeMcpRestartRequest({
  siteRoot,
  serverName,
  targetSurface,
  targetEntrypoint,
  restartRequestPath,
  baselinePath,
  requestedBy,
  reason,
  note,
}) {
  const requestedAt = new Date().toISOString();
  const payload = {
    schema: 'narada.mcp.restart_request.v0',
    requested_at: requestedAt,
    requested_by: requestedBy ?? null,
    reason,
    can_self_restart: false,
    restart_mechanism: 'external_stdio_mcp_restart_required',
    server_name: serverName,
    target_surface: targetSurface,
    target_entrypoint: targetEntrypoint,
    requested_process: {
      pid: process.pid,
      booted_at: process.env.NARADA_SERVER_BOOTED_AT ?? null,
    },
    note,
  };
  mkdirSync(join(siteRoot, '.ai', 'tmp'), { recursive: true });
  writeFileSync(restartRequestPath, JSON.stringify(payload, null, 2), 'utf8');
  writeFileSync(baselinePath, JSON.stringify({
    schema: 'narada.mcp.reload_request.v0',
    requested_at: requestedAt,
    baseline_mtime: Date.now(),
    surface: targetSurface,
    target_entrypoint: targetEntrypoint,
    note,
  }, null, 2), 'utf8');
  return {
    status: 'restart_requested',
    schema: payload.schema,
    can_self_restart: false,
    restart_mechanism: payload.restart_mechanism,
    request_path: restartRequestPath,
    baseline_path: baselinePath,
    requested_at: requestedAt,
    message: note,
  };
}

export function acknowledgeMcpRestartRequest({
  siteRoot,
  pcSiteRoot = process.env.NARADA_PC_SITE_ROOT ?? 'C:/ProgramData/Narada/sites/pc/desktop-sunroom-2',
  serverName,
  targetSurface,
  targetEntrypoint,
  restartRequestPath,
  baselinePath,
  acknowledgedBy,
  reason,
  watchedPaths = [],
  expectedTools = [],
  registeredTools = [],
  note,
}) {
  const acknowledgedAt = new Date().toISOString();
  const sourceEvidence = collectSourceEvidence({ siteRoot, watchedPaths });
  const restartRequest = readJsonFile(restartRequestPath);
  const acknowledgementGate = validateMcpRestartAcknowledgement({
    pcSiteRoot,
    targetSurface,
    targetEntrypoint,
    restartRequest,
    sourceEvidence,
    expectedTools,
    registeredTools,
  });
  if (acknowledgementGate.status !== 'acknowledgeable') {
    return {
      status: 'restart_acknowledgement_rejected',
      schema: 'narada.mcp.restart_acknowledgement_rejection.v0',
      can_self_restart: false,
      restart_mechanism: 'external_stdio_mcp_restart_required',
      request_path: restartRequestPath,
      baseline_path: baselinePath,
      target_surface: targetSurface,
      target_entrypoint: targetEntrypoint,
      rejected_at: acknowledgedAt,
      acknowledged_by: acknowledgedBy ?? null,
      reason: acknowledgementGate.reason,
      validation: acknowledgementGate,
      message: 'Restart acknowledgement rejected: post-request carrier boot evidence is required before clearing the marker.',
    };
  }
  const baselineMtime = Math.max(Date.now(), Math.ceil(sourceEvidence.current_max_mtime));
  mkdirSync(join(siteRoot, '.ai', 'tmp'), { recursive: true });
  rmSync(restartRequestPath, { force: true });
  const payload = {
    schema: 'narada.mcp.restart_acknowledgement.v0',
    acknowledged_at: acknowledgedAt,
    acknowledged_by: acknowledgedBy ?? null,
    reason: reason ?? null,
    baseline_mtime: baselineMtime,
    source_digest: sourceEvidence.source_digest,
    source_digest_algorithm: sourceEvidence.source_digest_algorithm,
    source_files_count: sourceEvidence.source_files_count,
    source_manifest_paths: sourceEvidence.source_manifest_paths,
    freshness_basis: 'source_digest',
    surface: targetSurface,
    server_name: serverName,
    target_entrypoint: targetEntrypoint,
    source_max_mtime: sourceEvidence.current_max_mtime,
    source_max_path: sourceEvidence.current_max_path,
    acknowledgement_validation: acknowledgementGate,
    note: note ?? 'External stdio MCP restart acknowledged; restart request marker cleared.',
  };
  writeFileSync(baselinePath, JSON.stringify(payload, null, 2), 'utf8');
  const registry_reconciliation = reconcileMcpRuntimeRegistryAfterAcknowledgement({
    pcSiteRoot,
    targetSurface,
    targetEntrypoint,
    baselinePayload: payload,
    acknowledgementGate,
    sourceEvidence,
  });
  return {
    status: 'restart_acknowledged',
    schema: payload.schema,
    can_self_restart: false,
    restart_mechanism: 'external_stdio_mcp_restart_required',
    request_path: restartRequestPath,
    baseline_path: baselinePath,
    acknowledged_at: acknowledgedAt,
    baseline: payload,
    validation: acknowledgementGate,
    registry_reconciliation,
    message: payload.note,
  };
}

function reconcileMcpRuntimeRegistryAfterAcknowledgement({
  pcSiteRoot,
  targetSurface,
  targetEntrypoint,
  baselinePayload,
  acknowledgementGate,
  sourceEvidence,
}) {
  const registryPath = join(resolve(pcSiteRoot), 'runtime', 'mcp-runtime-instances.json');
  const registry = readJsonFile(registryPath);
  const instances = Array.isArray(registry?.instances) ? registry.instances : [];
  const index = instances.findIndex((entry) => entry?.surface_id === targetSurface
    || entry?.server_entrypoint === targetEntrypoint
    || entry?.server_entry_point === targetEntrypoint);
  if (index < 0) {
    return {
      schema: 'narada.mcp.restart_registry_reconciliation.v0',
      status: 'skipped_target_not_observed',
      registry_path: registryPath,
      target_surface: targetSurface,
      target_entrypoint: targetEntrypoint,
    };
  }

  const instance = instances[index];
  const acknowledgedAt = baselinePayload.acknowledged_at;
  const bootEvidence = acknowledgementGate.post_restart_process_identity ?? {};
  const reconciliation = {
    schema: 'narada.mcp.restart_registry_reconciliation.v0',
    status: 'restart_acknowledged_baseline_refreshed',
    reconciled_at: acknowledgedAt,
    target_surface: targetSurface,
    target_entrypoint: targetEntrypoint,
    previous_restart_request_state: instance.restart_request?.state ?? null,
    baseline_mtime: baselinePayload.baseline_mtime,
    source_digest: baselinePayload.source_digest,
    source_digest_algorithm: baselinePayload.source_digest_algorithm,
    source_max_mtime: sourceEvidence.current_max_mtime,
    evidence_refs: [
      'restart_request_marker_present',
      'post_request_boot_evidence',
      'carrier_session_lineage_present',
      'tool_readiness_verified',
    ],
  };
  const nextInstance = {
    ...instance,
    source_newer_than_baseline: false,
    pending_restart: false,
    restart_request: {
      schema: 'narada.mcp.restart_request_reconciled.v0',
      state: 'carrier_restarted',
      requested_at: acknowledgementGate.requested_at,
      restarted_at: bootEvidence.booted_at ?? null,
      acknowledged_at: acknowledgedAt,
      acknowledged_by: baselinePayload.acknowledged_by ?? null,
      reason: baselinePayload.reason ?? null,
      previous_state: instance.restart_request?.state ?? 'restart_requested',
    },
    source: {
      ...(instance.source ?? {}),
      current_max_mtime: sourceEvidence.current_max_mtime,
      current_max_path: sourceEvidence.current_max_path,
      source_digest: sourceEvidence.source_digest,
      source_digest_algorithm: sourceEvidence.source_digest_algorithm,
      source_manifest_paths: sourceEvidence.source_manifest_paths,
      source_newer_than_baseline: false,
      source_digest_changed: false,
      freshness_basis: 'source_digest',
    },
    baseline: {
      ...(instance.baseline ?? {}),
      baseline_mtime: baselinePayload.baseline_mtime,
      source_digest: baselinePayload.source_digest,
      source_digest_algorithm: baselinePayload.source_digest_algorithm,
      acknowledged_at: acknowledgedAt,
      payload_schema: baselinePayload.schema,
    },
    source_freshness: {
      ...(instance.source_freshness ?? {}),
      source_epoch: sourceEvidence.current_max_mtime,
      source_max_mtime: sourceEvidence.current_max_mtime,
      baseline_mtime: baselinePayload.baseline_mtime,
      baseline_recorded_at: acknowledgedAt,
      source_digest: sourceEvidence.source_digest,
      baseline_source_digest: baselinePayload.source_digest,
      source_digest_algorithm: baselinePayload.source_digest_algorithm,
      source_digest_changed: false,
      freshness_basis: 'source_digest',
      source_newer_than_baseline: false,
      pending_restart: false,
    },
    runtime: {
      ...(instance.runtime ?? {}),
      pid: bootEvidence.pid ?? instance.runtime?.pid ?? instance.process_identity_evidence?.pid ?? null,
      booted_at: bootEvidence.booted_at ?? instance.runtime?.booted_at ?? instance.process_identity_evidence?.booted_at ?? null,
      source_newer_than_baseline: false,
      source_digest_changed: false,
      freshness_basis: 'source_digest',
    },
    verification: {
      ...(instance.verification ?? {}),
      fresh_one_shot_verified: instance.verification?.fresh_one_shot_verified ?? null,
      live_surface_verified: true,
      carrier_restarted: true,
      evidence_refs: [
        ...new Set([
          ...(Array.isArray(instance.verification?.evidence_refs) ? instance.verification.evidence_refs : []),
          ...reconciliation.evidence_refs,
        ]),
      ],
    },
    registry_reconciliation: reconciliation,
  };
  const nextRegistry = {
    ...registry,
    updated_at: acknowledgedAt,
    instances: [
      ...instances.slice(0, index),
      nextInstance,
      ...instances.slice(index + 1),
    ],
  };
  writeFileSync(registryPath, JSON.stringify(nextRegistry, null, 2), 'utf8');
  return {
    ...reconciliation,
    registry_path: registryPath,
    carrier_session_id: nextInstance.carrier_session_id ?? nextInstance.process_identity_evidence?.carrier_session_id ?? null,
  };
}

export function validateMcpRestartAcknowledgement({
  pcSiteRoot = process.env.NARADA_PC_SITE_ROOT ?? 'C:/ProgramData/Narada/sites/pc/desktop-sunroom-2',
  targetSurface,
  targetEntrypoint,
  restartRequest,
  sourceEvidence,
  expectedTools = [],
  registeredTools = [],
} = {}) {
  if (!restartRequest || restartRequest.status === 'unreadable') {
    return {
      status: 'rejected',
      reason: 'restart_request_marker_missing',
      detail: 'A restart marker must be present; deleting or clearing it is not proof of restart.',
    };
  }
  const requestedAt = Date.parse(restartRequest.requested_at ?? '');
  if (!Number.isFinite(requestedAt)) {
    return {
      status: 'rejected',
      reason: 'restart_request_timestamp_missing',
      detail: 'Restart acknowledgement requires a parseable restart request timestamp.',
      restart_request: restartRequest,
    };
  }

  const registryPath = join(resolve(pcSiteRoot), 'runtime', 'mcp-runtime-instances.json');
  const registry = readJsonFile(registryPath);
  const instances = Array.isArray(registry?.instances) ? registry.instances : [];
  const instance = instances.find((entry) => entry?.surface_id === targetSurface
    || entry?.server_entrypoint === targetEntrypoint
    || entry?.server_entry_point === targetEntrypoint);
  if (!instance) {
    return {
      status: 'rejected',
      reason: 'post_restart_runtime_observation_missing',
      detail: 'No PC runtime observation exists for the target surface.',
      registry_path: registryPath,
    };
  }

  const processEvidence = instance.process_identity_evidence ?? {};
  const bootedAtRaw = processEvidence.booted_at ?? instance.booted_at ?? null;
  const bootedAt = Date.parse(bootedAtRaw ?? '');
  if (!Number.isFinite(bootedAt) || bootedAt <= requestedAt) {
    return {
      status: 'rejected',
      reason: 'post_request_boot_evidence_missing',
      detail: 'Target MCP child boot evidence must be newer than the restart request.',
      requested_at: restartRequest.requested_at,
      observed_booted_at: bootedAtRaw,
      observed_pid: processEvidence.pid ?? instance.pid ?? null,
    };
  }

  const binding = instance.carrier_session_binding ?? {};
  const carrierSessionId = instance.carrier_session_id ?? processEvidence.carrier_session_id ?? null;
  const bindingStatus = binding.status ?? (carrierSessionId ? 'bound_to_parent_carrier_session' : 'legacy_unbound');
  if (!carrierSessionId || ['legacy_unbound', 'terminal_missing_embodiment_authority'].includes(bindingStatus)) {
    return {
      status: 'rejected',
      reason: 'carrier_session_lineage_missing',
      detail: 'Post-restart child evidence must include inherited carrier session lineage or explicit successor session evidence.',
      carrier_session_id: carrierSessionId,
      carrier_session_binding: binding,
    };
  }

  const sourceFreshness = instance.source_freshness ?? {};
  const sourceDigestComparison = compareSourceDigest({
    sourceEvidence,
    baseline: instance.baseline ?? instance.source_baseline ?? {},
  });
  const sourceNewerThanBaseline = sourceFreshness.source_newer_than_baseline
    ?? instance.source_newer_than_baseline
    ?? (Number.isFinite(instance.source?.current_max_mtime) && Number.isFinite(instance.baseline?.baseline_mtime)
      ? instance.source.current_max_mtime > instance.baseline.baseline_mtime
      : null);
  const pendingRestart = sourceFreshness.pending_restart ?? instance.pending_restart ?? null;

  const missingExpectedTools = expectedTools.filter((name) => !registeredTools.includes(name));
  if (expectedTools.length > 0 && missingExpectedTools.length > 0) {
    return {
      status: 'rejected',
      reason: 'tool_readiness_unproven',
      detail: 'Registered live tool surface does not contain all expected tools.',
      expected_count: expectedTools.length,
      registered_count: registeredTools.length,
      missing_expected_tools: missingExpectedTools,
    };
  }

  return {
    status: 'acknowledgeable',
    schema: 'narada.mcp.restart_acknowledgement_validation.v0',
    requested_at: restartRequest.requested_at,
    target_surface: targetSurface,
    target_entrypoint: targetEntrypoint,
    post_restart_process_identity: {
      pid: processEvidence.pid ?? instance.pid ?? null,
      booted_at: bootedAtRaw,
    },
    carrier_session_id: carrierSessionId,
    parent_carrier_session_ref: instance.parent_carrier_session_ref ?? binding.parent_carrier_session_ref ?? null,
    carrier_session_binding: binding,
    source_freshness: {
      source_newer_than_baseline: sourceNewerThanBaseline,
      source_digest: sourceEvidence?.source_digest ?? null,
      baseline_source_digest: sourceDigestComparison.baseline_source_digest,
      source_digest_algorithm: sourceDigestComparison.source_digest_algorithm,
      source_digest_changed: sourceDigestComparison.source_digest_changed,
      freshness_basis: sourceDigestComparison.freshness_basis,
      pending_restart: pendingRestart,
      source_max_mtime: sourceEvidence?.current_max_mtime ?? null,
    },
    tool_readiness: {
      expected_count: expectedTools.length,
      registered_count: registeredTools.length,
      missing_expected_tools: missingExpectedTools,
    },
  };
}

export function buildMcpRestartPressure(freshnessEntries = []) {
  const staleSurfaces = freshnessEntries.filter((entry) =>
    entry?.stale_live_surface_possible === true || entry?.pending_restart === true
  );
  return {
    schema: 'narada.mcp.restart_pressure.v0',
    status: staleSurfaces.length > 0 ? 'active' : 'clear',
    pressure_kind: 'external_mcp_restart_required',
    summary: staleSurfaces.length > 0
      ? `${staleSurfaces.length} live MCP surface(s) have pending restart or stale-live pressure.`
      : 'No pending MCP restart pressure detected.',
    authority_boundary: {
      agent_can_execute_restart: false,
      restart_authority: 'operator_or_external_carrier',
      rule: 'Agents may surface restart pressure and use fresh one-shot verification; stdio MCP servers require external carrier/session restart.',
    },
    surfaces: staleSurfaces.map((entry) => {
      const startupDisposition = classifyFreshnessStartupDisposition(entry);
      return {
        server_name: entry.server_name ?? null,
        server_entrypoint: entry.server_entrypoint ?? null,
        pending_restart: entry.pending_restart === true,
        stale_live_surface_possible: entry.stale_live_surface_possible === true,
        restart_request_state: entry.restart_request?.state ?? entry.restart_request_state ?? 'unknown',
        restart_mechanism: entry.restart_mechanism ?? (
          entry.live_process?.self_restart_supported === true
            ? 'self_restart_supported'
            : 'external_stdio_mcp_restart_required'
        ),
        startup_disposition: startupDisposition,
        restart_handle_required: startupDisposition === 'terminal_blocked_missing_parent_carrier_restart_handle',
        host_registry_reference: entry.host_registry_reference ?? buildHostRuntimeReference({
          serverName: entry.server_name,
          serverEntryPoint: entry.server_entrypoint,
          restartRequest: entry.restart_request?.payload,
        }),
        remediation: entry.remediation ?? entry.sanctioned_remediation ?? [],
      };
    }),
    next_actions: staleSurfaces.length > 0
      ? [
          'Do not declare standby while restart pressure is active.',
          'Inspect operator_surface_mcp_runtime_registry_status for host-level MCP runtime evidence.',
          'Use operator_surface_mcp_restart_request to coordinate restartable instances and surface concrete restart handles or missing-authority blockers.',
          'Use fresh one-shot MCP verification for claims that depend on changed source.',
          'Ask for operator restart only when host evidence reports operator_restart_required_with_handle; otherwise preserve the terminal missing-authority blocker.',
        ]
      : [],
    is_navigation_pressure: staleSurfaces.length > 0,
  };
}

export function deriveMcpRestartPressureRecommendation(mcpRestartPressure) {
  if (mcpRestartPressure?.status !== 'active') return null;
  return {
    action: mcpRestartPressure.surfaces?.some((surface) => surface.startup_disposition === 'operator_restart_required_with_handle')
      ? 'request_external_mcp_restart_with_handle'
      : 'resolve_missing_mcp_carrier_restart_handle',
    reason: mcpRestartPressure.summary,
    authority_boundary: mcpRestartPressure.authority_boundary,
    mcp_restart_pressure: mcpRestartPressure,
  };
}

export function buildStaleLiveNavigationDegradation(mcpRestartPressure) {
  const active = mcpRestartPressure?.status === 'active' && mcpRestartPressure?.is_navigation_pressure === true;
  const fields = [
    'recommendation',
    'recommendations',
    'local_followups',
    'role_wide_followups',
    'downstream_role_followups',
    'recently_materialized',
    'new_tasks_available',
  ];
  return {
    schema: 'narada.mcp.stale_live_navigation_degradation.v0',
    status: active ? 'degraded' : 'fresh',
    stale_live_surface_possible: active,
    warning: active
      ? 'Navigation-critical fields may reflect stale live MCP code. Treat recommendations and followup classification as provisional until external restart or fresh one-shot verification.'
      : null,
    affected_fields: active ? fields : [],
    field_quality: Object.fromEntries(fields.map((field) => [
      field,
      {
        stale_live_possible: active,
        confidence: active ? 'provisional' : 'normal',
      },
    ])),
    remediation: active ? (mcpRestartPressure.next_actions ?? []) : [],
  };
}

function classifyFreshnessStartupDisposition(entry) {
  if (entry?.startup_disposition) return entry.startup_disposition;
  if (entry?.live_process?.self_restart_supported === true) return 'restartable_by_supervisor';
  if (entry?.restart_request?.state === 'carrier_restarted' && entry?.pending_restart !== true) return 'already_refreshed_acknowledgeable';
  if (entry?.carrier_session_binding?.status === 'legacy_unbound') return 'legacy_unbound_carrier_session';
  if (entry?.carrier_session_binding?.status === 'terminal_missing_embodiment_authority') {
    return 'terminal_blocked_missing_parent_carrier_restart_handle';
  }
  const restartHandle = entry?.carrier_session_binding?.record_summary?.restart_handle
    ?? entry?.parent_carrier_session_ref?.restart_handle
    ?? entry?.restart_handle;
  if (restartHandle && restartHandle.class && restartHandle.class !== 'missing_restart_handle' && restartHandle.class !== 'not_restartable') {
    return 'operator_restart_required_with_handle';
  }
  if (entry?.pending_restart === true || entry?.stale_live_surface_possible === true) {
    return 'terminal_blocked_missing_parent_carrier_restart_handle';
  }
  return 'already_refreshed_acknowledgeable';
}

function buildHostRuntimeReference({ serverName, serverEntryPoint, restartRequest }) {
  const targetSurface = restartRequest?.target_surface ?? inferSurfaceIdFromServerName(serverName);
  return {
    schema: 'narada.mcp.host_runtime_reference.v0',
    status: targetSurface ? 'available' : 'target_unknown',
    surface_id: targetSurface,
    server_name: serverName ?? null,
    server_entrypoint: serverEntryPoint ?? restartRequest?.target_entrypoint ?? null,
    registry_tool: 'operator_surface_mcp_runtime_registry_status',
    coordinator_tool: 'operator_surface_mcp_restart_request',
    authority_locus: 'pc_site_runtime',
    rule: 'Use host registry/coordinator evidence for fleet-level restart planning; do not treat a restart request marker as proof that any carrier was restarted.',
  };
}

function inferSurfaceIdFromServerName(serverName) {
  if (serverName === 'narada-task-lifecycle-mcp') return 'task-lifecycle-mcp.local';
  if (serverName === 'revolution-agent-context-mcp') return 'agent-context-mcp.local';
  return null;
}

function buildRestartRemediation({ restartToolName, testToolName, serverEntryPoint, selfRestartSupported }) {
  const steps = [];
  if (restartToolName) {
    steps.push(`Inspect ${restartToolName} with mode=status.`);
    steps.push(`Request restart with ${restartToolName} if the carrier MCP server must reload source changes.`);
  }
  steps.push(`Use ${testToolName} against ${serverEntryPoint} for fresh one-shot verification before live reload.`);
  if (!selfRestartSupported) {
    steps.push('Use operator_surface_mcp_runtime_registry_status for host-level runtime evidence before restarting carriers.');
    steps.push('Use operator_surface_mcp_restart_request to coordinate restartable instances and identify external-carrier-required stdio sessions.');
    steps.push('Restart only the carrier/session MCP servers reported as external-carrier-required when live stdio surfaces must reload.');
  }
  return steps;
}

function collectSourceEvidence({ siteRoot, watchedPaths }) {
  const files = [];
  for (const watchedPath of watchedPaths) {
    const absPath = resolve(siteRoot, watchedPath);
    collectFiles(absPath, files);
  }
  files.sort();
  let currentMaxMtime = 0;
  let currentMaxPath = null;
  const hash = createHash('sha256');
  const sourceManifestPaths = [];
  for (const file of files) {
    try {
      const stats = statSync(file);
      if (stats.mtimeMs > currentMaxMtime) {
        currentMaxMtime = stats.mtimeMs;
        currentMaxPath = file;
      }
      const relativePath = normalizeRelativePath(siteRoot, file);
      sourceManifestPaths.push(relativePath);
      hash.update(relativePath);
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    } catch {
      // ignore vanished files
    }
  }
  return {
    watched_paths: watchedPaths,
    source_files_count: files.length,
    source_digest_algorithm: 'sha256',
    source_digest: hash.digest('hex'),
    source_manifest_paths: sourceManifestPaths,
    current_max_mtime: currentMaxMtime,
    current_max_path: currentMaxPath,
  };
}

function compareSourceDigest({ sourceEvidence, baseline }) {
  const currentDigest = typeof sourceEvidence?.source_digest === 'string' ? sourceEvidence.source_digest : null;
  const baselineDigest = typeof baseline?.source_digest === 'string'
    ? baseline.source_digest
    : (typeof baseline?.source?.source_digest === 'string' ? baseline.source.source_digest : null);
  if (currentDigest && baselineDigest) {
    return {
      source_digest_algorithm: sourceEvidence.source_digest_algorithm ?? baseline.source_digest_algorithm ?? 'sha256',
      baseline_source_digest: baselineDigest,
      source_digest_changed: currentDigest !== baselineDigest,
      freshness_basis: 'source_digest',
    };
  }
  return {
    source_digest_algorithm: sourceEvidence?.source_digest_algorithm ?? baseline?.source_digest_algorithm ?? 'sha256',
    baseline_source_digest: baselineDigest,
    source_digest_changed: null,
    freshness_basis: 'legacy_mtime',
  };
}

function normalizeRelativePath(siteRoot, file) {
  return relative(resolve(siteRoot), file).split(sep).join('/');
}

function collectFiles(absPath, out) {
  if (!existsSync(absPath)) return;
  const stats = statSync(absPath);
  if (stats.isFile()) {
    if (absPath.endsWith('.mjs') || absPath.endsWith('.js') || absPath.endsWith('.json')) out.push(absPath);
    return;
  }
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(absPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = join(absPath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(child, out);
    } else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js') || entry.name.endsWith('.json'))) {
      out.push(child);
    }
  }
}
