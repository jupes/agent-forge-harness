/** Source hearth entry. Import server-runtime for explicit source/packaged composition. */

import { fileURLToPath } from "node:url";
import { isMain } from "../is-main";
import { MCP_STDIO_FLAG } from "./mcp-stdio-entry";
import { runHearthServer } from "./server-runtime";

export * from "./server-runtime";

if (isMain(import.meta)) {
  void runHearthServer(process.argv.slice(2), {
    agentMcpStdioCommand: [
      process.execPath,
      fileURLToPath(new URL("./compiled-entry.ts", import.meta.url)),
      MCP_STDIO_FLAG,
    ],
  });
}
