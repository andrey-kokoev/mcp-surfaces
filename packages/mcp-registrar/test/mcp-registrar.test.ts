import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payloadCreate } from '@narada2/mcp-transport';
import { buildSiteBindConfig, buildSiteSurfaceRegistry, checkOutputReaderClosureForRegistry, checkSiteRegistryConformance, checkSiteRegistryConformanceFromObservation, compareCarrierProjection, createServerState, handleRequest, sharedSurfaceIdsForBinding, siteBindSidecarRefusal, siteSurfaceServerKey, validateSiteMcpFabric, validateSiteToolInventoryObservation } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'mcp-registrar-behavior-'));

const nestedCarrierMetadataDiff = compareCarrierProjection({
  carrierId: 'fixture-codex',
  configPath: 'fixture.toml',
  generatedContent: '[mcp_servers.fixture]\ncommand = "node"\n[mcp_servers.fixture.tools.new_tool]\napproval_mode = "approve"\n',
  generatedStructured: { mcpServers: { fixture: { command: 'node' } } },
  currentContent: '[mcp_servers.fixture]\ncommand = "node"\n',
  currentStructured: { mcpServers: { fixture: { command: 'node' } } },
});
assert.equal(nestedCarrierMetadataDiff.status, 'diff');
assert.equal(nestedCarrierMetadataDiff.projection_changed, true);
assert.equal(nestedCarrierMetadataDiff.changed_count, 0);
assert.equal(nestedCarrierMetadataDiff.server_projection_changed, false);
assert.equal(nestedCarrierMetadataDiff.carrier_metadata_or_format_only, true);
assert.deepEqual(nestedCarrierMetadataDiff.change_scopes, ['full_projection', 'carrier_metadata_or_format']);
assert.equal(nestedCarrierMetadataDiff.explanation_code, 'carrier_metadata_or_format_changed_without_server_definition_change');
assert.equal(nestedCarrierMetadataDiff.count_semantics, 'added_removed_changed_counts_cover_server_definitions_only');
assert.notEqual(nestedCarrierMetadataDiff.generated_sha256, nestedCarrierMetadataDiff.current_sha256);

const identicalCarrierProjection = compareCarrierProjection({
  carrierId: 'fixture-codex',
  configPath: 'fixture.toml',
  generatedContent: 'same\n',
  generatedStructured: { mcpServers: {} },
  currentContent: 'same\n',
  currentStructured: { mcpServers: {} },
});
assert.equal(identicalCarrierProjection.status, 'clean');
assert.equal(identicalCarrierProjection.projection_changed, false);
assert.deepEqual(identicalCarrierProjection.change_scopes, []);
assert.equal(identicalCarrierProjection.explanation_code, 'carrier_projection_exact_match');

async function observeToolsList(entrypoint: string, args: string[]): Promise<string[]> {
  const child = spawn(process.execPath, [entrypoint, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  return new Promise<string[]>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`tools_list_timeout:${stderr.slice(-2000)}`)), 5000);
    let initialized = false;
    const finish = (error: Error | null, tools?: string[]) => {
      clearTimeout(timeout);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve(tools ?? []);
    };
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!initialized && code !== null) finish(new Error(`tools_list_child_exited:${code}:${stderr}`));
    });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, any>;
        if (message.id === 100) {
          initialized = true;
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} })}\n`);
        } else if (message.id === 101) {
          finish(null, (message.result?.tools ?? []).map((tool: Record<string, unknown>) => String(tool.name)));
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'registrar-inventory-test', version: '1.0.0' } } })}\n`);
  });
}

