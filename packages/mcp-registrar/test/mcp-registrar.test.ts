import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSiteBindConfig, createServerState, handleRequest, sharedSurfaceIdsForBinding, siteBindSidecarRefusal, siteSurfaceServerKey, validateSiteMcpFabric } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'mcp-registrar-behavior-'));

try {
  const state = createServerState({});

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
  }
  function view(res: Record<string, any>): Record<string, any> {
    return res.result.structuredContent as Record<string, any>;
  }

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
  assert.deepEqual(speech.tools, ['speech_speak', 'speech_voices', 'speech_capture_transcribe', 'speech_prompt_capture_response', 'speech_listen_status', 'speech_listen_start', 'speech_listen_stop']);
  const operatorRouting = (surfaceData.items as Array<Record<string, any>>).find((s) => s.id === 'operator-routing');
  assert.ok(operatorRouting);
  assert.equal(operatorRouting.injection_scope, 'user_site');
  assert.equal(operatorRouting.default_injection, 'all_site_bound_sessions');
  assert.deepEqual(operatorRouting.tools, ['operator_route_doctor', 'operator_route_request']);
  const sharedSurfaceIds = sharedSurfaceIdsForBinding({ site_id: 'narada-test', prefix: 'narada-test', surfaces: ['agent-context'] });
  assert.ok(sharedSurfaceIds.includes('speech'));
  assert.ok(sharedSurfaceIds.includes('operator-routing'));
  assert.equal(sharedSurfaceIds.filter((surfaceId) => surfaceId === 'speech').length, 1);
  const registrar = (surfaceData.items as Array<Record<string, any>>).find((s) => s.id === 'mcp-registrar');
  assert.ok(registrar);
  assert.equal(registrar.injection_scope, 'user_site');
  assert.deepEqual(registrar.authority_locus, { kind: 'user_site', site_root: 'C:/Users/Andrey/Narada' });
  assert.ok(registrar.tools.includes('registrar_surface_tool_inventory_check'));

  const bySurface = new Map((surfaceData.items as Array<Record<string, any>>).map((surface) => [surface.id, surface]));
  assert.ok((bySurface.get('git')?.tools as string[]).includes('git_changed_summary'));
  assert.ok((bySurface.get('git')?.tools as string[]).includes('git_unstage'));
  assert.ok((bySurface.get('graph-mail')?.tools as string[]).includes('graph_mail_attachment_upload_file'));
  assert.ok((bySurface.get('graph-mail')?.tools as string[]).includes('graph_mail_reply_all_to_last_in_thread_draft_create'));
  assert.ok((bySurface.get('task-lifecycle')?.tools as string[]).includes('task_lifecycle_submit_work'));
  assert.ok((bySurface.get('site-inbox')?.tools as string[]).includes('inbox_stage_submission_workflow'));
  assert.ok((bySurface.get('worker-delegation')?.tools as string[]).includes('worker_dashboard_describe'));
  assert.equal((bySurface.get('worker-delegation')?.tools as string[]).includes('worker_output_show'), false);
  assert.ok((bySurface.get('delegated-task')?.tools as string[]).includes('delegated_task_result'));
  assert.ok((bySurface.get('agent-context')?.tools as string[]).includes('agent_context_list_sessions'));
  assert.ok((bySurface.get('sop')?.tools as string[]).includes('sop_doctor'));
  assert.ok((bySurface.get('mcp-loader')?.tools as string[]).includes('mcp_loader_site_fabric_diagnostics'));
  assert.ok((bySurface.get('surface-feedback')?.tools as string[]).includes('surface_feedback_import'));

  const inventoryCheck = view(await call('registrar_surface_tool_inventory_check', {
    include_ok: true,
    observed_tools: {
      git: bySurface.get('git')?.tools,
      'graph-mail': bySurface.get('graph-mail')?.tools,
      'worker-delegation': bySurface.get('worker-delegation')?.tools,
    },
  }));
  assert.equal(inventoryCheck.status, 'ok');
  assert.equal(inventoryCheck.checked_count, 3);
  assert.equal((inventoryCheck.findings as Array<Record<string, any>>).length, 3);
  const driftCheck = view(await call('registrar_surface_tool_inventory_check', {
    observed_tools: { git: ['git_status', 'git_extra_observed'] },
  }));
  assert.equal(driftCheck.status, 'drift');
  const gitDrift = (driftCheck.findings as Array<Record<string, any>>).find((finding) => finding.surface_id === 'git');
  assert.ok(gitDrift);
  assert.deepEqual(gitDrift.missing_from_registrar, ['git_extra_observed']);
  assert.ok((gitDrift.extra_in_registrar as string[]).includes('git_policy_inspect'));

  const sites = await call('registrar_site_list', {});
  const siteData = view(sites);
  assert.ok((siteData.items as Array<unknown>).length >= 7);

  const carriers = await call('registrar_carrier_list', {});
  const carrierData = view(carriers);
  assert.ok((carrierData.items as Array<unknown>).length >= 3);

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
  const bindConfig = buildSiteBindConfig(
    { site_id: 'narada-sonar', root, config_path: join(root, 'site.json'), surfaces: [] },
    { id: 'scheduler', package: 'scheduler-mcp', entrypoint: 'D:/code/mcp-surfaces/packages/scheduler-mcp/dist/src/main.js', kind: 'mcp_surface', args: [], tools: ['scheduler_task_list'] },
  );
  assert.equal(bindConfig.fileName, 'narada-sonar-scheduler-mcp.json');
  assert.equal(bindConfig.serverKey, 'narada-sonar-scheduler');
  assert.ok((bindConfig.config.mcpServers as Record<string, any>)['narada-sonar-scheduler']);
  assert.ok(!(bindConfig.config.mcpServers as Record<string, any>)['sonar-scheduler']);
  const schedServer = (bindConfig.config.mcpServers as Record<string, any>)['narada-sonar-scheduler'];
  assert.equal(schedServer.injection_scope, 'local_site');
  assert.deepEqual(schedServer.authority_locus, { kind: 'local_site', site_root: root });
  assert.equal(schedServer.narada_scope.scope_source, 'registrar_surface_catalog');
  assert.equal(schedServer.narada_scope.bound_into_site, 'narada-sonar');

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
      args: ['--site-root', '{site_root}', '--allowed-root', '{site_root}', '--run-root', '{site_root}/.narada/runtime/worker-delegation'],
      tools: ['worker_run'],
      env_vars: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE_URL', 'NARADA_WORKER_MCP_CONFIG'],
    },
  );
  const workerServer = (workerBindConfig.config.mcpServers as Record<string, any>)['narada-sonar-worker-delegation'];
  assert.ok(workerServer.args.includes('--site-root'));
  assert.equal(workerServer.args[workerServer.args.indexOf('--site-root') + 1], root);
  assert.ok(workerServer.env_vars.includes('DEEPSEEK_API_KEY'));
  assert.ok(workerServer.env_vars.includes('DEEPSEEK_API_BASE_URL'));
  assert.ok(workerServer.env_vars.includes('NARADA_WORKER_MCP_CONFIG'));

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

  for (const carrierId of ['opencode-andrey', 'opencode-sonar', 'kimi-andrey', 'codex-andrey']) {
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
