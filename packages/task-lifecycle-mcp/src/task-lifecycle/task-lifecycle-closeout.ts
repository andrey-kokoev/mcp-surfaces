import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'child_process';
import { join, relative, resolve } from 'path';

const NO_FILES_CHANGED_MARKER = '__narada_no_files_changed_declared__';

export function buildStateAwareFinishBlockerRemediation({ taskNumber, agentId, lifecycle, payload }) {
  const summary = String(payload?.summary ?? '').trim();
  const changedFiles = Array.isArray(payload?.changed_files) ? payload.changed_files : [];
  const noFilesChanged = payload?.no_files_changed === true;
  const recoveryTruthfulness = payload?.recovery_truthfulness ?? null;
  return {
    status: 'blocked',
    task_number: taskNumber,
    agent_id: agentId,
    lifecycle_status: lifecycle?.status ?? null,
    summary,
    changed_files: changedFiles,
    no_files_changed: noFilesChanged,
    recovery_truthfulness: recoveryTruthfulness,
    remediation: 'State-aware finish blocked until the task result packet includes evidence that the requested closeout is truthful, scoped, and mechanically supported.',
  };
}

export async function buildTaskEvidencePreflight({ siteRoot, store, taskNumber, findTaskFile, inspectTaskEvidence, buildBlockedTaskReportPosture, buildTaskFileResolutionFailure }) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) {
    return {
      status: 'error',
      error: 'task_not_found',
      task_number: taskNumber,
    };
  }
  const evidence = await inspectTaskEvidence(siteRoot, String(taskNumber), store);
  const taskFile = await findTaskFile(siteRoot, taskNumber);
  const changedFileEvidence = collectChangedFileEvidenceFromReports(evidence.report_records ?? [], evidence.sqlite_reports ?? []);
  const reports = store.listReportRecords ? store.listReportRecords(lifecycle.task_id) : [];
  const sqliteReports = store.listReports ? store.listReports(lifecycle.task_id) : [];
  const verificationRuns = store.listVerificationRunsForTask ? store.listVerificationRunsForTask(lifecycle.task_id) : [];
  const observations = store.db.prepare('SELECT artifact_uri, created_at FROM observation_artifacts WHERE task_id = ? ORDER BY created_at DESC').all(lifecycle.task_id);
  const blockedWorkPosture = buildBlockedTaskReportPosture({ store, lifecycle, changedFileEvidence });
  const blockedWorkNextAction = blockedWorkPosture.state === 'blocked_reported'
    ? 'Blocked report is recorded. Do not finish as complete until blockers are resolved; continue or defer the task instead.'
    : blockedWorkPosture.state === 'stale_blocked_report_superseded'
    ? 'Prior blocked report is superseded by newer completion evidence; continue normal finish/review checks.'
    : 'No blocked-work report currently blocks finish.';
  return {
    status: 'ok',
    schema: 'narada.task.mcp.evidence_preflight.v0',
    task_number: taskNumber,
    task_id: lifecycle.task_id,
    lifecycle_status: lifecycle.status,
    task_file_exists: Boolean(taskFile),
    evidence,
    blocked_work_posture: blockedWorkPosture,
    next_action: blockedWorkNextAction,
    remediation: blockedWorkNextAction,
    report_count: reports.length + sqliteReports.length,
    verification_run_count: verificationRuns.length,
    observation_artifact_count: observations.length,
  };
}

