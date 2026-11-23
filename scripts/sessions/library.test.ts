import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProjectShiftAttemptOrigin } from "../../types/shift-origin";
import { ConversationError } from "../conversations/error";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { seedOwnedSession } from "../hearth/routes/session-fixture";
import { startTestHearth, type TestHearth } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { createSessionLibrary, sessionLibraryFile } from "./library";
import {
  MAX_SESSION_EXPORT_BYTES,
  sessionLibraryReadSchema,
  sessionTranscriptExportSchema,
} from "./library-protocol";
import { createSessionRegistry, sessionRegistryFile } from "./registry";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("export reads one complete private revision beyond a page and omits internal ownership authority without changing history", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  const address = {
    kind: "session" as const,
    projectId: session.projectId,
    sessionId: session.id,
  };
  const store = createConversationStore(h.home, undefined, address);
  const first = store.read(session.projectId).frames[0]?.event;
  if (first?.kind !== "user" || !first.session)
    throw Error("Missing private fixture launch");
  const requestId = randomUUID(),
    owner = randomUUID();
  const prompt = "Private exported follow-up";
  await store.accept(session.projectId, {
    requestId,
    expectedRevision: store.read(session.projectId).revision,
    text: prompt,
    about: [],
    session: {
      ...first.session,
      launch: { ...first.session.launch, prompt },
    },
  });
  await store.start(session.projectId, requestId, owner);
  for (let n = 0; n < 121; n++)
    await store.append(session.projectId, requestId, owner, {
      kind: "text",
      text: `Private reported output ${n}\n`,
    });
  const path = conversationFile(h.home, session.projectId, address);
  const before = readFileSync(path);
  const revision = store.read(session.projectId).revision;
  const library = createSessionLibrary({ root: h.root, home: h.home });
  const exported = library.exportTranscript(session.projectId, session.id);
  expect(sessionTranscriptExportSchema.safeParse(exported).success).toBe(true);
  expect(exported.complete).toBe(true);
  expect(exported.conversation.revision).toBe(revision);
  expect(exported.lastSequence).toBe(124);
  expect(exported.conversation.frames).toHaveLength(124);
  expect(JSON.stringify(exported)).toContain("Private reported output 120");
  expect(exported.conversation.turns.at(-1)?.phase).toBe("running");
  expect(JSON.stringify(exported)).not.toContain(owner);
  expect(
    exported.conversation.turns.every((turn) => !Object.hasOwn(turn, "owner")),
  ).toBe(true);
  expect(readFileSync(path)).toEqual(before);
});

test("export refuses foreign scope, absent accepted history and mismatched private launch instead of returning a partial transcript", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  const library = createSessionLibrary({ root: h.root, home: h.home });
  expect(() =>
    library.exportTranscript(`project-${randomUUID()}`, session.id),
  ).toThrow("different project");
  const registry = createSessionRegistry(h.home);
  const unaccepted = {
    ...session,
    id: `session-${randomUUID()}`,
    requestId: randomUUID(),
  };
  writeOwnerOnly(
    sessionRegistryFile(h.home),
    JSON.stringify({
      version: 1,
      records: [...registry.listAll(FIXTURE_PROJECT_ID), unaccepted],
    }),
  );
  expect(() =>
    library.exportTranscript(session.projectId, unaccepted.id),
  ).toThrow("original private launch");
  const before = readFileSync(sessionRegistryFile(h.home));
  writeOwnerOnly(
    sessionRegistryFile(h.home),
    JSON.stringify({
      version: 1,
      records: registry.listAll(FIXTURE_PROJECT_ID).map((record) => ({
        ...record,
        workspace: `${record.workspace}-foreign`,
      })),
    }),
  );
  expect(() => library.exportTranscript(session.projectId, session.id)).toThrow(
    "different workspace",
  );
  writeOwnerOnly(sessionRegistryFile(h.home), before.toString());
  const address = {
    kind: "session" as const,
    projectId: session.projectId,
    sessionId: session.id,
  };
  const path = conversationFile(h.home, session.projectId, address);
  const state = createConversationStore(h.home, undefined, address).read(
    session.projectId,
  );
  const first = state.frames[0]?.event;
  if (first?.kind !== "user" || !first.session) throw Error("Missing launch");
  first.session.smith = "different-smith";
  writeOwnerOnly(path, JSON.stringify(state));
  expect(() => library.exportTranscript(session.projectId, session.id)).toThrow(
    "original private launch",
  );
});

