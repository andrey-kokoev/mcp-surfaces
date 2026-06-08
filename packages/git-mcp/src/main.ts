#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs, runStdioServer } from './mcp-server.js';

export {
  createServerState,
  handleRequest,
  parseArgs,
  runStdioServer,
} from './mcp-server.js';
export {
  gitAdd,
  gitCommit,
  gitDiff,
  gitLog,
  gitPush,
  gitRepositoriesSummary,
  gitShow,
  gitStatus,
  gitWorkflowRecord,
} from './git-tools.js';
export {
  listTools,
} from './git-tool-list.js';
export type { GitMcpState } from './state.js';

if (isMainModule()) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
