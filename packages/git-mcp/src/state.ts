import type { GitMcpPolicy } from './policy.js';

export type GitMcpState = {
  policy: GitMcpPolicy;
  outputRoot: string;
  auditLogDir: string | null;
};
