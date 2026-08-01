# Work Lifecycle MCP

Work Lifecycle is the single Site-scoped mutation authority for sibling ticket
and task aggregates. It exposes first-class `ticket_*` tools and the existing
`task_lifecycle_*` family from one runtime and one SQLite database.

Runtime startup is preparation-free. Prepare explicitly:

```powershell
node dist/src/main.js --prepare --site-root C:\path\to\site
```

Then start the MCP runtime with `--site-root`. The canonical database is
`.ai/work-lifecycle.db`; no legacy task database is opened as fallback.
