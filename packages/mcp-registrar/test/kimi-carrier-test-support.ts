import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServerState, handleRequest } from '../src/main.js';

export type KimiMcpServerConfig = {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  env_vars?: string[];
};

export type KimiCarrierConfig = {
  mcpServers: Record<string, KimiMcpServerConfig>;
};

export async function materializeKimiCarrierConfig(outputPath: string): Promise<KimiCarrierConfig> {
  const response = await handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'registrar_carrier_materialize', arguments: { carrier_id: 'kimi-andrey', output_path: outputPath } },
  }, createServerState({})) as Record<string, any>;
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  const result = response.result?.structuredContent as Record<string, unknown> | undefined;
  assert.equal(result?.status, 'materialized');
  assert.equal(result?.carrier_id, 'kimi-andrey');
  const parsed = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
  assert.ok(isRecord(parsed.mcpServers), 'materialized Kimi config must contain mcpServers');
  assert.ok(Object.keys(parsed.mcpServers).length > 0, 'materialized Kimi config must contain at least one server');
  return parsed as KimiCarrierConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
