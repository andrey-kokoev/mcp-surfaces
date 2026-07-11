import type { WorkerPolicy } from './policy.js';
import type { CognitionDefaultsState } from './cognition-defaults.js';
import type { WorkerProviderRuntimeMetadata } from './provider-runtime-binding.js';

export type WorkerMcpState = {
  policy: WorkerPolicy;
  env: NodeJS.ProcessEnv;
  activeRunCount: number;
  cognitionDefaults?: CognitionDefaultsState;
  providerRuntimeMetadata: Record<string, WorkerProviderRuntimeMetadata>;
  activeRunControllers?: Map<string, AbortController>;
  activeRunCompletions?: Map<string, Promise<Record<string, unknown>>>;
  activeRunCancellationRequests?: Set<string>;
  clientRoots?: {
    supported: boolean;
    roots: Array<{ uri: string; name?: string }>;
    lastUpdatedAt: string | null;
  };
};
