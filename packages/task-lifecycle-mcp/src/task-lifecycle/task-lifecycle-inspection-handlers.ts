import { join } from 'path';
import { existsSync, readFileSync } from 'node:fs';
import { findReviewerCapableAgents } from './operator-identity.js';

export const TASK_LIFECYCLE_INSPECTION_TOOL_NAMES = Object.freeze([
  'task_lifecycle_show',
  'task_lifecycle_inspect',
  'task_lifecycle_inspect_range',
  'task_lifecycle_diagnose_task_ref',
  'task_lifecycle_evidence_preflight',
  'task_lifecycle_audit',
  'task_lifecycle_search',
  'task_lifecycle_related',
]);

export function createTaskLifecycleInspectionHandlers({
  store,
  siteRoot,
  jsonToolResult,
  stringField,
  numberField,
  getSingleOperatorReviewMeta,
  findTaskFile,
  readTaskFile,
  deriveClosureAuthority,
  getTaskRouting,
  inspectTaskEvidence,
  readTaskRouting,
  buildTaskEvidencePreflight,
  buildBlockedTaskReportPosture,
  buildRoutingAssignmentDivergence,
  searchTasksService,
  findRelatedTasks,
}) {
  return {
    task_lifecycle_show: async (args) => {
      const taskNumber = numberField(args, 'task_number');
      if (!taskNumber) throw new Error('task_number_required');
      const lifecycle = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
      const spec = store.getTaskSpec(lifecycle.task_id);
      const routing = getTaskRouting(store, lifecycle.task_id);
      const assignment = store.db.prepare('SELECT * FROM task_assignments WHERE task_id = ? AND released_at IS NULL ORDER BY claimed_at DESC LIMIT 1').get(lifecycle.task_id);
      const observations = store.db.prepare('SELECT * FROM observation_artifacts WHERE task_id = ? ORDER BY created_at DESC').all(lifecycle.task_id);
      const reviewRows = store.db.prepare('SELECT * FROM task_reviews WHERE task_id = ? ORDER BY reviewed_at DESC').all(lifecycle.task_id);
      const assignmentIntents = store.listAssignmentIntentsForTask ? store.listAssignmentIntentsForTask(lifecycle.task_id) : [];
      const reviews = reviewRows.map((review) => ({
        review_id: review.review_id,
        reviewer_agent_id: review.reviewer_agent_id,
        verdict: review.verdict,
        reviewed_at: review.reviewed_at,
        single_operator_meta: getSingleOperatorReviewMeta(review),
      }));
      const eligibleReviewers = lifecycle.status === 'in_review' ? findReviewerCapableAgents(store) : [];
      let body = null;
      try {
        const taskFile = await findTaskFile(siteRoot, String(taskNumber));
        if (taskFile) {
          const fileData = await readTaskFile(taskFile.path);
          body = fileData.body;
        }
      } catch {
        // Missing/unreadable task files should not block SQLite-backed show.
      }
      return jsonToolResult({
        status: 'ok',
        task_number: taskNumber,
        task_id: lifecycle.task_id,
        lifecycle,
        closure_authority: deriveClosureAuthority(lifecycle),
        spec: spec ? { ...spec, target_role: routing.target_role, preferred_agent_id: routing.preferred_agent_id } : null,
        routing,
        active_assignment: assignment ?? null,
        assignment_intents: assignmentIntents,
        observations: observations ?? [],
        reviews: reviews ?? [],
        body,
        eligible_reviewers: eligibleReviewers,
      });
    },

    task_lifecycle_inspect: async (args) => {
      const taskNumber = numberField(args, 'task_number');
      if (!taskNumber) throw new Error('task_number_required');
      const lifecycle = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
      const evidence = await inspectTaskEvidence(siteRoot, String(taskNumber), store);
      const spec = store.getTaskSpecByNumber(taskNumber);
      const assignment = store.getActiveAssignment(lifecycle.task_id);
      const routing = readTaskRouting(store, lifecycle.task_id, spec);
      const obligations = store.listDirectedObligationsForTask(lifecycle.task_id, null);
      const reports = store.db.prepare('SELECT report_id, agent_id, submitted_at as reported_at FROM task_reports WHERE task_id = ?').all(lifecycle.task_id);
      const observations = store.db.prepare('SELECT * FROM observation_artifacts WHERE task_id = ? ORDER BY created_at DESC').all(lifecycle.task_id);
      const reviewRows = store.db.prepare('SELECT * FROM task_reviews WHERE task_id = ? ORDER BY reviewed_at DESC').all(lifecycle.task_id);
      const blockedWorkPosture = buildBlockedTaskReportPosture({ store, lifecycle });
      const assignmentIntents = store.listAssignmentIntentsForTask ? store.listAssignmentIntentsForTask(lifecycle.task_id) : [];

      const reviews = reviewRows.map((review) => ({
        review_id: review.review_id,
        reviewer_agent_id: review.reviewer_agent_id,
        verdict: review.verdict,
        reviewed_at: review.reviewed_at,
        single_operator_meta: getSingleOperatorReviewMeta(review),
      }));
      const eligibleReviewers = lifecycle.status === 'in_review' ? findReviewerCapableAgents(store) : [];
      return jsonToolResult({
        status: 'ok',
        task_number: taskNumber,
        task_id: lifecycle.task_id,
        lifecycle: {
          status: lifecycle.status,
          governed_by: lifecycle.governed_by,
          closed_at: lifecycle.closed_at,
          closed_by: lifecycle.closed_by,
          closure_mode: lifecycle.closure_mode,
          updated_at: lifecycle.updated_at,
        },
        evidence: evidence ? {
          verdict: evidence.verdict,
          all_criteria_checked: evidence.all_criteria_checked,
          unchecked_count: evidence.unchecked_count,
          has_report: evidence.has_report,
          has_execution_notes: evidence.has_execution_notes,
          has_verification: evidence.has_verification,
          violations: evidence.violations,
        } : null,
        evidence_preflight: await buildTaskEvidencePreflight({ siteRoot, store, taskNumber }),
        blocked_work_posture: blockedWorkPosture,
        assignment: assignment ? { agent_id: assignment.agent_id, claimed_at: assignment.claimed_at, intent: assignment.intent } : null,
        routing,
        routing_assignment_divergence: buildRoutingAssignmentDivergence({ lifecycle, routing, assignment, reports }),
        assignment_intents: assignmentIntents,
        reports: reports || [],
        observations: observations || [],
        observation_artifact_count: observations.length,
        reviews: reviews || [],
        obligations: obligations.map((obligation) => ({ obligation_id: obligation.obligation_id, kind: obligation.kind, status: obligation.status })),
        eligible_reviewers: eligibleReviewers,
        schema: 'narada.task.mcp.inspect.v0',
      });
    },

    task_lifecycle_inspect_range: async (args) => {
      const chapterId = stringField(args, 'chapter_id');
      const startTaskNumber = numberField(args, 'start_task_number');
      const endTaskNumber = numberField(args, 'end_task_number');
      const limit = Math.max(1, Math.min(200, numberField(args, 'limit') ?? 50));
      const includeBody = args.include_body === true;
      let rows = [];
      if (chapterId) {
        const chapterTaskNumbers = readChapterTaskNumbers(siteRoot, chapterId).slice(0, limit);
        rows = chapterTaskNumbers.map((taskNumber) => store.getLifecycleByNumber(taskNumber)).filter(Boolean);
      } else {
        if (!startTaskNumber || !endTaskNumber) throw new Error('start_task_number_and_end_task_number_required');
        const low = Math.min(startTaskNumber, endTaskNumber);
        const high = Math.max(startTaskNumber, endTaskNumber);
        rows = store.db.prepare('SELECT * FROM task_lifecycle WHERE task_number >= ? AND task_number <= ? ORDER BY task_number ASC LIMIT ?').all(low, high, limit);
      }
      const tasks = [];
      for (const lifecycle of rows) {
        const taskNumber = lifecycle.task_number;
        const spec = store.getTaskSpecByNumber(taskNumber);
        const evidence = await inspectTaskEvidence(siteRoot, String(taskNumber), store).catch(() => null);
        const evidencePreflight = await buildTaskEvidencePreflight({ siteRoot, store, taskNumber }).catch((error) => ({ status: 'unavailable', error: error instanceof Error ? error.message : String(error) }));
        const closureAuthority = deriveClosureAuthority(lifecycle);
        let body = null;
        if (includeBody) {
          const taskFile = await findTaskFile(siteRoot, String(taskNumber)).catch(() => null);
          body = taskFile ? (await readTaskFile(taskFile.path).catch(() => ({ body: null }))).body : null;
        }
        tasks.push({
          task_number: taskNumber,
          task_id: lifecycle.task_id,
          title: spec?.title ?? null,
          lifecycle: {
            status: lifecycle.status,
            governed_by: lifecycle.governed_by,
            closed_at: lifecycle.closed_at,
            closed_by: lifecycle.closed_by,
            closure_mode: lifecycle.closure_mode,
            reopened_at: lifecycle.reopened_at,
            updated_at: lifecycle.updated_at,
          },
          closure_authority: closureAuthority,
          closure_evidence_posture: closureEvidencePosture({ lifecycle, closureAuthority, evidencePreflight }),
          evidence: evidence ? {
            verdict: evidence.verdict,
            all_criteria_checked: evidence.all_criteria_checked,
            unchecked_count: evidence.unchecked_count,
            has_report: evidence.has_report,
            has_execution_notes: evidence.has_execution_notes,
            has_verification: evidence.has_verification,
            violation_count: Array.isArray(evidence.violations) ? evidence.violations.length : 0,
          } : null,
          evidence_preflight: evidencePreflight,
          ...(includeBody ? { body } : {}),
        });
      }
      return jsonToolResult({
        status: 'ok',
        schema: 'narada.task.mcp.inspect_range.v0',
        query: { chapter_id: chapterId ?? null, start_task_number: startTaskNumber ?? null, end_task_number: endTaskNumber ?? null, limit, include_body: includeBody },
        count: tasks.length,
        read_only: true,
        tasks,
      });
    },

    task_lifecycle_diagnose_task_ref: async (args) => {
      const taskId = stringField(args, 'task_id');
      const taskNumber = numberField(args, 'task_number');
      if (!taskId && !taskNumber) throw new Error('task_id_or_task_number_required');
      const lifecycleById = taskId
        ? store.db.prepare('SELECT * FROM task_lifecycle WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1').get(taskId)
        : null;
      const lifecycleByNumber = taskNumber ? store.getLifecycleByNumber(taskNumber) : null;
      const effectiveNumber = taskNumber ?? lifecycleById?.task_number;
      const numberOwner = effectiveNumber ? store.getLifecycleByNumber(effectiveNumber) : null;
      const taskFile = effectiveNumber ? await findTaskFile(siteRoot, String(effectiveNumber)).catch(() => null) : null;
      const requestedTaskFileMatches = taskFile && taskId ? taskFile.path.includes(taskId) || readTaskFile(taskFile.path).then((file) => file.taskId === taskId).catch(() => false) : null;
      const projectionMatchesRequestedTask = typeof requestedTaskFileMatches?.then === 'function' ? await requestedTaskFileMatches : requestedTaskFileMatches;
      const collision = Boolean(taskId && numberOwner && numberOwner.task_id !== taskId);
      const missingProjection = Boolean(lifecycleById && effectiveNumber && !taskFile);
      const state = !lifecycleById && !lifecycleByNumber
        ? 'not_found'
        : collision
        ? 'task_number_collision'
        : missingProjection
        ? 'missing_projection'
        : projectionMatchesRequestedTask === false
        ? 'projection_mismatch'
        : 'ok';
      return jsonToolResult({
        status: state === 'ok' ? 'ok' : 'attention_needed',
        schema: 'narada.task.ref_diagnostics.v0',
        query: { task_id: taskId ?? null, task_number: taskNumber ?? null },
        state,
        lifecycle_by_task_id: lifecycleById ?? null,
        lifecycle_by_task_number: lifecycleByNumber ?? null,
        number_owner: numberOwner ?? null,
        projection: taskFile ? { exists: true, path: taskFile.path, matches_requested_task: projectionMatchesRequestedTask } : { exists: false, path: effectiveNumber ? join(siteRoot, '.ai', 'do-not-open', 'tasks', `task-${effectiveNumber}.md`) : null },
        collision: collision ? {
          requested_task_id: taskId,
          requested_task_number: effectiveNumber,
          number_owner_task_id: numberOwner.task_id,
          number_owner_status: numberOwner.status,
        } : null,
        repair_guidance: buildTaskRefRepairGuidance({ state, taskId, taskNumber: effectiveNumber, lifecycleById, numberOwner }),
      });
    },

    task_lifecycle_evidence_preflight: async (args) => {
      const taskNumber = numberField(args, 'task_number');
      if (!taskNumber) throw new Error('task_number_required');
      return jsonToolResult(await buildTaskEvidencePreflight({ siteRoot, store, taskNumber }));
    },

    task_lifecycle_audit: (args) => {
      const since = stringField(args, 'since');
      const until = stringField(args, 'until');
      const now = new Date();
      const defaultSince = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const sinceVal = since || defaultSince;
      const untilVal = until || now.toISOString();
      const sql = `
        SELECT 'claim' AS event_type, CAST(ai.task_number AS TEXT) AS task, ai.agent_id AS actor, ai.requested_at AS occurred_at, ai.status AS result, ai.assignment_id AS ref
        FROM assignment_intents ai
        WHERE ai.kind = 'claim' AND ai.requested_at >= ? AND ai.requested_at <= ?
        UNION ALL
        SELECT 'report', CAST(tl.task_number AS TEXT), tr.agent_id, tr.submitted_at, 'submitted', tr.report_id
        FROM task_reports tr
        JOIN task_lifecycle tl ON tl.task_id = tr.task_id
        WHERE tr.submitted_at >= ? AND tr.submitted_at <= ?
        UNION ALL
        SELECT 'review', CAST(tl.task_number AS TEXT), rv.reviewer_agent_id, rv.reviewed_at, rv.verdict, rv.review_id
        FROM task_reviews rv
        JOIN task_lifecycle tl ON tl.task_id = rv.task_id
        WHERE rv.reviewed_at >= ? AND rv.reviewed_at <= ?
        UNION ALL
        SELECT 'admission', CAST(task_number AS TEXT), admitted_by, admitted_at, verdict, admission_id
        FROM evidence_admission_results
        WHERE admitted_at >= ? AND admitted_at <= ?
        UNION ALL
        SELECT 'observation', CAST(COALESCE(task_number, '') AS TEXT), COALESCE(agent_id, source_operator), created_at, 'submitted', artifact_id
        FROM observation_artifacts
        WHERE created_at >= ? AND created_at <= ?
        UNION ALL
        SELECT 'close', CAST(task_number AS TEXT), closed_by, closed_at, closure_mode, task_id
        FROM task_lifecycle
        WHERE closed_at IS NOT NULL AND closed_at >= ? AND closed_at <= ?
        ORDER BY occurred_at DESC
      `;
      const rows = store.db.prepare(sql).all(sinceVal, untilVal, sinceVal, untilVal, sinceVal, untilVal, sinceVal, untilVal, sinceVal, untilVal, sinceVal, untilVal);
      return jsonToolResult({
        status: 'ok',
        schema: 'narada.task.mcp.audit.v0',
        since: sinceVal,
        until: untilVal,
        count: rows.length,
        events: rows,
      });
    },

    task_lifecycle_search: async (args) => {
      const query = stringField(args, 'query');
      const statusFilter = stringField(args, 'status');
      const limit = numberField(args, 'limit') ?? 20;
      if (!query) throw new Error('query_required');
      const result = await searchTasksService({ cwd: siteRoot, query, maxSnippets: 3 });
      const output = result.result || result;
      if (Array.isArray(output.results)) {
        const authoritativeResults = output.results
          .map((item) => annotateSearchResultAuthority(store, item))
          .filter((item) => statusFilter ? item.authority?.status === 'authoritative' && item.status === statusFilter : true);
        output.results = authoritativeResults.slice(0, limit);
        output.count = authoritativeResults.length;
        output.authoritative_result_count = authoritativeResults.filter((item) => item.authority?.status === 'authoritative').length;
        output.stale_result_count = authoritativeResults.filter((item) => item.authority?.status === 'stale_projection').length;
      }
      return jsonToolResult(output, result.exitCode !== 0);
    },

    task_lifecycle_related: (args) => {
      const taskNumber = numberField(args, 'task_number');
      const limit = numberField(args, 'limit') ?? 8;
      if (!taskNumber) throw new Error('task_number_required');
      const result = findRelatedTasks({ tasksDir: join(siteRoot, '.ai', 'do-not-open', 'tasks'), targetTaskNumber: taskNumber, limit });
      return jsonToolResult(result);
    },
  };
}

