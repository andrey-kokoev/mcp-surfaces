import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  structured,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('registrar-catalog-site-fabric-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'mcp-registrar.site-fabric.full-catalog-sweep.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'mcp-registrar.site-fabric.full-catalog-sweep', authority: 'A0' });
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--narada-root', siteRoot], {
  cwd: siteRoot,
  env: { ...process.env, NARADA_ROOT: siteRoot },
  label: 'mcp-registrar catalog Site fabric e2e',
});

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'mcp-registrar',
    requiredTools: ['registrar_surface_list', 'registrar_surface_tool_inventory_check'],
  });

  const catalog = structured(await server.client.request(3, 'tools/call', {
    name: 'registrar_surface_list',
    arguments: {},
  }));
  const items = catalog.items as JsonRecord[];
  assert.ok(items.length > 10, JSON.stringify(catalog));
  assert.equal(catalog.count, items.length, JSON.stringify(catalog));
  const ids = items.map((item) => String(item.id));
  assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
  for (const item of items) {
    assert.ok(String(item.package), JSON.stringify(item));
    assert.ok(String(item.entrypoint), JSON.stringify(item));
    const tools = item.tools as unknown[];
    assert.ok(Array.isArray(tools) && tools.length > 0, JSON.stringify(item));
    assert.equal(new Set(tools.map(String)).size, tools.length, JSON.stringify(item));
  }

  const observedTools = Object.fromEntries(items.map((item) => [String(item.id), item.tools]));
  const inventory = structured(await server.client.request(4, 'tools/call', {
    name: 'registrar_surface_tool_inventory_check',
    arguments: { include_ok: true, observed_tools: observedTools },
  }));
  assert.equal(inventory.status, 'ok', JSON.stringify(inventory));
  assert.equal(inventory.checked_count, items.length, JSON.stringify(inventory));
  assert.equal((inventory.findings as JsonRecord[]).length, items.length, JSON.stringify(inventory));
  assert.equal((inventory.findings as JsonRecord[]).every((finding) => finding.status === 'ok'), true, JSON.stringify(inventory));

  console.log(JSON.stringify({
    status: 'passed',
    test_id: 'mcp-registrar.site-fabric.full-catalog-sweep',
    authority: 'A0',
    catalog_count: items.length,
    live_child: true,
    cleanup: 'completed_after_finally',
  }));
  evidence.update({ status: 'passed' });
} finally {
  await server.close();
  const cleanupOk = removeTemporaryE2eRoot(siteRoot);
  evidence.finalize({ status: cleanupOk ? 'passed' : 'failed', cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}
