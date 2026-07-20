import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const testFiles = [
  'delegated-task-mcp.test.js',
  'execution-boundary.test.js',
  'protocol-smoke.test.js',
  'task-executability-assessment.test.js',
  'task-executability-dispatch.test.js',
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
