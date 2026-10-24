import { expect, test } from "bun:test";
import { ownedSessionControls } from "../../apps/desktop/src/session-controls";
import type { ConversationPage } from "../../types/conversation";
import type { PreparedGeminiChat } from "../../types/gemini-chat-runtime";
import type { GeminiChatOwnedRecord } from "../../types/gemini-owned-chat";

const requestId = "925f49e8-14b5-46d2-80f5-a143ae120bed",
  at = "2026-10-23T00:00:00Z";
const record: GeminiChatOwnedRecord = {
  id: `session-${requestId}`,
  requestId,
  projectId: "project-fixture",
  requestHash: "a".repeat(64),
  createdAt: at,
  provider: "gemini",
  route: "gemini-cli",
  mode: "chat",
  smith: "gemini",
  requestedModel: null,
  requestedEffort: null,
  workspace: "/repo",
  repository: "/repo",
  worktree: "/repo",
};
const snapshot: PreparedGeminiChat = {
  version: 1,
  provider: "gemini",
  smith: "gemini",
  canonicalRoot: "/repo",
  canonicalCwd: "/repo",
  command: ["/native/gemini"],
  paths: [],
  capabilities: { version: "0.65.0", flags: ["--acp"] },
  launch: {
    route: "gemini-cli",
    mode: "chat",
    cwd: "/repo",
    prompt: "PRIVATE",
  },
};
const page: ConversationPage = {
  version: 1,
  projectId: record.projectId,
  conversationId: record.id,
  revision: 1,
  binding: { provider: "gemini", sessionId: "native", version: "0.65.0" },
  frames: [
    {
      seq: 1,
      turnId: requestId,
      at,
      event: { kind: "user", text: "PRIVATE", about: [], geminiChat: snapshot },
    },
  ],
  turns: [
    {
      requestId,
      hash: "a".repeat(64),
      phase: "completed",
      createdAt: at,
      updatedAt: at,
      reason: null,
      owner: null,
    },
  ],
  more: false,
  nextCursor: 1,
  lastSequence: 1,
  request: null,
  controllable: false,
};
const input = {
  record,
  page,
  loaded: true,
  live: true,
  pending: false,
  stopping: false,
};
test("Gemini Chat uses its actual ACP preview and exact native binding, never Task serialization", () => {
  const controls = ownedSessionControls(input);
  expect(controls.commandPreview).toContain("--acp");
  expect(controls.commandPreview).not.toContain("--output-format");
  expect(controls.commandPreview).not.toContain("PRIVATE");
  expect(controls.resume.available).toBe(true);
  expect(controls.permissions.inline).toBe(true);
  expect([controls.fork.available, controls.terminal.available]).toEqual([
    false,
    false,
  ]);
  for (const delta of [
    { live: false },
    { loaded: false },
    { pending: true },
    { stopping: true },
    { readError: "failed" },
    { feedInterrupted: true },
    { page: { ...page, projectId: "foreign" } },
    { page: { ...page, binding: null } },
    {
      page: {
        ...page,
        binding: {
          provider: "gemini" as const,
          sessionId: "native",
          version: "different",
        },
      },
    },
    { page: { ...page, frames: [] } },
  ])
    expect(ownedSessionControls({ ...input, ...delta }).resume.available).toBe(
      false,
    );
});
test("a saved native terminal withdraws Stop and permission controls before generic finalization", () => {
  const active = {
    ...page,
    controllable: true,
    turns: page.turns.map((turn) => ({ ...turn, phase: "running" as const })),
  };
  expect(
    ownedSessionControls({ ...input, page: active }).permissions.available,
  ).toBe(true);
  expect(ownedSessionControls({ ...input, page: active }).stop.available).toBe(
    true,
  );
  const ended: ConversationPage = {
    ...active,
    frames: [
      ...active.frames,
      {
        seq: 2,
        turnId: requestId,
        at,
        event: {
          kind: "coding-gemini-chat",
          provider: "gemini",
          version: "0.65.0",
          event: {
            kind: "outcome",
            outcome: {
              phase: "completed",
              sessionId: "native",
              reason: null,
              stopReason: "end_turn",
              usage: null,
            },
            exitCode: 0,
            stopped: false,
            timedOut: false,
            stderr: { text: "", truncated: false },
          },
        },
      },
    ],
  };
  const controls = ownedSessionControls({ ...input, page: ended });
  expect([
    controls.stop.available,
    controls.permissions.available,
    controls.resume.available,
  ]).toEqual([false, false, false]);
});
