#!/usr/bin/env bun
/** Source MCP CLI; packaged entries import only mcp-runtime. */
import { createCouncilMcpServer } from "../council/mcp-runtime";
import { isMain } from "../is-main";
import { parseArgs, serveHearthMcp } from "./mcp-runtime";

export * from "./mcp-runtime";

if (isMain(import.meta)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(
      `hearth:mcp: ${args.error}\nUsage: bun run hearth:mcp [--operator] [--root <dir>]\n`,
    );
    process.exit(2);
  }
  // Loaded here, not at the top: the ledger needs Bun's SQLite, and a
  // re-exported council tool records its run as it does under council:mcp.
  const { councilLedger } = await import("../council/ledger-wiring");
  serveHearthMcp({
    root: args.root ?? process.cwd(),
    operator: args.operator,
    council: () => createCouncilMcpServer(councilLedger(process.env)),
  });
}
