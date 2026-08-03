import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installE2eArtifactRecorder,
  readMcpOutputText,
  runMcpProtocolSmoke,
  spawnContentLengthMcpServer,
  structured,
  type JsonRecord,
  type JsonRpcResponse,
} from '@narada-core/mcp-e2e-harness';

const TEST_ID = 'site-loop.production-scheduler-resident-recovery';
const PRODUCTION_E2E_DEADLINE_MS = 150_000;
const PRODUCTION_E2E_POLL_MS = 5_000;
const resultPath = join(fileURLToPath(new URL('../..', import.meta.url)), '.tmp', 'e2e-results', `${TEST_ID}.json`);
const evidence = installE2eArtifactRecorder(resultPath, {
  test_id: TEST_ID,
  authority: 'A1',
  authority_scope: 'explicitly_admitted_site_root',
  external_authority: 'declared_production_site_when_opted_in',
  provider_boundary: 'configured_production_scheduler_resident_and_connector',
});
const authorityEnabled = process.env.NARADA_E2E_SITE_LOOP_PRODUCTION === '1';
const configuredSiteRoot = process.env.NARADA_E2E_SITE_LOOP_SITE_ROOT
  ? resolve(process.env.NARADA_E2E_SITE_LOOP_SITE_ROOT)
  : null;
const declaredTaskName = process.env.NARADA_E2E_SITE_LOOP_TASK_NAME?.trim() || null;
const controlledMailboxSource = process.env.NARADA_E2E_SITE_LOOP_CONTROLLED_MAILBOX_SOURCE?.trim() || null;
const configPath = configuredSiteRoot
  ? join(configuredSiteRoot, '.narada', 'capabilities', 'site-loop-config.json')
  : null;

type ProductionStatus = 'passed' | 'failed' | 'not_run';

class ProductionNotRunError extends Error {
  readonly reasonCode: string;
  readonly details: JsonRecord;

