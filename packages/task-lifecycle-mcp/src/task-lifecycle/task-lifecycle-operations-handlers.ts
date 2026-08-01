import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireTaskTagsArray } from '@narada-core/task-governance-core/task-tags';
import { resolveFreshServerPath } from './fresh-server-path.js';

export const TASK_LIFECYCLE_OPERATIONS_TOOL_NAMES: any = Object.freeze([
  "task_lifecycle_submit_observation",
  "task_lifecycle_evidence_supersede",
  "task_lifecycle_bridge_poll",
  "task_lifecycle_inbox_target",
  "task_lifecycle_tags_update",
  "task_lifecycle_set_routing",
  "task_lifecycle_test_mcp_tool",
  "task_lifecycle_run_tests"
]);

export function createTaskLifecycleOperationsHandlers(context: any) {
  const {
    store,
    siteRoot,
    jsonToolResult,
    stringField,
    numberField,
    booleanField,
    nullableStringField,
    enforceSessionIdentity,
    pollInboxBridge,
    targetInboxEnvelope,
    roleExistsInRoster,
    agentExistsWithRole,
    resolveAgentRoleWithDiagnostics,
    ensureTaskRoutingTables,
    getTaskRouting,
    findTaskFile,
    readTaskFile,
    writeTaskProjection,
    getSitePolicy,
    testMcpTool,
    testTargetsForSelector,
    randomUUID,
  } = context;

  async function dispatchOperationsTool(canonicalName: any, args: any, dispatchContext : any= {}) {
    switch (canonicalName) {
    case 'task_lifecycle_submit_observation': {
      const taskNumber: any = numberField(args, 'task_number');
      const artifactUri: any = stringField(args, 'artifact_uri');
      const content: any = args.content;
      if (!artifactUri) throw new Error('artifact_uri_required');
      const taskId: any = taskNumber ? store.getLifecycleByNumber(taskNumber)?.task_id : null;
      const artifactId: any = randomUUID();
      const admittedView: any = JSON.stringify(content ?? {});
      store.upsertObservationArtifact({
        artifact_id: artifactId,
        artifact_type: 'observation',
        source_operator: stringField(args, 'source_operator') ?? 'mcp_agent',
        task_id: taskId ?? null,
        task_number: taskNumber ?? null,
        agent_id: stringField(args, 'agent_id') ?? null,
        artifact_uri: artifactUri,
        digest: artifactId.slice(0, 16),
        admitted_view_json: admittedView,
        created_at: new Date().toISOString(),
      });
      return jsonToolResult({ status: 'submitted', artifact_id: artifactId, artifact_uri: artifactUri });
    }

    case 'task_lifecycle_evidence_supersede': {
      const taskNumber: any = numberField(args, 'task_number');
      const agentId: any = stringField(args, 'agent_id');
      const supersedesReportId: any = stringField(args, 'supersedes_report_id');
      const artifactUri: any = stringField(args, 'artifact_uri');
      const summary: any = stringField(args, 'summary');
      const verificationSummary: any = stringField(args, 'verification_summary');
      const noFilesChanged: any = booleanField(args, 'no_files_changed') ?? false;
      const changedFiles: any = args.changed_files === undefined
        ? []
        : Array.isArray(args.changed_files)
          && args.changed_files.length > 0
          && args.changed_files.every((value: any) => typeof value === 'string' && value.trim())
          ? args.changed_files
          : null;
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      if (!supersedesReportId) throw new Error('supersedes_report_id_required');
      if (!artifactUri) throw new Error('artifact_uri_required');
      if (!summary) throw new Error('summary_required');
      if (!verificationSummary) throw new Error('verification_summary_required');
      if (changedFiles === null) throw new Error('changed_files_must_be_nonempty_string_array');
      if (noFilesChanged === (changedFiles.length > 0)) throw new Error('exactly_one_of_changed_files_or_no_files_changed_required');
      enforceSessionIdentity(agentId);
      const lifecycle: any = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
      if (lifecycle.status !== 'in_review') {
        return jsonToolResult({
          status: 'blocked',
          reason: 'evidence_supersession_requires_in_review',
          task_number: taskNumber,
          current_status: lifecycle.status,
          remediation: 'Use task_lifecycle_finish for active work or task_lifecycle_reopen for closed/confirmed work before submitting replacement evidence.',
        }, true);
      }
      const report: any = store.db.prepare('SELECT report_id FROM task_reports WHERE task_id = ? AND report_id = ?').get(lifecycle.task_id, supersedesReportId);
      if (!report) {
        return jsonToolResult({
          status: 'blocked',
          reason: 'superseded_report_not_found_for_task',
          task_number: taskNumber,
          supersedes_report_id: supersedesReportId,
        }, true);
      }
      const artifactId: any = randomUUID();
      const supersession: any = {
        schema: 'narada.task.evidence_supersession.v1',
        task_number: taskNumber,
        supersedes_report_id: supersedesReportId,
        summary,
        changed_files: changedFiles,
        no_files_changed: noFilesChanged,
        verification_summary: verificationSummary,
        submitted_at: new Date().toISOString(),
      };
      store.upsertObservationArtifact({
        artifact_id: artifactId,
        artifact_type: 'evidence_supersession',
        source_operator: 'task_lifecycle_evidence_supersede',
        task_id: lifecycle.task_id,
        task_number: taskNumber,
        agent_id: agentId,
        artifact_uri: artifactUri,
        digest: artifactId.slice(0, 16),
        admitted_view_json: JSON.stringify(supersession),
        created_at: supersession.submitted_at,
      });
      return jsonToolResult({
        status: 'superseded',
        task_number: taskNumber,
        artifact_id: artifactId,
        artifact_uri: artifactUri,
        current_execution_evidence: supersession,
        reviewer_action: 'Review current_execution_evidence instead of the superseded report; this does not close or confirm the task.',
      });
    }

    case 'task_lifecycle_bridge_poll': {
      const dryRun: any = booleanField(args, 'dry_run') ?? false;
      const threshold: any = numberField(args, 'threshold');
      const limit: any = numberField(args, 'limit');
      const result: any = await pollInboxBridge(siteRoot, { dryRun, threshold, limit });
      return jsonToolResult(result, result.status === 'error');
    }

    case 'task_lifecycle_inbox_target': {
      const envelopeId: any = stringField(args, 'envelope_id');
      const dryRun: any = booleanField(args, 'dry_run') ?? false;
      const disposition: any = stringField(args, 'disposition') ?? 'materialize';
      const principal: any = stringField(args, 'principal') ?? stringField(args, 'agent_id') ?? 'task_lifecycle_mcp';
      const reason: any = stringField(args, 'reason');
      const result: any = await targetInboxEnvelope(siteRoot, { envelopeId, dryRun, disposition, principal, reason });
      return jsonToolResult(result, result.status === 'not_found');
    }

    case 'task_lifecycle_tags_update': {
      const taskNumber: any = numberField(args, 'task_number');
      const agentId: any = stringField(args, 'agent_id');
      const reason: any = stringField(args, 'reason');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      if (!reason) throw new Error('reason_required');
      const tags: any = requireTaskTagsArray(args.tags);
      enforceSessionIdentity(agentId);
      const lifecycle: any = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
      const roleResolution: any = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
      const actorRole: any = roleResolution.role;
      const activeAssignment: any = store.getActiveAssignment(lifecycle.task_id);
      const isTaskOwner: any = activeAssignment?.agent_id === agentId;
      const isOperator: any = actorRole === 'architect' || actorRole === 'operator';
      if (!isTaskOwner && !isOperator) {
        return jsonToolResult({
          schema: 'narada.task.tags.v0',
          status: 'blocked',
          reason: 'tag_update_actor_not_authorized',
          task_number: taskNumber,
          task_id: lifecycle.task_id,
          actor_agent_id: agentId,
          actor_role: actorRole,
          role_resolution: roleResolution,
          active_assignment_agent_id: activeAssignment?.agent_id ?? null,
          message: 'Tag updates are allowed for the active task owner or an architect/operator; tags do not alter task routing or authorization.',
        }, true);
      }
      const result: any = store.replaceTaskTags({
        taskId: lifecycle.task_id,
        tags,
        actorAgentId: agentId,
        reason,
        updateId: `tag-${randomUUID()}`,
      });
      let projectionStatus: any = 'not_found';
      let projectionError: any = null;
      try {
        const taskFile: any = await findTaskFile(siteRoot, taskNumber);
        if (taskFile) {
          const { frontMatter, body } = await readTaskFile(taskFile.path);
          if (result.tags.length > 0) frontMatter.tags = result.tags.join(', ');
          else delete frontMatter.tags;
          await writeTaskProjection(taskFile.path, frontMatter, body);
          projectionStatus = 'projected';
        }
      } catch (error: any) {
        projectionStatus = 'failed';
        projectionError = error instanceof Error ? error.message : String(error);
      }
      return jsonToolResult({
        schema: 'narada.task.tags.v0',
        ...result,
        actor_role: actorRole,
        active_assignment_agent_id: activeAssignment?.agent_id ?? null,
        projection_status: projectionStatus,
        projection_repair_required: projectionStatus === 'failed',
        projection_error: projectionError,
        projection_repair_action: projectionStatus === 'failed'
          ? 'Retry task_lifecycle_tags_update with the same complete tag set after resolving the projection error.'
          : null,
      });
    }

    case 'task_lifecycle_set_routing': {
      const taskNumber: any = numberField(args, 'task_number');
      const actorAgentId: any = stringField(args, 'actor_agent_id');
      const targetRole: any = nullableStringField(args, 'target_role');
      const preferredAgentId: any = nullableStringField(args, 'preferred_agent_id');
      const relativePriority: any = numberField(args, 'relative_priority');
      const reason: any = stringField(args, 'reason');
      if (!taskNumber) throw new Error('task_number_required');
      if (!actorAgentId) throw new Error('actor_agent_id_required');
      if (!reason) throw new Error('reason_required');
      if (targetRole === undefined && preferredAgentId === undefined && relativePriority === undefined) {
        throw new Error('routing_change_required');
      }
      enforceSessionIdentity(actorAgentId);

      if (targetRole !== undefined && targetRole !== null && !getSitePolicy().policy.roster.roles_are_obligation_targets) {
        return jsonToolResult({
          status: 'blocked',
          reason: 'roles_are_obligation_targets_false',
          target_role: targetRole,
          message: 'Role-targeted routing is disabled by site task-lifecycle policy. Clearing target_role remains allowed.',
          site_policy: {
            roster: {
              roles_are_obligation_targets: false,
            },
          },
        }, true);
      }

      const lifecycle: any = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
      if (lifecycle.status !== 'opened') {
        return jsonToolResult({
          status: 'blocked',
          reason: 'task_not_opened',
          task_number: taskNumber,
          current_status: lifecycle.status,
          message: 'Routing is only allowed for opened tasks; claim/finish ownership gates remain separate.',
        }, true);
      }

      const actorRoleResolution: any = resolveAgentRoleWithDiagnostics(store, siteRoot, actorAgentId);
      const actorRole: any = actorRoleResolution.role;
      if (!['architect', 'operator'].includes(actorRole)) {
        return jsonToolResult({
          status: 'blocked',
          reason: 'routing_actor_not_authorized',
          actor_agent_id: actorAgentId,
          actor_role: actorRole,
          role_resolution: actorRoleResolution,
          message: 'Only architect/operator agents can route tasks through this tool.',
        }, true);
      }

      if (targetRole && !roleExistsInRoster(store, siteRoot, targetRole)) {
        return jsonToolResult({ status: 'blocked', reason: 'target_role_not_in_roster', target_role: targetRole }, true);
      }

      if (preferredAgentId) {
        const preferred: any = agentExistsWithRole(store, siteRoot, preferredAgentId);
        if (!preferred.exists) {
          return jsonToolResult({ status: 'blocked', reason: 'preferred_agent_not_in_roster', preferred_agent_id: preferredAgentId, role_resolution: preferred.role_resolution }, true);
        }
        if (targetRole && preferred.role !== targetRole) {
          return jsonToolResult({
            status: 'blocked',
            reason: 'preferred_agent_role_mismatch',
            preferred_agent_id: preferredAgentId,
            preferred_agent_role: preferred.role,
            target_role: targetRole,
            role_resolution: preferred.role_resolution,
          }, true);
        }
      }

      ensureTaskRoutingTables(store);
      const now: any = new Date().toISOString();
      const previousRouting: any = getTaskRouting(store, lifecycle.task_id);
      const nextRouting: any = {
        target_role: targetRole !== undefined ? targetRole : previousRouting.target_role,
        preferred_agent_id: preferredAgentId !== undefined ? preferredAgentId : previousRouting.preferred_agent_id,
        relative_priority: relativePriority !== undefined ? relativePriority : previousRouting.relative_priority,
      };
      const changedFields: any = {};
      for (const field of ['target_role', 'preferred_agent_id', 'relative_priority']) {
        if (previousRouting[field] !== nextRouting[field]) {
          changedFields[field] = { before: previousRouting[field], after: nextRouting[field] };
        }
      }
      if (Object.keys(changedFields).length === 0) {
        return jsonToolResult({
          schema: 'narada.task.routing.v0',
          status: 'unchanged',
          task_number: taskNumber,
          task_id: lifecycle.task_id,
          routing: nextRouting,
        });
      }

      store.db.exec('BEGIN');
      try {
        store.db.prepare(`
          INSERT INTO narada_andrey_task_role_preferences (task_id, preferred_role, target_role, preferred_agent_id, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            preferred_role = excluded.preferred_role,
            target_role = excluded.target_role,
            preferred_agent_id = excluded.preferred_agent_id,
            updated_at = excluded.updated_at
        `).run(lifecycle.task_id, nextRouting.target_role, nextRouting.target_role, nextRouting.preferred_agent_id, now);
        store.db.prepare(`
          UPDATE task_lifecycle
          SET relative_priority = ?, priority_reason = ?, updated_at = ?
          WHERE task_id = ?
        `).run(nextRouting.relative_priority, reason, now, lifecycle.task_id);
        const eventId: any = `route-${randomUUID()}`;
        store.db.prepare(`
          INSERT INTO task_routing_events (
            event_id, task_id, task_number, actor_agent_id, actor_role,
            reason, changed_fields_json, previous_routing_json, new_routing_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          eventId,
          lifecycle.task_id,
          taskNumber,
          actorAgentId,
          actorRole,
          reason,
          JSON.stringify(changedFields),
          JSON.stringify(previousRouting),
          JSON.stringify(nextRouting),
          now,
        );
        store.db.exec('COMMIT');

        try {
          const taskFile: any = await findTaskFile(siteRoot, taskNumber);
          if (taskFile) {
            const { frontMatter, body } = await readTaskFile(taskFile.path);
            if (nextRouting.target_role) {
              frontMatter.target_role = nextRouting.target_role;
              frontMatter.preferred_role = nextRouting.target_role;
            } else {
              delete frontMatter.target_role;
              delete frontMatter.preferred_role;
            }
            if (nextRouting.preferred_agent_id) {
              frontMatter.preferred_agent_id = nextRouting.preferred_agent_id;
            } else {
              delete frontMatter.preferred_agent_id;
            }
            const shouldProjectPriority: any = nextRouting.relative_priority !== null
              && nextRouting.relative_priority !== undefined
              && (
                relativePriority !== undefined
                || Object.prototype.hasOwnProperty.call(frontMatter, 'relative_priority')
                || nextRouting.relative_priority !== 0
              );
            if (shouldProjectPriority) {
              frontMatter.relative_priority = nextRouting.relative_priority;
            } else {
              delete frontMatter.relative_priority;
            }
            await writeTaskProjection(taskFile.path, frontMatter, body);
          }
        } catch {
          // Projection write is compatibility-only; SQLite routing state is authoritative.
        }

        return jsonToolResult({
          schema: 'narada.task.routing.v0',
          status: 'routed',
          task_number: taskNumber,
          task_id: lifecycle.task_id,
          actor_agent_id: actorAgentId,
          actor_role: actorRole,
          reason,
          changed_fields: changedFields,
          routing: nextRouting,
          audit_event_id: eventId,
        });
      } catch (error: any) {
        try { store.db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
        throw error;
      }
    }

    case 'task_lifecycle_test_mcp_tool': {
      const serverPath: any = stringField(args, 'server_path');
      const toolName: any = stringField(args, 'tool_name');
      const toolArgs: any = args.arguments ?? {};
      const timeoutSeconds: any = numberField(args, 'timeout_seconds');
      if (!serverPath) throw new Error('server_path_required');
      if (!toolName) throw new Error('tool_name_required');

      const admission: any = resolveFreshServerPath({
        siteRoot,
        serverPath,
        runtimeModulePath: fileURLToPath(import.meta.url),
      });
      if (admission.status === 'refused') {
        return jsonToolResult({
          schema: 'narada.task_lifecycle.fresh_server_path_admission.v1',
          status: 'refused',
          error: admission.reason,
          server_path_admission: admission,
          remediation: 'Use a site-root-relative MCP server script, a script under the running @narada-core/task-lifecycle-mcp package root, or configure an explicit root with NARADA_TASK_LIFECYCLE_FRESH_SERVER_ALLOWED_ROOTS.',
        }, true);
      }
      const result: any = await testMcpTool(siteRoot, admission.resolved_path, toolName, toolArgs, { timeoutSeconds });
      const payload: any = result && typeof result === 'object' && !Array.isArray(result)
        ? { ...result, server_path_admission: admission }
        : { status: 'ok', result, server_path_admission: admission };
      return jsonToolResult(payload);
    }
    case 'task_lifecycle_run_tests': {
      const selector: any = stringField(args, 'selector') || 'task-lifecycle';
      const taskNumber: any = numberField(args, 'task_number');
      const agentId: any = stringField(args, 'agent_id');
      const timeoutSeconds: any = numberField(args, 'timeout_seconds') || 120;
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const lifecycle: any = taskNumber ? store.getLifecycleByNumber(taskNumber) : null;
      if (taskNumber && !lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
      const targets: any = testTargetsForSelector(selector);
      const results: any[] = [];
      const testServer: any = resolveTestMcpServerPath(siteRoot);
      if (!testServer.found) {
        return jsonToolResult({
          schema: 'narada.task_lifecycle.run_tests.v0',
          status: 'blocked',
          error: 'test_mcp_site_binding_invalid',
          selector,
          task_number: taskNumber ?? null,
          task_id: lifecycle?.task_id ?? null,
          agent_id: agentId,
          site_binding: testServer.binding,
          configured_test_server_path: testServer.primary,
          candidate_test_server_paths: testServer.candidates,
          remediation: 'Set NARADA_TASK_LIFECYCLE_TEST_ROOT to the Site or workspace that owns the Test MCP server, or run package/root tests through structured-command and submit the resulting execution refs as evidence. Do not interpret missing/stale paths under the current task-lifecycle root as failed implementation evidence.',
        }, true);
      }
      for (const target of targets) {
        try {
          const result: any = await testMcpTool(testServer.root, testServer.path, 'run_test', target, { timeoutSeconds, agentId });
          results.push(result);
        } catch (error: any) {
          const diagnostic: any = error instanceof Error ? error.message : String(error);
          results.push({
            status: 'failed',
            error: 'test_mcp_execution_failed',
            target,
            test_server_path: testServer.path,
            site_binding: testServer.binding,
            diagnostic,
            remediation: 'Verify the configured Test MCP server path and restart the task-lifecycle session with the requested agent identity before retrying.',
          });
        }
      }
      const failed: any = results.filter((result: any) => result.status !== 'passed');
      const payload: Record<string, unknown> = {
        schema: 'narada.task_lifecycle.run_tests.v0',
        status: failed.length === 0 ? 'passed' : 'failed',
        selector,
        task_number: taskNumber ?? null,
        task_id: lifecycle?.task_id ?? null,
        agent_id: agentId,
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        results,
      };
      if (taskNumber) {
        const artifactId: any = randomUUID();
        store.upsertObservationArtifact({
          artifact_id: artifactId,
          artifact_type: 'test_result',
          source_operator: agentId,
          task_id: lifecycle.task_id,
          task_number: taskNumber,
          agent_id: agentId,
          artifact_uri: `task://${taskNumber}/test-results/${artifactId}`,
          digest: artifactId.slice(0, 16),
          admitted_view_json: JSON.stringify(payload),
          created_at: new Date().toISOString(),
        });
        payload.artifact_id = artifactId;
      }
      return jsonToolResult(payload, failed.length > 0);
    }

      default:
        throw new Error(`task_mcp_refused: ${canonicalName}`);
    }
  }

  return Object.fromEntries(TASK_LIFECYCLE_OPERATIONS_TOOL_NAMES.map((name: any) => [name, (args: any, dispatchContext: any) => dispatchOperationsTool(name, args, dispatchContext)]));
}

