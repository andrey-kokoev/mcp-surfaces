import assert from 'node:assert/strict';
import { createServerState, handleRequest, listTools } from '../src/main.js';

const state = createServerState({ naradaRoot: 'D:/definitely/missing/narada' });
const tools = listTools();
const names = tools.map((tool) => tool.name);

assert.equal(names.includes('site_lifecycle_doctor'), true);
assert.equal(names.includes('site_create_plan'), true);
assert.equal(names.includes('site_init'), true);
assert.equal(names.includes('site_lifecycle_preflight'), true);

const doctorResponse = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'site_lifecycle_doctor', arguments: {} } }, state);
assert.equal(doctorResponse?.error, undefined);
const doctorPayload = JSON.parse((doctorResponse?.result as { content: { text: string }[] }).content[0].text);
assert.equal(doctorPayload.status, 'cli_module_missing');
assert.equal(doctorPayload.cli_module_exists, false);

const mapResponse = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'site_lifecycle_command_map', arguments: {} } }, state);
const mapPayload = JSON.parse((mapResponse?.result as { content: { text: string }[] }).content[0].text);
assert.equal(mapPayload.commands.some((item: { tool: string; cli_command: string }) => item.tool === 'site_create_plan' && item.cli_command === 'narada sites create --dry-run'), true);

const plannedMutation = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'site_init', arguments: { site_id: 'demo-site', substrate: 'windows-native', authority_basis: { kind: 'test', summary: 'fixture' } } } }, state);
const plannedPayload = JSON.parse((plannedMutation?.result as { content: { text: string }[] }).content[0].text);
assert.equal(plannedPayload.status, 'planned');
assert.equal(plannedPayload.mutation_performed, false);

console.log('site-lifecycle-mcp behavior ok');
