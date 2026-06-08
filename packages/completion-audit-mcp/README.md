# @narada2/completion-audit-mcp

MCP surface for recording requirement/evidence/verdict completion audits.

The surface is intentionally narrow: it does not inspect repositories, run tests,
or decide agent intent. Callers provide concrete requirements and evidence, and
the surface validates and persists the audit record.
