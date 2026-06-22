import type { GitMcpPolicy } from './policy.js';

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
};
