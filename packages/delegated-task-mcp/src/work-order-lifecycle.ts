export const WORK_ORDER_LIFECYCLE_SCHEMA = 'narada.delegation.work_order.lifecycle_state.v1' as const;

export const WORK_ORDER_LIFECYCLE_STATES = [
  'requested',
  'admitted',
  'planned',
  'dispatched',
  'running',
  'review',
  'repaired',
  'completed',
  'failed',
  'cancelled',
] as const;

export type WorkOrderLifecycleState = typeof WORK_ORDER_LIFECYCLE_STATES[number];

export interface WorkOrderLifecycle {
  schema: typeof WORK_ORDER_LIFECYCLE_SCHEMA;
  state: WorkOrderLifecycleState;
  history: readonly WorkOrderLifecycleState[];
}

const transitions: Record<WorkOrderLifecycleState, readonly WorkOrderLifecycleState[]> = {
  requested: ['admitted', 'failed', 'cancelled'],
  admitted: ['planned', 'failed', 'cancelled'],
  planned: ['dispatched', 'failed', 'cancelled'],
  dispatched: ['running', 'failed', 'cancelled'],
  running: ['review', 'failed', 'cancelled'],
  review: ['repaired', 'completed', 'failed', 'cancelled'],
  repaired: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function createWorkOrderLifecycle(initialState: WorkOrderLifecycleState = 'requested'): WorkOrderLifecycle {
  assertWorkOrderLifecycleState(initialState);
  return { schema: WORK_ORDER_LIFECYCLE_SCHEMA, state: initialState, history: [initialState] };
}

export function normalizeWorkOrderLifecycle(value: unknown): WorkOrderLifecycle {
  if (!value || typeof value !== 'object') return createWorkOrderLifecycle();
  const candidate = value as Record<string, unknown>;
  const state = candidate.state;
  const history = candidate.history;
  if (typeof state !== 'string' || !isWorkOrderLifecycleState(state)) return createWorkOrderLifecycle();
  if (!Array.isArray(history) || history.length === 0 || history.some((item) => typeof item !== 'string' || !isWorkOrderLifecycleState(item))) {
    return createWorkOrderLifecycle(state);
  }
  const normalizedHistory = history as WorkOrderLifecycleState[];
  return {
    schema: WORK_ORDER_LIFECYCLE_SCHEMA,
    state,
    history: normalizedHistory[normalizedHistory.length - 1] === state ? normalizedHistory : [...normalizedHistory, state],
  };
}

export function canTransitionWorkOrderLifecycle(from: WorkOrderLifecycleState, to: WorkOrderLifecycleState): boolean {
  assertWorkOrderLifecycleState(from);
  assertWorkOrderLifecycleState(to);
  return from === to || transitions[from].includes(to);
}

export function assertWorkOrderLifecycleTransition(from: WorkOrderLifecycleState, to: WorkOrderLifecycleState): void {
  if (!canTransitionWorkOrderLifecycle(from, to)) {
    throw new Error(`invalid_work_order_lifecycle_transition: ${from}->${to}`);
  }
}

export function transitionWorkOrderLifecycle(lifecycle: WorkOrderLifecycle, nextState: WorkOrderLifecycleState): WorkOrderLifecycle {
  assertWorkOrderLifecycleTransition(lifecycle.state, nextState);
  return lifecycle.state === nextState
    ? lifecycle
    : { schema: WORK_ORDER_LIFECYCLE_SCHEMA, state: nextState, history: [...lifecycle.history, nextState] };
}

export function isTerminalWorkOrderLifecycleState(state: WorkOrderLifecycleState): boolean {
  assertWorkOrderLifecycleState(state);
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export function isWorkOrderLifecycleState(value: string): value is WorkOrderLifecycleState {
  return (WORK_ORDER_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function assertWorkOrderLifecycleState(state: string): asserts state is WorkOrderLifecycleState {
  if (!isWorkOrderLifecycleState(state)) {
    throw new Error(`unsupported_work_order_lifecycle_state: ${state}`);
  }
}
