export const TASK_LIFECYCLE_READ_TOOL_NAMES = Object.freeze([
  'task_lifecycle_list',
  'task_lifecycle_roster',
]);

export function createTaskLifecycleReadHandlers({
  store,
  jsonToolResult,
  stringField,
  numberField,
}) {
  return {
    task_lifecycle_list: (args) => {
      const statusFilter = stringField(args, 'status');
      const agentFilter = stringField(args, 'agent_id');
      const limit = numberField(args, 'limit') ?? 50;
      const rows = store.db.prepare('SELECT * FROM task_lifecycle ORDER BY task_number DESC LIMIT ?').all(limit);
      const tasks = rows.map((row) => {
        const spec = store.getTaskSpec(row.task_id);
        const assignment = store.db.prepare('SELECT * FROM task_assignments WHERE task_id = ? AND released_at IS NULL ORDER BY claimed_at DESC LIMIT 1').get(row.task_id);
        return {
          task_number: row.task_number,
          task_id: row.task_id,
          status: row.status,
          title: spec?.title ?? null,
          assigned_to: assignment?.agent_id ?? null,
          claimed_at: assignment?.claimed_at ?? null,
          updated_at: row.updated_at,
        };
      });
      const filtered = tasks.filter((task) => {
        if (statusFilter && task.status !== statusFilter) return false;
        if (agentFilter && task.assigned_to !== agentFilter) return false;
        return true;
      });
      return jsonToolResult({ status: 'ok', count: filtered.length, tasks: filtered });
    },
    task_lifecycle_roster: () => {
      const roster = store.getRoster();
      return jsonToolResult({ status: 'ok', roster: roster ?? [] });
    },
  };
}
