import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  projectCouncilMetadata,
  projectCouncilOriginalReadSchema,
  type ProjectCouncilBinding,
} from "../../types/project-council";
import { ConversationError } from "../conversations/error";
import { privateTempDir } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { buildContextPackFromParts, contextListing } from "./context";
import {
  createProjectCouncilOriginalStore,
  projectCouncilInputHash,
  projectCouncilIntentHash,
  projectCouncilProfileHash,
} from "./project-original-store";
import { providerEndpointSnapshot } from "./providers";
import { parseCouncilProfileJson } from "./types";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

function fixture() {
  const home = privateTempDir("project-council-original-");
  homes.push(home);
  const profilePath = resolve(import.meta.dir, "../../councils/default.json");
  const parsed = parseCouncilProfileJson(readFileSync(profilePath, "utf8"));
  if (!parsed.ok)
    throw new Error("The inert Council profile fixture is invalid.");
  const workspace = resolve(home, "workspace");
  const binding: ProjectCouncilBinding = {
    projectId: "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12",
    workspace,
    catalogRevision: 1,
    scopeHash: "a".repeat(64),
    profileHash: projectCouncilProfileHash(parsed.value),
  };
  const store = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: binding.projectId,
  });
  const prepared = (source: string) => {
    const context = buildContextPackFromParts({
      kind: "stdin",
      displayName: "Pasted review text",
      locator: "Pasted review text",
      maxBytes: 1024,
      parts: [{ label: "review text", chunks: [{ text: source }] }],
    });
    return {
      binding,
      inputHash: projectCouncilInputHash({ source }),
      profileChoice: profilePath,
      profile: parsed.value,
      providerEndpoints: providerEndpointSnapshot(parsed.value, {}),
      context,
      listing: contextListing(context),
      options: {
        maxUsd: 0.25,
        maxBytes: 1024,
        redactSecrets: false,
        deepDiscussion: false,
      },
    };
  };
  return { home, workspace, binding, profilePath, store, prepared };
}

test("project Council originals are durable, exact-retry idempotent, single-dispatch, and non-evicting", async () => {
  const { home, workspace, binding, prepared } = fixture();
  const firstStore = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: binding.projectId,
  });
  const input = prepared("Review the inert project fixture exactly once.");
  const first = await firstStore.reservePrepared(input);
  expect(first.created).toBe(true);
  expect(projectCouncilIntentHash(first.original)).toBe(
    first.original.intentHash,
  );
  expect(
    projectCouncilIntentHash({
      ...first.original,
      state: "running",
      updatedAt: new Date(
        Date.parse(first.original.updatedAt) + 1000,
      ).toISOString(),
      dispatchClaimedAt: new Date(
        Date.parse(first.original.updatedAt) + 1000,
      ).toISOString(),
    }),
  ).toBe(first.original.intentHash);

  const reopened = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: input.binding.projectId,
  });
  const retry = await reopened.reservePrepared(input);
  expect(retry.created).toBe(false);
  expect(retry.original.requestId).toBe(first.original.requestId);
  expect(retry.original.context).toEqual(input.context);
  expect(
    reopened.read(first.original.binding.projectId, first.original.requestId),
  ).toEqual(first.original);

  const exactBinding = {
    ...input.binding,
    scopeHash: "b".repeat(64),
  };
  await expect(
    reopened.findActive(exactBinding.projectId, exactBinding, input.inputHash),
  ).rejects.toBeInstanceOf(ConversationError);
  await expect(
    reopened.reservePrepared({
      ...input,
      inputHash: projectCouncilInputHash({ source: "different" }),
    }),
  ).rejects.toBeInstanceOf(ConversationError);

  let validationCalls = 0;
  const claimed = await reopened.claimDispatch(
    first.original.binding.projectId,
    first.original.requestId,
    first.original.intentHash,
    async () => {
      validationCalls++;
    },
  );
  expect(claimed.created).toBe(true);
  const replay = await reopened.claimDispatch(
    first.original.binding.projectId,
    first.original.requestId,
    first.original.intentHash,
    async () => {
      validationCalls++;
    },
  );
  expect(replay.created).toBe(false);
  expect(validationCalls).toBe(1);

  await reopened.setTerminal(
    first.original.binding.projectId,
    first.original.requestId,
    first.original.intentHash,
    "completed",
  );
  const next = await reopened.reservePrepared(
    prepared("A second explicit review after the first is terminal."),
  );
  expect(next.created).toBe(true);
  expect(next.original.requestId).not.toBe(first.original.requestId);
  expect(
    reopened.read(first.original.binding.projectId, first.original.requestId)
      .state,
  ).toBe("completed");
});

