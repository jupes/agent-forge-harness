import { expect, test } from "bun:test";
import type { SmithConfigPreview } from "../../types/smith-config-create";
import {
  createSmithCreateJournalCore,
  type SmithCreateJournalStorage,
  type SmithCreateJournalWriter,
} from "./smith-create-journal-core";
import {
  SMITH_CREATE_JOURNAL_FILES,
  SMITH_CREATE_JOURNAL_LIMITS,
  type SmithCreateJournalFile,
  type SmithCreateOwner,
  smithCreateInputHash,
  smithCreateOwnerHash,
} from "./smith-create-journal-protocol";

const owner: SmithCreateOwner = {
  version: 1,
  checkout: { path: "/served/repo", dev: "1", ino: "2" },
  profile: "/private/profile",
  userSelector: "/user/config.toml",
  workspaceSelector: "/served/repo/agent-forge.toml",
};
const original = {
  requestId: "eb56db61-e8ac-46c8-8e05-a787754d1019",
  target: "workspace" as const,
  smith: {
    name: "complete",
    provider: "custom",
    model: "exact",
    effort: "custom",
    enabled: true,
    tags: [],
  },
  expectedRevision: {
    version: 1 as const,
    user: "a".repeat(64),
    workspace: "b".repeat(64),
  },
};
const file = "/served/repo/agent-forge.toml";
const preview: SmithConfigPreview = {
  version: 1,
  target: "workspace",
  file,
  expectedRevision: original.expectedRevision,
  candidate: { sha256: "c".repeat(64), byteLength: 300, created: true },
  review: {
    before: null,
    after: original.smith,
    provenance: {
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
    writes = 0,
    reads = 0,
    tail = Promise.resolve();
  const entries = (files: Map<string, string>) =>
    [...files].map(([name, text]) => ({
      name,
      bytes: new TextEncoder().encode(text).byteLength,
      plain: true,
    }));
  let fail: { file: SmithCreateJournalFile; after: boolean } | null = null;
  const storage: SmithCreateJournalStorage = {
    inspect: (id) => {
      const files = records.get(id);
      return files ? entries(files) : null;
    },
    operations: function* () {
      for (const [requestId, files] of records)
        yield { requestId, entries: entries(files) };
    },
    read: (id, entry, max) => {
      reads++;
      const text = records.get(id)?.get(entry.name);
      if (text === undefined || new TextEncoder().encode(text).byteLength > max)
        throw Error("controlled bounded storage refusal");
      return text;
    },
    writeOnce: (id, name, text) => {
      writes++;
      if (fail?.file === name && !fail.after)
        throw Error("controlled save failure");
      const files = records.get(id) ?? new Map<string, string>();
      if (files.has(name)) throw Error("controlled immutable file refusal");
      files.set(name, text);
      records.set(id, files);
      if (fail?.file === name && fail.after)
        throw Error("controlled lost save response");
    },
    exclusive: async (work) => {
      locks++;
      const before = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
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
    counts: () => ({ locks, writes, reads }),
    fail: (value: typeof fail) => {
      fail = value;
    },
  };
}

test("a foreign prepared review refuses before any immutable phase is written", async () => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  await expect(
    journal.reserve(original, (writer) =>
      writer.prepare({
        ...preview,
        review: {
          ...preview.review,
          after: { ...original.smith, model: "foreign" },
        },
      }),
    ),
  ).rejects.toThrow();
  expect([...(m.records.get(original.requestId)?.keys() ?? [])]).toEqual([
    "intent.json",
    "claimed.json",
  ]);
});

const publication = { file, created: true, sha256: preview.candidate.sha256 };
function finish(writer: SmithCreateJournalWriter) {
  writer.prepare(preview);
  writer.attempted();
  writer.confirm(publication);
}

test("exact duplicate and recreated reads return the original without entering another producer or lock", async () => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  const first = await journal.reserve(original, finish),
    before = m.counts();
  expect(first.result.phase).toBe("confirmed");
  let callbacks = 0;
  expect(
    await journal.reserve(original, () => {
      callbacks++;
    }),
  ).toEqual(first);
  const recreated = createSmithCreateJournalCore(m.storage, owner);
  expect(recreated.readOriginal(original.requestId)).toEqual(first);
  expect(callbacks).toBe(0);
  expect(m.counts().locks).toBe(before.locks);
  expect(m.counts().writes).toBe(before.writes);
});

test("changed body, revision and owner reuse refuse the original UUID before producer entry", async () => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  await journal.reserve(original, finish);
  const bytes = [...(m.records.get(original.requestId) ?? [])];
  let callbacks = 0;
  for (const changed of [
    { ...original, target: "user" },
    { ...original, smith: { ...original.smith, model: "changed" } },
    {
      ...original,
      expectedRevision: { ...original.expectedRevision, user: "f".repeat(64) },
    },
  ])
    await expect(
      journal.reserve(changed, () => {
        callbacks++;
      }),
    ).rejects.toThrow("another original or owner");
  const foreign = createSmithCreateJournalCore(m.storage, {
    ...owner,
    profile: "/another/profile",
  });
  expect(() => foreign.readOriginal(original.requestId)).toThrow(
    "another original or owner",
  );
  await expect(
    foreign.reserve(original, () => {
      callbacks++;
    }),
  ).rejects.toThrow("another original or owner");
  expect(callbacks).toBe(0);
  expect([...(m.records.get(original.requestId) ?? [])]).toEqual(bytes);
});

