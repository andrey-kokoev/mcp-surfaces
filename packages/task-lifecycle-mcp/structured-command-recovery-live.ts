import { homedir } from "node:os";
import { join } from "node:path";
import { runStdioServer } from "../structured-command-mcp/dist/src/main.js";

const sourceRoot = process.env.NARADA_SRC_ROOT ?? join(homedir(), "src");
const naradaRoot = process.env.NARADA_ROOT ?? process.env.NARADA_PROPER_ROOT ?? join(sourceRoot, "narada");

await runStdioServer({
  siteRoot: naradaRoot,
  storageRoot: naradaRoot,
  allowedRoot: sourceRoot,
  allowedCommands: ["node", "pnpm"],
});
