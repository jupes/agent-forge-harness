import { expect, test } from "bun:test";
import type { PreparedCodexTask } from "../../types/codex-task-runtime";
import {
  eventSchema,
  parsePreparedConversationSend,
  stateSchema,
} from "../conversations/protocol";
import {
  ownedCodingEventSchema,
  ownedCodingStateSchema,
  parseOwnedPreparedConversationSend,
} from "./codex-owned-journal";

const requestId = "a5832fa0-7a21-403b-8184-44892f0d8d86";
const snapshot = {
  version: 1,
  provider: "codex",
  smith: "codex-journeyman",
  cwd: "/fixture",
  canonicalCwd: "/fixture",
  launch: {
    mode: "task",
    cwd: "/fixture",
    model: "gpt-example-exact",
    sandbox: "read-only",
    approvalPolicy: "never",
    prompt: "  Exact private prompt\n",
    context: {
      projectId: "project-test",
      repository: "/fixture",
      worktree: "/fixture",
      about: [],
    },
  },
  capabilities: {
    version: "0.163.0-alpha.10.2",
    flags: ["--json", "--color", "--sandbox", "--model", "--cd", "--config"],
  },
} satisfies PreparedCodexTask;
const user = {
  kind: "user",
  text: snapshot.launch.prompt,
  about: [],
  codexTask: snapshot,
};
const usage = {
  kind: "coding-usage",
  provider: "codex",
  source: "exec.turn.completed",
  version: "0.163.0-alpha.10.2",
  usage: { inputTokens: 9, outputTokens: 6 },
};

test("Codex private intent and usage are accepted only by the addressed coding codec, while Keeper remains sealed", () => {
  const request = {
    requestId,
    expectedRevision: 0,
    text: user.text,
    about: [],
    codexTask: snapshot,
  };
  expect(parseOwnedPreparedConversationSend(request)).toEqual(request);
  expect(() => parsePreparedConversationSend(request)).toThrow();
  for (const event of [user, usage]) {
    expect(ownedCodingEventSchema.safeParse(event).success).toBe(true);
    expect(eventSchema.safeParse(event).success).toBe(false);
  }
  for (const event of [
    { ...user, session: {} },
    { ...user, text: "Different private input" },
    { ...usage, usage: { ...usage.usage, model: "invented" } },
    { ...usage, source: "estimated" },
    { ...usage, usage: { inputTokens: -1 } },
  ])
    expect(ownedCodingEventSchema.safeParse(event).success).toBe(false);
});

test("a saved Codex intent cannot project another project's private context", () => {
  const state = {
    version: 1,
    projectId: "project-test",
    conversationId: `session-${requestId}`,
    revision: 1,
    binding: null,
    turns: [
      {
        requestId,
        hash: "a".repeat(64),
        phase: "accepted",
        createdAt: "2026-10-23T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:00.000Z",
        reason: null,
        owner: null,
      },
    ],
    frames: [
      {
        seq: 1,
        turnId: requestId,
        at: "2026-10-23T00:00:00.000Z",
        event: user,
      },
    ],
  };
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  expect(stateSchema.safeParse(state).success).toBe(false);
  expect(
    ownedCodingStateSchema.safeParse({ ...state, projectId: "foreign-project" })
      .success,
  ).toBe(false);
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      binding: { provider: "claude", sessionId: "foreign", version: "1.0.0" },
    }).success,
  ).toBe(false);
  const activity = {
    kind: "coding-activity",
    provider: "codex",
    version: snapshot.capabilities.version,
    id: "reasoning-1",
    source: "codex.item.completed",
    partial: false,
    activity: {
      kind: "reasoning",
      content: { text: "Reported private summary", truncated: false },
      redacted: false,
    },
  };
  const richState = {
    ...state,
    frames: [
      ...state.frames,
      {
        ...state.frames[0],
        seq: 2,
        turnId: requestId,
        at: "2026-10-23T00:00:01.000Z",
        event: activity,
      },
    ],
  };
  expect(ownedCodingStateSchema.safeParse(richState).success).toBe(true);
  for (const event of [
    { ...activity, version: "0.164.0" },
    { ...activity, provider: "claude", source: "claude.assistant" },
  ]) {
    expect(ownedCodingEventSchema.safeParse(event).success).toBe(true);
    expect(
      ownedCodingStateSchema.safeParse({
        ...richState,
        frames: [state.frames[0], { ...richState.frames[1], event }],
      }).success,
    ).toBe(false);
  }
  expect(
    ownedCodingStateSchema.safeParse({
      ...richState,
      frames: [richState.frames[1]],
    }).success,
  ).toBe(false);
});
