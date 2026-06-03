import { openTaskLifecycleStoreWithDiscipline } from '../task-lifecycle/sqlite-discipline.js';
import { ensureSiteLoopTables } from '../site-operating-loop/site-loop-store.js';

export * from '../site-operating-loop/site-loop-store.js';

export function openSiteLoopStore(cwd, options: Record<string, any> = {}) {
  const write = options.write !== false;
  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(cwd, { write });
  if (write) ensureSiteLoopTables(lifecycleStore.db);
  return {
    db: lifecycleStore.db,
    close() {
      lifecycleStore.db.close();
    },
  };
}
