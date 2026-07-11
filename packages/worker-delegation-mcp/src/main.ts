#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, runStdioServer } from './mcp-server.js';

export { createServerState, handleRequest, parseArgs, runStdioServer } from './mcp-server.js';
export { callWorkerTool } from './worker-tools.js';
export { buildCodexArgv } from './codex-adapter.js';
export { buildAgentRuntimeServerArgv, runtimeName as agentRuntimeServerRuntimeName } from './agent-runtime-server-adapter.js';
export { createWorkerPolicy, publicWorkerPolicy } from './policy.js';
export { providerRuntimeMetadataFromRegistry } from './provider-runtime-binding.js';
export type { WorkerProviderRuntimeMetadata } from './provider-runtime-binding.js';
export type { WorkerMcpState } from './state.js';

if (isMainModule()) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
}
