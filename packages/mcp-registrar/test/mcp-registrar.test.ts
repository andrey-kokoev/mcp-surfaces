import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSiteBindConfig, createServerState, handleRequest, siteBindSidecarRefusal, siteSurfaceServerKey } from '../src/main.js';

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

  for (const carrierId of ['opencode-andrey', 'opencode-sonar', 'kimi-andrey', 'codex-andrey']) {
    const outputPath = join(root, `${carrierId}.generated`);
    const materializedCarrier = await call('registrar_carrier_materialize', { carrier_id: carrierId, output_path: outputPath });
    assert.equal(view(materializedCarrier).status, 'materialized');
    const content = readFileSync(outputPath, 'utf8');
    assert.match(content, /surface-feedback/);
    assert.match(content, /--feedback-root/);
    assert.match(content, /D:\/code\/mcp-surfaces/);
    assert.doesNotMatch(content, /--feedback-root["',\s\]]+[A-Z]:\/code\/narada(?!\/mcp-surfaces)/i);
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
