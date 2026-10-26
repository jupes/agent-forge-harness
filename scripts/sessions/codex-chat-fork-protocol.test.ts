import { expect, test } from "bun:test";
import {
  canonicalCodexChatForkOriginal,
  codexChatForkIntentSchema,
  codexChatForkOriginalHash,
} from "./codex-chat-fork-protocol";

const base = {
  kind: "codex-chat-fork" as const,
  hashVersion: 1 as const,
  projectId: "project-00000000-0000-4000-8000-000000000001",
  workspaceKey: "c:/work/alpha",
  parentSessionId: "session-0199a213-81c0-7800-8aa1-bbab2a035a51",
  throughTurnRequestId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
  requestId: "0199a213-81c0-7800-8aa1-bbab2a035a55",
  protocolVersion: "0.163.0-alpha.10.2" as const,
};

test("Fork original canonical bytes and hash match the reviewed known vector", () => {
  expect(canonicalCodexChatForkOriginal(base)).toBe(
    '{"kind":"codex-chat-fork","hashVersion":1,"projectId":"project-00000000-0000-4000-8000-000000000001","workspaceKey":"c:/work/alpha","parentSessionId":"session-0199a213-81c0-7800-8aa1-bbab2a035a51","throughTurnRequestId":"0199a213-81c0-7800-8aa1-bbab2a035a54","requestId":"0199a213-81c0-7800-8aa1-bbab2a035a55","protocolVersion":"0.163.0-alpha.10.2"}',
  );
  expect(codexChatForkOriginalHash(base)).toBe(
    "e50ec5b90eeb243f0bdb64ab0c5e2d21a7f7bb2a124be2c29ade50b1613bfdbd",
  );
});

test("Fork intent allows only its request UUID and committed parent-turn UUID", () => {
  const intent = {
    requestId: base.requestId,
    throughTurnRequestId: base.throughTurnRequestId,
  };
  expect(codexChatForkIntentSchema.parse(intent)).toEqual(intent);
  for (const extra of [
    { prompt: "synthetic Start" },
    { nativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a56" },
    { workspaceKey: "c:/client/selected" },
    { path: "C:/client/selected" },
    { notSent: true },
  ])
    expect(
      codexChatForkIntentSchema.safeParse({ ...intent, ...extra }).success,
    ).toBe(false);
});

test("each canonical authority and identity field changes the original hash", () => {
  const changes = [
    { projectId: "project-00000000-0000-4000-8000-000000000002" },
    { workspaceKey: "c:/work/beta" },
    { parentSessionId: "session-0199a213-81c0-7800-8aa1-bbab2a035a52" },
    { throughTurnRequestId: "0199a213-81c0-7800-8aa1-bbab2a035a56" },
    { requestId: "0199a213-81c0-7800-8aa1-bbab2a035a57" },
  ];
  for (const change of changes)
    expect(codexChatForkOriginalHash({ ...base, ...change })).not.toBe(
      codexChatForkOriginalHash(base),
    );
  expect(() =>
    canonicalCodexChatForkOriginal({ ...base, prompt: "x" }),
  ).toThrow();
});