test("missing original GET is inert and the owner-wide slot releases only after exact retirement", async () => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  expect(journal.readOriginal(original.requestId)).toBeNull();
  expect(m.counts()).toEqual({ locks: 0, writes: 0, reads: 0 });
  const held = await journal.reserveOriginal(original);
  expect(held.result).toMatchObject({ phase: "held", stage: "reserved" });
  const other = {
    ...original,
    requestId: "2ef36706-c698-4d1c-93ef-7ee2112eb0ca",
  };
  await expect(journal.reserveOriginal(other)).rejects.toMatchObject({
    reason: "conflict",
  });
  const retired = await journal.retireReserved(
    original.requestId,
    smithCreateInputHash(original),
  );
  expect(retired.result).toMatchObject({
    phase: "refused",
    reason: "cancelled-before-attempt",
  });
  const next = await journal.reserveOriginal(other);
  expect(next.original.requestId).toBe(other.requestId);
  expect(journal.listOriginals()).toMatchObject({
    complete: true,
    entries: [
      { requestId: original.requestId, state: "refused", stage: "terminal" },
      { requestId: other.requestId, state: "reserved", stage: "reserved" },
    ],
  });
  expect([...m.records.keys()]).toEqual([original.requestId, other.requestId]);
});

test("the shared profile index excludes valid other owners without hiding corrupt rows", async () => {
  const m = memory(),
    ownerB: SmithCreateOwner = {
      ...owner,
      checkout: { path: "/served/other", dev: "3", ino: "4" },
      workspaceSelector: "/served/other/agent-forge.toml",
    },
    a = createSmithCreateJournalCore(m.storage, owner),
    b = createSmithCreateJournalCore(m.storage, ownerB),
    otherA = {
      ...original,
      requestId: "3ef36706-c698-4d1c-93ef-7ee2112eb0cb",
    },
    otherB = {
      ...original,
      requestId: "4ef36706-c698-4d1c-93ef-7ee2112eb0cc",
    };

  await a.reserveOriginal(original);
  expect(b.listOriginals().entries).toEqual([]);
  expect(() => b.readOriginal(original.requestId)).toThrow(
    "another original or owner",
  );
  await b.reserveOriginal(otherB);
  expect(b.listOriginals().entries.map((row) => row.requestId)).toEqual([
    otherB.requestId,
  ]);
  expect(a.listOriginals().entries.map((row) => row.requestId)).toEqual([
    original.requestId,
  ]);
  await expect(a.reserveOriginal(otherA)).rejects.toMatchObject({
    reason: "conflict",
  });

  m.records.get(original.requestId)?.set("unknown.json", "{}");
  expect(() => b.listOriginals()).toThrow();
});

test("a durable v2 claim runs its callback once and survives a lost claim response as held", async () => {
  const m = memory(),
    first = createSmithCreateJournalCore(m.storage, owner),
    second = createSmithCreateJournalCore(m.storage, owner);
  await first.reserveOriginal(original);
  let callbacks = 0;
  const claimed = await first.claim(original, (writer) => {
    callbacks++;
    writer.refuse("source-unavailable");
  });
  expect(callbacks).toBe(1);
  expect(claimed.result).toMatchObject({
    phase: "refused",
    reason: "source-unavailable",
  });
  await second.reserveOriginal(original);
  expect(callbacks).toBe(1);

  const other = {
    ...original,
    requestId: "2ef36706-c698-4d1c-93ef-7ee2112eb0ca",
  };
  await expect(second.reserveOriginal(other)).resolves.toMatchObject({
    result: { phase: "held", stage: "reserved" },
  });
});

