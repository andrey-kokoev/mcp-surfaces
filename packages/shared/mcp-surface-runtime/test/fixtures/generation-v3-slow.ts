import type { SurfaceRuntimeFactory } from '@narada-core/mcp-fabric-contracts';

export const createSurfaceRuntime: SurfaceRuntimeFactory = async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    tool_names: ['fixture_version'],
    async callTool() {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { version: 3 };
    },
    async health() { return { status: 'healthy' }; },
    async assessReplacement() { return { compatible: true, reason: 'fixture_compatible' }; },
    async dispose() {},
  };
};
