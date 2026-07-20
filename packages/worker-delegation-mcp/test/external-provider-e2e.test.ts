import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  installE2eArtifactRecorder,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  structured,
} from '@narada2/mcp-e2e-harness';
import { resolveWorkerProviderRuntimeBindingFromRegistry } from '../src/provider-runtime-binding.js';

const siteRoot = createTemporaryE2eRoot('worker-external-provider-e2e');
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', 'worker-delegation.site-fabric.external-provider.json');
const evidence = installE2eArtifactRecorder(resultPath, { test_id: 'worker-delegation.site-fabric.external-provider', authority: 'A1' });
const liveRequested = process.env.NARADA_E2E_WORKER_EXTERNAL_PROVIDER_LIVE === '1';
const providerResolution = liveRequested
  ? resolveLiveProviderSelection()
  : { selection: null, missingPrerequisites: ['external_authority_not_enabled'], registryPathForChild: null };
const selectedProvider = providerResolution.selection;
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
  NARADA_AI_THINKING: 'low',
  ...(selectedProvider ? {
    NARADA_INTELLIGENCE_PROVIDER: selectedProvider.provider,
    NARADA_AI_API_KEY: selectedProvider.binding.api_key ?? undefined,
    NARADA_AI_BASE_URL: selectedProvider.binding.base_url,
    NARADA_AI_MODEL: selectedProvider.binding.model,
    NARADA_AI_THINKING: selectedProvider.binding.reasoning_effort,
  } : {}),
  ...(providerResolution.registryPathForChild
    ? { NARADA_INTELLIGENCE_PROVIDER_METADATA_PATH: providerResolution.registryPathForChild }
    : {}),
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

  const missingPrerequisites = providerResolution.missingPrerequisites;
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
    process.exitCode = 2;
  } else {
    assert.ok(selectedProvider, JSON.stringify(providerResolution));
    const timeoutMs = boundedTimeoutMs();
    const response = await server.client.request(4, 'tools/call', {
      name: 'worker_run',
      arguments: {
        intent: { instruction: 'Return the bounded worker contract without editing files.', mode: 'plan_only' },
        constraints: {
          authority: 'read',
          cognition: 'low',
          cwd: siteRoot,
          site_root: siteRoot,
          provider: selectedProvider.provider,
          max_run_ms: timeoutMs,
          wait_timeout_ms: timeoutMs + 5000,
          wait_for_completion: true,
          overrides: {
            runtime: 'narada-agent-runtime-server',
            model: selectedProvider.binding.model,
            reasoning_effort: selectedProvider.binding.reasoning_effort,
          },
        },
      },
    });
    assert.equal(response.error, undefined, JSON.stringify(response));
    const run = structured(response);
    assert.ok(run.schema === 'narada.worker.run.v1' || run.schema === 'narada.producer_output_page.v1', JSON.stringify(run));
    const workerBinding = (run.resolved_worker_config as Record<string, unknown> | undefined)?.provider_runtime_binding;
    assert.deepEqual(workerBinding, selectedProvider.redactedBinding, JSON.stringify({ workerBinding, expected: selectedProvider.redactedBinding }));
    console.log(JSON.stringify({
      status: 'passed',
      test_id: 'worker-delegation.site-fabric.external-provider',
      authority: 'A1',
      provider: selectedProvider.provider,
      model: selectedProvider.binding.model,
      provider_authority: selectedProvider.authority,
      resolved_binding: selectedProvider.redactedBinding,
      worker_binding: workerBinding,
      cleanup: 'completed_after_finally',
    }));
    evidence.update({ status: 'passed', provider: selectedProvider.provider, model: selectedProvider.binding.model, provider_authority: selectedProvider.authority, resolved_binding: selectedProvider.redactedBinding, worker_binding: workerBinding });
  }
} finally {
  await server.close();
  const cleanupOk = removeTemporaryE2eRoot(siteRoot);
  evidence.finalize({ ...(cleanupOk ? {} : { status: 'failed' }), cleanup: { status: cleanupOk ? 'completed_after_finally' : 'failed' } });
  assert.equal(cleanupOk, true);
}

