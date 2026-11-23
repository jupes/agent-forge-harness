import { afterEach, expect, test } from "bun:test";
import type { GeminiOwnedSessionMetadata } from "../../types/gemini-owned-task";
import { sessionOwnershipMetadataSchema } from "../projects/session-observations-protocol";
import { scratchDirs } from "../test-scratch";
import { ownedCodingSessionSchema } from "./codex-owned-wire-protocol";
import { geminiOwnedMetadataSchema } from "./gemini-owned-metadata";
import { createSessionRegistry } from "./registry";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const project = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  original = "f144c851-7152-463e-aa26-a8bd191b3d73";

test("Gemini owns an explicit metadata-only registry branch without invented model or effort facts", async () => {
  const home = scratch.make("owned-gemini-registry-"),
    metadata = {
      provider: "gemini",
      route: "gemini-cli",
      mode: "task",
      smith: "gemini-example",
      workspace: home,
      repository: home,
      worktree: home,
      requestedModel: null,
      requestedEffort: null,
    } satisfies GeminiOwnedSessionMetadata;
  expect(geminiOwnedMetadataSchema.parse(metadata)).toEqual(metadata);
  const registry = createSessionRegistry(home, "gemini"),
    hash = "a".repeat(64);
  let prepared = 0;
  const first = await registry.reserve(project, original, hash, async () => {
    prepared++;
    return metadata;
  });
  const retry = await registry.reserve(project, original, hash, async () => {
    throw Error("Mutable preparation must not run on retry");
  });
  expect(retry).toEqual(first);
  expect(prepared).toBe(1);
  expect(createSessionRegistry(home).list(project)).toEqual([]);
  expect(createSessionRegistry(home).listAll(project)).toEqual([first]);
  expect(createSessionRegistry(home).listWorkspace(home)).toEqual([first]);
  expect(ownedCodingSessionSchema.parse(first)).toEqual(first);
  expect(
    sessionOwnershipMetadataSchema.parse({ record: first, origin: null }),
  ).toEqual({ record: first, origin: null });
  await expect(
    registry.reserve(project, original, "b".repeat(64), async () => metadata),
  ).rejects.toThrow("different");
  await expect(
    createSessionRegistry(home, "codex").reserve(
      project,
      original,
      hash,
      async () => {
        throw Error("Foreign provider preparation must not run");
      },
    ),
  ).rejects.toThrow("different");
  expect(() => createSessionRegistry(home).read(project, first.id)).toThrow(
    "different provider",
  );
  expect(first).not.toHaveProperty("nativeSessionId");
  expect(first).not.toHaveProperty("pid");
});

test("Gemini metadata cannot carry private body, arbitrary authority or unsupported native facts", () => {
  const metadata = {
    provider: "gemini",
    route: "gemini-cli",
    mode: "task",
    smith: "gemini-example",
    workspace: "/fixture",
    repository: "/fixture",
    worktree: "/fixture",
    requestedModel: null,
    requestedEffort: null,
  };
  for (const extra of [
    { prompt: "private" },
    { command: ["gemini"] },
    { token: "synthetic" },
    { pid: 1 },
    { configuredModel: "reported" },
  ])
    expect(
      geminiOwnedMetadataSchema.safeParse({ ...metadata, ...extra }).success,
    ).toBe(false);
  for (const change of [
    { route: "antigravity" },
    { mode: "chat" },
    { requestedEffort: "high" },
    { provider: "codex" },
  ])
    expect(
      geminiOwnedMetadataSchema.safeParse({ ...metadata, ...change }).success,
    ).toBe(false);
});