test("a v1 legacy original stays readable and blocks a new owner UUID without claiming", async () => {
  const m = memory(),
    inputHash = smithCreateInputHash(original),
    record = {
      version: 1,
      kind: "intent",
      requestId: original.requestId,
      ownerScopeHash: smithCreateOwnerHash(owner),
      inputHash,
      owner,
      original,
      at: "2026-10-26T00:00:00.000Z",
    };
  m.records.set(
    original.requestId,
    new Map([["intent.json", JSON.stringify(record)]]),
  );
  const journal = createSmithCreateJournalCore(m.storage, owner),
    read = journal.readOriginal(original.requestId);
  expect(read?.result).toMatchObject({ phase: "held", stage: "intent" });
  expect(journal.listOriginals()).toMatchObject({
    entries: [
      { requestId: original.requestId, state: "held", stage: "legacy" },
    ],
  });
  let callbacks = 0;
  if (!read) throw Error("The legacy receipt was not readable");
  expect(
    await journal.claim(original, () => {
      callbacks++;
    }),
  ).toEqual(read);
  expect(callbacks).toBe(0);
  await expect(
    journal.reserveOriginal({
      ...original,
      requestId: "2ef36706-c698-4d1c-93ef-7ee2112eb0ca",
    }),
  ).rejects.toMatchObject({ reason: "conflict" });
});

test("one concurrent original admits once and an orphaned prepared operation never re-enters work", async () => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  let callbacks = 0,
    release = () => {},
    enter = () => {};
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
  const first = journal.reserve(original, async (writer) => {
    callbacks++;
    writer.prepare(preview);
    enter();
    await pending;
  });
  await entered;
  try {
    const second = await journal.reserve(original, () => {
      callbacks++;
    });
    expect(second.result).toMatchObject({ phase: "held", stage: "prepared" });
    expect(callbacks).toBe(1);
  } finally {
    release();
    await first;
  }
  const recreated = createSmithCreateJournalCore(m.storage, owner);
  expect(
    (
      await recreated.reserve(original, () => {
        callbacks++;
      })
    ).result,
  ).toMatchObject({ phase: "held", stage: "prepared" });
  expect(callbacks).toBe(1);
});

test.each([
  false,
  true,
])("an attempted marker save failure after publication=%s can never become a no-effect refusal", async (after) => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  m.fail({ file: "attempted.json", after });
  const result = await journal.reserve(original, (writer) => {
    writer.prepare(preview);
    expect(() => writer.attempted()).toThrow();
    expect(() => writer.refuse("write-refused-before-attempt")).toThrow();
  });
  expect(result.result).toMatchObject({
    phase: "held",
    stage: after ? "attempted" : "prepared",
  });
  expect(m.records.get(original.requestId)?.has("refused.json")).toBe(false);
  m.fail(null);
  let callbacks = 0;
  expect(
    await journal.reserve(original, () => {
      callbacks++;
    }),
  ).toEqual(result);
  expect(callbacks).toBe(0);
});

test.each([
  false,
  true,
])("a lost completed-save response after publication=%s is recovered only from a valid durable chain", async (after) => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  m.fail({ file: "confirmed.json", after });
  await expect(journal.reserve(original, finish)).rejects.toThrow(
    "held or unavailable",
  );
  m.fail(null);
  const recreated = createSmithCreateJournalCore(m.storage, owner),
    recovered = recreated.readOriginal(original.requestId);
  if (!recovered) throw Error("The durable original must remain readable");
  expect(recovered.result.phase).toBe(after ? "confirmed" : "held");
  let callbacks = 0;
  expect(
    await recreated.reserve(original, () => {
      callbacks++;
    }),
  ).toEqual(recovered);
  expect(callbacks).toBe(0);
});

