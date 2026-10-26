import { expect, test } from "bun:test";
import type { SmithConfigEditPreview } from "../../types/smith-config-edit";
import type {
  SmithCreateJournalEntry,
  SmithCreateJournalStorage,
} from "./smith-create-journal-core";
import {
  createSmithEditJournalCore,
  SmithEditJournalError,
  type SmithEditJournalWriter,
} from "./smith-edit-journal-core";
import type { SmithEditOwner } from "./smith-edit-journal-protocol";

const owner: SmithEditOwner = {
  version: 1,
  checkout: { path: "/served/repo", dev: "1", ino: "2" },
  profile: "/private/profile",
  userSelector: "/user/config.toml",
  workspaceSelector: "/served/repo/agent-forge.toml",
};
const request = {
  requestId: "eb56db61-e8ac-46c8-8e05-a787754d1019",
  target: "workspace" as const,
  name: "existing",
  smith: {
    name: "existing",
    provider: "custom",
    model: "reviewed-model",
    effort: "high",
    enabled: true,
    tags: ["reviewed"],
  },
  expectedRevision: {
    version: 1 as const,
    user: "a".repeat(64),
    workspace: "b".repeat(64),
  },
};
const file = "/served/repo/agent-forge.toml";
const before = { ...request.smith, model: "previous-model" };
const preview: SmithConfigEditPreview = {
  version: 1,
  target: "workspace",
  file,
  expectedRevision: request.expectedRevision,
  candidate: { sha256: "c".repeat(64), byteLength: 300, created: false },
  review: {
    name: request.name,
    targetBefore: { model: before.model },
    targetAfter: request.smith,
    effectiveBefore: before,
    effectiveAfter: request.smith,
    provenanceBefore: {
      provider: file,
      model: file,
      effort: file,
      enabled: file,
      tags: file,
    },
    provenanceAfter: {
      provider: file,
      model: file,
      effort: file,
      enabled: file,
      tags: file,
    },
  },
};

function memory() {
  const records = new Map<string, Map<string, string>>();
  let locks = 0,
    failAttemptAfterWrite = false,
    tail = Promise.resolve();
  const entries = (files: Map<string, string>): SmithCreateJournalEntry[] =>
    [...files].map(([name, text]) => ({
      name,
      bytes: Buffer.byteLength(text),
      plain: true,
    }));
  const storage: SmithCreateJournalStorage = {
    inspect: (id) => {
      const files = records.get(id);
      return files ? entries(files) : null;
    },
    operations: function* () {
      for (const [requestId, files] of records)
        yield { requestId, entries: entries(files) };
    },
    read: (id, entry, maxBytes) => {
      const text = records.get(id)?.get(entry.name);
      if (text === undefined || Buffer.byteLength(text) > maxBytes)
        throw new Error("bounded memory read refused");
      return text;
    },
    writeOnce: (id, name, text) => {
      const files = records.get(id) ?? new Map<string, string>();
      if (files.has(name)) throw new Error("immutable record already exists");
      files.set(name, text);
      records.set(id, files);
      if (name === "attempted.json" && failAttemptAfterWrite)
        throw new Error("injected lost attempted write response");
    },
    exclusive: async (work) => {
      locks++;
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
  return {
    storage,
    records,
    setAttemptFailure(value: boolean) {
      failAttemptAfterWrite = value;
    },
    locks: () => locks,
  };
}

const publication = { file, created: false, sha256: preview.candidate.sha256 };
function finish(writer: SmithEditJournalWriter) {
  writer.prepare(preview);
  writer.attempted();
  writer.confirm(publication);
}

test("confirmed edit original survives recreation and exact duplicate is inert", async () => {
  const state = memory(),
    first = createSmithEditJournalCore(
      state.storage,
      owner,
      () => "2026-10-25T12:00:00.000Z",
    ),
    saved = await first.reserve(request, finish),
    reads = state.locks(),
    recreated = createSmithEditJournalCore(state.storage, owner);
  let called = false;

  expect(saved.result.phase).toBe("confirmed");
  expect(recreated.readOriginal(request.requestId)).toEqual(saved);
  expect(
    await recreated.reserve(request, () => {
      called = true;
    }),
  ).toEqual(saved);
  expect(called).toBe(false);
  expect(state.locks()).toBe(reads);
  await expect(
    recreated.reserve(
      { ...request, smith: { ...request.smith, model: "different" } },
      () => undefined,
    ),
  ).rejects.toBeInstanceOf(SmithEditJournalError);
});

test("uncertain durable attempted marker stays held and never re-enters work", async () => {
  const state = memory();
  state.setAttemptFailure(true);
  const journal = createSmithEditJournalCore(state.storage, owner);
  await expect(
    journal.reserve(request, (writer) => {
      writer.prepare(preview);
      writer.attempted();
    }),
  ).rejects.toMatchObject({ reason: "held" });

  const receipt = journal.readOriginal(request.requestId);
  expect(receipt).not.toBeNull();
  if (receipt === null) throw new Error("the attempted receipt was missing");
  expect(receipt.result).toMatchObject({ phase: "held", stage: "attempted" });
  let called = false;
  expect(
    await journal.reserve(request, () => {
      called = true;
    }),
  ).toEqual(receipt);
  expect(called).toBe(false);
  expect(state.locks()).toBe(1);
});

test("journal refuses a prepared preview that changes the immutable selected name", async () => {
  const state = memory(),
    journal = createSmithEditJournalCore(state.storage, owner);
  await expect(
    journal.reserve(request, (writer) =>
      writer.prepare({
        ...preview,
        review: {
          ...preview.review,
          effectiveAfter: { ...request.smith, name: "different" },
        },
      }),
    ),
  ).rejects.toThrow();
  expect([...state.records.get(request.requestId)!.keys()]).toEqual([
    "intent.json",
  ]);
});
