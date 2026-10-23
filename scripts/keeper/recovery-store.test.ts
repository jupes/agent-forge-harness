import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "../conversations/store";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

test("a reviewed continuation retains transcript, changes identity only when needed, and reconciles its original receipt", async () => {
  const home = mkdtempSync(join(tmpdir(), "keeper-recovery-"));
  homes.push(home);
  const projectId = `project-${randomUUID()}`,
    store = createConversationStore(home);
  const requestId = randomUUID(),
    owner = randomUUID();
  await store.accept(projectId, {
    requestId,
    expectedRevision: 0,
    text: "Keep this question",
    about: [],
  });
  await store.start(projectId, requestId, owner);
  await store.append(projectId, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: randomUUID(),
    version: "fixture",
  });
  await store.append(projectId, requestId, owner, {
    kind: "text",
    text: "Keep this answer",
  });
  await store.finish(projectId, requestId, owner, "completed", null);
  const before = store.read(projectId);
  const switchRequest = {
    requestId: randomUUID(),
    expectedRevision: before.revision,
    mode: "switch" as const,
    smith: "other-claude",
    summary: "",
  };
  const switched = await store.continueKeeper(
    projectId,
    switchRequest,
    "claude",
  );
  expect(switched.resumed).toBe(true);
  expect(store.read(projectId).binding).toEqual(before.binding);
  const freshRequest = {
    ...switchRequest,
    requestId: randomUUID(),
    expectedRevision: switched.revision,
    mode: "fresh" as const,
    summary: "  The operator reviewed this exact summary.\n",
  };
  const fresh = await store.continueKeeper(projectId, freshRequest, "claude");
  expect(fresh.resumed).toBe(false);
  expect(store.read(projectId).binding).toBeNull();
  expect(store.read(projectId).frames).toEqual(before.frames);
  expect(store.read(projectId).keeperRecovery?.continuation.summary).toBe(
    freshRequest.summary,
  );
  expect(await store.continueKeeper(projectId, freshRequest, "claude")).toEqual(
    fresh,
  );
  await expect(
    store.continueKeeper(
      projectId,
      { ...freshRequest, summary: "Changed" },
      "claude",
    ),
  ).rejects.toThrow("different content");
  await expect(
    store.continueKeeper(
      projectId,
      { ...freshRequest, requestId: randomUUID() },
      "claude",
    ),
  ).rejects.toThrow("changed");
});

test("unresolved turns and colliding ids refuse changes, and bounded receipt history never evicts an original request", async () => {
  const home = mkdtempSync(join(tmpdir(), "keeper-recovery-bounds-"));
  homes.push(home);
  const projectId = `project-${randomUUID()}`,
    store = createConversationStore(home),
    requestId = randomUUID();
  await store.accept(projectId, {
    requestId,
    expectedRevision: 0,
    text: "Preserved pending turn",
    about: [],
  });
  const input = {
    requestId: randomUUID(),
    expectedRevision: store.read(projectId).revision,
    mode: "fresh" as const,
    smith: "explicit",
    summary: "Reviewed source",
  };
  await expect(
    store.continueKeeper(projectId, input, "claude"),
  ).rejects.toThrow("active");
  await store.requestStop(projectId, requestId);
  await expect(
    store.continueKeeper(
      projectId,
      { ...input, requestId, expectedRevision: store.read(projectId).revision },
      "claude",
    ),
  ).rejects.toThrow("already names a conversation turn");
  const firstInput = {
    ...input,
    expectedRevision: store.read(projectId).revision,
  };
  const first = await store.continueKeeper(projectId, firstInput, "claude");
  await expect(
    store.accept(projectId, {
      requestId: first.requestId,
      expectedRevision: first.revision,
      text: "Collision",
      about: [],
    }),
  ).rejects.toThrow("already names a Keeper continuation");
  for (let count = 1; count < 100; count++)
    await store.continueKeeper(
      projectId,
      {
        ...input,
        requestId: randomUUID(),
        expectedRevision: store.read(projectId).revision,
      },
      "claude",
    );
  const before = store.read(projectId);
  await expect(
    store.continueKeeper(
      projectId,
      { ...input, requestId: randomUUID(), expectedRevision: before.revision },
      "claude",
    ),
  ).rejects.toThrow("history is full");
  expect(store.read(projectId)).toEqual(before);
  expect(await store.continueKeeper(projectId, firstInput, "claude")).toEqual(
    first,
  );
  expect(store.read(projectId).keeperRecovery?.records).toHaveLength(100);
});
