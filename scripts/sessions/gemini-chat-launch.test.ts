import { expect, test } from "bun:test";
import { serializeGeminiChat } from "./gemini-task";

test("Gemini Chat uses ACP flags and private inline data without requiring the Task stream flag", () => {
  const actual = serializeGeminiChat(
    {
      route: "gemini-cli",
      mode: "chat",
      cwd: "C:/fixture/worktree",
      prompt: "Private 🌱",
      model: "exact-model",
      approvalMode: "plan",
      sandbox: true,
      attachments: [{ kind: "text", name: "note", text: "@private-file" }],
    },
    {
      version: "0.65.0",
      flags: ["--acp", "--model", "--approval-mode", "--sandbox"],
    },
  );
  expect(actual.argv).toEqual([
    "--acp",
    "--model",
    "exact-model",
    "--approval-mode",
    "plan",
    "--sandbox",
  ]);
  expect(actual.stdin).toBe(
    'Private 🌱\n\n<agent-forge-chat-data>\n{"attachments":[{"kind":"text","name":"note","text":"\\u0040private-file"}]}\n</agent-forge-chat-data>',
  );
  expect(actual.equivalentCommand).not.toContain("Private");
  expect(actual.requiredFlags).not.toContain("--output-format");
  expect(() =>
    serializeGeminiChat(
      {
        route: "gemini-cli",
        mode: "chat",
        cwd: "C:/fixture/worktree",
        prompt: "private",
      },
      { version: "0.65.0", flags: ["--output-format"] },
    ),
  ).toThrow("--acp");
});