export async function taskLifecycleDispositionCloseout({
  siteRoot,
  store,
  taskNumber,
  agentId,
  envelopeId,
  disposition,
  summary,
  dryRun,
  proveCriteria,
  finish,
  changedFiles: finishChangedFiles,
  noFilesChanged,
  reviewer,
  includeUnrelatedChangedFiles = false,
  findTaskFile,
  buildTaskFileResolutionFailure,
  readIndexedEnvelope,
  inferDisposition,
  relativeSitePath,
  gitVisiblePathSubset,
  validateCapaDispositionCorrectiveCoverage,
  replaceTaskSection,
  extractEnvelopeId,
  refreshInboxIndex,
  evaluateEnvelopeSeverity,
  admitTaskEvidence,
  withAuthoredRosterJsonPreserved,
  finishTaskService,
  evaluatePostTransitionFollowups,
  detectGitChangedFiles,
  scopeChangedFiles,
}) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  const taskFile = await findTaskFile(siteRoot, taskNumber);
  if (!taskFile) return buildTaskFileResolutionFailure({ siteRoot, store, taskNumber, lifecycle, surface: 'task_lifecycle_disposition_closeout' });
  const original = readFileSync(taskFile.path, 'utf8');
  const resolvedEnvelopeId = envelopeId ?? extractEnvelopeId(original);
  const envelope = resolvedEnvelopeId ? readIndexedEnvelope(siteRoot, resolvedEnvelopeId, refreshInboxIndex, evaluateEnvelopeSeverity) : null;
  const envelopeStatus = envelope?.status ?? null;
  const inferredDisposition = disposition ?? inferDisposition(envelopeStatus);
  const changedFiles = [relativeSitePath(siteRoot, taskFile.path)];
  const gitVisibleChangedFiles = gitVisiblePathSubset(siteRoot, changedFiles);
  const now = new Date().toISOString();
  const executionNotes = [
    `- Close-out workflow: \`task_lifecycle_disposition_closeout\` invoked by \`${agentId}\` at ${now}.`,
    resolvedEnvelopeId ? `- Envelope: \`${resolvedEnvelopeId}\` (${envelopeStatus ?? 'not_found'}).` : '- Envelope: none detected in task body.',
    envelope?.title ? `- Envelope title: ${envelope.title}` : null,
    `- Disposition: ${inferredDisposition}.`,
    summary ? `- Summary: ${summary}` : null,
  ].filter(Boolean).join('\n');
  const verificationNotes = [
    `- Inbox index refreshed through \`refreshInboxIndex\`; envelope status resolved as \`${envelopeStatus ?? 'not_found'}\`.`,
    '- Scoped changed-file list returned by the workflow for commit planning.',
    proveCriteria ? '- Acceptance criteria proof requested after note materialization.' : '- Acceptance criteria proof not requested by this invocation.',
    finish ? '- Finish requested after note materialization.' : '- Finish not requested by this invocation.',
  ].join('\n');
  const plannedContent = replaceTaskSection(replaceTaskSection(original, 'Execution Notes', executionNotes), 'Verification', verificationNotes);
  const capaCoverageValidation = validateCapaDispositionCorrectiveCoverage({ envelope, body: plannedContent, store });
  if (!capaCoverageValidation.ok) {
    return {
      status: dryRun ? 'dry_run_blocked' : 'blocked',
      error: 'capa_corrective_action_coverage_required',
      schema: 'narada.task.mcp.disposition_closeout.capa_corrective_coverage_gate.v0',
      task_number: taskNumber,
      task_id: lifecycle.task_id,
      envelope: resolvedEnvelopeId ? {
        envelope_id: resolvedEnvelopeId,
        status: envelopeStatus ?? 'not_found',
        title: envelope?.title ?? null,
        kind: envelope?.kind ?? null,
        received_at: envelope?.received_at ?? null,
      } : null,
      close_blocked: true,
      close_blockers: capaCoverageValidation.errors,
      capa_corrective_action_coverage: capaCoverageValidation,
      remediation: 'Add a top-level ## Follow-Up Ledger entry that links the CAPA corrective action to an active implementation task (`created #N` or `covered by #N`), records `deferred:` / blocker rationale, or records `no follow-up needed:` with admitted no-action rationale. Closed audit/disposition tasks alone do not count as corrective-action coverage.',
    };
  }
  let criteriaResult = null;
  let finishResult = null;
  if (!dryRun) {
    writeFileSync(taskFile.path, plannedContent, 'utf8');
    if (proveCriteria) {
      const afterNotes = readFileSync(taskFile.path, 'utf8');
      const proved = afterNotes.replace(/^(\s*)- \[ \](.*)$/gm, '$1- [x]$2');
      if (proved !== afterNotes) writeFileSync(taskFile.path, proved, 'utf8');
      const evidenceMethods = ['criteria_proof'];
      const admission = await admitTaskEvidence({ cwd: siteRoot, taskNumber, admittedBy: agentId, methods: evidenceMethods, store });
      criteriaResult = {
        status: admission.blockers.length === 0 ? 'proved' : 'proved_with_blockers',
        admission_id: admission.result.admission_id,
        blockers: admission.blockers,
        verdict: admission.result.verdict,
      };
    }
    if (finish) {
      if (finishChangedFiles && noFilesChanged) {
        throw new Error('changed_files_conflicts_with_no_files_changed');
      }
      const rawAutoDetectedChangedFiles = !finishChangedFiles && !noFilesChanged ? detectGitChangedFiles(siteRoot) : [];
      const scopedChangedFiles = scopeChangedFiles(siteRoot, rawAutoDetectedChangedFiles, { includeUnrelated: includeUnrelatedChangedFiles });
      const autoDetectedChangedFiles = scopedChangedFiles.files;
      const finishOptions: Record<string, unknown> = { cwd: siteRoot, taskNumber, agent: agentId, summary: summary ?? `Disposition close-out: ${inferredDisposition}`, close: true, store };
      if (reviewer) {
        finishOptions.reviewer = reviewer;
        finishOptions.suppressLegacyReviewRouting = true;
      }
      if (proveCriteria) finishOptions.proveCriteria = true;
      if (finishChangedFiles) finishOptions.changedFiles = JSON.stringify(finishChangedFiles);
      if (!finishChangedFiles && autoDetectedChangedFiles.length > 0) finishOptions.changedFiles = JSON.stringify(autoDetectedChangedFiles);
      if (noFilesChanged) finishOptions.changedFiles = JSON.stringify([NO_FILES_CHANGED_MARKER]);
      const result = await withAuthoredRosterJsonPreserved(siteRoot, () => finishTaskService(finishOptions), store);
      finishResult = result.result || result;
      finishResult.follow_up_policy = evaluatePostTransitionFollowups({
        event: { transition_kind: finishResult.close_action ?? 'close', task_number: taskNumber, task_id: lifecycle.task_id, agent_id: agentId },
        source_task: { task_number: taskNumber, task_id: lifecycle.task_id },
        actor: { agent_id: agentId },
        result: finishResult,
        signals: { evidence_blocked: finishResult.close_action === 'blocked' },
      });
      if (!finishChangedFiles && !noFilesChanged) {
        finishResult.changed_files_scoping = scopedChangedFiles;
      }
    }
  }
  return {
    status: dryRun ? 'dry_run' : 'prepared',
    schema: 'narada.task.mcp.disposition_closeout.v0',
    task_number: taskNumber,
    task_id: lifecycle.task_id,
    envelope: resolvedEnvelopeId ? {
      envelope_id: resolvedEnvelopeId,
      status: envelopeStatus ?? 'not_found',
      title: envelope?.title ?? null,
      kind: envelope?.kind ?? null,
      received_at: envelope?.received_at ?? null,
    } : null,
    disposition: inferredDisposition,
    capa_corrective_action_coverage: capaCoverageValidation,
    changed_files: changedFiles,
    lifecycle_store_paths: changedFiles,
    committable_path_set: {
      schema: 'narada.task.disposition_closeout.committable_path_set.v0',
      task_owned_paths: gitVisibleChangedFiles,
      ordinary_task_closeout_paths: gitVisibleChangedFiles,
      lifecycle_store_paths: changedFiles,
      non_committable_lifecycle_store_paths: changedFiles.filter((file) => !gitVisibleChangedFiles.includes(file)),
      ignored_envelope_projection_paths: [],
      envelope_handoff_tool: 'git_handoff_inbox_envelope_export',
      guidance: 'Stage ordinary_task_closeout_paths only. lifecycle_store_paths are durable closeout records and may be outside Git or ignored by repository policy.',
    },
    notes_written: !dryRun,
    criteria_result: criteriaResult,
    finish_result: finishResult,
    commit_ready: {
      stage_paths: gitVisibleChangedFiles,
      ordinary_task_closeout_paths: gitVisibleChangedFiles,
      lifecycle_store_paths: changedFiles,
      non_committable_lifecycle_store_paths: changedFiles.filter((file) => !gitVisibleChangedFiles.includes(file)),
      ignored_envelope_projection_paths: [],
      envelope_handoff_tool: 'git_handoff_inbox_envelope_export',
      exclude_unrelated_dirty_files: true,
    },
  };
}