  constructor(reasonCode: string, details: JsonRecord = {}) {
    super(reasonCode);
    this.name = 'ProductionNotRunError';
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function contentText(label: string, response: JsonRpcResponse): JsonRecord {
  assert.equal(response.error, undefined, label + ': ' + JSON.stringify(response));
  const result = response.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  assert.equal(content.length > 0, true, label + ': ' + JSON.stringify(response));
  const first = content[0];
  assert.equal(first && typeof first === 'object' && !Array.isArray(first) && (first as JsonRecord).type, 'text', label + ': ' + JSON.stringify(response));
  return JSON.parse(String((first as JsonRecord).text ?? '')) as JsonRecord;
}

async function toolJson(client: ReturnType<typeof spawnContentLengthMcpServer>['client'], id: number, name: string, args: JsonRecord): Promise<JsonRecord> {
  const response = await client.request(id, 'tools/call', { name, arguments: args });
  const inline = contentText(name, response);
  if (inline.truncated !== true || typeof inline.output_ref !== 'string') return inline;
  const firstPage = structured(response);
  const materialized = await readMcpOutputText(
    firstPage,
    async ({ offset, limit, pageNumber }) => structured(await client.request(`${id}-page-${pageNumber}`, 'tools/call', {
      name: 'site_loop_output_show',
      arguments: { ref: firstPage.output_ref, offset, limit },
    })),
    { pageSize: 5_000, maxPages: 20, maxTextChars: 1_000_000 },
  );
  return JSON.parse(materialized.text) as JsonRecord;
}

function gate(readiness: JsonRecord, name: string): JsonRecord {
  const gates = Array.isArray(readiness.gates) ? readiness.gates as JsonRecord[] : [];
  const found = gates.find((item) => item.gate === name);
  assert.ok(found, `readiness gate missing: ${name}: ${JSON.stringify(readiness)}`);
  return found;
}

function notRun(reasonCode: string, details: JsonRecord = {}): void {
  const result = {
    schema: 'narada.site_loop.production_e2e.result.v1',
    test_id: TEST_ID,
    status: 'not_run',
    authority: 'A1',
    authority_scope: 'explicitly_admitted_site_root',
    external_authority: 'not_run',
    provider_boundary: 'configured_production_scheduler_resident_and_connector',
    artifact_path: resultPath,
    reason_code: reasonCode,
    ...details,
  };
  evidence.finalize(result);
  console.log(JSON.stringify(result));
  process.exitCode = 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForControlledMailboxProof(
  client: ReturnType<typeof spawnContentLengthMcpServer>['client'],
  requestId: string,
  deadline: number,
): Promise<JsonRecord> {
  let last: JsonRecord = {};
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    last = await toolJson(client, 80 + attempt, 'site_loop_proof_status', {});
    const mailbox = (last.mailbox_proof ?? {}) as JsonRecord;
    const request = (mailbox.request ?? {}) as JsonRecord;
    if (String(request.request_id ?? '') === requestId && request.status === 'failed') {
      throw new Error(`controlled_mailbox_proof_failed: ${JSON.stringify(last)}`);
    }
    if (
      String(request.request_id ?? '') === requestId
      && request.status === 'passed'
      && request.result_status === 'passed'
      && mailbox.status === 'fresh'
      && mailbox.fresh === true
    ) {
      return last;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(PRODUCTION_E2E_POLL_MS, remaining));
  }
  throw new Error(`controlled_mailbox_proof_timeout: ${JSON.stringify(last)}`);
}

let activeServer: ReturnType<typeof spawnContentLengthMcpServer> | null = null;
let deadlineExceeded = false;

async function main(): Promise<void> {
  if (!authorityEnabled) {
    notRun('production_authority_opt_in_required:NARADA_E2E_SITE_LOOP_PRODUCTION=1');
    return;
  }
  if (!configuredSiteRoot || !configPath) {
    notRun('site_root_required:NARADA_E2E_SITE_LOOP_SITE_ROOT');
    return;
  }
  if (!declaredTaskName) {
    notRun('task_name_required:NARADA_E2E_SITE_LOOP_TASK_NAME', { site_root: configuredSiteRoot });
    return;
  }
  if (!controlledMailboxSource) {
    notRun('controlled_mailbox_source_required:NARADA_E2E_SITE_LOOP_CONTROLLED_MAILBOX_SOURCE', {
      site_root: configuredSiteRoot,
      task_name: declaredTaskName,
    });
    return;
  }
  if (!existsSync(configPath)) {
    notRun('site_loop_config_missing', { site_root: configuredSiteRoot, config_path: configPath });
    return;
  }

  let server: ReturnType<typeof spawnContentLengthMcpServer> | null = null;
  let stderr = '';
  let status: ProductionStatus = 'failed';
  let failureReason: string | null = null;
  let observations: JsonRecord = {
    site_root: configuredSiteRoot,
    task_name: declaredTaskName,
    controlled_mailbox_source: controlledMailboxSource,
  };
  try {
    const serverPath = fileURLToPath(new URL('../src/site-loop-mcp-server.js', import.meta.url));
    server = spawnContentLengthMcpServer(process.execPath, ['--no-warnings', serverPath, '--site-root', configuredSiteRoot], {
      cwd: configuredSiteRoot,
      label: 'site-loop production scheduler/resident/recovery e2e',
      timeoutMs: 130_000,
      closeTimeoutMs: 5_000,
    });
    activeServer = server;
    server.child.stderr.setEncoding('utf8');
    server.child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4_000);
    });

    await runMcpProtocolSmoke(server.client, {
      expectedServerName: 'narada-site-loop-mcp',
      requiredTools: [
        'site_loop_config_validate',
        'site_loop_unified_status',
        'site_loop_recovery_plan',
        'site_loop_proof_status',
        'site_loop_proof_run',
        'site_loop_recovery_drill',
        'site_loop_readiness',
        'site_loop_coherence',
        'site_loop_operating_status',
        'site_loop_output_show',
      ],
    });

