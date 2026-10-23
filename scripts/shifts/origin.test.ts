import { afterEach, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { codexOwnedSessionSchema } from "../sessions/codex-owned-metadata";
import { ownedSessionSchema } from "../sessions/protocol";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../sessions/registry";
import { scratchDirs } from "../test-scratch";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const projectId = "project-05f27fd0-011b-4e0c-bb01-0da9104b1439";
const origin = {
  kind: "shift",
  projectId,
  originalRequestId: "2230bb02-1119-4c69-adad-c44116b375c1",
  shiftId: "shift-20261023-080000-1234",
  runId: "bounded-run-1",
  beadId: "bounded-task-1",
  attempt: 1,
} as const;
function fixture() {
  const root = realpathSync.native(scratch.make("shift attempt registry "));
  return {
    root,
    metadata: {
      mode: "task",
      provider: "claude",
      workspace: root,
      repository: root,
      worktree: root,
      beadId: origin.beadId,
      smith: "claude-journeyman",
      requestedModel: "claude-sonnet-5-5",
      requestedEffort: "medium",
      origin,
    } as const,
  };
}

test("the shared private session registry retains bounded shift origins for both coding providers", async () => {
  const { root, metadata } = fixture();
  const claude = await createSessionRegistry(root).reserve(
    projectId,
    "15165118-dcd6-4a5e-b6b3-ddf3b34651f3",
    "a".repeat(64),
    () => metadata,
  );
  expect(claude.origin).toEqual(origin);
  expect(ownedSessionSchema.safeParse(claude).success).toBe(true);
  const codex = await createSessionRegistry(root, "codex").reserve(
    projectId,
    "76c12d8a-a41c-41a3-a383-aac004d332e4",
    "b".repeat(64),
    () => ({
      ...metadata,
      provider: "codex",
      smith: "codex-journeyman",
      requestedModel: "gpt-exact",
    }),
  );
  expect(codex.origin).toEqual(origin);
  expect(codexOwnedSessionSchema.safeParse(codex).success).toBe(true);
  const file = sessionRegistryFile(root),
    bytes = readFileSync(file, "utf8");
  expect(createSessionRegistry(root).lookup(projectId, claude.id)).toEqual(
    claude,
  );
  expect(readFileSync(file, "utf8")).toBe(bytes);
});

test("origin project, bead, mode and attempt remain strict and ordinary records remain byte-compatible", async () => {
  const { root, metadata } = fixture();
  const registry = createSessionRegistry(root);
  const { origin: _origin, ...ordinary } = metadata;
  const original = await registry.reserve(
    projectId,
    "15165118-dcd6-4a5e-b6b3-ddf3b34651f3",
    "a".repeat(64),
    () => ordinary,
  );
  const file = sessionRegistryFile(root),
    bytes = readFileSync(file, "utf8");
  expect(registry.read(projectId, original.id)).toEqual(original);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  for (const changed of [
    {
      ...metadata,
      origin: {
        ...origin,
        projectId: "project-69e03926-471b-4fbc-b15e-e29f778361b6",
      },
    },
    { ...metadata, beadId: "another-bead" },
    { ...metadata, mode: "chat" as const },
    { ...metadata, origin: { ...origin, attempt: 0 } },
    { ...metadata, origin: { ...origin, prompt: "private body forbidden" } },
  ]) {
    expect(
      ownedSessionSchema.safeParse({ ...original, ...changed }).success,
    ).toBe(false);
    await expect(
      registry.reserve(
        projectId,
        "76c12d8a-a41c-41a3-a383-aac004d332e4",
        "b".repeat(64),
        () => changed,
      ),
    ).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(bytes);
  }
});
