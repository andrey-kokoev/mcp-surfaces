# Site root contract

Narada surfaces use one canonical Site root: the workspace directory that contains the Site's source tree. The `.narada` directory is the Site control root, not a second Site root.

For a workspace such as `D:/code/mcp-surfaces`:

- `site_root` and `workspace_root` are `D:/code/mcp-surfaces`.
- `governance_root` and other control files live under `D:/code/mcp-surfaces/.narada`.
- runtime state belongs under the workspace's `.ai` or the control root's documented runtime subdirectories.
- `.narada/site.json` is a generated, machine-local identity marker. It is ignored by Git and may contain absolute paths. It must not be treated as a portable source file.

The repository-owned `.narada/site-tool-surface.manifest.json` is a separate inventory artifact. When it is present, its `site_root` names the canonical workspace and its `tool_root` names the control-root tool directory; it is not evidence that `.narada` itself is the Site root.

Compatibility inputs may still name the legacy control root (`<workspace>/.narada`). Registries, registrar lookups, attachment metadata, and generated bindings normalize that input to the workspace root before publishing Site identity or interpolating `{site_root}`. The control root remains available through `{site_control_root}`.

The registrar derives its package and workspace roots from the loaded package or explicit `NARADA_MCP_WORKSPACE_ROOT` / `NARADA_MCP_SURFACES_ROOT` configuration. It does not embed a developer-machine drive, user profile, or fixed feedback database path. A canonical feedback store must be supplied explicitly with `--canonical-feedback-root` or `NARADA_SURFACE_FEEDBACK_ROOT`.

When adding a new Site-bound surface, test both forms of input:

1. a workspace root with `.narada` control files; and
2. a legacy `.narada` root that declares its workspace.

The emitted binding must use the same canonical workspace identity in its authority metadata, while control/config files remain under the resolved control root.
