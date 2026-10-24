import { expect, test } from "bun:test";
import { join } from "node:path";
import type { GeminiChatStartRequest } from "../../types/gemini-owned-chat";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "./codex-owned-protocol";
import { geminiTaskStartSchema } from "./gemini-owned-protocol";

const chat = {
  provider: "gemini",
  requestId: "a5832fa0-7a21-403b-8184-44892f0d8d86",
  smith: "gemini-journeyman",
  repository: "/fixture",
  worktree: "/fixture/tree",
  about: [],
  launch: { route: "gemini-cli", mode: "chat", prompt: "  Private question\n" },
} satisfies GeminiChatStartRequest;

test("explicit Gemini ACP Chat keeps CLI defaults omitted and refuses caller authority", () => {
  expect(parseOwnedSessionStart(chat)).toEqual(chat);
  expect(geminiTaskStartSchema.safeParse(chat).success).toBe(false);
  expect(canonicalOwnedSessionStart(chat)).toContain('"mode":"chat"');
  for (const launch of [
    { ...chat.launch, cwd: "/foreign" },
    { ...chat.launch, policyFiles: ["/foreign"] },
    { ...chat.launch, includeDirectories: ["/foreign"] },
    { ...chat.launch, model: "" },
    { ...chat.launch, effort: "high" },
    { ...chat.launch, approvalMode: "yolo" },
    { ...chat.launch, sandbox: false },
    { ...chat.launch, attachments: [{ kind: "image", name: "a", data: "a" }] },
  ])
    expect(() => parseOwnedSessionStart({ ...chat, launch })).toThrow();
});

test("the strict owned private reader remains a browser-pure import graph", async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "codex-owned-journal.ts")],
    target: "browser",
    external: ["node:*", "bun:*"],
  });
  expect(result.logs.map((item) => item.message)).toEqual([]);
  expect(result.success).toBe(true);
  for (const output of result.outputs)
    expect(
      (await output.text()).match(
        /(?:from|import)\s*["'](?:node:|bun:)[^"']+/,
      )?.[0] ?? null,
    ).toBeNull();
});
