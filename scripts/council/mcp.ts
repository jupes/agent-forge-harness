#!/usr/bin/env bun
/** Source Council MCP CLI; reusable composition imports only mcp-runtime. */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isMain } from "../is-main";
import { createCouncilMcpServer } from "./mcp-runtime";

export * from "./mcp-runtime";

if (isMain(import.meta)) {
  // Loaded here, not at the top: the ledger needs Bun's SQLite, and this
  // module's exports are imported by callers that must not load it.
  const { councilLedger } = await import("./ledger-wiring");
  serveStdio(() => createCouncilMcpServer(councilLedger(process.env)));
}
