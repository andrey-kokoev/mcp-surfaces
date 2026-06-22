import {
  TASK_LIFECYCLE_TOOL_ALIASES,
  taskLifecycleDomainTools,
} from '@narada2/task-governance-core/task-lifecycle-mcp-contract';
import { listPayloadTools } from '@narada2/mcp-transport';

export { TASK_LIFECYCLE_TOOL_ALIASES };

export function taskLifecycleTools() {
  return [
    ...taskLifecycleDomainTools(),
    ...listPayloadTools(),
  ];
}