function resolveTestMcpServerPath(siteRoot: any) {
  const candidates: any = [
    'tools/mcp-servers/test/test-mcp-server.mjs',
    'packages/test-mcp-server/dist/test-mcp-server.mjs',
    'tools/mcp-servers/test/test-mcp-server.js',
    'packages/test-mcp-server/dist/test-mcp-server.js',
  ];
  const configuredRoot: any = typeof process.env.NARADA_TASK_LIFECYCLE_TEST_ROOT === 'string'
    && process.env.NARADA_TASK_LIFECYCLE_TEST_ROOT.trim()
    ? resolve(process.env.NARADA_TASK_LIFECYCLE_TEST_ROOT.trim())
    : null;
  const roots: any = configuredRoot
    ? [{ root: configuredRoot, source: 'env:NARADA_TASK_LIFECYCLE_TEST_ROOT' }]
    : [{ root: siteRoot, source: 'task_lifecycle_site_root' }];
  for (const candidateRoot of roots) {
    for (const candidate of candidates) {
      const fullPath: any = resolve(candidateRoot.root, candidate);
      if (existsSync(fullPath)) {
        return {
          found: true,
          root: candidateRoot.root,
          path: candidate,
          primary: resolve(candidateRoot.root, candidates[0]),
          candidates: candidates.map((item: any) => resolve(candidateRoot.root, item)),
          binding: { task_lifecycle_site_root: siteRoot, test_root: candidateRoot.root, source: candidateRoot.source },
        };
      }
    }
  }
  return {
    found: false,
    path: null,
    root: configuredRoot ?? siteRoot,
    primary: resolve(configuredRoot ?? siteRoot, candidates[0]),
    candidates: candidates.map((item: any) => resolve(configuredRoot ?? siteRoot, item)),
    binding: {
      task_lifecycle_site_root: siteRoot,
      test_root: configuredRoot ?? siteRoot,
      source: configuredRoot ? 'env:NARADA_TASK_LIFECYCLE_TEST_ROOT' : 'task_lifecycle_site_root',
      configuration_required: true,
    },
  };
}
