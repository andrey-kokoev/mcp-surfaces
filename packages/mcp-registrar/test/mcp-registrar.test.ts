import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'mcp-registrar-behavior-'));

try {
  const state = createServerState({});

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
  }
  function view(res: Record<string, any>): Record<string, any> {
    return res.result.structuredContent as Record<string, any>;
  }

  const surfaces = await call('registrar_surface_list', {});
  const surfaceData = view(surfaces);
  assert.ok(Array.isArray(surfaceData.items));
  assert.ok(surfaceData.count >= 10);
  const sched = (surfaceData.items as Array<Record<string, any>>).find((s) => s.id === 'scheduler');
  assert.ok(sched);
  assert.ok(sched.tools.includes('scheduler_task_list'));

  const sites = await call('registrar_site_list', {});
  const siteData = view(sites);
  assert.ok((siteData.items as Array<unknown>).length >= 7);

  const carriers = await call('registrar_carrier_list', {});
  const carrierData = view(carriers);
  assert.ok((carrierData.items as Array<unknown>).length >= 3);

  const siteDir = join(root, '.ai', 'mcp');
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(root, 'site.json'), JSON.stringify({ site_id: 'test-site' }), 'utf8');

  const bind = await call('registrar_site_bind', { site_id: 'narada-sonar', surface_id: 'scheduler' });
  const bindData = view(bind);
  assert.equal(bindData.status, 'bound');
  assert.ok(bindData.file);

  const surfaces2 = await call('registrar_site_surfaces', { site_id: 'narada-sonar' });
  assert.ok((view(surfaces2) as Record<string, any>).surfaces.includes('scheduler'));

  console.log('mcp-registrar behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