export function buildTaskFileResolutionFailure({ siteRoot, store, taskNumber, lifecycle, surface }) {
  const expectedPath = resolve(siteRoot, '.ai', 'do-not-open', 'tasks', `${lifecycle.task_id}.md`);
  const spec = store.getTaskSpec(lifecycle.task_id) ?? store.getTaskSpecByNumber?.(taskNumber) ?? null;
  const assignment = store.getActiveAssignment?.(lifecycle.task_id) ?? null;
  return {
    status: 'error',
    error: 'task_file_resolution_failed',
    schema: 'narada.task.mcp.task_file_resolution_failed.v1',
    surface,
    task_number: taskNumber,
    task_id: lifecycle.task_id,
    lifecycle_task_id: lifecycle.task_id,
    lifecycle_status: lifecycle.status,
    lifecycle_row_exists: true,
    task_spec_exists: Boolean(spec),
    active_assignment_agent_id: assignment?.agent_id ?? null,
    expected_path: expectedPath,
    task_file_exists: false,
    resolution_source: 'sqlite_lifecycle_without_markdown_projection',
    recommended_next_tool: 'task_lifecycle_show',
    repair_options: [
      {
        tool: 'task_lifecycle_show',
        reason: 'Inspect the SQLite-backed task state and task_id before choosing a repair path.',
        arguments: { task_number: taskNumber },
      },
      {
        tool: 'task_lifecycle_record_observation',
        reason: 'Record evidence without mutating the missing task markdown projection.',
        arguments: { task_number: taskNumber },
      },
      {
        tool: 'task_lifecycle_reopen',
        reason: 'Use only if the lifecycle state itself needs a governed transition before regenerating or replacing the task projection.',
        arguments: { task_number: taskNumber },
      },
    ],
    remediation: 'The task exists in SQLite lifecycle state but its markdown task projection could not be resolved. Do not retry closeout/report blindly. Inspect the task, restore/regenerate the expected markdown projection if needed, or use DB-backed observation/transition tools that do not require the markdown file.',
  };
}

