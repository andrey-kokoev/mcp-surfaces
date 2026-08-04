import type { SurfaceRuntimeFactory } from '@narada-core/mcp-fabric-contracts';

export const createSurfaceRuntime: SurfaceRuntimeFactory = async () => ({
  tool_names: ['fixture_version'],
  async callTool() { return { version: 3 }; },
  async health() { return { status: 'healthy' }; },
  async assessReplacement() {
    return { compatible: false, reason: 'fixture_schema_migration_required', state_migration_required: true };
  },
  async dispose() {},
});
