export function createTaskLifecycleRemainingHandlers() {
  return async function dispatchRemainingDomainTool(canonicalName) {
    throw new Error(`task_mcp_refused: ${canonicalName}`);
  };
}
