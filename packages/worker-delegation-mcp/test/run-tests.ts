import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const testFiles = [
  'cognition-defaults.test.js',
  'provider-runtime-binding.test.js',
  'output-contract.test.js',
  'runtime-events.test.js',
  'diagnostics.test.js',
  'run-store.test.js',
  'status-handler.test.js',
  'batch-handler.test.js',
  'dashboard-handler.test.js',
  'prompt.test.js',
  'worker-delegation-mcp.test.js',
  'protocol-smoke.test.js',
];

for (const testFile of testFiles) {
  const result = spawnSync(process.execPath, [join(testRoot, testFile)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
