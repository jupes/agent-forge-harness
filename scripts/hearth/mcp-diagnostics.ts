import { resolve } from "node:path";

export type McpDiagnosticEvent =
  | { kind: "serving"; root: string; operator: boolean }
  | { kind: "startup"; error: unknown }
  | { kind: "protocol"; error: Error };

/** Generic packaged output never reads raw error details; legacy CLI text stays compatible. */
export function hearthMcpDiagnosticLine(
  event: McpDiagnosticEvent,
  mode?: "generic",
): string {
  if (mode === "generic") {
    if (event.kind === "serving") return "hearth:mcp: agent stdio ready.\n";
    if (event.kind === "startup") return "hearth:mcp: stdio startup failed.\n";
    return "hearth:mcp: protocol error.\n";
  }
  if (event.kind === "serving")
    return `hearth:mcp: serving ${resolve(event.root)} as ${event.operator ? "an operator session" : "an agent session (no operator token)"}\n`;
  if (event.kind === "startup")
    return `hearth:mcp cannot start: ${event.error instanceof Error ? event.error.message : String(event.error)}\n`;
  const text = event.error.message
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?");
  return `hearth:mcp: ${event.error.name}: ${/^[[{]/.test(text) ? "a message that is not a valid request" : text.slice(0, 200)}\n`;
}