function annotateSearchResultAuthority(store, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const taskNumber = Number(item.task_number ?? item.taskNumber ?? item.number);
  const lifecycle = Number.isInteger(taskNumber) && taskNumber > 0 ? store.getLifecycleByNumber(taskNumber) : null;
  if (!lifecycle) {
    return {
      ...item,
      authority: {
        status: 'stale_projection',
        resolvable: false,
        remediation: 'This search hit is not present in the authoritative task lifecycle projection; use show/inspect only for authoritative results.',
      },
    };
  }
  return {
    ...item,
    task_id: item.task_id ?? lifecycle.task_id,
    task_number: lifecycle.task_number,
    status: lifecycle.status,
    authority: { status: 'authoritative', resolvable: true },
  };
}

function readChapterTaskNumbers(siteRoot, chapterId) {
  const path = join(siteRoot, '.ai', 'do-not-open', 'task-chapters.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const memberships = parsed?.chapters?.[chapterId]?.memberships;
    if (!Array.isArray(memberships)) return [];
    return memberships
      .map((item) => ({ task_number: Number(item.task_number), order_index: Number(item.order_index ?? 0) }))
      .filter((item) => Number.isInteger(item.task_number) && item.task_number > 0)
      .sort((a, b) => a.order_index - b.order_index || a.task_number - b.task_number)
      .map((item) => item.task_number);
  } catch {
    return [];
  }
}