test("archive and restore are separate reversible metadata changes; exact retries retain original receipts and never alter a running private turn", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h, true);
  const address = {
    kind: "session" as const,
    projectId: session.projectId,
    sessionId: session.id,
  };
  await createConversationStore(h.home, undefined, address).start(
    session.projectId,
    session.requestId,
    randomUUID(),
  );
  const history = readFileSync(
    conversationFile(h.home, session.projectId, address),
  );
  const registry = readFileSync(sessionRegistryFile(h.home));
  const library = createSessionLibrary({ root: h.root, home: h.home });
  expect(library.read(session.projectId, session.id).entry).toMatchObject({
    revision: 0,
    archived: false,
  });
  const archive = {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  };
  const applied = await library.archive(session.projectId, session.id, archive);
  expect(applied.receipt).toMatchObject({
    original: archive,
    outcome: "applied",
    revision: 1,
    archived: true,
  });
  const bytes = readFileSync(sessionLibraryFile(h.home));
  expect(await library.archive(session.projectId, session.id, archive)).toEqual(
    applied,
  );
  expect(readFileSync(sessionLibraryFile(h.home))).toEqual(bytes);
  expect(
    library.read(session.projectId, session.id, archive.requestId).receipt,
  ).toEqual(applied.receipt);
  await expect(
    library.archive(session.projectId, session.id, {
      ...archive,
      archived: false,
    }),
  ).rejects.toThrow("different");
  const stale = {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: false,
  };
  expect(
    (await library.archive(session.projectId, session.id, stale)).receipt,
  ).toMatchObject({
    original: stale,
    outcome: "refused",
    revision: 1,
    archived: true,
  });
  const restore = {
    requestId: randomUUID(),
    expectedRevision: 1,
    archived: false,
  };
  expect(
    (await library.archive(session.projectId, session.id, restore)).entry,
  ).toMatchObject({ archived: false, revision: 2 });
  const old = library.read(session.projectId, session.id, archive.requestId);
  expect(old.entry).toMatchObject({ archived: false, revision: 2 });
  expect(old.receipt).toEqual(applied.receipt);
  expect(
    readFileSync(conversationFile(h.home, session.projectId, address)),
  ).toEqual(history);
  expect(readFileSync(sessionRegistryFile(h.home))).toEqual(registry);
});

test("a lost archive write outcome recovers its exact original receipt without another mutation, while a pre-write failure remains unrecorded", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  let writes = 0;
  const library = createSessionLibrary({
    root: h.root,
    home: h.home,
    persist(file, text) {
      writes++;
      writeOwnerOnly(file, text);
      throw Error("Synthetic lost acknowledgment after save");
    },
  });
  const original = {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  };
  await expect(
    library.archive(session.projectId, session.id, original),
  ).rejects.toThrow("could not be confirmed");
  const restored = createSessionLibrary({ root: h.root, home: h.home });
  const read = restored.read(session.projectId, session.id, original.requestId);
  expect(sessionLibraryReadSchema.safeParse(read).success).toBe(true);
  expect(read.receipt).toMatchObject({
    outcome: "applied",
    original,
    revision: 1,
  });
  expect(
    await library.archive(session.projectId, session.id, original),
  ).toEqual(read);
  expect(writes).toBe(1);
  const bytes = readFileSync(sessionLibraryFile(h.home));
  const beforeWrite = createSessionLibrary({
    root: h.root,
    home: h.home,
    persist() {
      throw Error("Synthetic before save");
    },
  });
  const next = {
    requestId: randomUUID(),
    expectedRevision: 1,
    archived: false,
  };
  await expect(
    beforeWrite.archive(session.projectId, session.id, next),
  ).rejects.toThrow("could not be confirmed");
  expect(() =>
    restored.read(session.projectId, session.id, next.requestId),
  ).toThrow("not recorded in this read");
  expect(readFileSync(sessionLibraryFile(h.home))).toEqual(bytes);
  expect(
    (await restored.archive(session.projectId, session.id, next)).receipt,
  ).toMatchObject({ outcome: "applied", original: next, revision: 2 });
});

