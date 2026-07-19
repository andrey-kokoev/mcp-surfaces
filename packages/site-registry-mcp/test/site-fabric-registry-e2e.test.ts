import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createSiteFabricIsolation,
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const cliModulePath = process.env.NARADA_SITE_E2E_CLI_MODULE
  ?? 'D:/code/narada/packages/layers/cli/dist/commands/site-registry-management.js';
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'site-registry.site-fabric.real-cli.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'site-registry.site-fabric.real-cli', authority: 'A0' });

if (!existsSync(cliModulePath)) {
  evidence.finalize({
    status: 'not_run',
    reason_code: 'narada_cli_module_missing',
    cli_module_path: cliModulePath,
    cleanup: { status: 'not_needed' },
  });
  console.log(JSON.stringify({
    status: 'not_run',
    test_id: 'site-registry.site-fabric.real-cli',
    reason_code: 'narada_cli_module_missing',
    cli_module_path: cliModulePath,
    cleanup: 'not_needed',
  }));
  process.exit(2);
}

const naradaRoot = createTemporaryE2eRoot('site-registry-site-fabric-e2e');
const userSiteIsolation = createSiteFabricIsolation(naradaRoot);
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [
  serverPath,
  '--narada-root', naradaRoot,
  '--cli-module-path', cliModulePath,
], {
  cwd: naradaRoot,
  env: siteFabricChildEnv(naradaRoot, { NARADA_ROOT: naradaRoot }),
  label: 'site-registry Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'site-registry-mcp',
    requiredTools: ['site_registry_doctor', 'site_registry_command_map', 'site_registry_list', 'site_registry_show', 'site_registry_discover_plan'],
  });

  const doctor = structured(await server.client.request(1, 'tools/call', {
    name: 'site_registry_doctor',
    arguments: {},
  }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  assert.equal(doctor.cli_module_exists, true, JSON.stringify(doctor));

  const commandMap = structured(await server.client.request(2, 'tools/call', {
    name: 'site_registry_command_map',
    arguments: {},
  }));
  assert.equal(commandMap.status, 'ok', JSON.stringify(commandMap));
  assert.equal(commandMap.count, 3, JSON.stringify(commandMap));
  assert.deepEqual(
    (commandMap.commands as JsonRecord[]).map((command) => command.tool),
    ['site_registry_list', 'site_registry_show', 'site_registry_discover_plan'],
    JSON.stringify(commandMap),
  );

  const listed = structured(await server.client.request(3, 'tools/call', {
    name: 'site_registry_list',
    arguments: {},
  }));
  assert.equal(listed.status, 'ok', JSON.stringify(listed));
  assert.equal(listed.mutation_performed, false, JSON.stringify(listed));

  // Seed the isolated registry so site_registry_show has a fixture record;
  // the isolated DB starts empty and the real User Site registry is off-limits.
  const seedDb = new DatabaseSync(join(userSiteIsolation.userSiteRoot, 'registry.db'));
  seedDb.prepare('INSERT INTO site_registry (site_id, variant, site_root, substrate) VALUES (?, ?, ?, ?)')
    .run('fixture-site', 'native', join(naradaRoot, 'sites', 'fixture-site'), 'windows-native');
  seedDb.close();

  const shown = structured(await server.client.request(4, 'tools/call', {
    name: 'site_registry_show',
    arguments: { reference: 'fixture-site' },
  }));
  assert.equal(shown.status, 'ok', JSON.stringify(shown));
  assert.equal(shown.tool, 'site_registry_show', JSON.stringify(shown));
  assert.equal(shown.mutation_performed, false, JSON.stringify(shown));

  const discoveryPlan = structured(await server.client.request(5, 'tools/call', {
    name: 'site_registry_discover_plan',
    arguments: { source: 'all', root: naradaRoot, actor: 'site-registry-e2e' },
  }));
  assert.equal(discoveryPlan.status, 'ok', JSON.stringify(discoveryPlan));
  assert.equal(discoveryPlan.mutation_performed, false, JSON.stringify(discoveryPlan));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'site-registry.site-fabric.real-cli',
    authority: 'A0',
    mutation_performed: false,
    cleanup: 'completed_after_finally',
  }));
  evidence.update({ status: 'passed' });
} finally {
  await server.close();
  const cleanupOk = removeTemporaryE2eRoot(naradaRoot);
  evidence.finalize({ status: cleanupOk ? 'passed' : 'failed', cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}

