import type { SurfaceRuntimeFactory } from '@narada-core/mcp-fabric-contracts';

export const createSurfaceRuntime: SurfaceRuntimeFactory = async () => ({
  tool_names: ['fixture_version'],
  async callTool() { return { version: 2 }; },
  async health() { return { status: 'healthy' }; },
  async assessReplacement() { return { compatible: true, reason: 'fixture_compatible' }; },
  async dispose() {},
});