test("project Council summary labels redact the complete text before truncating", async () => {
  const { prepared, store } = fixture();
  const reserved = await store.reservePrepared(
    prepared("A protected original for label projection."),
  );
  const label = `${"a".repeat(250)}\u200bOPENAI_API_KEY=abcZq9Zq8Zq7Zq6Zq5Zq4`;
  const original = {
    ...reserved.original,
    context: {
      ...reserved.original.context,
      source: {
        ...reserved.original.context.source,
        displayName: label,
      },
    },
    profile: { ...reserved.original.profile, title: label },
  };
  const metadata = projectCouncilMetadata(original);
  expect(projectCouncilOriginalReadSchema.parse({ metadata, original })).toEqual({
    metadata,
    original,
  });
  expect(metadata.sourceName).toHaveLength(256);
  expect(metadata.profileTitle).toHaveLength(256);
  expect(metadata.sourceName).not.toContain("\u200b");
  expect(metadata.profileTitle).not.toContain("\u200b");
  expect(metadata.sourceName).not.toContain("abcZq9Zq8Zq7Zq6Zq5Zq4");
  expect(metadata.profileTitle).not.toContain("abcZq9Zq8Zq7Zq6Zq5Zq4");
});

test("a changed saved original is refused rather than repaired or replaced", async () => {
  const { home, workspace, binding, store, prepared } = fixture();
  const reserved = await store.reservePrepared(
    prepared("A protected original."),
  );
  const file = resolve(
    home,
    "council-reviews",
    `${createHash("sha256").update(`${workspace}\0${binding.projectId}`, "utf8").digest("hex")}.json`,
  );
  const changed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof changed !== "object" ||
    changed === null ||
    Array.isArray(changed) ||
    !("records" in changed) ||
    !Array.isArray(changed.records) ||
    typeof changed.records[0] !== "object" ||
    changed.records[0] === null ||
    Array.isArray(changed.records[0]) ||
    !("context" in changed.records[0]) ||
    typeof changed.records[0].context !== "object" ||
    changed.records[0].context === null ||
    Array.isArray(changed.records[0].context) ||
    !("evidence" in changed.records[0].context) ||
    !Array.isArray(changed.records[0].context.evidence) ||
    typeof changed.records[0].context.evidence[0] !== "object" ||
    changed.records[0].context.evidence[0] === null ||
    Array.isArray(changed.records[0].context.evidence[0]) ||
    !("content" in changed.records[0].context.evidence[0])
  )
    throw new Error("The stored Council original fixture is malformed.");
  changed.records[0].context.evidence[0].content = "tampered";
  writeOwnerOnly(file, JSON.stringify(changed));

  expect(() =>
    store.read(binding.projectId, reserved.original.requestId),
  ).toThrow(ConversationError);
  expect(() => store.discover(binding.projectId)).toThrow(ConversationError);
});

test("different projects in one workspace have independent retained journals", async () => {
  const { home, workspace, binding, prepared } = fixture();
  const firstStore = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: binding.projectId,
  });
  const firstInput = prepared("Same workspace, first project.");
  const first = await firstStore.reservePrepared(firstInput);
  const secondProjectId = "project-3c5f9a1b-85b3-4d71-8e3a-6c9140275f20";
  const secondBinding = { ...binding, projectId: secondProjectId };
  const secondStore = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: secondProjectId,
  });
  const secondInput = {
    ...prepared("Same workspace, first project."),
    binding: secondBinding,
    inputHash: projectCouncilInputHash({
      projectId: secondProjectId,
      source: "Same workspace, first project.",
    }),
  };
  const second = await secondStore.reservePrepared(secondInput);
  expect(second.created).toBe(true);
  expect(second.original.requestId).not.toBe(first.original.requestId);
  expect(firstStore.read(binding.projectId, first.original.requestId)).toEqual(
    first.original,
  );
  expect(secondStore.read(secondProjectId, second.original.requestId)).toEqual(
    second.original,
  );
});
