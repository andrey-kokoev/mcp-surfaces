import { parseStoredTaskTags } from '@narada2/task-governance-core/task-tags';

type TaskLifecycleRecord = { task_id: string; task_number: number; status?: string | null };

export type SupersededTaskGuardResult = {
  status: 'not_applicable' | 'blocked' | 'overridden';
  tags: string[];
  lineage_tags: string[];
  authority_basis?: Record<string, unknown> | null;
  error?: string;
  task_number?: number;
  task_id?: string;
  remediation?: string;
};

/**
 * Superseded/replacement labels describe lineage, not ordinary task metadata.
 * They must therefore be checked at every responsibility boundary instead of
 * relying on an agent to notice them in a task projection.
 */
export function inspectSupersededTaskGuard({ store, lifecycle, authorityBasis }: {
  store: any;
  lifecycle: TaskLifecycleRecord;
  authorityBasis?: unknown;
}): SupersededTaskGuardResult {
  const spec = store.getTaskSpec?.(lifecycle.task_id);
  const tags = parseStoredTaskTags(spec?.tags_json);
  // Legacy task projections may contain lineage labels that predate the
  // current small-label grammar (for example `superseded/replacement-2219`).
  // Read the persisted JSON defensively for this safety check instead of
  // allowing normalization to erase the very label that must block work.
  const persistedTags = readPersistedTags(spec?.tags_json);
  const lineageTags = persistedTags.filter((tag) => {
    const normalized = tag.toLowerCase();
    return normalized === 'superseded'
      || normalized.startsWith('superseded/')
      || normalized.startsWith('superseded:')
      || normalized.startsWith('superseded-')
      || normalized.startsWith('replacement/')
      || normalized.startsWith('replacement:')
      || normalized.startsWith('replacement-');
  });
  if (lineageTags.length === 0) return { status: 'not_applicable', tags, lineage_tags: [] };

  const authority = normalizeLineageOverride(authorityBasis);
  if (authority) {
    return {
      status: 'overridden',
      tags,
      lineage_tags: lineageTags,
      authority_basis: authority,
      task_number: lifecycle.task_number,
      task_id: lifecycle.task_id,
    };
  }
  return {
    status: 'blocked',
    error: 'superseded_task_requires_lineage_override',
    tags,
    lineage_tags: lineageTags,
    authority_basis: null,
    task_number: lifecycle.task_number,
    task_id: lifecycle.task_id,
    remediation: 'Inspect the replacement lineage and claim/continue/finish only with authority_basis.kind=operator_direct_instruction and a substantive summary when the operator explicitly authorizes work on the superseded task.',
  };
}

function readPersistedTags(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : [];
  } catch {
    return [];
  }
}

function normalizeLineageOverride(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (kind !== 'operator_direct_instruction' || !summary) return null;
  return { kind, summary };
}
