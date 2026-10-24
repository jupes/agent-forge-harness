import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { withQueueLock } from "../scheduler/queue-lock";
import { scratchDirs } from "../test-scratch";
import { openOwnedConversationTurn } from "./owned-turn";
import { conversationFile, conversationWriteLockFile } from "./paths";
import { createConversationStore } from "./store";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function fixture() {
  const home = join(scratch.make("private turn owner "), "home");
  const address = {
    kind: "session",
    projectId: "project-05f27fd0-011b-4e0c-bb01-0da9104b1439",
    sessionId: "session-75126685-270f-49b9-8262-d74b49b0b94e",
  } as const;
  const input = {
    requestId: "15165118-dcd6-4a5e-b6b3-ddf3b34651f3",
    expectedRevision: 0,
    text: "private attempt",
    about: [],
  };
  const controller = new AbortController();
  return {
    home,
    address,
    input,
    signal: controller.signal,
    controller,
    store: createConversationStore(home, undefined, address),
  };
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a fresh private turn persists input before returning and owns its lease through actual process exit", async () => {
  const f = fixture(),
    owner = await openOwnedConversationTurn(f);
  try {
    expect(f.store.read(f.address.projectId).frames[0]?.event).toEqual({
      kind: "user",
      text: f.input.text,
      about: [],
    });
    await expect(openOwnedConversationTurn(f)).rejects.toThrow("holds");
    const other = await openOwnedConversationTurn({
      ...f,
      address: {
        ...f.address,
        sessionId: "session-76c12d8a-a41c-41a3-a383-aac004d332e4",
      },
    });
    await other.finish({ phase: "failed", reason: "No provider started." });
    owner.processStarted();
    await owner.append({
      kind: "identity",
      provider: "claude",
      version: "2.1.293",
      sessionId: f.input.requestId,
    });
    await expect(
      owner.finish({ phase: "completed", reason: null }),
    ).rejects.toThrow("has not exited");
    owner.processExited();
    await owner.finish({ phase: "completed", reason: null });
    expect(f.store.read(f.address.projectId).turns[0]?.phase).toBe("completed");
    await expect(openOwnedConversationTurn(f)).rejects.toThrow(
      "already exists",
    );
  } finally {
    owner.processExited();
    await owner
      .finish({ phase: "unknown", reason: "Fixture cleanup." })
      .catch(() => {});
  }
}, 10000);

test("aborting fences queued writes but retains the lease until the provider exit witness", async () => {
  const f = fixture(),
    owner = await openOwnedConversationTurn(f),
    entered = deferred(),
    release = deferred();
  owner.processStarted();
  const held = withQueueLock(
    conversationWriteLockFile(f.home, f.address.projectId, f.address),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await entered.promise;
  const queued = owner.append({ kind: "text", text: "late private output" });
  owner.abort();
  try {
    await expect(openOwnedConversationTurn(f)).rejects.toThrow("holds");
    owner.processExited();
    release.resolve();
    await held;
    await expect(queued).rejects.toThrow("owner");
    await owner.done;
    expect(f.store.read(f.address.projectId).frames).toHaveLength(1);
    expect(f.store.read(f.address.projectId).turns[0]?.phase).toBe("unknown");
    const file = conversationFile(f.home, f.address.projectId, f.address),
      bytes = readFileSync(file, "utf8");
    await expect(
      owner.append({ kind: "text", text: "after completion" }),
    ).rejects.toThrow("owner");
    await Bun.sleep(0);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  } finally {
    release.resolve();
    await held;
    owner.processExited();
    await owner
      .finish({ phase: "unknown", reason: "Fixture cleanup." })
      .catch(() => {});
  }
}, 10000);

test("Stop before a queued admission commits leaves no late private user or running turn", async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  ensurePrivateHome(f.home);
  const held = withQueueLock(
    conversationWriteLockFile(f.home, f.address.projectId, f.address),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await entered.promise;
  const pending = openOwnedConversationTurn(f);
  f.controller.abort();
  release.resolve();
  await held;
  await expect(pending).rejects.toThrow("owner");
  expect(f.store.read(f.address.projectId).turns).toEqual([]);
  expect(f.store.read(f.address.projectId).frames).toEqual([]);
  const replacement = await openOwnedConversationTurn({
    ...f,
    signal: new AbortController().signal,
  });
  await replacement.finish({
    phase: "failed",
    reason: "Fixture completed without provider.",
  });
});

test("observing a retained accepted attempt never edits it or takes its dispatch ownership", async () => {
  const f = fixture();
  await f.store.accept(f.address.projectId, f.input);
  const file = conversationFile(f.home, f.address.projectId, f.address),
    bytes = readFileSync(file, "utf8");
  await expect(openOwnedConversationTurn(f)).rejects.toThrow("already exists");
  expect(readFileSync(file, "utf8")).toBe(bytes);
});

test("a completion queued before private cancellation cannot later commit confirmed success", async () => {
  const f = fixture(),
    owner = await openOwnedConversationTurn(f),
    entered = deferred(),
    release = deferred();
  owner.processStarted();
  await owner.append({
    kind: "identity",
    provider: "claude",
    version: "2.1.293",
    sessionId: f.input.requestId,
  });
  owner.processExited();
  const held = withQueueLock(
    conversationWriteLockFile(f.home, f.address.projectId, f.address),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await entered.promise;
  const completing = owner.finish({ phase: "completed", reason: null });
  await Bun.sleep(0);
  owner.abort();
  release.resolve();
  await held;
  await completing;
  expect(f.store.read(f.address.projectId).turns[0]?.phase).toBe("unknown");
});
