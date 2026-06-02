import { openTaskLifecycleStoreWithDiscipline } from '../task-lifecycle/sqlite-discipline.mjs';
import { ensureSiteLoopTables } from '../site-operating-loop/site-loop-store.mjs';

export * from '../site-operating-loop/site-loop-store.mjs';

export function openSiteLoopStore(cwd, options = {}) {
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
