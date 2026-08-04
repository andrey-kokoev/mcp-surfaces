import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { memoryAttribution, memoryOwners, memoryStatus, memoryTimeline } from '../src/memory-store.js';

test('reads only the canonical Site observer store with bounded owner attribution', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-introspection-memory-'));
  const storeRoot = join(root, '.narada', 'runtime', 'mcp-runtime-observer');
  mkdirSync(storeRoot, { recursive: true });
  const db = new DatabaseSync(join(storeRoot, 'observations.db'));
  db.exec(`
    CREATE TABLE owners(owner_id TEXT PRIMARY KEY,site_id TEXT,authority_ref TEXT,owner_kind TEXT,pid INTEGER,parent_owner_id TEXT,surface_id TEXT,instance_id TEXT,generation_id TEXT,carrier_session_id TEXT,executable_name TEXT,observed_at TEXT,active INTEGER);
    CREATE TABLE process_samples(sample_id TEXT,sampled_at_ms INTEGER,owner_id TEXT,pid INTEGER,parent_pid INTEGER,creation_ticks INTEGER,working_set_bytes INTEGER,private_bytes INTEGER,commit_bytes INTEGER,virtual_bytes INTEGER,handle_count INTEGER,thread_count INTEGER,cpu_time_ms INTEGER,executable_name TEXT,sample_status TEXT);
    CREATE TABLE worker_samples(sample_id TEXT,sampled_at_ms INTEGER,owner_id TEXT,instance_id TEXT,generation_id TEXT,heap_total_bytes INTEGER,heap_used_bytes INTEGER,external_bytes INTEGER,array_buffers_bytes INTEGER,heap_limit_bytes INTEGER,invocation_count INTEGER,inflight INTEGER,active_resource_counts_json TEXT,sample_status TEXT);
    CREATE TABLE incidents(incident_id TEXT,owner_id TEXT,opened_at_ms INTEGER,updated_at_ms INTEGER,status TEXT,detector TEXT,attribution TEXT,confidence REAL,baseline_bytes INTEGER,observed_bytes INTEGER,slope_bytes_per_minute REAL,review_note TEXT);
    CREATE TABLE evidence(evidence_id TEXT,incident_id TEXT,created_at_ms INTEGER,evidence_type TEXT,payload_json TEXT);
    CREATE TABLE artifacts(artifact_id TEXT,incident_id TEXT,created_at_ms INTEGER,path TEXT,kind TEXT,bytes INTEGER);
  `);
  const now = Date.now();
  db.prepare('INSERT INTO owners VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('worker-1','site-1','site:site-1:mcp','surface_worker',100,null,'fixture','instance-1','generation-1',null,'node',new Date().toISOString(),1);
  db.prepare('INSERT INTO process_samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('p1',now,'worker-1',100,1,1,1000,1000,1000,0,2,3,4,'node','complete');
  db.prepare('INSERT INTO worker_samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('w1',now,'worker-1','instance-1','generation-1',800,600,200,100,4096,2,0,'{}','complete');
  db.close();
  try {
    assert.equal(memoryStatus({}, root).status, 'ready');
    assert.equal((memoryOwners({}, root).items as unknown[]).length, 1);
    assert.equal(memoryAttribution({ owner_id: 'worker-1' }, root).attribution, 'direct');
    assert.equal((memoryTimeline({ owner_id: 'worker-1' }, root).items as unknown[]).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
