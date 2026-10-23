import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSessionArchiveJournal } from "../../apps/desktop/src/session-archive-journal";
import { createSessionLibraryClient } from "../../apps/desktop/src/session-library-client";
import type { ActionOutcome } from "../../docs/js/action-outcome";
import type { OwnedSessionRecord } from "../../types/owned-session";
import type {
  SessionArchiveRequest,
  SessionLibraryRead,
} from "../../types/session-library";
import { sessionStartFixture } from "./session-start-fixture";

const record: OwnedSessionRecord = {
  id: "session-2d5ed741-5528-424c-a927-263348778dad",
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  requestId: "18da5c95-3218-439c-a33d-e5662465f505",
  requestHash: "a".repeat(64),
  mode: "chat",
  provider: "claude",
  workspace: "/repo",
  repository: "/repo",
  worktree: "/repo",
  smith: "claude-journeyman",
  requestedModel: "sonnet",
  requestedEffort: null,
  createdAt: "2026-10-23T03:00:00.000Z",
};
const entry = {
  projectId: record.projectId,
  sessionId: record.id,
  startRequestId: record.requestId,
  startRequestHash: record.requestHash,
  revision: 0,
  archived: false,
  updatedAt: null,
};
function confirmed(original: SessionArchiveRequest): SessionLibraryRead {
  return {
    entry: {
      ...entry,
      revision: original.expectedRevision + 1,
      archived: original.archived,
      updatedAt: record.createdAt,
    },
    receipt: {
      projectId: record.projectId,
      sessionId: record.id,
      startRequestId: record.requestId,
      startRequestHash: record.requestHash,
      original,
      outcome: "applied",
      revision: original.expectedRevision + 1,
      archived: original.archived,
      at: record.createdAt,
      reason: null,
    },
  };
}

test("lost archive response survives reload and a not-recorded read; only explicit exact original retry posts again", async () => {
  const fixture = sessionStartFixture(),
    bodies: SessionArchiveRequest[] = [];
  let minted = 0,
    retry = false;
  const make = () =>
    createSessionLibraryClient({
      canWrite: () => true,
      requestId: () => {
        minted++;
        return randomUUID();
      },
      journal: createSessionArchiveJournal(fixture),
      list: async () => ({ projectId: record.projectId, entries: [entry] }),
      read: async (_record, requestId) => {
        if (requestId) throw Error("Original not recorded in this read");
        return { entry, receipt: null };
      },
      post: async (_record, body) => {
        bodies.push(structuredClone(body));
        return retry
          ? { state: "done", data: confirmed(body) }
          : { state: "unknown", message: "Lost response" };
      },
      exportTranscript: async () => {
        throw Error("Unexpected export");
      },
      download: () => {
        throw Error("Unexpected download");
      },
    });
  const first = make();
  first.activate(record.projectId, record);
  await Bun.sleep(0);
  await first.change(true);
  expect(bodies).toHaveLength(1);
  expect(first.current()?.pending?.original).toEqual(bodies[0]);
  first.dispose();
  const restored = make();
  restored.activate(record.projectId, record);
  await Bun.sleep(0);
  expect(restored.current()?.pending?.original).toEqual(bodies[0]);
  await restored.change(false);
  expect(bodies).toHaveLength(1);
  expect(minted).toBe(1);
  retry = true;
  await restored.retry();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(restored.current()?.entry?.archived).toBe(true);
  expect(restored.current()?.pending).toBeNull();
});

test("an exact protected confirmation wins over a delayed malformed archive POST response", async () => {
  const fixture = sessionStartFixture();
  let release: ((value: ActionOutcome) => void) | undefined;
  let original: SessionArchiveRequest | undefined;
  const client = createSessionLibraryClient({
    canWrite: () => true,
    requestId: randomUUID,
    journal: createSessionArchiveJournal(fixture),
    list: async () => ({ projectId: record.projectId, entries: [entry] }),
    read: async () =>
      original ? confirmed(original) : { entry, receipt: null },
    post: async (_record, body) => {
      original = body;
      return new Promise<ActionOutcome>((resolve) => {
        release = resolve;
      });
    },
    exportTranscript: async () => {
      throw Error("Unexpected export");
    },
    download: () => {},
  });
  client.activate(record.projectId, record);
  await Bun.sleep(0);
  const posting = client.change(true);
  await Bun.sleep(0);
  await client.check();
  expect(client.current()?.pending).toBeNull();
  if (!release) throw Error("Missing held POST");
  release({ state: "done", data: { malformed: true } });
  await posting;
  expect(client.current()?.pending).toBeNull();
  expect(client.current()?.entry?.archived).toBe(true);
  expect(client.current()?.notice).not.toContain("not confirmed");
});

