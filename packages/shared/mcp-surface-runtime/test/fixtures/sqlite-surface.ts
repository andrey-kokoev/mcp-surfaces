import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from '@narada-core/sqlite';
import type { SurfaceRuntimeFactory } from '@narada-core/mcp-fabric-contracts';

export const createSurfaceRuntime: SurfaceRuntimeFactory = async (init) => {
  if (!init.site_root) throw new Error('sqlite_fixture_site_root_required');
  const path = join(init.site_root, '.narada', 'runtime-proof.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS counter (authority_ref TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  return {
    tool_names: ['fixture_increment', 'fixture_read_count'],
    async callTool(request) {
      if (request.tool_name === 'fixture_increment') {
        db.prepare(`
          INSERT INTO counter(authority_ref, value) VALUES (?, 1)
          ON CONFLICT(authority_ref) DO UPDATE SET value = value + 1
        `).run(init.authority_ref);
      }
      const row = db.prepare('SELECT value FROM counter WHERE authority_ref = ?').get(init.authority_ref) as { value?: number } | undefined;
      return { authority_ref: init.authority_ref, value: row?.value ?? 0 };
    },
    async health() { return { status: 'healthy' }; },
    async dispose() { db.close(); },
  };
};