export function validateCapaDispositionCorrectiveCoverage({ envelope, body, store }) {
  const payload = envelope?.envelope?.payload ?? envelope?.envelope ?? envelope?.payload ?? {};
  const envelopeId = envelope?.envelope_id ?? envelope?.envelope?.envelope_id ?? null;
  const classification = String(payload.classification ?? envelope?.kind ?? '').toLowerCase();
  const correctiveAction = typeof payload.corrective_action === 'string' ? payload.corrective_action.trim() : '';
  const capaLike = Boolean(correctiveAction)
    || classification.includes('capa')
    || Array.isArray(payload.related_capas)
    || Array.isArray(payload.acceptance_evidence);
  if (!capaLike || !correctiveAction) {
    return { ok: true, required: false, status: 'not_required', errors: [] };
  }

  const ledger = extractTaskSection(body, 'Follow-Up Ledger');
  if (!ledger) {
    return {
      ok: false,
      required: true,
      status: 'missing_corrective_action_coverage',
      envelope_id: envelopeId,
      corrective_action_present: true,
      corrective_action_summary: correctiveAction,
      errors: [`CAPA ${envelopeId ?? 'unknown'} has corrective_action but no Follow-Up Ledger entry proving implementation coverage, deferral/blocker state, or no-action rationale.`],
    };
  }

  const lines = ledger.split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s+/, '')).filter(Boolean);
  const activeStatuses = new Set(['opened', 'claimed', 'needs_continuation', 'in_review', 'awaiting_dependencies']);
  const taskLinks = [];
  for (const line of lines) {
    const taskMatches = [...line.matchAll(/\b(?:created|covered by)\s+#(\d+)\b/gi)];
    for (const match of taskMatches) {
      const taskNumber = Number(match[1]);
      const lifecycle = Number.isFinite(taskNumber) ? store.getLifecycleByNumber(taskNumber) : null;
      taskLinks.push({
        task_number: taskNumber,
        status: lifecycle?.status ?? 'not_found',
        active_implementation_coverage: lifecycle ? activeStatuses.has(lifecycle.status) : false,
        line,
      });
    }
  }
  const activeTaskLinks = taskLinks.filter((link) => link.active_implementation_coverage);
  const deferredOrBlocked = lines.find((line) => /\b(?:deferred|blocked|blocker)\s*:/i.test(line));
  const noAction = lines.find((line) => /\bno follow-?up needed\s*:/i.test(line) || /\bno[- ]action rationale\s*:/i.test(line));
  if (activeTaskLinks.length > 0 || deferredOrBlocked || noAction) {
    return {
      ok: true,
      required: true,
      status: activeTaskLinks.length > 0 ? 'covered_by_active_implementation_task' : deferredOrBlocked ? 'explicit_defer_or_blocker_state' : 'admitted_no_action_rationale',
      envelope_id: envelopeId,
      corrective_action_present: true,
      corrective_action_summary: correctiveAction,
      task_links: taskLinks,
      accepted_line: deferredOrBlocked ?? noAction ?? null,
      errors: [],
    };
  }

  return {
    ok: false,
    required: true,
    status: 'missing_corrective_action_coverage',
    envelope_id: envelopeId,
    corrective_action_present: true,
    corrective_action_summary: correctiveAction,
    task_links: taskLinks,
    errors: [`CAPA ${envelopeId ?? 'unknown'} corrective action lacks active implementation coverage. Link an active task with created #N / covered by #N, record deferred/blocker state, or record no follow-up needed with no-action rationale. Closed historical/disposition tasks do not count.`],
  };
}

function collectChangedFileEvidenceFromReports(reportRecords, sqliteReports) {
  const changedFiles = new Set();
  const noFilesChangedDeclarations = [];
  for (const record of [...reportRecords, ...sqliteReports]) {
    let parsed = null;
    try {
      parsed = typeof record.report_json === 'string' ? JSON.parse(record.report_json) : record;
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const files = Array.isArray(parsed.changed_files) ? parsed.changed_files : [];
    for (const file of files) {
      if (typeof file === 'string' && file.trim().length > 0 && file !== NO_FILES_CHANGED_MARKER) {
        changedFiles.add(file);
      }
    }
    if (parsed.no_files_changed === true || parsed.changed_files?.includes?.(NO_FILES_CHANGED_MARKER)) {
      noFilesChangedDeclarations.push(parsed.report_id ?? parsed.task_id ?? 'unknown');
    }
  }
  const uniqueChangedFiles = [...changedFiles];
  return {
    changedFiles: uniqueChangedFiles,
    changed_files_count: uniqueChangedFiles.length,
    noFilesChangedDeclarations,
    no_files_changed_declaration_count: noFilesChangedDeclarations.length,
  };
}

function extractTaskSection(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body).match(new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i'));
  return match ? match[1].trim() : null;
}

export function detectGitChangedFiles(cwd, basePath = cwd) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => resolve(basePath, file));
}

