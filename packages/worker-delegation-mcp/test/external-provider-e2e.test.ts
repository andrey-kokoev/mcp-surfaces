import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  structured,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('worker-external-provider-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'worker-delegation.site-fabric.external-provider.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'worker-delegation.site-fabric.external-provider', authority: 'A1' });
const providerBaseUrl = process.env.NARADA_E2E_WORKER_PROVIDER_BASE_URL;
const providerApiKey = process.env.NARADA_E2E_WORKER_PROVIDER_API_KEY;
const providerModel = process.env.NARADA_E2E_WORKER_PROVIDER_MODEL;
const liveRequested = process.env.NARADA_E2E_WORKER_EXTERNAL_PROVIDER_LIVE === '1';
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const runRoot = join(siteRoot, '.ai', 'runtime', 'worker-delegation');
const auditLogDir = join(siteRoot, '.ai', 'runtime', 'worker-audit');
mkdirSync(runRoot, { recursive: true });
mkdirSync(auditLogDir, { recursive: true });

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NARADA_PROVIDER_SECRET_STORE: 'disabled',
  NARADA_SITE_ROOT: siteRoot,
  NARADA_WORKSPACE_ROOT: siteRoot,
  NARADA_INTELLIGENCE_PROVIDER: 'openai-api',
  NARADA_AI_API_KEY: liveRequested ? providerApiKey : undefined,
  NARADA_AI_BASE_URL: liveRequested ? providerBaseUrl : undefined,
  NARADA_AI_MODEL: liveRequested ? providerModel : undefined,
  NARADA_AI_THINKING: 'low',
};
const server = spawnJsonlMcpServer(process.execPath, [
  serverPath,
  '--site-root', siteRoot,
  '--allowed-root', siteRoot,
  '--run-root', runRoot,
  '--audit-log-dir', auditLogDir,
], {
  cwd: siteRoot,
  env: childEnv,
  label: 'worker external-provider e2e',
});

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'worker-delegation-mcp',
    requiredTools: ['worker_guidance', 'worker_policy_inspect', 'worker_run', 'worker_output_show'],
  });

  const policy = structured(await server.client.request(3, 'tools/call', {
    name: 'worker_policy_inspect',
    arguments: {},
  }));
  assert.ok(policy.status === 'ok' || policy.schema !== undefined, JSON.stringify(policy));

  const missingPrerequisites = [
    ['external_authority_not_enabled', liveRequested],
    ['provider_base_url_missing', Boolean(providerBaseUrl)],
    ['provider_api_key_missing', Boolean(providerApiKey)],
    ['provider_model_missing', Boolean(providerModel)],
  ].filter(([, present]) => !present).map(([reason]) => reason);
  if (missingPrerequisites.length > 0) {
    evidence.update({ status: 'not_run', reason_code: 'controlled_external_provider_not_configured', missing_prerequisites: missingPrerequisites });
    console.log(JSON.stringify({
      status: 'not_run',
      test_id: 'worker-delegation.site-fabric.external-provider',
      authority: 'A1',
      reason_code: 'controlled_external_provider_not_configured',
      missing_prerequisites: missingPrerequisites,
      cleanup: 'completed_after_finally',
    }));
  } else {
    const response = await server.client.request(4, 'tools/call', {
      name: 'worker_run',
      arguments: {
        intent: { instruction: 'Return the bounded worker contract without editing files.', mode: 'plan_only' },
        constraints: {
          authority: 'read',
          cognition: 'low',
          cwd: siteRoot,
          site_root: siteRoot,
          provider: 'openai-api',
          wait_for_completion: true,
          overrides: { model: providerModel, reasoning_effort: 'low' },
        },
      },
    });
    assert.equal(response.error, undefined, JSON.stringify(response));
    const run = structured(response);
    assert.ok(run.schema === 'narada.worker.run.v1' || run.schema === 'narada.producer_output_page.v1', JSON.stringify(run));
    console.log(JSON.stringify({
      status: 'passed',
      test_id: 'worker-delegation.site-fabric.external-provider',
      authority: 'A1',
      provider: 'openai-api',
      model: providerModel,
      cleanup: 'completed_after_finally',
    }));
    evidence.update({ status: 'passed' });
  }
} finally {
  await server.close();
  const cleanupOk = removeTemporaryE2eRoot(siteRoot);
  evidence.finalize({ ...(cleanupOk ? {} : { status: 'failed' }), cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}
