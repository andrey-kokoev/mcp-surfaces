import {
  TASK_LIFECYCLE_TOOL_ALIASES,
  taskLifecycleDomainTools,
} from '@narada-core/task-governance-core/task-lifecycle-mcp-contract';
import { listPayloadTools } from '@narada-core/mcp-transport';

export { TASK_LIFECYCLE_TOOL_ALIASES };

export function taskLifecycleTools() {
  return [
    ...taskLifecycleDomainTools(),
    ...listPayloadTools(),
  ];
}