test("closed writers and unconfirmed originals cannot publish later terminal phases", async () => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  let late: SmithCreateJournalWriter | undefined;
  const result = await journal.reserve(original, (writer) => {
    late = writer;
    writer.prepare(preview);
    writer.attempted();
    writer.unconfirmed();
    expect(() => writer.confirm(publication)).toThrow();
  });
  const bytes = [...(m.records.get(original.requestId) ?? [])];
  expect(result.result).toMatchObject({ phase: "held", stage: "unconfirmed" });
  expect(() => late?.refuse("invalid-candidate")).toThrow();
  expect([...(m.records.get(original.requestId) ?? [])]).toEqual(bytes);
});

test("a mismatched completion never writes a terminal file or alters its original", async () => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  const result = await journal.reserve(original, (writer) => {
    writer.prepare(preview);
    writer.attempted();
    expect(() =>
      writer.confirm({ ...publication, sha256: "f".repeat(64) }),
    ).toThrow();
  });
  expect(result.result).toMatchObject({ phase: "held", stage: "attempted" });
  expect(m.records.get(original.requestId)?.has("confirmed.json")).toBe(false);
});

test("missing, corrupt, future and conflicting phase evidence never invents a terminal receipt", async () => {
  const seed = memory();
  await createSmithCreateJournalCore(seed.storage, owner).reserve(
    original,
    finish,
  );
  const valid = seed.records.get(original.requestId);
  if (!valid) throw Error("Missing valid in-memory original");
  for (const changed of [
    "missing-attempt",
    "missing-prepared",
    "corrupt",
    "future",
    "conflict",
    "unknown",
  ]) {
    const m = memory(),
      files = new Map(valid);
    if (changed === "missing-attempt") files.delete("attempted.json");
    if (changed === "missing-prepared") files.delete("prepared.json");
    if (changed === "corrupt") files.set("prepared.json", "{");
    if (changed === "future") files.set("attempted.json", '{"version":2}');
    if (changed === "conflict")
      files.set("refused.json", files.get("confirmed.json") ?? "");
    if (changed === "unknown") files.set("future.json", "DO_NOT_DELETE");
    m.records.set(original.requestId, files);
    const journal = createSmithCreateJournalCore(m.storage, owner),
      before = [...files];
    expect(() => journal.readOriginal(original.requestId)).toThrow();
    await expect(
      journal.reserve(original, () => {
        throw Error("Must not enter producer");
      }),
    ).rejects.toThrow();
    expect([...files]).toEqual(before);
    expect(m.counts().writes).toBe(0);
  }
});

test("phase hash changes refuse even when the replacement remains otherwise valid JSON", async () => {
  const m = memory(),
    journal = createSmithCreateJournalCore(m.storage, owner);
  await journal.reserve(original, finish);
  const files = m.records.get(original.requestId);
  if (!files) throw Error("Missing in-memory original");
  const prepared = files.get("prepared.json");
  if (!prepared) throw Error("Missing prepared phase");
  files.set("prepared.json", `${prepared} `);
  expect(() => journal.readOriginal(original.requestId)).toThrow();
});

test("file metadata bounds and unknown entries refuse before any body allocation/read", () => {
  for (const entries of [
    [
      {
        name: "intent.json",
        bytes: SMITH_CREATE_JOURNAL_LIMITS.fileBytes + 1,
        plain: true,
      },
    ],
    [{ name: "intent.json", bytes: 1, plain: false }],
    [
      ...SMITH_CREATE_JOURNAL_FILES.map((name) => ({
        name,
        bytes: 0,
        plain: true,
      })),
      { name: "future.json", bytes: 0, plain: true },
    ],
  ]) {
    const m = memory();
    m.storage.inspect = () => entries;
    expect(() =>
      createSmithCreateJournalCore(m.storage, owner).readOriginal(
        original.requestId,
      ),
    ).toThrow();
    expect(m.counts()).toEqual({ locks: 0, writes: 0, reads: 0 });
  }
});

test("operation overflow stops a streaming scan, preserves identities and never evicts for room", async () => {
  const m = memory();
  let yielded = 0;
  m.storage.operations = function* () {
    for (let i = 0; ; i++) {
      yielded++;
      yield {
        requestId: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
        entries: [{ name: "intent.json", bytes: 1, plain: true }],
      };
    }
  };
  await expect(
    createSmithCreateJournalCore(m.storage, owner).reserve(original, finish),
  ).rejects.toThrow();
  expect(yielded).toBe(SMITH_CREATE_JOURNAL_LIMITS.operations);
  expect(m.counts().writes).toBe(0);
  expect(m.records.size).toBe(0);
});
