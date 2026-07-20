import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'node:fs';
import { findTaskFile, readTaskFile, writeTaskProjection, isValidTransition } from '@narada2/task-governance-core/task-governance';
import { admitTaskEvidence } from '@narada2/task-governance-core/evidence-admission';
import { taskAgentIdentityRefJson } from '@narada2/task-governance-core/agent-identity-ref';
import { deriveClosureAuthority, terminalTaskMutationGuard } from './closure-authority.js';

export async function claimLifecycleTask({ siteRoot, store, taskNumber, agentId }) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  const terminalGuard = terminalTaskMutationGuard(lifecycle, 'claim');
  if (terminalGuard) {
    return {
      status: 'closure_authority_blocks_claim',
      task_number: taskNumber,
      task_id: lifecycle.task_id,
      ...terminalGuard,
      remediation: 'Use a valid reopen/continue transition before claiming this task.',
    };
  }
  const existing = store.getActiveAssignment(lifecycle.task_id);
  if (existing) return { status: 'already_claimed', assignment: existing, lifecycle };

  const assignmentId = `assign-${randomUUID()}`;
  withStoreSavepoint(store, () => {
    store.insertAssignment({
      assignment_id: assignmentId,
      task_id: lifecycle.task_id,
      agent_id: agentId,
      agent_identity_ref_json: taskAgentIdentityRefJson(agentId, { siteId: process.env.NARADA_SITE_ID ?? null }),
      claimed_at: new Date().toISOString(),
      released_at: null,
      release_reason: null,
      intent: 'primary',
    });
    store.updateStatus(lifecycle.task_id, 'claimed', agentId, {});
  });
  await writeTaskStatusProjection(siteRoot, taskNumber, 'claimed');
  return { status: 'claimed', assignment_id: assignmentId, task_number: taskNumber, lifecycle };
}

function withStoreSavepoint<T>(store, action: () => T): T {
  const name = `narada_lifecycle_${randomUUID().replaceAll('-', '')}`;
  store.db.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    store.db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { store.db.exec(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* preserve original failure */ }
    try { store.db.exec(`RELEASE SAVEPOINT ${name}`); } catch { /* preserve original failure */ }
    throw error;
  }
}

export async function unclaimLifecycleTask({ siteRoot, store, taskNumber, agentId, reason }) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  const existing = store.getActiveAssignment(lifecycle.task_id);
  if (!existing) return { status: 'not_claimed', task_number: taskNumber };
  if (agentId && existing.agent_id !== agentId) return { status: 'claimed_by_other', claimed_by: existing.agent_id };
  const terminalGuard = terminalTaskMutationGuard(lifecycle, 'unclaim');
  if (terminalGuard) {
    return {
      status: 'closure_authority_blocks_unclaim',
      task_number: taskNumber,
      task_id: lifecycle.task_id,
      ...terminalGuard,
      remediation: 'Use a valid reopen transition before releasing a stale active assignment into opened state.',
    };
  }

  withStoreSavepoint(store, () => {
    store.releaseAssignment(existing.assignment_id, reason ?? 'mcp_unclaim');
    store.updateStatus(lifecycle.task_id, 'opened', agentId ?? existing.agent_id, {});
  });
  await writeTaskStatusProjection(siteRoot, taskNumber, 'opened');
  return { status: 'unclaimed', task_number: taskNumber, previous_agent: existing.agent_id, task_id: lifecycle.task_id };
}

export async function transitionLifecycleTask({ siteRoot, store, taskNumber, agentId, reason, toStatus, resultStatus, closureMode = 'transition', projectionMode = 'best_effort' }) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  if (!isValidTransition(lifecycle.status, toStatus)) {
    return {
      status: 'error',
      error: 'invalid_transition',
      task_number: taskNumber,
      from: lifecycle.status,
      to: toStatus,
      message: `Cannot transition from '${lifecycle.status}' to '${toStatus}'.`,
    };
  }
  const updates: Record<string, unknown> = { reason };
  if (toStatus === 'closed') {
    updates.closed_at = new Date().toISOString();
    updates.closed_by = agentId;
    updates.closure_mode = closureMode;
  }
  if (toStatus === 'opened' && ['closed', 'confirmed'].includes(lifecycle.status)) {
    updates.reopened_at = new Date().toISOString();
    updates.reopened_by = agentId;
  }
  withStoreSavepoint(store, () => {
    store.updateStatus(lifecycle.task_id, toStatus, agentId, updates);
  });
  await writeTaskStatusProjection(siteRoot, taskNumber, toStatus, projectionMode === 'strict');
  return { status: resultStatus, task_number: taskNumber, task_id: lifecycle.task_id };
}

