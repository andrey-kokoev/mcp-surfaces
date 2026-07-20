export type ContinuationProjectionState = {
  status: 'linked' | 'unlinked' | 'stale';
  reason: string | null;
  continuation_ref: Record<string, unknown> | null;
  previous_checkpoint_id: string | null;
  next_action: {
    tool: 'agent_context_continuation_export';
    arguments: Record<string, unknown>;
  } | null;
};

export function continuationProjectionState({
  agentId,
  continuation,
  continuationRef,
  previousCheckpoint,
}: {
  agentId: string;
  continuation: unknown;
  continuationRef: Record<string, unknown> | null;
  previousCheckpoint?: {
    checkpoint_id?: string | null;
    continuation_ref?: Record<string, unknown> | null;
  } | null;
}): ContinuationProjectionState | null {
  if (!continuation) return null;
  if (continuationRef) {
    return {
      status: 'linked',
      reason: null,
      continuation_ref: continuationRef,
      previous_checkpoint_id: null,
      next_action: null,
    };
  }

  const previousRef = previousCheckpoint?.continuation_ref ?? null;
  const path = typeof previousRef?.path === 'string' ? previousRef.path : undefined;
  return {
    status: previousRef ? 'stale' : 'unlinked',
    reason: previousRef ? 'checkpoint_supersedes_linked_projection' : 'continuation_projection_not_exported',
    continuation_ref: previousRef,
    previous_checkpoint_id: previousRef ? previousCheckpoint?.checkpoint_id ?? null : null,
    next_action: {
      tool: 'agent_context_continuation_export',
      arguments: {
        agent_id: agentId,
        ...(path ? { path, overwrite: true } : {}),
      },
    },
  };
}
