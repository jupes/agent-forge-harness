import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createSessionArchiveJournal,
  MAX_ARCHIVE_JOURNAL_BYTES,
  SESSION_ARCHIVE_JOURNAL,
} from "../../apps/desktop/src/session-archive-journal";
import type { OwnedSessionRecord } from "../../types/owned-session";
import type { SessionArchiveReceipt } from "../../types/session-library";
import { sessionStartFixture } from "./session-start-fixture";

const session: OwnedSessionRecord = {
  id: "session-2d5ed741-5528-424c-a927-263348778dad",
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  requestId: "18da5c95-3218-439c-a33d-e5662465f505",
  requestHash: "a".repeat(64),
  mode: "chat",
  provider: "claude",
  workspace: "/repo",
  repository: "/repo",
  worktree: "/repo",
  smith: "PRIVATE SMITH",
  requestedModel: "private-model",
  requestedEffort: null,
  createdAt: "2026-10-23T03:00:00.000Z",
};

test("two windows reserve one exact archive identity before POST; reload retains only bounded preference metadata", async () => {
  const fixture = sessionStartFixture();
  const make = () => createSessionArchiveJournal(fixture);
  let minted = 0;
  const mint = () => {
    minted++;
    return randomUUID();
  };
  const results = await Promise.all([
    make().reserve(session, { expectedRevision: 0, archived: true }, mint),
    make().reserve(session, { expectedRevision: 0, archived: false }, mint),
  ]);
  expect(results.map((result) => result.created)).toEqual([true, false]);
  expect(minted).toBe(1);
  expect(results[1]?.marker.original).toEqual(results[0]?.marker.original);
  expect(make().pending(session)).toEqual(results[0]?.marker);
  const text = fixture.storage.getItem(SESSION_ARCHIVE_JOURNAL);
  expect(text).not.toContain("PRIVATE SMITH");
  expect(text).not.toContain("private-model");
  expect(() =>
    make().pending({ ...session, requestHash: "b".repeat(64) }),
  ).toThrow("different original");
});

test("only an exactly matched server receipt releases a pending archive identity; a later explicit action gets a new UUID", async () => {
  const fixture = sessionStartFixture();
  const journal = createSessionArchiveJournal(fixture);
  const { marker } = await journal.reserve(
    session,
    { expectedRevision: 0, archived: true },
    randomUUID,
  );
  const receipt: SessionArchiveReceipt = {
    projectId: session.projectId,
    sessionId: session.id,
    startRequestId: session.requestId,
    startRequestHash: session.requestHash,
    original: marker.original,
    outcome: "applied",
    revision: 1,
    archived: true,
    at: "2026-10-23T03:00:00.000Z",
    reason: null,
  };
  await expect(
    journal.settle(marker, {
      ...receipt,
      original: { ...receipt.original, archived: false },
    }),
  ).rejects.toThrow();
  expect(journal.pending(session)).toEqual(marker);
  await journal.settle(marker, receipt);
  expect(journal.pending(session)).toBeNull();
  const next = await journal.reserve(
    session,
    { expectedRevision: 1, archived: false },
    randomUUID,
  );
  expect(next.created).toBe(true);
  expect(next.marker.original.requestId).not.toBe(marker.original.requestId);
  expect(() => journal.verify(marker)).toThrow("different original");
  await expect(journal.settle(marker, receipt)).rejects.toThrow(
    "different original",
  );
  expect(journal.pending(session)).toEqual(next.marker);
});

test("serialized metadata overflow refuses before writing and leaves earlier pending originals readable", async () => {
  const fixture = sessionStartFixture();
  const workspace = `/${"\\".repeat(1023)}`;
  const records = Array.from({ length: 1000 }, () => ({
    source: {
      projectId: session.projectId,
      sessionId: `session-${randomUUID()}`,
      startRequestId: randomUUID(),
      startRequestHash: session.requestHash,
      workspace,
    },
    original: { requestId: randomUUID(), expectedRevision: 0, archived: true },
    settled: false,
  }));
  const serialize = () => JSON.stringify({ version: 1, records });
  while (
    new TextEncoder().encode(serialize()).length > MAX_ARCHIVE_JOURNAL_BYTES
  )
    records.pop();
  const before = serialize(),
    first = records[0];
  if (!first) throw Error("Missing bounded history");
  fixture.storage.setItem(SESSION_ARCHIVE_JOURNAL, before);
  const journal = createSessionArchiveJournal(fixture);
  await expect(
    journal.reserve(
      { ...session, workspace },
      { expectedRevision: 0, archived: true },
      randomUUID,
    ),
  ).rejects.toThrow("full");
  expect(fixture.storage.getItem(SESSION_ARCHIVE_JOURNAL)).toBe(before);
  expect(
    journal.pending({
      ...session,
      id: first.source.sessionId,
      requestId: first.source.startRequestId,
      workspace,
    }),
  ).toEqual(first);
});