export async function unDeferLifecycleTask({ siteRoot, store, taskNumber, agentId, reason, authorityBasis }) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  if (lifecycle.status !== 'deferred') {
    return {
      status: 'error',
      error: 'invalid_transition',
      task_number: taskNumber,
      from: lifecycle.status,
      to: 'opened_or_claimed',
      message: `Cannot un-defer a task from '${lifecycle.status}'.`,
    };
  }

  const assignment = store.getActiveAssignment(lifecycle.task_id) ?? null;
  const nextStatus = assignment ? 'claimed' : 'opened';
  if (assignment && assignment.agent_id !== agentId && !isOperatorDirectAuthority(authorityBasis)) {
    return {
      status: 'error',
      error: 'authority_basis_required',
      task_number: taskNumber,
      active_assignment_agent_id: assignment.agent_id,
      actor_agent_id: agentId,
      message: 'Un-deferring a task assigned to another agent requires authority_basis.kind=operator_direct_instruction.',
    };
  }

  withStoreSavepoint(store, () => {
    store.updateStatus(lifecycle.task_id, nextStatus, agentId, {
      reason,
      un_defer_authority_basis_json: authorityBasis ? JSON.stringify(authorityBasis) : null,
    });
  });
  await writeTaskStatusProjection(siteRoot, taskNumber, nextStatus);
  return {
    status: 'un_deferred',
    task_number: taskNumber,
    task_id: lifecycle.task_id,
    from: 'deferred',
    to: nextStatus,
    active_assignment: assignment ? {
      assignment_id: assignment.assignment_id,
      agent_id: assignment.agent_id,
      claimed_at: assignment.claimed_at,
      intent: assignment.intent,
    } : null,
  };
}

export async function proveTaskCriteria({ siteRoot, store, taskNumber, agentId }) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  const taskPath = resolve(siteRoot, '.ai', 'do-not-open', 'tasks', `${lifecycle.task_id}.md`);
  let body;
  try {
    body = readFileSync(taskPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read task file: ${err.message}`);
  }

  const updatedBody = body.replace(/^(\s*)- \[ \](.*)$/gm, '$1- [x]$2');
  if (updatedBody === body) return { status: 'no_changes', task_number: taskNumber, message: 'No unchecked acceptance criteria found.' };

  const now = new Date().toISOString();
  let updatedContent = updatedBody;
  if (/^---\r?\n/.test(updatedBody)) {
    updatedContent = updatedBody.replace(/^(---\r?\n[\s\S]*?\r?\n---)/, (match) => {
      let fm = match;
      if (!fm.includes('criteria_proved_by:')) {
        fm = fm.replace(/\n---$/, `\ncriteria_proved_by: ${agentId}\ncriteria_proved_at: ${now}\n---`);
      }
      return fm;
    });
  }
  writeFileSync(taskPath, updatedContent, 'utf8');
  let admission;
  try {
    admission = await admitTaskEvidence({ cwd: siteRoot, taskNumber, admittedBy: agentId, methods: ['criteria_proof'] });
  } catch (error) {
    writeFileSync(taskPath, body, 'utf8');
    throw error;
  }
  if (admission.blockers.length > 0) {
    writeFileSync(taskPath, body, 'utf8');
  }
  return {
    status: admission.blockers.length === 0 ? 'proved' : 'proved_with_blockers',
    task_number: taskNumber,
    admission_id: admission.result.admission_id,
    blockers: admission.blockers,
    criteria_projection_rolled_back: admission.blockers.length > 0,
    schema: 'narada.task.mcp.prove_criteria.v0',
  };
}

function isOperatorDirectAuthority(value) {
  return value && typeof value === 'object' && value.kind === 'operator_direct_instruction' && typeof value.summary === 'string' && value.summary.trim().length > 0;
}

async function writeTaskStatusProjection(siteRoot, taskNumber, status, throwOnError = false) {
  try {
    const taskFile = await findTaskFile(siteRoot, taskNumber);
    if (!taskFile) return;
    const { frontMatter, body } = await readTaskFile(taskFile.path);
    frontMatter.status = status;
    await writeTaskProjection(taskFile.path, frontMatter, body);
  } catch (error) {
    // Projection writes are compatibility updates; SQLite remains authoritative.
    if (throwOnError) throw error;
  }
}
