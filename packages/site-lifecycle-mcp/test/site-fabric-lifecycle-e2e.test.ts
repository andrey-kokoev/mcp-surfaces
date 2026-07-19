import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFileStateUnchanged,
  createSiteFabricIsolation,
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  removeTemporaryE2eRoot,
  resolveDefaultUserSiteRegistryPath,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  snapshotFileState,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const cliModulePath = process.env.NARADA_SITE_E2E_CLI_MODULE
  ?? 'D:/code/narada/packages/layers/cli/dist/commands/sites.js';
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'site-lifecycle.site-fabric.real-cli.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'site-lifecycle.site-fabric.real-cli', authority: 'A0' });

if (!existsSync(cliModulePath)) {
  evidence.finalize({
    status: 'not_run',
    reason_code: 'narada_cli_module_missing',
    cli_module_path: cliModulePath,
    cleanup: { status: 'not_needed' },
  });
  console.log(JSON.stringify({
    status: 'not_run',
    test_id: 'site-lifecycle.site-fabric.real-cli',
    reason_code: 'narada_cli_module_missing',
    cli_module_path: cliModulePath,
    cleanup: 'not_needed',
  }));
  process.exit(2);
}

const naradaRoot = createTemporaryE2eRoot('site-lifecycle-site-fabric-e2e');
const userSiteIsolation = createSiteFabricIsolation(naradaRoot);
const realRegistryBefore = snapshotFileState(resolveDefaultUserSiteRegistryPath());
const siteRoot = join(naradaRoot, 'sites', 'fixture-site');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [
  serverPath,
  '--narada-root', naradaRoot,
  '--cli-module-path', cliModulePath,
], {
  cwd: naradaRoot,
  env: siteFabricChildEnv(naradaRoot, { NARADA_ROOT: naradaRoot }),
  label: 'site-lifecycle Site fabric e2e',
});

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'site-lifecycle-mcp',
    requiredTools: ['site_lifecycle_doctor', 'site_create_plan', 'site_list', 'site_init'],
  });

  const doctor = structured(await server.client.request(1, 'tools/call', {
    name: 'site_lifecycle_doctor',
    arguments: {},
  }));
  assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
  assert.equal(doctor.cli_module_exists, true, JSON.stringify(doctor));

  const presets = structured(await server.client.request(2, 'tools/call', {
    name: 'site_create_presets_list',
    arguments: {},
  }));
  assert.equal(presets.status, 'ok', JSON.stringify(presets));

  const plan = structured(await server.client.request(3, 'tools/call', {
    name: 'site_create_plan',
    arguments: {
      site_id: 'fixture-site',
      root: siteRoot,
      site_kind: 'project',
      authority_locus: 'user_site',
    },
  }));
  assert.equal(plan.mutation_performed, false, JSON.stringify(plan));
  assert.equal(plan.status, 'ok', JSON.stringify(plan));

  const initialized = structured(await server.client.request(4, 'tools/call', {
    name: 'site_init',
    arguments: {
      site_id: 'fixture-site',
      substrate: 'windows-native',
      root: siteRoot,
      authority_basis: { kind: 'controlled_test', summary: 'disposable Site lifecycle proof' },
      site_kind: 'project',
      execute: true,
    },
  }));
  assert.equal(initialized.status, 'ok', JSON.stringify(initialized));
  assert.equal(initialized.mutation_performed, true, JSON.stringify(initialized));
  assert.equal(
    existsSync(join(userSiteIsolation.userSiteRoot, 'registry.db')),
    true,
    'site_init must write the Site Registry inside the isolated temp User Site root',
  );

  const inspected = structured(await server.client.request(5, 'tools/call', {
    name: 'site_doctor',
    arguments: { site_id: 'fixture-site', root: siteRoot, kind: 'project', authority_locus: 'user_site' },
  }));
  assert.equal(inspected.tool, 'site_doctor', JSON.stringify(inspected));
  assert.equal(inspected.mutation_performed, false, JSON.stringify(inspected));
  assert.equal((inspected.result as JsonRecord).siteId, 'fixture-site', JSON.stringify(inspected));
  assert.equal(existsSync(join(siteRoot, 'config.json')), true);

  const listed = structured(await server.client.request(6, 'tools/call', {
    name: 'site_list',
    arguments: {},
  }));
  assert.equal(listed.status, 'ok', JSON.stringify(listed));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'site-lifecycle.site-fabric.real-cli',
    authority: 'A0',
    mutation_performed: true,
    cleanup: 'completed_after_finally',
  }));
  evidence.update({ status: 'passed' });
} finally {
  await server.close();
  assertFileStateUnchanged(realRegistryBefore);
  const cleanupOk = removeTemporaryE2eRoot(naradaRoot);
  evidence.finalize({ status: cleanupOk ? 'passed' : 'failed', cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}

