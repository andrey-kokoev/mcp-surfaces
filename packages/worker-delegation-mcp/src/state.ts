import type { WorkerPolicy } from './policy.js';

export type WorkerMcpState = {
  policy: WorkerPolicy;
  env: NodeJS.ProcessEnv;
};