test("late reads and a private export are discarded after project navigation without a download or mutation", async () => {
  const fixture = sessionStartFixture();
  const other = {
    ...record,
    id: `session-${randomUUID()}`,
    projectId: `project-${randomUUID()}`,
    requestId: randomUUID(),
    requestHash: "b".repeat(64),
    workspace: "/other",
    repository: "/other",
    worktree: "/other",
  };
  const otherEntry = {
    ...entry,
    projectId: other.projectId,
    sessionId: other.id,
    startRequestId: other.requestId,
    startRequestHash: other.requestHash,
  };
  let hold = false,
    posts = 0,
    downloads = 0;
  let releaseRead: ((value: unknown) => void) | undefined,
    releaseExport: ((value: unknown) => void) | undefined;
  const client = createSessionLibraryClient({
    canWrite: () => true,
    requestId: randomUUID,
    journal: createSessionArchiveJournal(fixture),
    list: async (id) => ({
      projectId: id,
      entries: [id === record.projectId ? entry : otherEntry],
    }),
    read: async (selected) =>
      selected.id === other.id
        ? { entry: otherEntry, receipt: null }
        : hold
          ? new Promise((resolve) => {
              releaseRead = resolve;
            })
          : { entry, receipt: null },
    post: async () => {
      posts++;
      return { state: "unknown", message: "Unexpected" };
    },
    exportTranscript: async () =>
      new Promise((resolve) => {
        releaseExport = resolve;
      }),
    download: () => {
      downloads++;
    },
  });
  client.activate(record.projectId, record);
  await Bun.sleep(0);
  hold = true;
  const reading = client.check(),
    exporting = client.exportTranscript();
  client.activate(other.projectId, other);
  await Bun.sleep(0);
  if (!releaseRead || !releaseExport) throw Error("Missing held reads");
  releaseRead({
    entry: {
      ...entry,
      archived: true,
      revision: 99,
      updatedAt: record.createdAt,
    },
    receipt: null,
  });
  releaseExport({ privateBody: "Foreign late body" });
  await Promise.all([reading, exporting]);
  expect(client.current()?.record.id).toBe(other.id);
  expect(client.current()?.entry).toEqual(otherEntry);
  expect(client.current()?.error).toBe("");
  expect(posts).toBe(0);
  expect(downloads).toBe(0);
});

test("a source identity change cannot reuse a cached archive preference or enable an old-record write", async () => {
  const fixture = sessionStartFixture();
  let posts = 0;
  const client = createSessionLibraryClient({
    canWrite: () => true,
    requestId: randomUUID,
    journal: createSessionArchiveJournal(fixture),
    list: async () => ({ projectId: record.projectId, entries: [entry] }),
    read: async () => ({ entry, receipt: null }),
    post: async () => {
      posts++;
      return { state: "unknown", message: "Unexpected" };
    },
    exportTranscript: async () => null,
    download: () => {},
  });
  client.activate(record.projectId, record);
  await Bun.sleep(0);
  expect(client.canChange()).toBe(true);
  client.activate(record.projectId, { ...record, requestHash: "b".repeat(64) });
  await Bun.sleep(0);
  expect(client.current()?.entry).toBeNull();
  expect(client.canChange()).toBe(false);
  await client.change(true);
  expect(posts).toBe(0);
});

test("unverifiable durable archive storage refuses before UUID minting or a network write", async () => {
  const fixture = sessionStartFixture();
  let minted = 0,
    posts = 0;
  const client = createSessionLibraryClient({
    canWrite: () => true,
    requestId: () => {
      minted++;
      return randomUUID();
    },
    journal: createSessionArchiveJournal({ ...fixture, storage: null }),
    list: async () => ({ projectId: record.projectId, entries: [entry] }),
    read: async () => ({ entry, receipt: null }),
    post: async () => {
      posts++;
      return { state: "unknown", message: "Unexpected" };
    },
    exportTranscript: async () => null,
    download: () => {},
  });
  client.activate(record.projectId, record);
  await Bun.sleep(0);
  await client.change(true);
  expect(client.canChange()).toBe(false);
  expect(client.current()?.error).toContain("storage is unavailable");
  expect(minted).toBe(0);
  expect(posts).toBe(0);
});