    const validation = await toolJson(server.client, 3, 'site_loop_config_validate', {});
    if (validation.status !== 'ok') {
      throw new ProductionNotRunError('site_loop_config_invalid', {
        site_root: configuredSiteRoot,
        config_path: configPath,
        validation,
      });
    }

    const statusArgs = { task_name: declaredTaskName };
    const unifiedBefore = await toolJson(server.client, 4, 'site_loop_unified_status', statusArgs);
    assert.equal(unifiedBefore.status, 'ok', JSON.stringify(unifiedBefore));
    const scheduledBefore = (unifiedBefore.scheduled_task ?? {}) as JsonRecord;
    if (scheduledBefore.status !== 'ok') {
      throw new ProductionNotRunError('production_scheduler_prerequisite_unavailable', {
        site_root: configuredSiteRoot,
        task_name: declaredTaskName,
        scheduled_task: scheduledBefore,
        unified_status: unifiedBefore,
      });
    }

    const recoveryPlanBefore = await toolJson(server.client, 5, 'site_loop_recovery_plan', { ...statusArgs, include_commands: true });
    assert.equal(recoveryPlanBefore.status, 'ok', JSON.stringify(recoveryPlanBefore));
    assert.equal(recoveryPlanBefore.read_only, true, JSON.stringify(recoveryPlanBefore));
    assert.equal(recoveryPlanBefore.mutation_performed, false, JSON.stringify(recoveryPlanBefore));
    assert.equal(Array.isArray(recoveryPlanBefore.recommended_order), true, JSON.stringify(recoveryPlanBefore));
    assert.equal((recoveryPlanBefore.recommended_order as unknown[]).length > 0, true, JSON.stringify(recoveryPlanBefore));

    const proofBefore = await toolJson(server.client, 6, 'site_loop_proof_status', {});
    assert.equal(['missing_or_stale', 'fresh'].includes(String(proofBefore.status)), true, JSON.stringify(proofBefore));
    const drillId = `site-loop-production-e2e-${Date.now()}`;
    const recoveryDrill = await toolJson(server.client, 7, 'site_loop_recovery_drill', {
      id: drillId,
      reason: 'site_loop_production_e2e_recovery_drill',
      title: 'Site Loop production E2E recovery drill',
      summary: 'MCP E2E proof after retiring the current resident carrier.',
      timeout_ms: 120_000,
      poll_ms: 5_000,
    });
    assert.equal(recoveryDrill.status, 'production_passed', JSON.stringify(recoveryDrill));
    assert.equal(recoveryDrill.accepted_work, true, JSON.stringify(recoveryDrill));
    assert.equal(recoveryDrill.production_proof, true, JSON.stringify(recoveryDrill));
    const drillProof = recoveryDrill.proof as JsonRecord;
    assert.equal(drillProof.directive_emitted, true, JSON.stringify(recoveryDrill));
    assert.equal(drillProof.carrier_receipt_observed, true, JSON.stringify(recoveryDrill));
    assert.equal(drillProof.task_report_observed, true, JSON.stringify(recoveryDrill));
    assert.equal(drillProof.production_task_report_observed, true, JSON.stringify(recoveryDrill));
    assert.equal((recoveryDrill.retired as JsonRecord).status, 'retired', JSON.stringify(recoveryDrill));
    assert.equal(['launch_requested', 'already_available'].includes(String((recoveryDrill.replacement as JsonRecord).status)), true, JSON.stringify(recoveryDrill));
    assert.equal((recoveryDrill.cleanup as JsonRecord).status, 'removed', JSON.stringify(recoveryDrill));
    const beforeCarrier = (recoveryDrill.before as JsonRecord).carrier as JsonRecord;
    const afterCarrier = (recoveryDrill.after as JsonRecord).carrier as JsonRecord;
    assert.ok(String(beforeCarrier.carrierSessionId), JSON.stringify(recoveryDrill));
    assert.ok(String(afterCarrier.carrierSessionId), JSON.stringify(recoveryDrill));
    assert.notEqual(afterCarrier.carrierSessionId, beforeCarrier.carrierSessionId, JSON.stringify(recoveryDrill));

