import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest, listTools } from '../src/main.js';

const names = listTools().map((tool) => tool.name);
assert.deepEqual(names.sort(), [
  'site_registry_command_map',
  'site_registry_discover_plan',
  'site_registry_doctor',
  'site_registry_guidance',
  'site_registry_list',
  'site_registry_show',
].sort());

const missingState = createServerState({ naradaRoot: 'D:/definitely/missing/narada' });
const doctorResponse = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'site_registry_doctor', arguments: {} } }, missingState);
const doctorPayload = JSON.parse((doctorResponse?.result as { content: { text: string }[] }).content[0].text);
assert.equal(doctorPayload.status, 'cli_module_missing');

const fixtureDir = await mkdtemp(join(tmpdir(), 'site-registry-mcp-'));
const fixturePath = join(fixtureDir, 'registry-fixture.mjs');
await writeFile(fixturePath, `
export async function sitesRegistryListCommand(options) { return { exitCode: 0, result: { kind: 'list', options } }; }
export async function sitesRegistryShowCommand(options) { return { exitCode: 0, result: { kind: 'show', options } }; }
export async function sitesRegistryDiscoverCommand(options) { return { exitCode: 0, result: { kind: 'discover', options } }; }
`);

try {
  const state = createServerState({ naradaRoot: fixtureDir, cliModulePath: fixturePath });
  const list = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'site_registry_list', arguments: {} } }, state);
  const listPayload = JSON.parse((list?.result as { content: { text: string }[] }).content[0].text);
  assert.equal(listPayload.result.kind, 'list');

  const show = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'site_registry_show', arguments: { reference: 'alias' } } }, state);
  const showPayload = JSON.parse((show?.result as { content: { text: string }[] }).content[0].text);
  assert.equal(showPayload.result.options.reference, 'alias');

  const discover = await handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'site_registry_discover_plan', arguments: { source: 'filesystem', apply: true } } }, state);
  const discoverPayload = JSON.parse((discover?.result as { content: { text: string }[] }).content[0].text);
  assert.equal(discoverPayload.result.options.dryRun, true);
  assert.equal(discoverPayload.result.options.apply, undefined);
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log('site-registry-mcp behavior ok');
