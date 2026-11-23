import { expect, test } from "bun:test";
import type { CodexChatStartRequest } from "../../types/codex-owned-chat";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "./codex-owned-protocol";

const start = {
  provider: "codex",
  requestId: "a5832fa0-7a21-403b-8184-44892f0d8d86",
  smith: "codex-journeyman",
  repository: "/fixture",
  worktree: "/fixture/tree",
  launch: {
    mode: "chat",
    model: "gpt-example-exact",
    prompt: "  Private Chat question\n",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    attachments: [{ kind: "text", name: "note.txt", text: "private context" }],
  },
} satisfies CodexChatStartRequest;

test("an explicit Codex Chat intent preserves bounded input and narrow native approval policy", () => {
  expect(parseOwnedSessionStart(start)).toEqual(start);
  expect(canonicalOwnedSessionStart(start)).toContain('"mode":"chat"');
  for (const launch of [
    { ...start.launch, cwd: "/forged" },
    { ...start.launch, resumeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    { ...start.launch, approvalPolicy: "untrusted" },
    { ...start.launch, sandbox: "danger-full-access" },
    { ...start.launch, command: ["codex"] },
    { ...start.launch, context: { projectId: "forged" } },
  ])
    expect(() => parseOwnedSessionStart({ ...start, launch })).toThrow();
});