    const mailboxProofStart = await toolJson(server.client, 8, 'site_loop_proof_run', {
      proof_kind: 'controlled_mailbox',
      controlled_mailbox_source: controlledMailboxSource,
      ensure_resident: true,
      require_live_carrier: true,
      timeout_ms: 120_000,
      poll_ms: PRODUCTION_E2E_POLL_MS,
      wait_for_completion: false,
    });
    assert.equal(mailboxProofStart.status, 'started', JSON.stringify(mailboxProofStart));
    assert.ok(String(mailboxProofStart.request_id), JSON.stringify(mailboxProofStart));
    const mailboxProof = await waitForControlledMailboxProof(
      server.client,
      String(mailboxProofStart.request_id),
      Date.now() + PRODUCTION_E2E_DEADLINE_MS,
    );
    const mailboxProofStatus = (mailboxProof.mailbox_proof ?? {}) as JsonRecord;
    const mailboxRequest = (mailboxProofStatus.request ?? {}) as JsonRecord;
    assert.equal(mailboxRequest.status, 'passed', JSON.stringify(mailboxProof));
    assert.equal(mailboxRequest.result_status, 'passed', JSON.stringify(mailboxProof));
    assert.equal(mailboxProofStatus.status, 'fresh', JSON.stringify(mailboxProof));
    assert.equal(mailboxProofStatus.fresh, true, JSON.stringify(mailboxProof));

    const operatingAfter = await toolJson(server.client, 9, 'site_loop_operating_status', { limit: 25 });
    const operatingMailboxProof = (operatingAfter.mailbox_proof ?? {}) as JsonRecord;
    const mailboxRecord = (operatingMailboxProof.proof ?? {}) as JsonRecord;
    assert.equal(mailboxRecord.status, 'passed', JSON.stringify(operatingAfter));
    assert.equal(mailboxRecord.mode, 'mailbox_live_unattended', JSON.stringify(operatingAfter));
    assert.equal(mailboxRecord.mailbox_proof, true, JSON.stringify(operatingAfter));
    assert.equal(mailboxRecord.live_unattended_proven, true, JSON.stringify(operatingAfter));
    assert.equal(mailboxRecord.production_proof, true, JSON.stringify(operatingAfter));
    const mailboxMaterialization = (mailboxRecord.mailbox_materialization ?? {}) as JsonRecord;
    assert.equal(mailboxMaterialization.controlled_source, controlledMailboxSource, JSON.stringify(operatingAfter));
    const controlledSourceStatus = (mailboxMaterialization.controlled_source_status ?? {}) as JsonRecord;
    assert.equal(controlledSourceStatus.status, 'matched_new_directive', JSON.stringify(operatingAfter));
    assert.equal(Number(mailboxMaterialization.new_directive_count) > 0, true, JSON.stringify(operatingAfter));
    assert.equal(Number(mailboxMaterialization.bridge_errors ?? 0), 0, JSON.stringify(operatingAfter));

    const unifiedAfter = await toolJson(server.client, 10, 'site_loop_unified_status', statusArgs);
    assert.equal(unifiedAfter.status, 'ok', JSON.stringify(unifiedAfter));
    assert.equal((unifiedAfter.scheduled_task as JsonRecord).status, 'ok', JSON.stringify(unifiedAfter));

    const readiness = await toolJson(server.client, 11, 'site_loop_readiness', { require_production: true });
    assert.equal(gate(readiness, 'resident_carrier').status, 'ok', JSON.stringify(readiness));
    assert.equal(gate(readiness, 'production_runtime').status, 'ok', JSON.stringify(readiness));