test("archive corruption is held without resetting preferences or overwriting the saved bytes", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  const library = createSessionLibrary({ root: h.root, home: h.home });
  const original = {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  };
  await library.archive(session.projectId, session.id, original);
  const valid = readFileSync(sessionLibraryFile(h.home));
  const raw: unknown = JSON.parse(valid.toString());
  if (
    !raw ||
    typeof raw !== "object" ||
    !("entries" in raw) ||
    !Array.isArray(raw.entries)
  )
    throw Error("Missing library fixture");
  const first: unknown = raw.entries[0];
  if (
    !first ||
    typeof first !== "object" ||
    !("entry" in first) ||
    !first.entry ||
    typeof first.entry !== "object" ||
    !("revision" in first.entry)
  )
    throw Error("Missing entry");
  first.entry.revision = 7;
  const corrupt = JSON.stringify(raw);
  writeOwnerOnly(sessionLibraryFile(h.home), corrupt);
  expect(() => library.read(session.projectId, session.id)).toThrow("invalid");
  await expect(
    library.archive(session.projectId, session.id, original),
  ).rejects.toThrow("invalid");
  expect(readFileSync(sessionLibraryFile(h.home)).toString()).toBe(corrupt);
  writeOwnerOnly(sessionLibraryFile(h.home), valid.toString());
  const changes = await Promise.all([
    library.archive(session.projectId, session.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      archived: false,
    }),
    library.archive(session.projectId, session.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      archived: false,
    }),
  ]);
  expect(changes.map((change) => change.receipt?.outcome).sort()).toEqual([
    "applied",
    "refused",
  ]);
  expect(library.list(session.projectId).entries[0]).toMatchObject({
    archived: false,
    revision: 2,
  });
});

test("an export that would exceed the complete 8 MiB boundary is refused without trimming a saved revision", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  const address = {
    kind: "session" as const,
    projectId: session.projectId,
    sessionId: session.id,
  };
  const state = createConversationStore(h.home, undefined, address).read(
    session.projectId,
  );
  let size = Buffer.byteLength(JSON.stringify(state));
  for (;;) {
    const frame = {
      seq: state.frames.length + 1,
      turnId: session.requestId,
      at: session.createdAt,
      event: { kind: "text" as const, text: "x" },
    };
    const overhead = Buffer.byteLength(JSON.stringify(frame)); // one text byte plus the array comma cancel out
    const length = Math.min(
      16_384,
      MAX_SESSION_EXPORT_BYTES - 1 - size - overhead,
    );
    if (length < 1) break;
    frame.event.text = "x".repeat(length);
    state.frames.push(frame);
    size += overhead + length;
  }
  const path = conversationFile(h.home, session.projectId, address);
  const text = JSON.stringify(state);
  expect(Buffer.byteLength(text)).toBeLessThan(MAX_SESSION_EXPORT_BYTES);
  writeOwnerOnly(path, text);
  expect(() =>
    createSessionLibrary({ root: h.root, home: h.home }).exportTranscript(
      session.projectId,
      session.id,
    ),
  ).toThrow("exceeds the 8 MiB export limit");
  expect(readFileSync(path).toString()).toBe(text);
});

