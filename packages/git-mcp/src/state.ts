import type { GitMcpPolicy } from './policy.js';
import type { GitScopeToken } from './scope-tokens.js';

export type GitMcpState = {
  policy: GitMcpPolicy;
  outputRoot: string;
  auditLogDir: string | null;
  env: NodeJS.ProcessEnv;
  clientRoots?: {
    supported: boolean;
    roots: Array<{ uri: string; name?: string }>;
    lastUpdatedAt: string | null;
  };
  scopeTokens?: Map<string, GitScopeToken>;
};