    const coherence = await toolJson(server.client, 12, 'site_loop_coherence', {
      require_production: true,
      require_mailbox_chain: true,
    });
    assert.equal(coherence.status, 'coherent', JSON.stringify(coherence));
    assert.equal((coherence.required as JsonRecord).production_runtime, true, JSON.stringify(coherence));
    assert.equal((coherence.required as JsonRecord).mailbox_proof, true, JSON.stringify(coherence));

    const proofAfter = await toolJson(server.client, 13, 'site_loop_proof_status', {});
    assert.equal((proofAfter.production_proof as JsonRecord).status, 'fresh', JSON.stringify(proofAfter));
    assert.equal((proofAfter.production_proof as JsonRecord).fresh, true, JSON.stringify(proofAfter));
    assert.equal((proofAfter.mailbox_proof as JsonRecord).status, 'fresh', JSON.stringify(proofAfter));
    assert.equal((proofAfter.mailbox_proof as JsonRecord).fresh, true, JSON.stringify(proofAfter));

    const recoveryPlanAfter = await toolJson(server.client, 14, 'site_loop_recovery_plan', { ...statusArgs, include_commands: true });
    assert.equal(recoveryPlanAfter.status, 'ok', JSON.stringify(recoveryPlanAfter));
    assert.equal(recoveryPlanAfter.read_only, true, JSON.stringify(recoveryPlanAfter));
    assert.equal(recoveryPlanAfter.mutation_performed, false, JSON.stringify(recoveryPlanAfter));
    assert.equal(stderr.trim(), '', `site-loop MCP stderr: ${stderr}`);

    status = 'passed';
    observations = {
      site_root: configuredSiteRoot,
      task_name: declaredTaskName,
      controlled_mailbox_source: controlledMailboxSource,
      validation,
      scheduler_before: unifiedBefore.scheduled_task,
      scheduler_after: unifiedAfter.scheduled_task,
      recovery_plan_before: recoveryPlanBefore,
      recovery_plan_after: recoveryPlanAfter,
      proof_before: proofBefore,
      recovery_drill: recoveryDrill,
      mailbox_proof_start: mailboxProofStart,
      mailbox_proof: mailboxProof,
      operating_after: operatingAfter,
      readiness,
      coherence,
      proof_after: proofAfter,
    };
    evidence.update({
      status,
      external_authority: 'declared_production_site',
      provider_boundary: 'configured_production_scheduler_resident_and_connector',
      ...observations,
    });
  } catch (error) {
    if (error instanceof ProductionNotRunError) {
      status = 'not_run';
      failureReason = null;
      observations = {
        ...observations,
        reason_code: error.reasonCode,
        ...error.details,
      };
      evidence.update({ status, external_authority: 'not_run', ...observations });
    } else {
      failureReason = deadlineExceeded
        ? 'production_e2e_deadline_exceeded'
        : error instanceof Error ? error.stack ?? error.message : String(error);
      evidence.update({ status, failure_reason: failureReason, stderr, ...observations });
    }
  } finally {
    if (server) await server.close();
    activeServer = null;
    const result = {
      schema: 'narada.site_loop.production_e2e.result.v1',
      test_id: TEST_ID,
      status,
      authority: 'A1',
      authority_scope: 'explicitly_admitted_site_root',
      external_authority: status === 'not_run' ? 'not_run' : 'declared_production_site',
      provider_boundary: 'configured_production_scheduler_resident_and_connector',
      artifact_path: resultPath,
      failure_reason: failureReason,
      reason_code: status === 'not_run' ? observations.reason_code ?? null : null,
      stderr,
      ...observations,
      cleanup: 'completed_after_finally',
    };
    evidence.finalize(result);
    console.log(JSON.stringify(result));
    process.exitCode = status === 'passed' ? 0 : status === 'not_run' ? 2 : 1;
  }
}

let watchdog: NodeJS.Timeout | null = null;
try {
  watchdog = setTimeout(() => {
    deadlineExceeded = true;
    if (activeServer) void activeServer.close();
  }, PRODUCTION_E2E_DEADLINE_MS);
  await main();
} finally {
  if (watchdog) clearTimeout(watchdog);
}