function closureEvidencePosture({ lifecycle, closureAuthority, evidencePreflight }) {
  const status = String(lifecycle.status ?? '');
  const preflight = evidencePreflight && typeof evidencePreflight === 'object' ? evidencePreflight : {};
  const blockers = Array.isArray(preflight.blockers) ? preflight.blockers : [];
  const closed = status === 'closed' || status === 'confirmed';
  if (closed && closureAuthority?.has_closure_evidence) {
    return {
      state: blockers.length > 0 ? 'closed_with_stale_or_non_authoritative_preflight_debt' : 'closed_current_authority_consistent',
      current_closure_authority_dominates: closureAuthority.closure_dominates === true,
      stale_preflight_blocker_count: blockers.length,
      guidance: blockers.length > 0 ? 'Treat blockers as historical/pre-review unless a fresh reopen or review obligation supersedes closure authority.' : null,
    };
  }
  return {
    state: blockers.length > 0 ? 'open_or_reviewing_with_current_preflight_blockers' : 'open_or_reviewing_without_preflight_blockers',
    current_closure_authority_dominates: false,
    stale_preflight_blocker_count: 0,
    guidance: null,
  };
}

function buildTaskRefRepairGuidance({ state, taskId, taskNumber, lifecycleById, numberOwner }) {
  if (state === 'task_number_collision') {
    return {
      safe_next_tool: 'task_lifecycle_diagnose_task_ref',
      summary: 'Do not report or close out by task_number; it resolves to a different lifecycle task.',
      options: [
        'Retire or mark the upstream directive orphaned in the directive-owning surface using task_id scope.',
        'If the task_id is legitimate, materialize or repair a lifecycle/projection record before dispatch.',
      ],
      evidence: { requested_task_id: taskId, requested_task_number: taskNumber, number_owner_task_id: numberOwner?.task_id },
    };
  }
  if (state === 'missing_projection') {
    return {
      safe_next_tool: 'task_lifecycle_evidence_preflight',
      summary: 'Lifecycle row exists but markdown projection is missing; repair projection before report/closeout.',
      options: ['Regenerate the task projection from lifecycle/spec data if available.', 'Tombstone or reopen through governed lifecycle tools only when operator authority exists.'],
      evidence: { requested_task_id: taskId, requested_task_number: taskNumber, lifecycle_status: lifecycleById?.status },
    };
  }
  if (state === 'projection_mismatch') {
    return {
      safe_next_tool: 'task_lifecycle_show',
      summary: 'The projection resolved by task_number does not appear to describe the requested task_id.',
      options: ['Treat the directive as unsafe to dispatch until directive routing is corrected by task_id.'],
      evidence: { requested_task_id: taskId, requested_task_number: taskNumber },
    };
  }
  if (state === 'not_found') {
    return {
      safe_next_tool: 'task_lifecycle_search',
      summary: 'No lifecycle row was found for the requested task reference.',
      options: ['Search by title/source ref before creating a new task.', 'Retire the directive in its owning queue if it references a nonexistent task_id.'],
    };
  }
  return { summary: 'Task reference is coherent enough for normal lifecycle tools.', safe_next_tool: 'task_lifecycle_show' };
}
