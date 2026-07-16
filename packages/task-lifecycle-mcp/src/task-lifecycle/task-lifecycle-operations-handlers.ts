import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const TASK_LIFECYCLE_OPERATIONS_TOOL_NAMES = Object.freeze([
  "task_lifecycle_submit_observation",
  "task_lifecycle_evidence_supersede",
  "task_lifecycle_bridge_poll",
  "task_lifecycle_inbox_target",
  "task_lifecycle_set_routing",
  "task_lifecycle_test_mcp_tool",
  "task_lifecycle_run_tests"
]);

export function createTaskLifecycleOperationsHandlers(context) {
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

  async function dispatchOperationsTool(canonicalName, args, dispatchContext = {}) {
    switch (canonicalName) {
    case 'task_lifecycle_submit_observation': {
      const taskNumber = numberField(args, 'task_number');
      const artifactUri = stringField(args, 'artifact_uri');
      const content = args.content;
      if (!artifactUri) throw new Error('artifact_uri_required');
      const taskId = taskNumber ? store.getLifecycleByNumber(taskNumber)?.task_id : null;
      const artifactId = randomUUID();
      const admittedView = JSON.stringify(content ?? {});
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
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const supersedesReportId = stringField(args, 'supersedes_report_id');
      const artifactUri = stringField(args, 'artifact_uri');
      const summary = stringField(args, 'summary');
      const verificationSummary = stringField(args, 'verification_summary');
      const noFilesChanged = booleanField(args, 'no_files_changed') ?? false;
      const changedFiles = args.changed_files === undefined
        ? []
        : Array.isArray(args.changed_files)
          && args.changed_files.length > 0
          && args.changed_files.every((value) => typeof value === 'string' && value.trim())
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
      const lifecycle = store.getLifecycleByNumber(taskNumber);
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
      const report = store.db.prepare('SELECT report_id FROM task_reports WHERE task_id = ? AND report_id = ?').get(lifecycle.task_id, supersedesReportId);
      if (!report) {
        return jsonToolResult({
          status: 'blocked',
          reason: 'superseded_report_not_found_for_task',
          task_number: taskNumber,
          supersedes_report_id: supersedesReportId,
        }, true);
      }
      const artifactId = randomUUID();
      const supersession = {
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
      const dryRun = booleanField(args, 'dry_run') ?? false;
      const threshold = numberField(args, 'threshold');
      const limit = numberField(args, 'limit');
      const result = await pollInboxBridge(siteRoot, { dryRun, threshold, limit });
      return jsonToolResult(result, result.status === 'error');
    }

    case 'task_lifecycle_inbox_target': {
      const envelopeId = stringField(args, 'envelope_id');
      const dryRun = booleanField(args, 'dry_run') ?? false;
      const disposition = stringField(args, 'disposition') ?? 'materialize';
      const principal = stringField(args, 'principal') ?? stringField(args, 'agent_id') ?? 'task_lifecycle_mcp';
      const reason = stringField(args, 'reason');
      const result = await targetInboxEnvelope(siteRoot, { envelopeId, dryRun, disposition, principal, reason });
      return jsonToolResult(result, result.status === 'not_found');
    }

    case 'task_lifecycle_set_routing': {
      const taskNumber = numberField(args, 'task_number');
      const actorAgentId = stringField(args, 'actor_agent_id');
      const targetRole = nullableStringField(args, 'target_role');
      const preferredAgentId = nullableStringField(args, 'preferred_agent_id');
      const relativePriority = numberField(args, 'relative_priority');
      const reason = stringField(args, 'reason');
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

      const lifecycle = store.getLifecycleByNumber(taskNumber);
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

      const actorRoleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, actorAgentId);
      const actorRole = actorRoleResolution.role;
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
        const preferred = agentExistsWithRole(store, siteRoot, preferredAgentId);
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
      const now = new Date().toISOString();
      const previousRouting = getTaskRouting(store, lifecycle.task_id);
      const nextRouting = {
        target_role: targetRole !== undefined ? targetRole : previousRouting.target_role,
        preferred_agent_id: preferredAgentId !== undefined ? preferredAgentId : previousRouting.preferred_agent_id,
        relative_priority: relativePriority !== undefined ? relativePriority : previousRouting.relative_priority,
      };
      const changedFields = {};
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
        const eventId = `route-${randomUUID()}`;
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
          const taskFile = await findTaskFile(siteRoot, taskNumber);
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
            const shouldProjectPriority = nextRouting.relative_priority !== null
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
      } catch (error) {
        try { store.db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
        throw error;
      }
    }

    case 'task_lifecycle_test_mcp_tool': {
      const serverPath = stringField(args, 'server_path');
      const toolName = stringField(args, 'tool_name');
      const toolArgs = args.arguments ?? {};
      const timeoutSeconds = numberField(args, 'timeout_seconds');
      if (!serverPath) throw new Error('server_path_required');
      if (!toolName) throw new Error('tool_name_required');

      const result = await testMcpTool(siteRoot, serverPath, toolName, toolArgs, { timeoutSeconds });
      return jsonToolResult(result);
    }
    case 'task_lifecycle_run_tests': {
      const selector = stringField(args, 'selector') || 'task-lifecycle';
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const timeoutSeconds = numberField(args, 'timeout_seconds') || 120;
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const lifecycle = taskNumber ? store.getLifecycleByNumber(taskNumber) : null;
      if (taskNumber && !lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
      const targets = testTargetsForSelector(selector);
      const results = [];
      const testServer = resolveTestMcpServerPath(siteRoot);
      if (!testServer.found) {
        return jsonToolResult({
          schema: 'narada.task_lifecycle.run_tests.v0',
          status: 'failed',
          error: 'test_mcp_server_not_found',
          selector,
          task_number: taskNumber ?? null,
          task_id: lifecycle?.task_id ?? null,
          agent_id: agentId,
          configured_test_server_path: testServer.primary,
          candidate_test_server_paths: testServer.candidates,
          remediation: 'Configure the site Test MCP server path for this workspace or run package/root tests through structured-command and submit the resulting execution refs as evidence.',
        }, true);
      }
      for (const target of targets) {
        try {
          const result = await testMcpTool(siteRoot, testServer.path, 'run_test', target, { timeoutSeconds, agentId });
          results.push(result);
        } catch (error) {
          const diagnostic = error instanceof Error ? error.message : String(error);
          results.push({
            status: 'failed',
            error: 'test_mcp_execution_failed',
            target,
            test_server_path: testServer.path,
            diagnostic,
            remediation: 'Verify the configured Test MCP server path and restart the task-lifecycle session with the requested agent identity before retrying.',
          });
        }
      }
      const failed = results.filter((result) => result.status !== 'passed');
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
        const artifactId = randomUUID();
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

  return Object.fromEntries(TASK_LIFECYCLE_OPERATIONS_TOOL_NAMES.map((name) => [name, (args, dispatchContext) => dispatchOperationsTool(name, args, dispatchContext)]));
}

function resolveTestMcpServerPath(siteRoot) {
  const candidates = [
    'tools/mcp-servers/test/test-mcp-server.mjs',
    'packages/test-mcp-server/dist/test-mcp-server.mjs',
    'tools/mcp-servers/test/test-mcp-server.js',
    'packages/test-mcp-server/dist/test-mcp-server.js',
  ];
  for (const candidate of candidates) {
    const fullPath = resolve(siteRoot, candidate);
    if (existsSync(fullPath)) return { found: true, path: candidate, primary: resolve(siteRoot, candidates[0]), candidates: candidates.map((item) => resolve(siteRoot, item)) };
  }
  return { found: false, path: null, primary: resolve(siteRoot, candidates[0]), candidates: candidates.map((item) => resolve(siteRoot, item)) };
}