type LiveProviderSelection = {
  provider: string;
  binding: {
    api_key: string | null;
    base_url: string;
    model: string;
    reasoning_effort: string;
  };
  redactedBinding: Record<string, unknown>;
  authority: Record<string, unknown>;
};

type LiveProviderResolution = {
  selection: LiveProviderSelection | null;
  missingPrerequisites: string[];
  registryPathForChild: string | null;
};

function resolveLiveProviderSelection(): LiveProviderResolution {
  const configuredPath = firstNonEmpty(
    process.env.NARADA_E2E_WORKER_PROVIDER_REGISTRY,
    process.env.NARADA_INTELLIGENCE_PROVIDER_METADATA_PATH,
  );
  if (!configuredPath) return unresolved('provider_registry_path_missing');

  const registryPath = resolve(configuredPath);
  if (!existsSync(registryPath)) return unresolved('provider_registry_missing');

  let registry: Record<string, unknown>;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return unresolved('provider_registry_invalid_json');
  }

  try {
    const resolved = resolveWorkerProviderRuntimeBindingFromRegistry({
      registry,
      env: process.env,
      providerOverride: firstNonEmpty(process.env.NARADA_E2E_WORKER_PROVIDER),
      modelOverride: firstNonEmpty(process.env.NARADA_E2E_WORKER_PROVIDER_MODEL),
      baseUrlOverride: firstNonEmpty(process.env.NARADA_E2E_WORKER_PROVIDER_BASE_URL),
      apiKeyOverride: firstNonEmpty(process.env.NARADA_E2E_WORKER_PROVIDER_API_KEY),
      reasoningEffortOverride: 'low',
      cognition: 'low',
    });
    const workerEnvironment = {
      ...process.env,
      NARADA_INTELLIGENCE_PROVIDER: resolved.provider,
      NARADA_AI_BASE_URL: resolved.binding.base_url,
      NARADA_AI_MODEL: resolved.binding.model,
      NARADA_AI_THINKING: resolved.binding.reasoning_effort,
      NARADA_AI_API_KEY: resolved.binding.api_key ?? undefined,
    };
    const workerResolved = resolveWorkerProviderRuntimeBindingFromRegistry({
      registry,
      env: workerEnvironment,
      modelOverride: resolved.binding.model,
      cognition: 'low',
    });
    return {
      selection: {
        provider: resolved.provider,
        binding: {
          api_key: resolved.binding.api_key,
          base_url: resolved.binding.base_url,
          model: resolved.binding.model,
          reasoning_effort: resolved.binding.reasoning_effort,
        },
        redactedBinding: workerResolved.redacted_binding,
        authority: {
          provider_source: resolved.provider_source,
          model_source: resolved.model_source,
          base_url_source: resolved.base_url_source,
          reasoning_effort_source: resolved.reasoning_effort_source,
          adapter_kind: resolved.adapter_kind,
          registry_path: registryPath,
          registry_binding: resolved.redacted_binding,
        },
      },
      missingPrerequisites: [],
      registryPathForChild: registryPath,
    };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'codeName' in error
      ? String((error as { codeName: unknown }).codeName)
      : 'provider_registry_resolution_failed';
    return unresolved(code);
  }
}

function unresolved(reason: string): LiveProviderResolution {
  return { selection: null, missingPrerequisites: [reason], registryPathForChild: null };
}

function boundedTimeoutMs(): number {
  const value = Number(process.env.NARADA_E2E_WORKER_EXTERNAL_PROVIDER_TIMEOUT_MS ?? 60000);
  if (!Number.isFinite(value)) return 60000;
  return Math.max(5000, Math.min(120000, Math.trunc(value)));
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}
