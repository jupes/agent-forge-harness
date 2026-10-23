import { expect, test } from "bun:test";
import {
  codexChatOwnedMetadataSchema,
  codexChatOwnedSessionSchema,
  codexOwnedMetadataSchema,
  codexOwnedSessionSchema,
} from "./codex-owned-metadata";
import {
  geminiOwnedMetadataSchema,
  geminiOwnedSessionSchema,
} from "./gemini-owned-metadata";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const origin = {
  kind: "shift",
  projectId,
  originalRequestId: "e9c8a4a8-b8ba-47a6-9727-d22d9cb4ed77",
  shiftId: "shift-20261023-063000-0001",
  runId: "run-fixture-1",
  beadId: "alpha-work",
  attempt: 1,
};
const common = {
  mode: "task",
  workspace: "/fixture/workspace",
  repository: "/fixture/workspace",
  worktree: "/fixture/workspace/trees/one",
  beadId: "alpha-work",
  smith: "fixture-smith",
};
const identity = {
  projectId,
  id: "session-2d4b98fc-2a7d-4c97-a755-ae57c850a70c",
  requestId: "32054d54-1713-4642-a7cf-c541efb752bc",
  requestHash: "a".repeat(64),
  createdAt: "2026-10-23T06:30:00.000Z",
};
const codex = {
  ...common,
  provider: "codex",
  requestedModel: "exact-model",
  requestedEffort: "high",
};
const gemini = {
  ...common,
  provider: "gemini",
  route: "gemini-cli",
  requestedModel: null,
  requestedEffort: null,
};

test.each([
  ["Codex", codex, codexOwnedMetadataSchema, codexOwnedSessionSchema],
  ["Gemini", gemini, geminiOwnedMetadataSchema, geminiOwnedSessionSchema],
] as const)("%s Task metadata composes valid managed origins and fences record project and bead identity", (_name, metadata, metadataSchema, recordSchema) => {
  expect(metadataSchema.safeParse({ ...metadata, origin }).success).toBe(true);
  const checked = recordSchema.safeParse({ ...metadata, ...identity, origin });
  expect(checked.success).toBe(true);
  if (checked.success) expect(checked.data.origin).toMatchObject(origin);
  for (const wrong of [
    { ...origin, beadId: "foreign-work" },
    { ...origin, attempt: 0 },
    { ...origin, nativePid: 1234 },
  ]) {
    expect(
      metadataSchema.safeParse({ ...metadata, origin: wrong }).success,
    ).toBe(false);
    expect(
      recordSchema.safeParse({ ...metadata, ...identity, origin: wrong })
        .success,
    ).toBe(false);
  }
  expect(
    recordSchema.safeParse({
      ...metadata,
      ...identity,
      origin: {
        ...origin,
        projectId: "project-311276b1-c573-4fe8-8ac9-97e8ca5f0304",
      },
    }).success,
  ).toBe(false);
  expect(
    metadataSchema.safeParse({ ...metadata, beadId: undefined, origin })
      .success,
  ).toBe(false);
});

test("Codex Chat retains its unowned branch and nullable effort without accepting a managed Task origin", () => {
  const chat = { ...codex, mode: "chat", requestedEffort: null };
  expect(codexChatOwnedMetadataSchema.safeParse(chat).success).toBe(true);
  expect(
    codexChatOwnedSessionSchema.safeParse({ ...chat, ...identity }).success,
  ).toBe(true);
  expect(
    codexChatOwnedMetadataSchema.safeParse({ ...chat, origin }).success,
  ).toBe(false);
  expect(
    codexChatOwnedSessionSchema.safeParse({ ...chat, ...identity, origin })
      .success,
  ).toBe(false);
  expect(codexOwnedMetadataSchema.safeParse(chat).success).toBe(false);
  expect(codexChatOwnedMetadataSchema.safeParse(codex).success).toBe(false);
});

test("provider metadata preserves exact effort/model nullability and excludes native execution fields", () => {
  expect(
    codexOwnedMetadataSchema.safeParse({ ...codex, requestedEffort: null })
      .success,
  ).toBe(true);
  expect(
    codexOwnedMetadataSchema.safeParse({
      ...codex,
      requestedEffort: "new_effort-1",
    }).success,
  ).toBe(true);
  expect(
    geminiOwnedMetadataSchema.safeParse({
      ...gemini,
      requestedModel: "gemini-3-pro",
    }).success,
  ).toBe(true);
  for (const wrong of [
    { ...codex, requestedEffort: "high effort" },
    { ...codex, requestedEffort: undefined },
  ])
    expect(codexOwnedMetadataSchema.safeParse(wrong).success).toBe(false);
  for (const wrong of [
    { ...gemini, mode: "chat" },
    { ...gemini, requestedEffort: "high" },
    { ...gemini, requestedModel: undefined },
    { ...gemini, route: "other-native" },
  ])
    expect(geminiOwnedMetadataSchema.safeParse(wrong).success).toBe(false);
  for (const [metadata, schema] of [
    [codex, codexOwnedMetadataSchema],
    [{ ...codex, mode: "chat" }, codexChatOwnedMetadataSchema],
    [gemini, geminiOwnedMetadataSchema],
  ] as const) {
    for (const extra of [
      { pid: 1234 },
      { sessionId: "native-id" },
      { argv: ["provider"] },
    ])
      expect(schema.safeParse({ ...metadata, ...extra }).success).toBe(false);
  }
});
