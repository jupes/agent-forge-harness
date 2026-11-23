import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { hearthMcpDiagnosticLine } from "./mcp-diagnostics";

test("legacy CLI diagnostics retain their existing bounded protocol error and session text", () => {
  expect(
    hearthMcpDiagnosticLine({ kind: "serving", root: ".", operator: false }),
  ).toBe(
    `hearth:mcp: serving ${resolve(".")} as an agent session (no operator token)\n`,
  );
  expect(
    hearthMcpDiagnosticLine({
      kind: "startup",
      error: Error("fixture startup"),
    }),
  ).toBe("hearth:mcp cannot start: fixture startup\n");
  expect(
    hearthMcpDiagnosticLine({
      kind: "protocol",
      error: Error('{"raw":"fixture"}'),
    }),
  ).toBe("hearth:mcp: Error: a message that is not a valid request\n");
});

test("packaged agent diagnostics are fixed codes and never inspect paths or raw errors", () => {
  expect(
    hearthMcpDiagnosticLine(
      { kind: "serving", root: "PRIVATE_ROOT", operator: true },
      "generic",
    ),
  ).toBe("hearth:mcp: agent stdio ready.\n");
  const privateError = Error("PRIVATE_BODY");
  Object.defineProperty(privateError, "message", {
    get() {
      throw Error("raw message getter evaluated");
    },
  });
  Object.defineProperty(privateError, "name", {
    get() {
      throw Error("raw name getter evaluated");
    },
  });
  expect(
    hearthMcpDiagnosticLine(
      { kind: "startup", error: privateError },
      "generic",
    ),
  ).toBe("hearth:mcp: stdio startup failed.\n");
  expect(
    hearthMcpDiagnosticLine(
      { kind: "protocol", error: privateError },
      "generic",
    ),
  ).toBe("hearth:mcp: protocol error.\n");
});
