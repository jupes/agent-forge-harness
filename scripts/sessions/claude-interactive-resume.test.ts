import { expect, test } from "bun:test";
import { CLAUDE_ALLOWED_TOOLS } from "../executors/claude-tools";
import { serializeClaudeInteractiveResume } from "./claude-interactive-resume";

const uuid = "8fd8ce1a-a0ad-4f89-a756-93f414b1640a";
const snapshot = (flags: string[]) => ({
  version: 1 as const,
  provider: "claude" as const,
  smith: "fixture",
  cwd: "C:\\repo\\worktree",
  launch: {
    mode: "chat" as const,
    model: "claude-sonnet-4-5",
    prompt: "private prompt must never enter terminal argv",
    permissionMode: "plan" as const,
    effort: "high" as const,
    context: { projectId: "project-fixture", repository: "C:\\repo", worktree: "C:\\repo\\worktree" },
  },
  capabilities: {
    version: "2.1.42",
    flags,
    modelEfforts: { "claude-sonnet-4-5": ["high"] },
  },
});

test("interactive resume uses only the exact saved identity and capability-backed safe options", () => {
  const argv = serializeClaudeInteractiveResume({
    executable: "C:\\Program Files\\Claude\\claude.exe",
    sessionId: uuid,
    snapshot: snapshot([
      "--resume",
      "--model",
      "--allowedTools",
      "--permission-mode",
      "--effort",
    ]),
  });
  expect(argv).toEqual([
    "C:\\Program Files\\Claude\\claude.exe",
    "--resume",
    uuid,
    "--model",
    "claude-sonnet-4-5",
    "--permission-mode",
    "plan",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS.join(","),
    "--effort",
    "high",
  ]);
  expect(argv.join(" ")).not.toContain("private prompt");
  expect(argv).not.toContain("--print");
  expect(argv).not.toContain("--continue");
  expect(argv).not.toContain("--permission-prompts");
});

test("interactive resume refuses a missing verified flag instead of changing saved options", () => {
  expect(() =>
    serializeClaudeInteractiveResume({
      executable: "C:\\Claude\\claude.exe",
      sessionId: uuid,
      snapshot: snapshot(["--resume", "--model", "--allowedTools"]),
    }),
  ).toThrow("cannot resume this Chat safely");
  expect(() =>
    serializeClaudeInteractiveResume({
      executable: "C:\\Claude\\claude.exe",
      sessionId: "latest",
      snapshot: snapshot(["--resume", "--model", "--allowedTools", "--permission-mode", "--effort"]),
    }),
  ).toThrow("native identity");
});

test("interactive resume rejects corrupted modes and headless-only policy", () => {
  const flags = ["--resume", "--model", "--allowedTools", "--permission-mode"];
  const nonChat = snapshot(flags);
  Object.assign(nonChat.launch, { mode: "task" });
  expect(() =>
    serializeClaudeInteractiveResume({
      executable: "C:\\Claude\\claude.exe",
      sessionId: uuid,
      snapshot: nonChat,
    }),
  ).toThrow("native identity");

  const forbiddenPermission = snapshot(flags);
  Object.assign(forbiddenPermission.launch, { permissionMode: "bypassPermissions" });
  expect(() =>
    serializeClaudeInteractiveResume({
      executable: "C:\\Claude\\claude.exe",
      sessionId: uuid,
      snapshot: forbiddenPermission,
    }),
  ).toThrow("native identity");

  const headlessPolicy = snapshot(flags);
  Object.assign(headlessPolicy.launch, { maxBudgetUsd: 2 });
  expect(() =>
    serializeClaudeInteractiveResume({
      executable: "C:\\Claude\\claude.exe",
      sessionId: uuid,
      snapshot: headlessPolicy,
    }),
  ).toThrow("unsupported terminal policy");
});

test("interactive resume cannot turn a shell-like path or session selector into execution", () => {
  for (const executable of [
    "claude",
    "C:\\Claude\\claude.cmd",
    "C:\\Claude\\claude.exe & whoami",
  ])
    expect(() =>
      serializeClaudeInteractiveResume({
        executable,
        sessionId: uuid,
        snapshot: snapshot(["--resume", "--model", "--allowedTools", "--permission-mode", "--effort"]),
      }),
    ).toThrow("native identity");
});
