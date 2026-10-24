import { expect, test } from "bun:test";
import type { ConversationState } from "../../types/conversation";
import type { PreparedGeminiTask } from "../../types/gemini-task-runtime";
import {
  eventSchema,
  parsePreparedConversationSend,
} from "../conversations/protocol";
import {
  ownedCodingEventSchema,
  ownedCodingPageSchema,
  ownedCodingStateSchema,
  parseOwnedPreparedConversationSend,
} from "./codex-owned-journal";

const requestId = "a5832fa0-7a21-403b-8184-44892f0d8d86";
const nativeId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const snapshot: PreparedGeminiTask = {
  version: 1,
  provider: "gemini",
  smith: "gemini-example",
  canonicalRoot: "/fixture",
  canonicalCwd: "/fixture",
  command: ["/fixture/inert"],
  paths: [],
  launch: {
    route: "gemini-cli",
    mode: "task",
    cwd: "/fixture",
    prompt: "Exact private Gemini 🌱\n",
    context: {
      projectId: "project-test",
      repository: "/fixture",
      worktree: "/fixture",
      about: [],
    },
  },
  capabilities: { version: "0.65.0", flags: ["--output-format"] },
};
const user = {
  kind: "user" as const,
  text: snapshot.launch.prompt,
  about: [],
  geminiTask: snapshot,
};
const process = {
  kind: "coding-gemini-task" as const,
  provider: "gemini" as const,
  version: "0.65.0" as const,
  event: {
    kind: "process" as const,
    pid: 42,
    bootstrapPid: 41,
    smith: snapshot.smith,
    requestedModel: null,
  },
};
const identity = {
  ...process,
  event: {
    kind: "identity" as const,
    provider: "gemini" as const,
    route: "gemini-cli" as const,
    version: "0.65.0",
    sessionId: nativeId,
    configuredModel: "auto-configured-example",
  },
};
const state = (): ConversationState => ({
  version: 1,
  projectId: "project-test",
  conversationId: `session-${requestId}`,
  revision: 5,
  binding: { provider: "gemini", sessionId: nativeId, version: "0.65.0" },
  turns: [
    {
      requestId,
      hash: "a".repeat(64),
      phase: "running",
      createdAt: "2026-10-23T08:00:00.000Z",
      updatedAt: "2026-10-23T08:00:00.000Z",
      reason: null,
      owner: requestId,
    },
  ],
  frames: [
    user,
    process,
    {
      kind: "identity" as const,
      provider: "gemini" as const,
      sessionId: nativeId,
      version: "0.65.0",
    },
    identity,
  ].map((event, index) => ({
    seq: index + 1,
    turnId: requestId,
    at: "2026-10-23T08:00:00.000Z",
    event,
  })),
});

test("Gemini private launch and native facts are confined to the owned codec, leaving Keeper sealed", () => {
  const request = {
    requestId,
    expectedRevision: 0,
    text: user.text,
    about: [],
    geminiTask: snapshot,
  };
  expect(parseOwnedPreparedConversationSend(request)).toEqual(request);
  expect(() => parsePreparedConversationSend(request)).toThrow();
  for (const event of [user, process, identity]) {
    expect(ownedCodingEventSchema.safeParse(event).success).toBe(true);
    expect(eventSchema.safeParse(event).success).toBe(false);
  }
  expect(ownedCodingStateSchema.safeParse(state()).success).toBe(true);
  for (const event of [
    { ...user, text: "Changed" },
    { ...user, session: {} },
    { ...process, version: "future" },
    { ...process, event: { ...process.event, requestedEffort: "high" } },
  ])
    expect(ownedCodingEventSchema.safeParse(event).success).toBe(false);
});

test("complete Gemini history proves project, provider, version, actual process and native identity", () => {
  for (const change of [
    (value: ConversationState) => {
      value.projectId = "project-foreign";
    },
    (value: ConversationState) => {
      value.binding = {
        provider: "codex",
        sessionId: nativeId,
        version: "0.65.0",
      };
    },
    (value: ConversationState) => {
      if (value.binding) value.binding.version = "future";
    },
    (value: ConversationState) => {
      value.frames = value.frames.filter(
        (frame) => frame.event.kind !== "user",
      );
    },
    (value: ConversationState) => {
      value.frames[1] = {
        ...value.frames[1]!,
        event: {
          ...process,
          event: { ...process.event, pid: process.event.bootstrapPid },
        },
      };
    },
    (value: ConversationState) => {
      value.frames[3] = {
        ...value.frames[3]!,
        event: {
          ...identity,
          event: { ...identity.event, sessionId: requestId },
        },
      };
    },
  ]) {
    const value = state();
    change(value);
    expect(ownedCodingStateSchema.safeParse(value).success).toBe(false);
  }
});

test("partial pages admit only known Gemini process reports before binding, and never excuse full orphan history", () => {
  const value = state();
  const page = {
    ...value,
    binding: null,
    frames: [value.frames[1]],
    more: true,
    nextCursor: 2,
    lastSequence: 2,
    request: value.turns[0],
    controllable: true,
  };
  expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
  expect(
    ownedCodingStateSchema.safeParse({
      ...value,
      binding: null,
      frames: page.frames,
    }).success,
  ).toBe(false);
  expect(
    ownedCodingPageSchema.safeParse({ ...page, frames: [value.frames[3]] })
      .success,
  ).toBe(false);
});
