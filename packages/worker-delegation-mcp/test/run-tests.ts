import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestProcessScope } from '@narada2/mcp-e2e-harness';

const testRoot = dirname(fileURLToPath(import.meta.url));
const testFiles = [
  'cognition-defaults.test.js',
  'canonical-provider-registry.test.js',
  'provider-registry-diagnostics.test.js',
  'provider-runtime-binding.test.js',
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

const processScope = createTestProcessScope({ label: 'worker-delegation-test-runner' });
let failureCode = 0;
try {
  for (const testFile of testFiles) {
    const status = await processScope.run(process.execPath, [join(testRoot, testFile)], {
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
