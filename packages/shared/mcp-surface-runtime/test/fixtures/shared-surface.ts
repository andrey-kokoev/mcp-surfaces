import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import type { SurfaceRuntimeFactory } from '@narada-core/mcp-fabric-contracts';

export const createSurfaceRuntime: SurfaceRuntimeFactory = async (init) => {
  const marker = `${init.authority_ref}:${threadId}:${randomUUID()}`;
  let calls = 0;
  return {
    tool_names: ['fixture_crash', 'fixture_read'],
    async callTool(request, context) {
      if (request.tool_name === 'fixture_crash') process.exit(17);
      calls += 1;
      return {
        marker,
        calls,
        authority_ref: init.authority_ref,
        carrier_session_id: context.carrier_session_id,
        generation_id: init.generation_id,
      };
    },
    async health() { return { status: 'healthy' }; },
    async dispose() {},
  };
};
