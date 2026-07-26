import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openSiteLoopStore } from '../site-loop/site-loop-store.js';
import {
  compactSiteLoopPersistence,
  pruneSiteLoopPersistence,
} from '../site-operating-loop/site-loop-store.js';

export type SiteLoopStorageMaintenanceCliArgs = {
  help: boolean;
  siteRoot: string | null;
  ackMaintenance: boolean;
  compact: boolean;
};

export function parseSiteLoopStorageMaintenanceCliArgs(argv: string[]): SiteLoopStorageMaintenanceCliArgs {
  let siteRoot: string | null = null;
  let ackMaintenance = false;
  let compact = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return { help: true, siteRoot, ackMaintenance, compact };
    if (arg === '--ack-maintenance') {
      ackMaintenance = true;
      continue;
    }
    if (arg === '--compact') {
      compact = true;
      continue;
    }
    if (arg === '--site-root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('site_root_value_required');
      siteRoot = value;
      continue;
    }
    throw new Error(`unknown_argument:${arg}`);
  }
  return { help: false, siteRoot, ackMaintenance, compact };
}

export function runSiteLoopStorageMaintenance(
  siteRoot: string,
  options: { ackMaintenance?: boolean; compact?: boolean } = {},
) {
  if (options.ackMaintenance !== true) {
    return {
      schema: 'narada.site_loop.persistence_prune.v1',
      status: 'refused',
      reason: 'ack_maintenance_required',
      required_flag: '--ack-maintenance',
      compact_requested: options.compact === true,
    };
  }
  const store = openSiteLoopStore(resolve(siteRoot), { write: true });
  try {
    return {
      ...pruneSiteLoopPersistence(store),
      status: 'pruned',
      site_root: resolve(siteRoot),
      compaction: options.compact === true ? compactSiteLoopPersistence(store) : null,
    };
  } finally {
    store.close();
  }
}

function printCliHelp() {
  console.log('Usage: site-loop-storage-maintenance --site-root <path> --ack-maintenance [--compact]');
  console.log('Runs bounded Site Loop SQLite and evidence retention maintenance outside the run hot path.');
  console.log('--compact performs an explicit VACUUM after retention pruning.');
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseSiteLoopStorageMaintenanceCliArgs(process.argv.slice(2));
    if (args.help) {
      printCliHelp();
    } else if (!args.siteRoot) {
      throw new Error('site_root_required');
    } else {
      const result = runSiteLoopStorageMaintenance(args.siteRoot, {
        ackMaintenance: args.ackMaintenance,
        compact: args.compact,
      });
      console.log(JSON.stringify(result));
      if (result.status === 'refused') process.exitCode = 2;
    }
  } catch (error: any) {
    console.error(JSON.stringify({
      schema: 'narada.site_loop.persistence_prune.v1',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 2;
  }
}
