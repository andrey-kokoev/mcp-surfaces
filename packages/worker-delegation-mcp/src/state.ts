import type { WorkerPolicy } from './policy.js';
import type { CognitionDefaultsState, ProviderRegistryDiagnostics } from './cognition-defaults.js';
import type { WorkerProviderRuntimeMetadata } from './provider-runtime-binding.js';
import type { IntelligenceLaunchContext } from './intelligence-launch-context.js';

export type WorkerMcpState = {
  siteRoot?: string;
  policy: WorkerPolicy;
  env: NodeJS.ProcessEnv;
  activeRunCount: number;
  cognitionDefaults?: CognitionDefaultsState;
  providerRegistryDiagnostics?: ProviderRegistryDiagnostics;
  providerRuntimeMetadata: Record<string, WorkerProviderRuntimeMetadata>;
  /** Load one provider's secret on first use; startup must remain side-effect free. */
  ensureProviderCredential?: (provider: string) => void;
  intelligenceLaunchContext?: IntelligenceLaunchContext;
  activeRunControllers?: Map<string, AbortController>;
  activeRunCompletions?: Map<string, Promise<Record<string, unknown>>>;
  activeRunCancellationRequests?: Set<string>;
  clientRoots?: {
    supported: boolean;
    roots: Array<{ uri: string; name?: string }>;
    lastUpdatedAt: string | null;
  };
};
