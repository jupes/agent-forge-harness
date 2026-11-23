import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexChatForkOriginSchema } from "./codex-chat-fork-origin-protocol";

const source = (path: string) =>
  readFileSync(join(import.meta.dir, path), "utf8");

describe("browser-safe Codex Fork origin protocol", () => {
  test("validates the origin without loading the server journal protocol", () => {
    expect(
      codexChatForkOriginSchema.safeParse({
        kind: "codex-chat-fork",
        projectId: "project-01234567-89ab-4cde-8fab-0123456789ab",
        parentSessionId: "session-01234567-89ab-4cde-8fab-0123456789ab",
        throughTurnRequestId: "01234567-89ab-4cde-8fab-0123456789ab",
        parentTurnHash: "a".repeat(64),
        parentNativeThreadId: "01234567-89ab-4cde-8fab-0123456789ab",
        throughNativeTurnId: "11234567-89ab-4cde-8fab-0123456789ab",
        childNativeThreadId: "21234567-89ab-4cde-8fab-0123456789ab",
        captureHash: "b".repeat(64),
        protocolVersion: "0.163.0-alpha.10.2",
      }).success,
    ).toBe(true);
  });

  test("keeps the browser origin dependency graph free of Node and Bun imports", () => {
    const graph = [
      source("codex-chat-fork-origin-protocol.ts"),
      source("identity-protocol.ts"),
      source("../projects/scope.ts"),
    ];

    for (const fileSource of graph)
      expect(fileSource).not.toMatch(/from\s+["'](?:node|bun):/);
  });
});
