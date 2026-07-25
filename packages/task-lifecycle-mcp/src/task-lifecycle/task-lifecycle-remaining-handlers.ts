export function createTaskLifecycleRemainingHandlers() {
  return async function dispatchRemainingDomainTool(canonicalName: any) {
    throw new Error(`task_mcp_refused: ${canonicalName}`);
  };
}
