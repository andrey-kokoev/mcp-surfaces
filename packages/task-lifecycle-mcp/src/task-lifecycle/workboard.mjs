/**
 * Shared workboard categorization logic used by generate-workboard.mjs and task_mcp_next.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSameOperatorReview, detectSelfReview } from './operator-identity.mjs';
import { deriveClosureAuthority } from './closure-authority.mjs';

export function buildWorkboard({ store, siteRoot = null, agentId, agentRole, allTasks }) {
  const all_in_review = [];
  const in_progress = [];
  const needs_continuation = [];
  const local_followups = [];
  const role_wide_followups = [];
  const non_actionable_parent_followups = [];
  const closure_authority_conflicts = [];
  const downstream_role_followups = [];
  const deferred = [];
  const actionable_deferred = [];
  const lifecycleByNumber = new Map((allTasks || []).map((t) => [t.task_number, t]));

  // Preload operator identities for agents in the workboard
  const operatorIdentities = new Map();
  try {
    const rows = store.db.prepare("SELECT agent_id, operator_identity FROM agent_roster WHERE operator_identity IS NOT NULL").all();
    for (const row of rows) {
      operatorIdentities.set(row.agent_id, row.operator_identity);
    }
  } catch {
    // Best-effort; column may not exist in minimal stores
  }

  for (const task of allTasks) {
    const spec = store.getTaskSpecByNumber(task.task_number);
    const assignment = store.getActiveAssignment(task.task_id);

    let targetRole = null;
    let preferredAgentId = null;
    try {
      const rolePref = store.db.prepare(
        'SELECT target_role, preferred_role, preferred_agent_id FROM narada_andrey_task_role_preferences WHERE task_id = ?'
      ).get(task.task_id);
      targetRole = rolePref?.target_role || rolePref?.preferred_role || spec?.target_role || spec?.preferred_role || null;
      preferredAgentId = rolePref?.preferred_agent_id || spec?.preferred_agent_id || null;
    } catch {
      // Table may not exist in fresh or minimal stores
    }

    let roleMatch = true;
    if (task.status === 'opened') {
      if (targetRole) {
        roleMatch = agentRole === targetRole;
      }
    }

    const item = {
      task_number: task.task_number,
      task_id: task.task_id,
      status: task.status,
      title: spec?.title || '(untitled)',
      assigned_agent: assignment?.agent_id || null,
      assigned_agent_operator_identity: operatorIdentities.get(assignment?.agent_id) || null,
      target_role: targetRole,
      preferred_agent_id: preferredAgentId,
      updated_at: task.updated_at,
      relative_priority: task.relative_priority ?? 0,
    };
    item.preferred_agent_relation = preferredAgentRelation(preferredAgentId, agentId);
    item.routing_policy = 'preferred_agent_id_is_soft_affinity_target_role_is_role_gate';
    item.parent_coordinator_actionability = deriveParentCoordinatorActionability({ task, spec, lifecycleByNumber });
    item.closure_authority = deriveClosureAuthority(task);
    item.pre_claim_warnings = buildPreClaimWarnings({ item, assignment, agentId });

    if (item.closure_authority.closure_dominates) {
      closure_authority_conflicts.push({
        ...item,
        visibility: 'closure_authority_conflict',
        claim_authority: 'not_claimable_closed_evidence_dominates',
        reason: item.closure_authority.reason,
      });
      continue;
    }

    if (!roleMatch) {
      downstream_role_followups.push({
        ...item,
        claim_authority: 'not_claimable_role_binding_mismatch',
        visibility: 'downstream_role_context',
        reason: `Task target_role=${targetRole}; querying agent role binding=${agentRole ?? 'unknown'}. Role binding is an eligibility filter, not mutation authority.`, 
      });
      continue;
    }

    if (task.status === 'in_review') {
      // Detect if the requesting agent would face a single-operator review
      if (agentId) {
        let structuralInfo = detectSameOperatorReview(store, agentId, task.task_number);
        if (!structuralInfo?.sameOperator) {
          structuralInfo = detectSelfReview(store, agentId, task.task_number);
        }
        if (structuralInfo?.sameOperator || structuralInfo?.selfReview) {
          item.single_operator_review_risk = true;
          item.single_operator_review_kind = structuralInfo.kind || 'same_operator';
          item.single_operator_review_hint = structuralInfo.warning;
        }
      }
      all_in_review.push(item);
    } else if (task.status === 'claimed') {
      if (agentId && assignment?.agent_id !== agentId) continue;
      in_progress.push(item);
    } else if (task.status === 'needs_continuation') {
      if (agentId && assignment?.agent_id !== agentId) continue;
      needs_continuation.push(item);
    } else if (task.status === 'opened') {
      if (item.parent_coordinator_actionability.status === 'non_actionable_parent') {
        non_actionable_parent_followups.push({
          ...item,
          visibility: 'parent_coordinator_context',
          claim_authority: 'not_recommended_parent_waiting_on_children',
          reason: item.parent_coordinator_actionability.reason,
          child_task_numbers: item.parent_coordinator_actionability.child_task_numbers,
          active_child_task_numbers: item.parent_coordinator_actionability.active_child_task_numbers,
        });
        continue;
      }
      if (item.preferred_agent_relation === 'self') {
        local_followups.push({
          ...item,
          visibility: 'preferred_local_followup',
          claim_authority: 'preferred_agent',
        });
      } else {
        role_wide_followups.push({
          ...item,
          visibility: item.preferred_agent_relation === 'other' ? 'role_wide_preferred_elsewhere' : 'role_wide_unpreferred',
          claim_authority: item.preferred_agent_relation === 'other'
            ? 'preferred_agent_override_required'
            : 'role_binding_eligible_unpreferred',
          reason: item.preferred_agent_relation === 'other'
            ? `Task prefers agent ${preferredAgentId}; same-role claim requires explicit override authority.`
            : 'Task has no preferred_agent_id; matching role binding makes the task claimable through the claim surface, not authorized for arbitrary mutation.',
        });
      }
    } else if (task.status === 'deferred') {
      const observationText = loadObservationArtifactText({ store, task });
      const actionability = deriveDeferredActionability({ siteRoot, task, spec, observationText, lifecycleByNumber });
      item.deferred_actionability = actionability.status;
      item.deferred_actionability_reason = actionability.reason;
      item.deferred_blocker = actionability.blocker;
      item.local_continuation_available = actionability.local_continuation_available;
      deferred.push(item);
      const assignmentMatches = !assignment?.agent_id || assignment.agent_id === agentId;
      const roleMatches = !targetRole || agentRole === targetRole;
      if (assignmentMatches && roleMatches && actionability.status === 'actionable') {
        actionable_deferred.push(item);
      }
    }
  }

  const sortByPriorityThenPreferred = (a, b) => {
    const prioDiff = (b.relative_priority ?? 0) - (a.relative_priority ?? 0);
    if (prioDiff !== 0) return prioDiff;
    const aPref = a.preferred_agent_id === agentId ? 0 : 1;
    const bPref = b.preferred_agent_id === agentId ? 0 : 1;
    return aPref - bPref;
  };

  all_in_review.sort(sortByPriorityThenPreferred);
  in_progress.sort(sortByPriorityThenPreferred);
  needs_continuation.sort(sortByPriorityThenPreferred);
  local_followups.sort(sortByPriorityThenPreferred);
  role_wide_followups.sort(sortByPriorityThenPreferred);
  non_actionable_parent_followups.sort(sortByPriorityThenPreferred);
  closure_authority_conflicts.sort(sortByPriorityThenPreferred);
  downstream_role_followups.sort(sortByPriorityThenPreferred);
  deferred.sort(sortByPriorityThenPreferred);
  actionable_deferred.sort(sortByPriorityThenPreferred);

  return {
    all_in_review,
    in_progress,
    needs_continuation,
    local_followups,
    role_wide_followups,
    non_actionable_parent_followups,
    closure_authority_conflicts,
    downstream_role_followups,
    deferred,
    actionable_deferred,
  };
}

const ACTIVE_CHILD_STATUSES = new Set(['opened', 'claimed', 'needs_continuation', 'in_review', 'deferred']);

function deriveParentCoordinatorActionability({ task, spec, lifecycleByNumber }) {
  if (task.status !== 'opened') {
    return { status: 'not_applicable', reason: 'task is not opened' };
  }
  const text = [
    spec?.title,
    spec?.goal_markdown,
    spec?.context_markdown,
    spec?.required_work_markdown,
    spec?.non_goals_markdown,
  ].filter(Boolean).join('\n\n');
  if (!/\b(split child tasks|child tasks|parent\/coordinator|coordinator)\b/i.test(text)) {
    return { status: 'ordinary_leaf_or_unclassified', reason: 'no parent/coordinator child-task evidence detected' };
  }
  const childTaskNumbers = extractChildTaskNumbers(text, task.task_number);
  if (childTaskNumbers.length === 0) {
    return { status: 'ordinary_leaf_or_unclassified', reason: 'parent/coordinator wording has no numbered child refs' };
  }
  const activeChildTaskNumbers = childTaskNumbers.filter((number) => {
    const child = lifecycleByNumber.get(number);
    return child && ACTIVE_CHILD_STATUSES.has(child.status);
  });
  if (activeChildTaskNumbers.length === 0) {
    return {
      status: 'parent_ready_for_consolidation',
      reason: 'parent/coordinator has no active child lifecycle refs',
      child_task_numbers: childTaskNumbers,
      active_child_task_numbers: [],
    };
  }
  return {
    status: 'non_actionable_parent',
    reason: `Parent/coordinator task has active child task(s): ${activeChildTaskNumbers.map((n) => `#${n}`).join(', ')}.`,
    child_task_numbers: childTaskNumbers,
    active_child_task_numbers: activeChildTaskNumbers,
  };
}

function extractChildTaskNumbers(text, parentTaskNumber) {
  const refs = new Set();
  const childRefPattern = /(?:^|\n)\s*(?:[-*]\s*)?`?#(\d+)`?/g;
  let match;
  while ((match = childRefPattern.exec(text)) !== null) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number !== parentTaskNumber) {
      refs.add(number);
    }
  }
  return [...refs].sort((a, b) => a - b);
}

function buildPreClaimWarnings({ item, assignment, agentId }) {
  const warnings = [];
  if (assignment?.agent_id && assignment.agent_id !== agentId) {
    warnings.push({
      kind: 'active_assignment',
      severity: 'blocker',
      assigned_agent: assignment.agent_id,
      claimed_at: assignment.claimed_at ?? null,
      message: `Task already has an active assignment by ${assignment.agent_id}.`,
    });
  }
  if (item.preferred_agent_id && item.preferred_agent_id !== agentId) {
    warnings.push({
      kind: 'preferred_agent_mismatch',
      severity: 'requires_authority',
      preferred_agent_id: item.preferred_agent_id,
      claiming_agent: agentId ?? null,
      message: `Task prefers ${item.preferred_agent_id}; claim requires override authority.`,
    });
  }
  return warnings;
}

function preferredAgentRelation(preferredAgentId, agentId) {
  if (!preferredAgentId) return 'none';
  if (agentId && preferredAgentId === agentId) return 'self';
  return 'other';
}

function deriveDeferredActionability({ siteRoot, task, spec, observationText = '', lifecycleByNumber = new Map() }) {
  const text = loadDeferredTaskText({ siteRoot, task, spec, observationText });
  const normalized = text.toLowerCase();
  const coordinatorBlocker = detectDeferredCoordinatorChildBlocker({ text, task, lifecycleByNumber });
  if (coordinatorBlocker) {
    return {
      status: 'blocked',
      reason: coordinatorBlocker.reason,
      blocker: coordinatorBlocker,
      local_continuation_available: false,
    };
  }

  const externalBlocker = detectExternalDeferredBlocker(normalized);
  if (externalBlocker) {
    return {
      status: 'blocked',
      reason: externalBlocker.reason,
      blocker: externalBlocker,
      local_continuation_available: false,
    };
  }

  const hasClearedBlocker = /\b(blocker|blocked|external|upstream)\b[\s\S]{0,80}\b(cleared|resolved|accepted|available|unblocked)\b/i.test(text)
    || /\b(local continuation path|local executable path)\b[\s\S]{0,80}\b(available|exists|present)\b/i.test(text);
  if (hasClearedBlocker) {
    return {
      status: 'actionable',
      reason: 'deferred task has blocker-cleared or local-continuation evidence',
      blocker: null,
      local_continuation_available: true,
    };
  }

  return {
    status: 'actionable',
    reason: 'no unresolved blocker evidence detected in deferred task text',
    blocker: null,
    local_continuation_available: true,
  };
}

function detectExternalDeferredBlocker(normalizedText) {
  const hasBlockerLanguage = /\b(blocked|blocker|refused|rejects|rejected|invalid --kind|still fails|still rejects|unresolved)\b/.test(normalizedText);
  const hasExternalBoundary = /\b(external|upstream|outside (?:this )?(?:workspace|user site|writable roots)|canonical .*cli|d:\\code\\narada|missing .*capability)\b/.test(normalizedText);
  const hasNoLocalPath = /\b(cannot honestly|cannot .* from .*workspace|no local executable path|outside .*authority|outside .*writable roots|awaiting upstream|until canonical)\b/.test(normalizedText);
  if (hasBlockerLanguage && hasExternalBoundary && hasNoLocalPath) {
    return {
      kind: 'external_unresolved_blocker',
      reason: 'deferred task records an unresolved external blocker with no local continuation path',
    };
  }
  return null;
}

function detectDeferredCoordinatorChildBlocker({ text, task, lifecycleByNumber }) {
  if (!/\b(child tasks?|children|parent\/coordinator|coordinator|blocked on|blocked until|blocked by)\b/i.test(text)) {
    return null;
  }
  const childTaskNumbers = extractTaskRefsAndRanges(text, task.task_number);
  if (childTaskNumbers.length === 0) return null;
  const activeChildTaskNumbers = childTaskNumbers.filter((number) => {
    const child = lifecycleByNumber.get(number);
    return child && ACTIVE_CHILD_STATUSES.has(child.status);
  });
  if (activeChildTaskNumbers.length === 0) return null;
  return {
    kind: 'deferred_parent_coordinator_child_blockers',
    reason: `deferred parent/coordinator has unresolved child task blocker evidence: ${activeChildTaskNumbers.map((n) => `#${n}`).join(', ')}`,
    child_task_numbers: childTaskNumbers,
    active_child_task_numbers: activeChildTaskNumbers,
    evidence_source: 'task_text_or_observation_artifact',
  };
}

function extractTaskRefsAndRanges(text, parentTaskNumber) {
  const refs = new Set();
  const rangePattern = /#(\d+)\s*-\s*#?(\d+)/g;
  let range;
  while ((range = rangePattern.exec(text)) !== null) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    if (high - low > 50) continue;
    for (let number = low; number <= high; number += 1) {
      if (number !== parentTaskNumber) refs.add(number);
    }
  }
  const refPattern = /#(\d+)/g;
  let match;
  while ((match = refPattern.exec(text)) !== null) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number !== parentTaskNumber) refs.add(number);
  }
  return [...refs].sort((a, b) => a - b);
}

function loadDeferredTaskText({ siteRoot, task, spec, observationText = '' }) {
  const chunks = [
    spec?.title,
    spec?.goal_markdown,
    spec?.context_markdown,
    spec?.required_work_markdown,
    spec?.non_goals_markdown,
  ].filter(Boolean);
  if (siteRoot && task?.task_id) {
    const taskPath = join(siteRoot, '.ai', 'do-not-open', 'tasks', `${task.task_id}.md`);
    if (existsSync(taskPath)) {
      try {
        chunks.push(readFileSync(taskPath, 'utf8'));
      } catch {
        // SQLite task spec remains enough for advisory actionability derivation.
      }
    }
  }
  if (observationText) chunks.push(observationText);
  return chunks.join('\n\n');
}

function loadObservationArtifactText({ store, task }) {
  if (!store?.db || !task?.task_id) return '';
  try {
    const rows = store.db.prepare(`
      SELECT artifact_uri, admitted_view_json
      FROM observation_artifacts
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT 8
    `).all(task.task_id);
    return rows.map((row) => `${row.artifact_uri ?? ''}\n${row.admitted_view_json ?? ''}`).join('\n\n');
  } catch {
    return '';
  }
}
