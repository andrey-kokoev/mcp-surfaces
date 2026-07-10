import type { WorkerPolicy } from './policy.js';

export type WorkerMcpState = {
  policy: WorkerPolicy;
  env: NodeJS.ProcessEnv;
  activeRunCount: number;
  activeRunControllers?: Map<string, AbortController>;
  activeRunCompletions?: Map<string, Promise<Record<string, unknown>>>;
  activeRunCancellationRequests?: Set<string>;
  clientRoots?: {
    supported: boolean;
    roots: Array<{ uri: string; name?: string }>;
    lastUpdatedAt: string | null;
  };
};
