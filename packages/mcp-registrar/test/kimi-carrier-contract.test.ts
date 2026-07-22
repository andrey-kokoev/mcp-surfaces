import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asRecord, createTemporaryE2eRoot, createTestProcessScope, removeTemporaryE2eRoot, spawnJsonlMcpServer, type TestProcessScope } from '@narada2/mcp-e2e-harness';
import { MOONSHOT_SCHEMA_DIALECT, validateMoonshotToolInputSchema, type MoonshotSchemaFinding } from '../src/moonshot-schema.js';
import { materializeKimiCarrierConfig, type KimiMcpServerConfig } from './kimi-carrier-test-support.js';

type ContractFailure = { server: string; tool?: string; finding?: MoonshotSchemaFinding; error?: string };
type ServerResult = { server: string; toolCount: number; schemaCount: number; failures: ContractFailure[] };

const temporaryRoot = createTemporaryE2eRoot('kimi-carrier-contract');
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const processScope = createTestProcessScope({ label: 'kimi-carrier-contract' });

try {
  const config = await materializeKimiCarrierConfig(join(temporaryRoot, 'mcp.json'));
  const entries = Object.entries(config.mcpServers).sort(([left], [right]) => left.localeCompare(right));
  const results = await mapWithConcurrency(entries, 1, ([server, definition]) => inspectServer(server, definition, processScope));
  const failures = results.flatMap((result) => result.failures);
  assert.equal(failures.length, 0, formatFailures(failures));

  const toolCount = results.reduce((sum, result) => sum + result.toolCount, 0);
  const schemaCount = results.reduce((sum, result) => sum + result.schemaCount, 0);
  assert.ok(toolCount > 0, 'Kimi carrier servers exposed no tools');
  assert.equal(schemaCount, toolCount, 'every exposed tool must have an input schema');
  console.log(`Kimi carrier contract ok: ${results.length} servers, ${toolCount} tools, ${schemaCount} schemas (${MOONSHOT_SCHEMA_DIALECT})`);
} finally {
  try {
    await processScope.close();
    processScope.assertClean();
  } finally {
    assert.equal(removeTemporaryE2eRoot(temporaryRoot), true, `failed to remove ${temporaryRoot}`);
  }
}

async function inspectServer(server: string, definition: KimiMcpServerConfig, processScope: TestProcessScope): Promise<ServerResult> {
  const failures: ContractFailure[] = [];
  let toolCount = 0;
  let schemaCount = 0;
  try {
    assert.equal(definition.transport, 'stdio', `${server}: transport must be stdio`);
    assert.equal(typeof definition.command, 'string', `${server}: command must be a string`);
    assert.ok(Array.isArray(definition.args) && definition.args.every((arg) => typeof arg === 'string'), `${server}: args must be strings`);
    if (definition.env !== undefined) assert.ok(isStringRecord(definition.env), `${server}: env must contain string values`);
    if (definition.env_vars !== undefined) {
      assert.ok(Array.isArray(definition.env_vars) && definition.env_vars.every((name) => typeof name === 'string'), `${server}: env_vars must contain strings`);
    }

    const spawned = spawnJsonlMcpServer(definition.command, definition.args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...definition.env },
      timeoutMs: 20_000,
      closeTimeoutMs: 1_000,
      scope: processScope,
      label: `Kimi carrier server ${server}`,
    });
    try {
      const initialize = await spawned.client.request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kimi-carrier-contract', version: '1.0.0' },
      });
      if (initialize.error) throw new Error(`initialize failed: ${JSON.stringify(initialize.error)}`);
      spawned.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      const listed = await spawned.client.request(2, 'tools/list', {});
      if (listed.error) throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}`);
      const tools = asRecord(listed.result).tools;
      if (!Array.isArray(tools)) throw new Error('tools/list returned no tools array');
      toolCount = tools.length;
      if (toolCount === 0) failures.push({ server, error: 'tools/list returned an empty tools array' });
      for (const rawTool of tools) {
        const tool = asRecord(rawTool);
        const toolName = typeof tool.name === 'string' ? tool.name : '<unnamed>';
        if (typeof tool.name !== 'string' || tool.name.length === 0) failures.push({ server, tool: toolName, error: 'tool name must be a non-empty string' });
        if (typeof tool.description !== 'string') failures.push({ server, tool: toolName, error: 'tool description must be a string' });
        if (!isRecord(tool.inputSchema)) {
          failures.push({ server, tool: toolName, error: 'tool inputSchema must be an object' });
          continue;
        }
        schemaCount += 1;
        for (const finding of validateMoonshotToolInputSchema(tool.inputSchema)) failures.push({ server, tool: toolName, finding });
      }
    } finally {
      await spawned.close();
    }
  } catch (error) {
    failures.push({ server, error: error instanceof Error ? error.message : String(error) });
  }
  return { server, toolCount, schemaCount, failures };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

function formatFailures(failures: ContractFailure[]): string {
  if (failures.length === 0) return '';
  return `Kimi carrier contract failures (${failures.length}):\n${failures.map((failure) => {
    const prefix = [failure.server, failure.tool].filter(Boolean).join(' / ');
    if (failure.finding) return `${prefix} / ${failure.finding.path}: [${failure.finding.code}] ${failure.finding.message}`;
    return `${prefix}: ${failure.error}`;
  }).join('\n')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
