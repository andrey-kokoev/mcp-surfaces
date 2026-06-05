import type { WorkerPolicy } from './policy.js';

export type WorkerMcpState = {
  policy: WorkerPolicy;
  env: NodeJS.ProcessEnv;
  activeRunCount: number;
  clientRoots?: {
    supported: boolean;
    roots: Array<{ uri: string; name?: string }>;
    lastUpdatedAt: string | null;
  };
};