export function scopeChangedFiles(siteRoot, files, { includeUnrelated = false, taskFilePath = null } = {}) {
  const normalized = [...new Set(files.filter((file) => typeof file === 'string' && file.trim().length > 0 && file !== NO_FILES_CHANGED_MARKER))] as string[];
  if (includeUnrelated) return { files: normalized, included_count: normalized.length, excluded_count: 0 };
  const scoped = normalized.filter((file: string) => {
    if (taskFilePath && file === taskFilePath) return true;
    if (!file.startsWith(siteRoot)) return false;
    const relativePath = relative(siteRoot, file).split('\\').join('/');
    if (relativePath === '.ai' || relativePath.startsWith('.ai/')) return false;
    return true;
  });
  return { files: scoped, included_count: scoped.length, excluded_count: normalized.length - scoped.length };
}

function relativeSitePath(siteRoot, filePath) {
  return relative(resolve(siteRoot), resolve(filePath)).replace(/\\/g, '/');
}

function gitVisiblePathSubset(cwd, files) {
  return files.filter((file) => {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (tracked.status === 0) return true;
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return untracked.status === 0 && untracked.stdout.trim().length > 0;
  });
}

function readIndexedEnvelope(siteRoot, envelopeId, refreshInboxIndex, evaluateEnvelopeSeverity) {
  const index = refreshInboxIndex(siteRoot, { evaluateEnvelopeSeverity });
  try {
    const row = index.db.prepare('SELECT * FROM inbox_envelopes WHERE envelope_id = ?').get(envelopeId);
    if (!row) return null;
    return { ...row, envelope: JSON.parse(String(row.payload_json)) };
  } finally {
    index.db.close();
  }
}