test("the export codec refuses partial frames, missing turns and forged internal ownership fields", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  const value = createSessionLibrary({
    root: h.root,
    home: h.home,
  }).exportTranscript(session.projectId, session.id);
  expect(
    sessionTranscriptExportSchema.safeParse({ ...value, complete: false })
      .success,
  ).toBe(false);
  expect(
    sessionTranscriptExportSchema.safeParse({
      ...value,
      conversation: {
        ...value.conversation,
        frames: value.conversation.frames.slice(1),
      },
    }).success,
  ).toBe(false);
  expect(
    sessionTranscriptExportSchema.safeParse({
      ...value,
      conversation: { ...value.conversation, turns: [] },
    }).success,
  ).toBe(false);
  expect(
    sessionTranscriptExportSchema.safeParse({
      ...value,
      conversation: {
        ...value.conversation,
        turns: value.conversation.turns.map((turn) => ({
          ...turn,
          owner: randomUUID(),
        })),
      },
    }).success,
  ).toBe(false);
});

test("archive rechecks current served-project authority under its write lease before saving anything", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const session = await seedOwnedSession(h);
  let checks = 0;
  const library = createSessionLibrary({
    root: h.root,
    home: h.home,
    validateAccess() {
      if (++checks > 1)
        throw new ConversationError(
          409,
          "Project scope changed during admission",
        );
    },
  });
  await expect(
    library.archive(session.projectId, session.id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      archived: true,
    }),
  ).rejects.toThrow("scope changed");
  expect(() => readFileSync(sessionLibraryFile(h.home))).toThrow();
});

test("managed shift attempts stay outside the generic library, including prior receipt recovery, without changing private history", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const managed = await seedOwnedSession(h),
    ordinary = await seedOwnedSession(h, true);
  const library = createSessionLibrary({ root: h.root, home: h.home });
  const original = {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  };
  await library.archive(managed.projectId, managed.id, original);
  const origin: ProjectShiftAttemptOrigin = {
    kind: "shift",
    projectId: managed.projectId,
    originalRequestId: randomUUID(),
    shiftId: "shift-20261023-123456-abcd",
    runId: "fixture-managed-attempt-1",
    beadId: "fixture-bead",
    attempt: 1,
  };
  const registry = createSessionRegistry(h.home);
  writeOwnerOnly(
    sessionRegistryFile(h.home),
    JSON.stringify({
      version: 1,
      records: registry
        .listAll(managed.projectId)
        .map((record) =>
          record.id === managed.id
            ? { ...record, mode: "task", beadId: origin.beadId, origin }
            : record,
        ),
    }),
  );
  expect(registry.lookup(managed.projectId, managed.id).origin).toEqual(origin);
  const historyPath = conversationFile(h.home, managed.projectId, {
    kind: "session",
    projectId: managed.projectId,
    sessionId: managed.id,
  });
  const history = readFileSync(historyPath),
    registrations = readFileSync(sessionRegistryFile(h.home)),
    preferences = readFileSync(sessionLibraryFile(h.home));
  expect(
    library.list(managed.projectId).entries.map((entry) => entry.sessionId),
  ).toEqual([ordinary.id]);
  for (const access of [
    () => library.read(managed.projectId, managed.id),
    () => library.read(managed.projectId, managed.id, original.requestId),
    () => library.exportTranscript(managed.projectId, managed.id),
    () => library.archive(managed.projectId, managed.id, original),
    () =>
      library.archive(managed.projectId, managed.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        archived: false,
      }),
  ]) {
    let caught: unknown;
    try {
      await access();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConversationError);
    expect(caught).toMatchObject({
      status: 409,
      message: expect.stringContaining("managed project shift"),
    });
    expect(readFileSync(historyPath)).toEqual(history);
    expect(readFileSync(sessionRegistryFile(h.home))).toEqual(registrations);
    expect(readFileSync(sessionLibraryFile(h.home))).toEqual(preferences);
  }
});
