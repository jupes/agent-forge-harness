import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SESSION_TRANSCRIPT_BYTES,
  readHomeFile,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { createConversationStore } from "./store";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const homeForTest = () => {
  const home = mkdtempSync(join(tmpdir(), "forge-conversation-"));
  homes.push(home);
  return home;
};

test("one standing conversation survives recreation and a duplicate send cannot add a turn", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const otherProject = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const first = store.read(projectId);
  expect(first.revision).toBe(0);
  expect(first.frames).toEqual([]);
  expect(store.read(otherProject).conversationId).not.toBe(
    first.conversationId,
  );
  const request = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "What is blocked?",
    about: [],
  };
  const accepted = await store.accept(projectId, request);
  expect(accepted.turn.phase).toBe("accepted");
  expect(accepted.conversationId).toBe(first.conversationId);
  const reopened = createConversationStore(home);
  const repeated = await reopened.accept(projectId, request);
  expect(repeated).toEqual(accepted);
  expect(reopened.read(projectId).turns).toHaveLength(1);
  expect(reopened.read(projectId).frames).toHaveLength(1);
  expect(reopened.read(projectId).frames[0]?.event).toEqual({
    kind: "user",
    text: request.text,
    about: [],
  });
  await expect(
    reopened.accept(projectId, { ...request, text: "Different intent" }),
  ).rejects.toThrow("different content");
  expect(reopened.read(otherProject).turns).toEqual([]);
});

test("partial replies and the actual resume identity survive restart while stale writers are refused", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const requestId = randomUUID();
  const owner = randomUUID();
  await store.accept(projectId, {
    requestId,
    expectedRevision: 0,
    text: "Read the blockers",
    about: [],
  });
  await store.start(projectId, requestId, owner);
  await store.append(projectId, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: "vendor-session",
    version: "fixture-1",
  });
  await store.append(projectId, requestId, owner, {
    kind: "text",
    text: "A partial answer 🌱",
  });
  await expect(
    store.append(projectId, requestId, randomUUID(), {
      kind: "text",
      text: "stale overwrite",
    }),
  ).rejects.toThrow("owner");
  const reopened = createConversationStore(home);
  expect(reopened.read(projectId).binding?.sessionId).toBe("vendor-session");
  expect(reopened.read(projectId).frames.at(-1)?.event).toEqual({
    kind: "text",
    text: "A partial answer 🌱",
  });
  // The service invokes recovery only while holding the conversation's dispatch lease.
  await reopened.recover(projectId);
  expect(reopened.read(projectId).turns.at(-1)?.phase).toBe("unknown");
  await expect(
    reopened.accept(projectId, {
      requestId: randomUUID(),
      expectedRevision: reopened.read(projectId).revision,
      text: "Do not replay the interrupted turn",
      about: [],
    }),
  ).rejects.toThrow("outcome is unknown");
  await expect(
    store.append(projectId, requestId, owner, {
      kind: "text",
      text: "late completion",
    }),
  ).rejects.toThrow("active");
});

test("a streamed transcript can exceed a catalog file without losing bounded, private replay", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const requestId = randomUUID();
  const owner = randomUUID();
  await store.accept(projectId, {
    requestId,
    expectedRevision: 0,
    text: "Explain the project",
    about: [],
  });
  await store.start(projectId, requestId, owner);
  for (let index = 0; index < 8; index++)
    await store.append(projectId, requestId, owner, {
      kind: "text",
      text: `${index}: ${"a".repeat(10_000)} 🌱`,
    });
  const reopened = createConversationStore(home).read(projectId);
  expect(reopened.frames).toHaveLength(9);
  expect(reopened.frames.at(-1)?.event).toEqual({
    kind: "text",
    text: `7: ${"a".repeat(10_000)} 🌱`,
  });
  const smallReader = readHomeFile(
    home,
    join(home, "conversations", `keeper-${projectId}.json`),
  );
  expect(smallReader.text).toBeNull();
  expect(smallReader.problem).not.toBeNull();
});

test("cancellation wins a late success and the next turn keeps the observed provider identity", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const requestId = randomUUID();
  const owner = randomUUID();
  await store.accept(projectId, {
    requestId,
    expectedRevision: 0,
    text: "First turn",
    about: [],
  });
  await store.start(projectId, requestId, owner);
  await store.append(projectId, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: "actual-vendor-id",
    version: "fixture-1",
  });
  await store.requestStop(projectId, requestId);
  // finish is called only after the supervised process exits.
  await store.finish(projectId, requestId, owner, "completed", null);
  expect(store.read(projectId).turns.at(-1)?.phase).toBe("cancelled");
  const secondId = randomUUID();
  await store.accept(projectId, {
    requestId: secondId,
    expectedRevision: store.read(projectId).revision,
    text: "Continue",
    about: [],
  });
  await store.start(projectId, secondId, owner);
  await expect(
    store.append(projectId, secondId, owner, {
      kind: "identity",
      provider: "claude",
      sessionId: "silently-forked-id",
      version: "fixture-1",
    }),
  ).rejects.toThrow("did not resume");
  expect(store.read(projectId).binding?.sessionId).toBe("actual-vendor-id");
});

test("future or malformed transcripts are preserved and a linked conversation directory is refused", async () => {
  const home = homeForTest();
  const external = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const input = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "Private external transcript",
    about: [],
  };
  await createConversationStore(external).accept(projectId, input);
  symlinkSync(
    join(external, "conversations"),
    join(home, "conversations"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const store = createConversationStore(home);
  expect(() => store.read(projectId)).toThrow("linked");
  await expect(store.accept(projectId, input)).rejects.toThrow("linked");
  expect(createConversationStore(external).read(projectId).turns).toHaveLength(
    1,
  );

  const brokenHome = homeForTest();
  const file = join(brokenHome, "conversations", `keeper-${projectId}.json`);
  for (const content of ['{"version":2}', '{"version":1,"frames":[']) {
    writeOwnerOnly(file, content);
    await expect(
      createConversationStore(brokenHome).accept(projectId, input),
    ).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(content);
  }
});

test("an over-limit transcript is refused before decoding and is never overwritten", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const file = join(home, "conversations", `keeper-${projectId}.json`);
  writeOwnerOnly(file, "a".repeat(MAX_SESSION_TRANSCRIPT_BYTES + 1));
  const store = createConversationStore(home);
  expect(() => store.read(projectId)).toThrow("could not be read");
  await expect(
    store.accept(projectId, {
      requestId: randomUUID(),
      expectedRevision: 0,
      text: "Must not erase saved data",
      about: [],
    }),
  ).rejects.toThrow();
  expect(statSync(file).size).toBe(MAX_SESSION_TRANSCRIPT_BYTES + 1);
});
