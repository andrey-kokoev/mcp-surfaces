import { runStdioServer } from "file:///D:/code/mcp-surfaces/packages/structured-command-mcp/dist/src/main.js";

await runStdioServer({
  siteRoot: "D:\\code\\narada",
  storageRoot: "D:\\code\\narada",
  allowedRoot: "D:\\code",
  allowedCommands: ["railway", "cargo", "pnpm"],
});
