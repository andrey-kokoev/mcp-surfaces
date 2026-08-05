import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestProcessScope } from '@narada-core/mcp-e2e-harness';

const testRoot = dirname(fileURLToPath(import.meta.url));
const testFiles = [
  'cognition-defaults.test.js',
  'canonical-provider-registry.test.js',
  'canonical-invocation-plan.test.js',
  'provider-registry-diagnostics.test.js',
  'provider-runtime-binding.test.js',
  'agent-runtime-server-adapter.test.js',
  'implementation-identity.test.js',
  'output-contract.test.js',
  'runtime-events.test.js',
  'diagnostics.test.js',
  'run-store.test.js',
  'status-handler.test.js',
  'batch-handler.test.js',
  'dashboard-handler.test.js',
  'prompt.test.js',
  'worker-projection.test.js',
  'worker-delegation-mcp.test.js',
  'protocol-smoke.test.js',
];
const bunTestRunnerFiles = new Set([
  'canonical-invocation-plan.test.js',
  'provider-runtime-binding.test.js',
]);
const nodeRuntimeFiles = new Set(['protocol-smoke.test.js']);

const processScope = createTestProcessScope({ label: 'worker-delegation-test-runner' });
let failureCode = 0;
try {
  for (const testFile of testFiles) {
    const testPath = join(testRoot, testFile);
    const command = process.versions.bun && nodeRuntimeFiles.has(testFile) ? 'node' : process.execPath;
    const args = process.versions.bun && bunTestRunnerFiles.has(testFile) ? ['test', testPath] : [testPath];
    const status = await processScope.run(command, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    if (status !== 0) {
      failureCode = status;
      break;
    }
  }
} finally {
  await processScope.close();
  processScope.assertClean();
}
if (failureCode !== 0) process.exit(failureCode);