try {
  const state = createServerState({});

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
  }
  function view(res: Record<string, any>): Record<string, any> {
    return res.result.structuredContent as Record<string, any>;
  }
  function assertRuntimeProxy(server: Record<string, any>, childEntrypoint: string): void {
    const args = server.args as string[];
    assert.equal(server.command, 'node');
    assert.match(args[0].replace(/\\/g, '/'), /packages\/shared\/mcp-runtime-proxy\/dist\/src\/main\.js$/);
    assert.equal(args[args.indexOf('--entrypoint') + 1].replace(/\\/g, '/'), childEntrypoint.replace(/\\/g, '/'));
    assert.ok(args.includes('--'));
  }
  function registryWithMailboxSurface(registeredLiveTools: string[], readOnlyTools: string[]): Record<string, any> {
    return {
      schema: 'narada.site.capabilities.mcp_surfaces.v1',
      site_id: 'fixture-site',
      surfaces: [{
        surface_id: 'fixture-mailbox.local',
        display_name: 'fixture-mailbox',
        server_name: 'fixture-mailbox',
        authority_boundary: {},
        client_config: {},
        tool_contract: {
          read_only_tools: readOnlyTools,
          mutating_tools: registeredLiveTools.filter((tool) => !readOnlyTools.includes(tool)),
          refused_tools: [],
        },
        registered_live_tools: registeredLiveTools,
        catalog_surface_id: 'mailbox',
      }],
    };
  }
  function registryWithSurface(catalogSurfaceId: string, registeredLiveTools: string[], readOnlyTools: string[]): Record<string, any> {
    return {
      schema: 'narada.site.capabilities.mcp_surfaces.v1',
      site_id: 'fixture-site',
      surfaces: [{
        surface_id: `fixture-${catalogSurfaceId}.local`,
        display_name: `fixture-${catalogSurfaceId}`,
        server_name: `fixture-${catalogSurfaceId}`,
        authority_boundary: {},
        client_config: {},
        tool_contract: {
          read_only_tools: readOnlyTools,
          mutating_tools: registeredLiveTools.filter((tool) => !readOnlyTools.includes(tool)),
          refused_tools: [],
        },
        registered_live_tools: registeredLiveTools,
        catalog_surface_id: catalogSurfaceId,
      }],
    };
  }
  function assertOutputReaderClosure(registry: Record<string, any>, label: string): void {
    const result = checkOutputReaderClosureForRegistry(registry, { site_id: label, site_root: root, registry_path: join(root, `${label}-mcp-surfaces.json`) });
    assert.equal(result.status, 'ok', `${label} output reader closure violations: ${JSON.stringify(result.violations)}`);
  }

  const missingReaderCheck = checkOutputReaderClosureForRegistry(
    registryWithMailboxSurface(['mailbox_message_show'], ['mailbox_message_show']),
    { site_id: 'missing-reader', site_root: root, registry_path: join(root, 'missing-reader-mcp-surfaces.json') },
  );
  assert.equal(missingReaderCheck.status, 'drift');
  assert.deepEqual((missingReaderCheck.violations as Array<Record<string, any>>).map((violation) => violation.violation), [
    'missing_registered_live_tool',
    'missing_read_only_admission',
  ]);
  assert.deepEqual((missingReaderCheck.violations as Array<Record<string, any>>).map((violation) => violation.required_reader_tool), [
    'mailbox_output_show',
    'mailbox_output_show',
  ]);

  const missingReadOnlyCheck = checkOutputReaderClosureForRegistry(
    registryWithMailboxSurface(['mailbox_message_show', 'mailbox_output_show'], ['mailbox_message_show']),
    { site_id: 'missing-read-only', site_root: root, registry_path: join(root, 'missing-read-only-mcp-surfaces.json') },
  );
  assert.equal(missingReadOnlyCheck.status, 'drift');
  assert.deepEqual((missingReadOnlyCheck.violations as Array<Record<string, any>>).map((violation) => violation.violation), [
    'missing_read_only_admission',
  ]);

  const goodReaderCheck = checkOutputReaderClosureForRegistry(
    registryWithMailboxSurface(['mailbox_message_show', 'mailbox_output_show'], ['mailbox_message_show', 'mailbox_output_show']),
    { site_id: 'good-reader', site_root: root, registry_path: join(root, 'good-reader-mcp-surfaces.json') },
  );
  assert.equal(goodReaderCheck.status, 'ok');
  assert.deepEqual(goodReaderCheck.violations, []);

  const surfaces = await call('registrar_surface_list', {});
  const surfaceData = view(surfaces);
  assert.ok(Array.isArray(surfaceData.items));
  assert.ok(surfaceData.count >= 10);
  const sched = (surfaceData.items as Array<Record<string, any>>).find((s) => s.id === 'scheduler');
  assert.ok(sched);
  assert.ok(sched.tools.includes('scheduler_task_list'));
  assert.equal(sched.injection_scope, 'local_site');
  const speech = (surfaceData.items as Array<Record<string, any>>).find((s) => s.id === 'speech');
  assert.ok(speech);
  assert.equal(speech.injection_scope, 'host');
  assert.deepEqual(speech.authority_locus, { kind: 'host' });
  assert.equal((speech.narada_scope as Record<string, any>).scope_source, 'registrar_surface_catalog');
  assert.equal((speech.narada_scope as Record<string, any>).injection_scope, 'host');
  assert.equal(speech.default_injection, 'all_carrier_sessions');
  assert.deepEqual(speech.tools, ['speech_guidance', 'speech_speak', 'speech_voices', 'speech_capture_transcribe', 'speech_prompt_capture_response', 'speech_listen_status', 'speech_listen_start', 'speech_listen_stop']);
  const operatorRouting = (surfaceData.items as Array<Record<string, any>>).find((s) => s.id === 'operator-routing');
  assert.ok(operatorRouting);
  assert.equal(operatorRouting.injection_scope, 'user_site');
  assert.equal(operatorRouting.default_injection, 'all_site_bound_sessions');
  assert.deepEqual(operatorRouting.tools, ['operator_route_doctor', 'operator_route_request']);
  const artifacts = (surfaceData.items as Array<Record<string, any>>).find((s) => s.id === 'artifacts');
  assert.ok(artifacts);
  assert.equal(artifacts.injection_scope, 'local_site');
  assert.equal(artifacts.default_injection, 'all_site_bound_sessions');
  assert.deepEqual(artifacts.env_vars, ['NARADA_SESSION_ID', 'NARADA_SITE_ROOT', 'NARADA_NARS_BASE_URL']);
  assert.ok(artifacts.tools.includes('artifact_register_file'));
  const sharedSurfaceIds = sharedSurfaceIdsForBinding({ site_id: 'narada-test', prefix: 'narada-test', surfaces: ['agent-context'] });
  assert.ok(sharedSurfaceIds.includes('speech'));
  assert.ok(sharedSurfaceIds.includes('operator-routing'));
  assert.ok(sharedSurfaceIds.includes('artifacts'));
  assert.equal(sharedSurfaceIds.filter((surfaceId) => surfaceId === 'speech').length, 1);
  const registrar = (surfaceData.items as Array<Record<string, any>>).find((s) => s.id === 'mcp-registrar');
  assert.ok(registrar);
  assert.equal(registrar.injection_scope, 'user_site');
  assert.deepEqual(registrar.authority_locus, { kind: 'user_site', site_root: 'C:/Users/Andrey/Narada' });
  assert.ok(registrar.tools.includes('registrar_surface_tool_inventory_check'));
  assert.ok(registrar.tools.includes('registrar_site_registry_conformance_check'));
  assert.ok(registrar.tools.includes('registrar_site_output_reader_closure_check'));
  const bySurface = new Map((surfaceData.items as Array<Record<string, any>>).map((surface) => [surface.id, surface]));
  assert.ok((bySurface.get('git')?.tools as string[]).includes('git_changed_summary'));
  assert.ok((bySurface.get('git')?.tools as string[]).includes('git_unstage'));
  assert.ok((bySurface.get('graph-mail')?.tools as string[]).includes('graph_mail_attachment_upload_file'));
  assert.ok((bySurface.get('graph-mail')?.tools as string[]).includes('graph_mail_reply_all_to_last_in_thread_draft_create'));
  assert.ok((bySurface.get('task-lifecycle')?.tools as string[]).includes('task_lifecycle_submit_work'));
  assert.ok((bySurface.get('site-loop')?.tools as string[]).includes('site_loop_proof_status'));
  assert.ok((bySurface.get('site-loop')?.tools as string[]).includes('site_loop_proof_run'));
  assert.ok((bySurface.get('site-loop')?.tools as string[]).includes('site_loop_output_show'));
  assert.ok((bySurface.get('site-inbox')?.tools as string[]).includes('inbox_submit'));
  assert.ok((bySurface.get('site-inbox')?.tools as string[]).includes('inbox_output_show'));
  assert.ok((bySurface.get('mailbox')?.tools as string[]).includes('mailbox_output_show'));
  assert.ok((bySurface.get('graph-mail')?.tools as string[]).includes('graph_mail_output_show'));
  assert.ok((bySurface.get('calendar')?.tools as string[]).includes('calendar_output_show'));
  assert.ok((bySurface.get('worker-delegation')?.tools as string[]).includes('worker_dashboard_describe'));
  assert.equal((bySurface.get('worker-delegation')?.tools as string[]).includes('worker_output_show'), true);
  assert.ok((bySurface.get('delegated-task')?.tools as string[]).includes('delegated_task_result'));
  assert.ok((bySurface.get('agent-context')?.tools as string[]).includes('agent_context_list_sessions'));
  assert.ok((bySurface.get('sop')?.tools as string[]).includes('sop_doctor'));
  assert.ok((bySurface.get('mcp-loader')?.tools as string[]).includes('mcp_loader_site_fabric_diagnostics'));
  assert.ok((bySurface.get('mcp-loader')?.tools as string[]).includes('mcp_loader_site_tool_inventory_check'));
  assert.ok((bySurface.get('mcp-loader')?.tools as string[]).includes('mcp_loader_surface_status'));
  assert.ok((bySurface.get('mcp-loader')?.tools as string[]).includes('mcp_loader_surface_restart'));
  assert.ok((bySurface.get('surface-feedback')?.tools as string[]).includes('surface_feedback_import'));

  const localFilesystemEntrypoint = fileURLToPath(new URL('../../../local-filesystem-mcp/dist/src/main.js', import.meta.url));
  const observedLocalFilesystemTools = await observeToolsList(localFilesystemEntrypoint, [
    '--mode', 'write',
    '--allowed-root', root,
    '--output-root', root,
  ]);
  const mailboxEntrypoint = fileURLToPath(new URL('../../../mailbox-mcp/dist/src/main.js', import.meta.url));
  const observedMailboxTools = await observeToolsList(mailboxEntrypoint, ['--site-root', root]);
  const liveInventoryCheck = view(await call('registrar_surface_tool_inventory_check', {
    observed_tools: {
      'local-filesystem': observedLocalFilesystemTools,
      mailbox: observedMailboxTools,
    },
  }));
  assert.equal(liveInventoryCheck.status, 'ok', JSON.stringify(liveInventoryCheck));
  assert.ok(observedLocalFilesystemTools.includes('fs_guidance'));
  assert.ok(observedLocalFilesystemTools.includes('fs_doctor'));
  assert.ok(observedMailboxTools.includes('mailbox_guidance'));
  assert.ok(observedMailboxTools.includes('mailbox_output_show'));

  const conformanceSiteRoot = join(root, 'registry-conformance-site');
  mkdirSync(join(conformanceSiteRoot, '.ai', 'mcp'), { recursive: true });
  const mailboxCatalogTools = bySurface.get('mailbox')?.tools as string[];
  writeFileSync(join(conformanceSiteRoot, '.ai', 'mcp', 'fixture-mailbox-mcp.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    site_id: 'registry-conformance-site',
    mcpServers: {
      'fixture-mailbox': {
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/mailbox-mcp/dist/src/main.js', '--site-root', conformanceSiteRoot],
        tools: mailboxCatalogTools,
        surface_id: 'mailbox',
      },
    },
  }, null, 2), 'utf8');
  const conformanceSite = {
    site_id: 'registry-conformance-site',
    root: conformanceSiteRoot,
    config_path: join(conformanceSiteRoot, 'config.json'),
    surfaces: [],
  };
  assert.equal(validateSiteToolInventoryObservation(conformanceSite, {
    schema: 'narada.mcp_loader.site_tool_inventory_check.v1',
    site_root: conformanceSiteRoot,
    observed_tools: {},
    observed_read_only_tools: {},
    observed_mutating_tools: {},
  }).schema, 'narada.mcp_loader.site_tool_inventory_check.v1');
  assert.throws(() => validateSiteToolInventoryObservation(conformanceSite, {
    schema: 'narada.mcp_loader.site_tool_inventory_check.v1',
    site_root: join(conformanceSiteRoot, 'other'),
    observed_tools: {},
    observed_read_only_tools: {},
    observed_mutating_tools: {},
  }), /registrar_inventory_observation_site_mismatch/);
  const conformingRegistry = buildSiteSurfaceRegistry(conformanceSite);
  const conformingSurface = (conformingRegistry.surfaces as Array<Record<string, any>>)[0];
  const observedConformanceTools = { 'fixture-mailbox': mailboxCatalogTools };
  const observedConformanceReadOnlyTools = { 'fixture-mailbox': conformingSurface.tool_contract.read_only_tools as string[] };
  const observedConformanceMutatingTools = { 'fixture-mailbox': conformingSurface.tool_contract.mutating_tools as string[] };
  const conformingCheck = checkSiteRegistryConformance(
    conformanceSite,
    conformingRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
    true,
  );
  assert.equal(conformingCheck.status, 'ok', JSON.stringify(conformingCheck));
  assert.equal(conformingCheck.violation_count, 0);
  const observationPayload = payloadCreate({
    siteRoot: conformanceSiteRoot,
    args: {
      payload_id: 'site-tools-fixture-observation',
      payload: {
        schema: 'narada.mcp_loader.site_tool_inventory_check.v1',
        status: 'ok',
        site_root: conformanceSiteRoot,
        observed_at: new Date().toISOString(),
        observed_tools: observedConformanceTools,
        observed_read_only_tools: observedConformanceReadOnlyTools,
        observed_mutating_tools: observedConformanceMutatingTools,
      },
      created_by: 'mcp-loader-mcp',
    },
  });
  const refConformanceCheck = checkSiteRegistryConformanceFromObservation(
    conformanceSite,
    conformingRegistry,
    observationPayload.ref,
  );
  assert.equal(refConformanceCheck.status, 'ok', JSON.stringify(refConformanceCheck));
  assert.equal(refConformanceCheck.observation_ref, observationPayload.ref);
  assert.equal(refConformanceCheck.observation_sha256, observationPayload.sha256);
  const observationLineage = refConformanceCheck.observation_lineage as Record<string, any>;
  assert.equal(observationLineage.assurance, 'declarative_lineage_guard_not_cryptographic_provenance');
  assert.equal(observationLineage.authority_effect, 'none');
  const forgedLineagePayload = payloadCreate({
    siteRoot: conformanceSiteRoot,
    args: {
      payload_id: 'site-tools-wrong-lineage',
      payload: {
        schema: 'narada.mcp_loader.site_tool_inventory_check.v1',
        site_root: conformanceSiteRoot,
        observed_tools: observedConformanceTools,
        observed_read_only_tools: observedConformanceReadOnlyTools,
        observed_mutating_tools: observedConformanceMutatingTools,
      },
      created_by: 'not-the-loader',
    },
  });
  assert.throws(
    () => checkSiteRegistryConformanceFromObservation(conformanceSite, conformingRegistry, forgedLineagePayload.ref),
    /registrar_inventory_observation_lineage_mismatch/,
  );

  const staleRegistry = structuredClone(conformingRegistry);
  const staleSurface = (staleRegistry.surfaces as Array<Record<string, any>>)[0];
  staleSurface.registered_live_tools = (staleSurface.registered_live_tools as string[]).filter((tool) => tool !== 'mailbox_output_show');
  staleSurface.tool_contract.read_only_tools = (staleSurface.tool_contract.read_only_tools as string[]).filter((tool: string) => tool !== 'mailbox_output_show');
  const staleCheck = checkSiteRegistryConformance(
    conformanceSite,
    staleRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  );
  assert.equal(staleCheck.status, 'drift');
  const staleCodes = (staleCheck.violations as Array<Record<string, any>>).map((violation) => violation.code);
  assert.ok(staleCodes.includes('registered_tools_differ_from_live'));
  assert.ok(staleCodes.includes('output_reader_closure_violation'));

  const overlappingRegistry = structuredClone(conformingRegistry);
  const overlappingSurface = (overlappingRegistry.surfaces as Array<Record<string, any>>)[0];
  overlappingSurface.tool_contract.mutating_tools.push('mailbox_doctor');
  const overlappingCheck = checkSiteRegistryConformance(
    conformanceSite,
    overlappingRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  );
  const overlappingCodes = (overlappingCheck.violations as Array<Record<string, any>>).map((violation) => violation.code);
  assert.ok(overlappingCodes.includes('tool_contract_partition_overlap'));
  assert.ok(overlappingCodes.includes('mutating_classification_differ_from_live'));

  const missingEvidenceCheck = checkSiteRegistryConformance(conformanceSite, conformingRegistry, {}, {}, {});
  const missingEvidenceCodes = (missingEvidenceCheck.violations as Array<Record<string, any>>).map((violation) => violation.code);
  assert.ok(missingEvidenceCodes.includes('live_tool_observation_missing'));
  assert.ok(missingEvidenceCodes.includes('live_read_only_observation_missing'));
  assert.ok(missingEvidenceCodes.includes('live_mutating_observation_missing'));

  const violationCodes = (check: Record<string, any>) =>
    new Set((check.violations as Array<Record<string, any>>).map((violation) => violation.code));

  const provenanceRegistry = structuredClone(conformingRegistry);
  provenanceRegistry.schema = 'wrong.schema';
  provenanceRegistry.site_id = 'wrong-site';
  provenanceRegistry.generated_by = 'manual';
  provenanceRegistry.generated_at = 'not-a-time';
  provenanceRegistry.generation_policy = { mode: 'manual', source: 'unknown', note: 'unknown' };
  const provenanceCodes = violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    provenanceRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  ));
  for (const code of [
    'registry_schema_mismatch',
    'registry_site_id_mismatch',
    'registry_generator_mismatch',
    'registry_generation_policy_mismatch',
    'registry_generation_source_mismatch',
    'registry_generation_note_mismatch',
    'registry_generated_at_invalid',
  ]) assert.ok(provenanceCodes.has(code), code);

  const missingSurfaceRegistry = structuredClone(conformingRegistry);
  missingSurfaceRegistry.surfaces = [];
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    missingSurfaceRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('registry_surface_missing'));

  const extraSurfaceRegistry = structuredClone(conformingRegistry);
  (extraSurfaceRegistry.surfaces as Array<Record<string, any>>).push({ ...structuredClone(conformingSurface), server_name: 'not-in-fabric', surface_id: 'not-in-fabric.local' });
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    extraSurfaceRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('registry_surface_not_in_fabric'));

  const duplicateSurfaceRegistry = structuredClone(conformingRegistry);
  (duplicateSurfaceRegistry.surfaces as Array<Record<string, any>>).push(structuredClone(conformingSurface));
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    duplicateSurfaceRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('registry_surface_server_name_duplicate'));

  const incompleteContractRegistry = structuredClone(conformingRegistry);
  const incompleteContractSurface = incompleteContractRegistry.surfaces[0];
  incompleteContractSurface.tool_contract.read_only_tools =
    incompleteContractSurface.tool_contract.read_only_tools.filter((tool: string) => tool !== 'mailbox_doctor');
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    incompleteContractRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('tool_contract_partition_incomplete'));

  const refusedContractRegistry = structuredClone(conformingRegistry);
  const refusedContractSurface = refusedContractRegistry.surfaces[0];
  refusedContractSurface.tool_contract.read_only_tools =
    refusedContractSurface.tool_contract.read_only_tools.filter((tool: string) => tool !== 'mailbox_doctor');
  refusedContractSurface.tool_contract.refused_tools.push('mailbox_doctor');
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    refusedContractRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('tool_contract_contains_external_refusals'));

  const duplicateContractRegistry = structuredClone(conformingRegistry);
  duplicateContractRegistry.surfaces[0].registered_live_tools.push('mailbox_doctor');
  duplicateContractRegistry.surfaces[0].tool_contract.read_only_tools.push('mailbox_doctor');
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    duplicateContractRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('tool_contract_contains_duplicates'));

  const incompleteLiveReadOnly = {
    'fixture-mailbox': observedConformanceReadOnlyTools['fixture-mailbox'].slice(1),
  };
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    conformingRegistry,
    observedConformanceTools,
    incompleteLiveReadOnly,
    observedConformanceMutatingTools,
  )).has('live_tool_semantics_partition_incomplete'));

  const overlappingLiveMutating = {
    'fixture-mailbox': [...observedConformanceMutatingTools['fixture-mailbox'], 'mailbox_doctor'],
  };
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    conformingRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    overlappingLiveMutating,
  )).has('live_tool_semantics_partition_overlap'));

  const duplicateLiveTools = {
    'fixture-mailbox': [...mailboxCatalogTools, mailboxCatalogTools[0]],
  };
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    conformingRegistry,
    duplicateLiveTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('live_tools_duplicate'));

  const projectionDriftRegistry = structuredClone(conformingRegistry);
  projectionDriftRegistry.surfaces[0].display_name = 'manually changed';
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    projectionDriftRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('registry_surface_projection_drift'));

  const missingCatalogRegistry = structuredClone(conformingRegistry);
  missingCatalogRegistry.surfaces[0].catalog_surface_id = 'missing-catalog-surface';
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    missingCatalogRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('catalog_surface_missing'));

  const conformanceFabricPath = join(conformanceSiteRoot, '.ai', 'mcp', 'fixture-mailbox-mcp.json');
  const duplicateFabricConfig = JSON.parse(readFileSync(conformanceFabricPath, 'utf8'));
  duplicateFabricConfig.mcpServers['fixture-mailbox'].tools.push('mailbox_doctor');
  writeFileSync(conformanceFabricPath, JSON.stringify(duplicateFabricConfig, null, 2), 'utf8');
  assert.ok(violationCodes(checkSiteRegistryConformance(
    conformanceSite,
    conformingRegistry,
    observedConformanceTools,
    observedConformanceReadOnlyTools,
    observedConformanceMutatingTools,
  )).has('fabric_tools_duplicate'));
  duplicateFabricConfig.mcpServers['fixture-mailbox'].tools.pop();
  writeFileSync(conformanceFabricPath, JSON.stringify(duplicateFabricConfig, null, 2), 'utf8');

  const inventoryCheck = view(await call('registrar_surface_tool_inventory_check', {
    include_ok: true,
    observed_tools: {
      git: bySurface.get('git')?.tools,
      mailbox: bySurface.get('mailbox')?.tools,
      'graph-mail': bySurface.get('graph-mail')?.tools,
      'worker-delegation': bySurface.get('worker-delegation')?.tools,
    },
  }));
  assert.equal(inventoryCheck.status, 'ok');
  assert.equal(inventoryCheck.checked_count, 4);
  assert.equal((inventoryCheck.findings as Array<Record<string, any>>).length, 4);
  const driftCheck = view(await call('registrar_surface_tool_inventory_check', {
    observed_tools: { git: ['git_status', 'git_extra_observed'] },
  }));
  assert.equal(driftCheck.status, 'drift');
  const gitDrift = (driftCheck.findings as Array<Record<string, any>>).find((finding) => finding.surface_id === 'git');
  assert.ok(gitDrift);
  assert.deepEqual(gitDrift.missing_from_registrar, ['git_extra_observed']);
  assert.ok((gitDrift.extra_in_registrar as string[]).includes('git_policy_inspect'));

  const badMaterializedSiteRoot = join(root, 'bad-materialized-site');
  mkdirSync(join(badMaterializedSiteRoot, '.narada', 'capabilities'), { recursive: true });
  writeFileSync(
    join(badMaterializedSiteRoot, '.narada', 'capabilities', 'mcp-surfaces.json'),
    JSON.stringify(registryWithMailboxSurface(['mailbox_message_show'], ['mailbox_message_show']), null, 2),
    'utf8',
  );
  const materializedClosureCheck = view(await call('registrar_site_output_reader_closure_check', {
    site_roots: [badMaterializedSiteRoot],
  }));
  assert.equal(materializedClosureCheck.status, 'drift');
  assert.equal(materializedClosureCheck.violation_count, 2);
  const materializedViolations = materializedClosureCheck.violations as Array<Record<string, any>>;
  assert.equal(materializedViolations[0].site_root, badMaterializedSiteRoot);
  assert.equal(materializedViolations[0].registry_path, join(badMaterializedSiteRoot, '.narada', 'capabilities', 'mcp-surfaces.json'));
  assert.equal(materializedViolations[0].server_name, 'fixture-mailbox');
  assert.equal(materializedViolations[0].producer_tool, 'mailbox_message_show');
  assert.equal(materializedViolations[0].required_reader_tool, 'mailbox_output_show');
  const missingMaterializedClosureCheck = view(await call('registrar_site_output_reader_closure_check', {
    site_roots: [join(root, 'site-without-materialized-registry')],
  }));
  assert.equal(missingMaterializedClosureCheck.status, 'missing');
  assert.equal(missingMaterializedClosureCheck.missing_count, 1);
  assert.equal(missingMaterializedClosureCheck.violation_count, 0);

  const missingCalendarReaderCheck = checkOutputReaderClosureForRegistry(
    registryWithSurface('calendar', ['calendar_event_query'], ['calendar_event_query']),
    { site_id: 'missing-calendar-reader', site_root: root, registry_path: join(root, 'missing-calendar-reader-mcp-surfaces.json') },
  );
  assert.equal(missingCalendarReaderCheck.status, 'drift');
  assert.deepEqual((missingCalendarReaderCheck.violations as Array<Record<string, any>>).map((violation) => violation.required_reader_tool), [
    'calendar_output_show',
    'calendar_output_show',
  ]);

  const goodSiteLoopReaderCheck = checkOutputReaderClosureForRegistry(
    registryWithSurface('site-loop', ['site_loop_guidance', 'site_loop_output_show'], ['site_loop_guidance', 'site_loop_output_show']),
    { site_id: 'good-site-loop-reader', site_root: root, registry_path: join(root, 'good-site-loop-reader-mcp-surfaces.json') },
  );
  assert.equal(goodSiteLoopReaderCheck.status, 'ok');

  const sites = await call('registrar_site_list', {});
  const siteData = view(sites);
  assert.ok((siteData.items as Array<unknown>).length >= 7);

  const carriers = await call('registrar_carrier_list', {});
  const carrierData = view(carriers);
  assert.ok((carrierData.items as Array<unknown>).length >= 3);
  const carrierIds = (carrierData.items as Array<Record<string, any>>).map((carrier) => carrier.carrier_id);
  assert.deepEqual(carrierIds.sort(), ['codex-andrey', 'kimi-andrey', 'opencode-andrey']);
  assert.equal(carrierIds.includes('opencode-sonar'), false);

  const materialize = await call('registrar_carrier_materialize', { carrier_id: 'kimi-andrey' });
  const matData = view(materialize);
  assert.equal(matData.status, 'materialized');
  assert.equal(matData.carrier_id, 'kimi-andrey');
  assert.ok(matData.byte_size > 0);
  assert.ok((matData.injection_scopes as Record<string, any>).counts.host >= 1);
  assert.ok(((matData.injection_scopes as Record<string, any>).servers as Array<Record<string, any>>).some((server) => server.surface_id === 'speech' && server.injection_scope === 'host'));
  const materializedSpeech = ((matData.injection_scopes as Record<string, any>).servers as Array<Record<string, any>>).find((server) => server.surface_id === 'speech');
  assert.ok(materializedSpeech);
  assert.equal((materializedSpeech.narada_scope as Record<string, any>).scope_source, 'registrar_surface_catalog');
  const materializedPath = join(root, 'kimi-generated.json');
  view(await call('registrar_carrier_materialize', { carrier_id: 'kimi-andrey', output_path: materializedPath }));
  const materializedConfig = JSON.parse(readFileSync(materializedPath, 'utf8')) as Record<string, any>;
  const materializedFilesystem = materializedConfig.mcpServers['narada-andrey-local-filesystem'];
  assertRuntimeProxy(materializedFilesystem, 'D:/code/mcp-surfaces/packages/local-filesystem-mcp/dist/src/main.js');
  for (const carrierId of ['codex-andrey', 'kimi-andrey', 'opencode-andrey']) {
    const generatedPath = join(root, `${carrierId}-generated.${carrierId === 'codex-andrey' ? 'toml' : 'json'}`);
    view(await call('registrar_carrier_materialize', { carrier_id: carrierId, output_path: generatedPath }));
    const generatedText = readFileSync(generatedPath, 'utf8');
    const normalizedGeneratedText = generatedText.replace(/\\\\/g, '/').replace(/\\/g, '/');
    assert.equal(generatedText.includes('opencode-sonar'), false);
    assert.equal(generatedText.includes('tools/typed-mcp/inbox-mcp-server.mjs'), false);
    assert.equal(generatedText.includes('inbox_stage_submission_workflow'), false);
    assert.equal(generatedText.includes('inbox_submit_typed_envelope'), false);
    assert.equal(generatedText.includes('mcp_command_create'), false);
    assert.equal(normalizedGeneratedText.includes('D:/code/mcp-surfaces/packages/site-inbox-mcp/dist/src/main.js'), true);
    assert.equal(normalizedGeneratedText.includes('D:/code/mcp-surfaces/packages/calendar-mcp/dist/src/main.js'), true);
    assert.equal(normalizedGeneratedText.includes('D:/code/mcp-surfaces/packages/mcp-loader-mcp/dist/src/main.js'), true);
    assert.equal(normalizedGeneratedText.includes('C:/Users/Andrey/Narada'), true);
    if (carrierId === 'codex-andrey') {
      assert.equal(generatedText.includes('inbox_submit'), true);
      assert.equal(generatedText.includes('inbox_output_show'), true);
    }
  }

  const carrierValidate = view(await call('registrar_carrier_validate', { carrier_id: 'kimi-andrey', include_ok: true }));
  const validateFindings = carrierValidate.findings as Array<Record<string, any>>;
  const speechFinding = validateFindings.find((finding) => finding.surface_id === 'speech');
  assert.ok(speechFinding);
  assert.equal(speechFinding.injection_scope, 'host');
  assert.equal(speechFinding.diagnostic_class, 'host_injected_surface_missing_or_misconfigured_in_session');
  assert.deepEqual(speechFinding.required_repair_locus, { kind: 'host' });
  assert.equal((speechFinding.narada_scope as Record<string, any>).injection_scope, 'host');
  assert.deepEqual(speechFinding.required_repair_locus, (speechFinding.narada_scope as Record<string, any>).mutation_locus);
  const filesystemFinding = validateFindings.find((finding) => finding.surface_id === 'local-filesystem');
  assert.ok(filesystemFinding);
  assert.equal(filesystemFinding.injection_scope, 'local_site');
  assert.equal(filesystemFinding.diagnostic_class, 'local_site_surface_missing_or_misconfigured');
  assert.equal((filesystemFinding.required_repair_locus as Record<string, any>).kind, 'local_site');
  assert.equal((filesystemFinding.narada_scope as Record<string, any>).injection_scope, 'local_site');
  assert.deepEqual(filesystemFinding.required_repair_locus, (filesystemFinding.narada_scope as Record<string, any>).mutation_locus);

  const siteDir = join(root, '.ai', 'mcp');
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(root, 'site.json'), JSON.stringify({ site_id: 'test-site' }), 'utf8');

  assert.equal(siteSurfaceServerKey('narada-sonar', 'scheduler'), 'narada-sonar-scheduler');
  assert.equal(siteSurfaceServerKey('smart-scheduling', 'scheduler'), 'narada-smart-scheduling-scheduler');
  const bindConfig = buildSiteBindConfig(
    { site_id: 'narada-sonar', root, config_path: join(root, 'site.json'), surfaces: [] },
    { id: 'scheduler', package: 'scheduler-mcp', entrypoint: 'D:/code/mcp-surfaces/packages/scheduler-mcp/dist/src/main.js', kind: 'mcp_surface', args: [], tools: ['scheduler_task_list'] },
  );
  assert.equal(bindConfig.fileName, 'narada-sonar-scheduler-mcp.json');
  assert.equal(bindConfig.serverKey, 'narada-sonar-scheduler');
  assert.ok((bindConfig.config.mcpServers as Record<string, any>)['narada-sonar-scheduler']);
  assert.ok(!(bindConfig.config.mcpServers as Record<string, any>)['sonar-scheduler']);
  const schedServer = (bindConfig.config.mcpServers as Record<string, any>)['narada-sonar-scheduler'];
  assert.equal(schedServer.surface_id, 'scheduler');
  assertRuntimeProxy(schedServer, 'D:/code/mcp-surfaces/packages/scheduler-mcp/dist/src/main.js');
  assert.equal(schedServer.injection_scope, 'local_site');
  assert.deepEqual(schedServer.authority_locus, { kind: 'local_site', site_root: root });
  assert.equal(schedServer.narada_scope.scope_source, 'registrar_surface_catalog');
  assert.equal(schedServer.narada_scope.bound_into_site, 'narada-sonar');

  const smartSchedulingBindConfig = buildSiteBindConfig(
    { site_id: 'smart-scheduling', root, config_path: join(root, 'site.json'), surfaces: [] },
    { id: 'scheduler', package: 'scheduler-mcp', entrypoint: 'D:/code/mcp-surfaces/packages/scheduler-mcp/dist/src/main.js', kind: 'mcp_surface', args: [], tools: ['scheduler_task_list'] },
  );
  assert.equal(smartSchedulingBindConfig.fileName, 'narada-smart-scheduling-scheduler-mcp.json');
  assert.equal(smartSchedulingBindConfig.serverKey, 'narada-smart-scheduling-scheduler');
  assert.ok((smartSchedulingBindConfig.config.mcpServers as Record<string, any>)['narada-smart-scheduling-scheduler']);
  assert.ok(!(smartSchedulingBindConfig.config.mcpServers as Record<string, any>)['smart-scheduling-scheduler']);

  const speechBindConfig = buildSiteBindConfig(
    { site_id: 'narada-staccato', root, config_path: join(root, 'site.json'), surfaces: [] },
    {
      id: 'speech',
      package: 'speech-mcp',
      entrypoint: 'D:/code/mcp-surfaces/packages/speech-mcp/dist/src/main.js',
      kind: 'mcp_surface',
      args: [],
      tools: ['speech_speak', 'speech_voices', 'speech_capture_transcribe', 'speech_prompt_capture_response', 'speech_listen_status', 'speech_listen_start', 'speech_listen_stop'],
    },
  );
  const speechServer = (speechBindConfig.config.mcpServers as Record<string, any>)['narada-staccato-speech'];
  assert.equal(speechServer.injection_scope, 'host');
  assertRuntimeProxy(speechServer, 'D:/code/mcp-surfaces/packages/speech-mcp/dist/src/main.js');
  assert.equal(speechServer.authority_posture, 'host_injected_mcp_surface');
  assert.deepEqual(speechServer.authority_locus, { kind: 'host' });
  assert.equal(speechServer.bound_into_site, 'narada-staccato');
  assert.equal(speechServer.narada_scope.scope_source, 'registrar_surface_catalog');
  assert.equal(speechServer.narada_scope.injection_scope, 'host');
  assert.equal(speechServer.narada_scope.bound_into_site, 'narada-staccato');
  assert.deepEqual(speechServer.tools, ['speech_speak', 'speech_voices', 'speech_capture_transcribe', 'speech_prompt_capture_response', 'speech_listen_status', 'speech_listen_start', 'speech_listen_stop']);

  const workerBindConfig = buildSiteBindConfig(
    { site_id: 'narada-sonar', root, config_path: join(root, 'site.json'), surfaces: [] },
    {
      id: 'worker-delegation',
      package: 'worker-delegation-mcp',
      entrypoint: 'D:/code/mcp-surfaces/packages/worker-delegation-mcp/dist/src/main.js',
      kind: 'mcp_surface',
      args: ['--site-root', '{site_root}', '--allowed-root', '{site_root}', '--run-root', '{site_runtime_root}/worker-delegation'],
      tools: ['worker_run'],
      env_vars: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE_URL', 'NARADA_WORKER_MCP_CONFIG'],
    },
  );
  const workerServer = (workerBindConfig.config.mcpServers as Record<string, any>)['narada-sonar-worker-delegation'];
  assert.equal(workerServer.surface_id, 'worker-delegation');
  assertRuntimeProxy(workerServer, 'D:/code/mcp-surfaces/packages/worker-delegation-mcp/dist/src/main.js');
  assert.ok(workerServer.args.includes('--site-root'));
  assert.equal(workerServer.args[workerServer.args.indexOf('--site-root') + 1], root);
  assert.equal(String(workerServer.args[workerServer.args.indexOf('--run-root') + 1]).replace(/\\/g, '/'), join(root, '.narada', 'runtime', 'worker-delegation').replace(/\\/g, '/'));
  assert.ok(workerServer.env_vars.includes('DEEPSEEK_API_KEY'));
  assert.ok(workerServer.env_vars.includes('DEEPSEEK_API_BASE_URL'));
  assert.ok(workerServer.env_vars.includes('NARADA_WORKER_MCP_CONFIG'));

  const controlRootSite = join(root, 'control-root-site', '.narada');
  const controlRootWorkspace = join(root, 'control-root-site');
  mkdirSync(controlRootSite, { recursive: true });
  writeFileSync(join(controlRootSite, 'config.json'), JSON.stringify({ workspace_root: controlRootWorkspace }), 'utf8');
  const controlRootWorkerBindConfig = buildSiteBindConfig(
    { site_id: 'smart-scheduling', root: controlRootSite, config_path: join(controlRootSite, 'config.json'), surfaces: [] },
    {
      id: 'worker-delegation',
      package: 'worker-delegation-mcp',
      entrypoint: 'D:/code/mcp-surfaces/packages/worker-delegation-mcp/dist/src/main.js',
      kind: 'mcp_surface',
      args: ['--site-root', '{site_root}', '--allowed-root', '{workspace_root}', '--run-root', '{site_runtime_root}/worker-delegation'],
      tools: ['worker_run'],
    },
  );
  const controlRootWorkerServer = (controlRootWorkerBindConfig.config.mcpServers as Record<string, any>)['narada-smart-scheduling-worker-delegation'];
  const controlRootRunRoot = String(controlRootWorkerServer.args[controlRootWorkerServer.args.indexOf('--run-root') + 1]);
  assert.equal(controlRootWorkerServer.args[controlRootWorkerServer.args.indexOf('--allowed-root') + 1], controlRootWorkspace);
  assert.equal(controlRootRunRoot.replace(/\\/g, '/'), join(controlRootSite, 'runtime', 'worker-delegation').replace(/\\/g, '/'));
  assert.equal(controlRootRunRoot.replace(/\\/g, '/').includes('/.narada/.narada/'), false);

  const surfaceFeedbackBindConfig = buildSiteBindConfig(
    { site_id: 'narada-staccato', root, config_path: join(root, 'site.json'), surfaces: [] },
    {
      id: 'surface-feedback',
      package: 'surface-feedback-mcp',
      entrypoint: 'D:/code/mcp-surfaces/packages/surface-feedback-mcp/dist/src/main.js',
      kind: 'mcp_surface',
      args: ['--feedback-root', 'D:/code/mcp-surfaces'],
      tools: ['surface_feedback_submit'],
    },
  );
  const surfaceFeedbackServer = (surfaceFeedbackBindConfig.config.mcpServers as Record<string, any>)['narada-staccato-surface-feedback'];
  assertRuntimeProxy(surfaceFeedbackServer, 'D:/code/mcp-surfaces/packages/surface-feedback-mcp/dist/src/main.js');
  assert.equal(surfaceFeedbackServer.args[surfaceFeedbackServer.args.indexOf('--feedback-root') + 1], 'D:/code/mcp-surfaces');

  const scopeReadbackRoot = join(root, 'scope-readback-site');
  mkdirSync(join(scopeReadbackRoot, '.ai', 'mcp'), { recursive: true });
  writeFileSync(join(scopeReadbackRoot, '.ai', 'mcp', 'narada-staccato-mcp.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    mcpServers: {
      'staccato-speech': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/speech-mcp/dist/src/main.js'],
        narada_scope: {
          injection_scope: 'host',
          authority_locus: { kind: 'host' },
          mutation_locus: { kind: 'host' },
          restart_owner: 'host',
          bound_into_site: 'narada-staccato',
          scope_source: 'registrar_surface_catalog',
        },
      },
      'staccato-mcp-registrar': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/mcp-registrar/dist/src/main.js'],
        injection_scope: 'user_site',
        authority_locus: { kind: 'user_site', site_root: 'C:/Users/Andrey/Narada' },
        mutation_locus: { kind: 'user_site', site_root: 'C:/Users/Andrey/Narada' },
        restart_owner: 'user_site',
      },
      'staccato-local-filesystem': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/local-filesystem-mcp/dist/src/main.js', '--mode', 'write', '--allowed-root', scopeReadbackRoot, '--output-root', scopeReadbackRoot],
      },
      'narada-staccato-artifacts': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/artifacts-mcp/dist/src/main.js'],
        surface_id: 'artifacts',
      },
    },
  }, null, 2), 'utf8');
  const scopeReadback = validateSiteMcpFabric({ site_id: 'narada-staccato', root: scopeReadbackRoot, config_path: join(scopeReadbackRoot, 'site.json'), surfaces: [] }, true);
  const scopeFindings = scopeReadback.findings as Array<Record<string, any>>;
  const speechScopeFinding = scopeFindings.find((finding) => finding.server_key === 'staccato-speech' && finding.code === 'registrar_site_fabric_server_key_ok');
  assert.ok(speechScopeFinding);
  assert.equal(speechScopeFinding.scope_source, 'site_config_narada_scope');
  assert.equal(speechScopeFinding.injection_scope, 'host');
  assert.equal((speechScopeFinding.narada_scope as Record<string, any>).scope_source, 'site_config_narada_scope');
  assert.deepEqual(speechScopeFinding.required_repair_locus, (speechScopeFinding.narada_scope as Record<string, any>).mutation_locus);
  const registrarScopeFinding = scopeFindings.find((finding) => finding.server_key === 'staccato-mcp-registrar' && finding.code === 'registrar_site_fabric_server_key_ok');
  assert.ok(registrarScopeFinding);
  assert.equal(registrarScopeFinding.scope_source, 'site_config_legacy_top_level');
  assert.equal(registrarScopeFinding.injection_scope, 'user_site');
  assert.equal((registrarScopeFinding.narada_scope as Record<string, any>).scope_source, 'site_config_legacy_top_level');
  const filesystemScopeFinding = scopeFindings.find((finding) => finding.server_key === 'staccato-local-filesystem' && finding.code === 'registrar_site_fabric_server_key_ok');
  assert.ok(filesystemScopeFinding);
  assert.equal(filesystemScopeFinding.scope_source, 'registrar_surface_catalog');
  assert.equal(filesystemScopeFinding.injection_scope, 'local_site');
  assert.equal((filesystemScopeFinding.narada_scope as Record<string, any>).scope_source, 'registrar_surface_catalog');

  const missingDefaultRoot = join(root, 'missing-default-site');
  mkdirSync(join(missingDefaultRoot, '.ai', 'mcp'), { recursive: true });
  writeFileSync(join(missingDefaultRoot, 'site.json'), JSON.stringify({ site_id: 'narada-sonar' }), 'utf8');
  writeFileSync(join(missingDefaultRoot, '.ai', 'mcp', 'narada-sonar-mcp.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    mcpServers: {
      'narada-sonar-agent-context': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/agent-context-mcp/dist/src/main.js'],
      },
    },
  }, null, 2), 'utf8');
  const missingDefault = validateSiteMcpFabric({ site_id: 'narada-sonar', root: missingDefaultRoot, config_path: join(missingDefaultRoot, 'site.json'), surfaces: [] }, false);
  const missingDefaultFinding = (missingDefault.findings as Array<Record<string, any>>).find((finding) => finding.code === 'registrar_site_fabric_missing_default_surface' && finding.surface_id === 'artifacts');
  assert.ok(missingDefaultFinding);
  assert.equal(missingDefault.status, 'invalid');

  for (const carrierId of ['opencode-andrey', 'kimi-andrey', 'codex-andrey']) {
    const outputPath = join(root, `${carrierId}.generated`);
    const materializedCarrier = await call('registrar_carrier_materialize', { carrier_id: carrierId, output_path: outputPath });
    assert.equal(view(materializedCarrier).status, 'materialized');
    const content = readFileSync(outputPath, 'utf8');
    assert.match(content, /surface-feedback/);
    assert.match(content, /--feedback-root/);
    assert.match(content, /D:\/code\/mcp-surfaces/);
    assert.doesNotMatch(content, /--feedback-root["',\s\]]+[A-Z]:\/code\/narada(?!\/mcp-surfaces)/i);
    if (carrierId === 'codex-andrey') {
      assert.match(content, /--anchored-allowed-root/);
      assert.match(content, /user_home:\.codex/);
      assert.match(content, /\[mcp_servers\.narada-andrey-local-filesystem\][\s\S]*?approval_mode = "approve"/);
      assert.match(content, /Generated carrier availability metadata\. Narada MCP surfaces own policy\./);
      assert.match(content, /\[mcp_servers\.narada-andrey-local-filesystem\.tools\.fs_apply_patch\]\s+approval_mode = "approve"/);
      assert.match(content, /\[mcp_servers\.narada-andrey-structured-command\.tools\.structured_command_execute\]\s+approval_mode = "approve"/);
      assert.doesNotMatch(content, /approval_mode = "auto"/);
    }
  }

  const aggregateSiteRoot = join(root, 'aggregate-site');
  mkdirSync(join(aggregateSiteRoot, '.ai', 'mcp'), { recursive: true });
  writeFileSync(join(aggregateSiteRoot, 'site.json'), JSON.stringify({ site_id: 'narada-sonar' }), 'utf8');
  writeFileSync(join(aggregateSiteRoot, '.ai', 'mcp', 'narada-sonar-mcp.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    mcpServers: {
      'narada-sonar-agent-context': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/agent-context-mcp/dist/src/main.js'],
      },
    },
  }, null, 2), 'utf8');
  const aggregateBindConfig = buildSiteBindConfig(
    { site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [] },
    sched as any,
  );
  assert.equal(aggregateBindConfig.serverKey, 'narada-sonar-scheduler');
  const artifactsBindConfig = buildSiteBindConfig(
    { site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [] },
    artifacts as any,
  );
  const artifactsServer = (artifactsBindConfig.config.mcpServers as Record<string, any>)['narada-sonar-artifacts'];
  assert.equal(artifactsServer.surface_id, 'artifacts');
  assert.ok((artifactsServer.env_vars as string[]).includes('NARADA_SESSION_ID'));
  assert.equal((artifactsServer.env_vars as string[]).length, new Set(artifactsServer.env_vars as string[]).size);
  writeFileSync(join(aggregateSiteRoot, '.ai', 'mcp', artifactsBindConfig.fileName), JSON.stringify(artifactsBindConfig.config, null, 2), 'utf8');
  const aggregateWithArtifacts = validateSiteMcpFabric({ site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [] }, true);
  const aggregateArtifactFinding = (aggregateWithArtifacts.findings as Array<Record<string, any>>).find((finding) => finding.server_key === 'narada-sonar-artifacts' && finding.code === 'registrar_site_fabric_server_key_ok');
  assert.ok(aggregateArtifactFinding);
  assert.equal(aggregateArtifactFinding.surface_id, 'artifacts');
  writeFileSync(join(aggregateSiteRoot, '.ai', 'mcp', 'narada-sonar-inbox-mcp.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    mcpServers: {
      'narada-sonar-inbox': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/site-inbox-mcp/dist/src/main.js', '--site-root', aggregateSiteRoot],
        tools: ['inbox_doctor', 'inbox_list', 'inbox_show'],
      },
    },
  }, null, 2), 'utf8');
  const surfaceRegistry = buildSiteSurfaceRegistry({ site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [] });
  assertOutputReaderClosure(surfaceRegistry, 'aggregate surface registry');
  const inboxRegistry = (surfaceRegistry.surfaces as Array<Record<string, any>>).find((surface) => surface.server_name === 'narada-sonar-inbox');
  assert.ok(inboxRegistry);
  assert.equal(inboxRegistry.catalog_surface_id, 'site-inbox');
  assert.ok((inboxRegistry.registered_live_tools as string[]).includes('inbox_acknowledge'));
  assert.ok((inboxRegistry.tool_contract.mutating_tools as string[]).includes('inbox_acknowledge'));
  writeFileSync(join(aggregateSiteRoot, '.ai', 'mcp', 'narada-sonar-mailbox-mcp.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    mcpServers: {
      'narada-sonar-mailbox': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/mailbox-mcp/dist/src/main.js', '--site-root', aggregateSiteRoot],
        tools: ['mailbox_message_show'],
      },
    },
  }, null, 2), 'utf8');
  writeFileSync(join(aggregateSiteRoot, '.ai', 'mcp', 'narada-sonar-graph-mail-mcp.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    mcpServers: {
      'narada-sonar-graph-mail': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/graph-mail-mcp/dist/src/main.js', '--site-root', aggregateSiteRoot],
        tools: ['graph_mail_message_show'],
      },
    },
  }, null, 2), 'utf8');
  const mailRegistry = buildSiteSurfaceRegistry({ site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [] });
  assertOutputReaderClosure(mailRegistry, 'mail surface registry');
  const mailboxRegistry = (mailRegistry.surfaces as Array<Record<string, any>>).find((surface) => surface.catalog_surface_id === 'mailbox');
  assert.ok(mailboxRegistry);
  assert.ok((mailboxRegistry.registered_live_tools as string[]).includes('mailbox_output_show'));
  assert.ok((mailboxRegistry.tool_contract.read_only_tools as string[]).includes('mailbox_output_show'));
  assert.deepEqual(mailboxRegistry.tool_contract.mutating_tools, []);
  const graphMailRegistry = (mailRegistry.surfaces as Array<Record<string, any>>).find((surface) => surface.catalog_surface_id === 'graph-mail');
  assert.ok(graphMailRegistry);
  assert.ok((graphMailRegistry.registered_live_tools as string[]).includes('graph_mail_output_show'));
  assert.ok((graphMailRegistry.tool_contract.read_only_tools as string[]).includes('graph_mail_output_show'));
  assert.equal((graphMailRegistry.tool_contract.refused_tools as string[]).includes('graph_mail_draft_send'), false);
  assert.equal((graphMailRegistry.tool_contract.mutating_tools as string[]).includes('graph_mail_draft_send'), true);

  const nestedSiteRoot = join(root, 'nested-control-site');
  mkdirSync(join(nestedSiteRoot, '.narada', '.ai', 'mcp'), { recursive: true });
  writeFileSync(join(nestedSiteRoot, '.narada', '.ai', 'mcp', 'narada-sonar-mailbox-mcp.json'), JSON.stringify({
    schema: 'narada.mcp.client_config.v0',
    mcpServers: {
      'narada-sonar-mailbox': {
        transport: 'stdio',
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/mailbox-mcp/dist/src/main.js', '--site-root', join(nestedSiteRoot, '.narada')],
        tools: ['mailbox_message_show'],
      },
    },
  }, null, 2), 'utf8');
  const nestedRegistry = buildSiteSurfaceRegistry({ site_id: 'narada-sonar', root: nestedSiteRoot, config_path: join(nestedSiteRoot, '.narada', 'config.json'), surfaces: [] });
  assertOutputReaderClosure(nestedRegistry, 'nested surface registry');
  assert.equal((nestedRegistry.surfaces as Array<Record<string, any>>).length, 1);
  assert.ok(((nestedRegistry.surfaces as Array<Record<string, any>>)[0].tool_contract.read_only_tools as string[]).includes('mailbox_output_show'));
  const sidecarRefusal = siteBindSidecarRefusal(
    { site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [] },
    'scheduler',
  );
  assert.equal(sidecarRefusal?.status, 'refused');
  assert.equal(sidecarRefusal?.reason_code, 'registrar_site_bind_refused_aggregate_fabric_exists');
  assert.equal(sidecarRefusal?.aggregate_file, 'narada-sonar-mcp.json');
  assert.equal(siteBindSidecarRefusal(
    { site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [] },
    'scheduler',
    { allow_sidecar: true },
  ), null);
  const disabledSidecarRefusal = siteBindSidecarRefusal(
    { site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [], surface_overrides: { scheduler: { enabled: false } } },
    'scheduler',
  );
  assert.equal(disabledSidecarRefusal?.status, 'refused');
  assert.equal(disabledSidecarRefusal?.reason_code, 'registrar_site_bind_refused_surface_disabled');
  assert.equal(disabledSidecarRefusal?.sidecar_state, 'disabled_by_site_override');
  assert.equal(siteBindSidecarRefusal(
    { site_id: 'narada-sonar', root: aggregateSiteRoot, config_path: join(aggregateSiteRoot, 'site.json'), surfaces: [], surface_overrides: { scheduler: { enabled: false } } },
    'scheduler',
    { allow_disabled_sidecar: true, allow_sidecar: true },
  ), null);

  console.log('mcp-registrar behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
