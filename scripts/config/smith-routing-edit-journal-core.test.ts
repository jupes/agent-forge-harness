import { expect, test } from "bun:test";
import type {
  SmithRoutingEditPreview,
  SmithRoutingEditRequest,
} from "../../types/smith-routing-edit";
import type {
  SmithCreateJournalEntry,
  SmithCreateJournalStorage,
} from "./smith-create-journal-core";
import {
  createSmithRoutingEditJournalCore,
  SmithRoutingEditJournalError,
} from "./smith-routing-edit-journal-core";
import type { SmithRoutingEditJournalFile } from "./smith-routing-edit-journal-protocol";
import {
  SMITH_ROUTING_EDIT_LIMITS,
  smithRoutingEditPreviewSchema,
} from "./smith-routing-edit-protocol";

class MemoryStorage implements SmithCreateJournalStorage {
  readonly records = new Map<
    string,
    Map<SmithRoutingEditJournalFile, string>
  >();
  failWrite: SmithRoutingEditJournalFile | null = null;
  failRead: SmithRoutingEditJournalFile | null = null;
  private tail: Promise<void> = Promise.resolve();

  inspect(requestId: string): Iterable<SmithCreateJournalEntry> | null {
    const files = this.records.get(requestId);
    if (files === undefined) return null;
    return [...files].map(([name, text]) => ({
      name,
      bytes: new TextEncoder().encode(text).byteLength,
      plain: true,
    }));
  }

  *operations(): Iterable<{
    requestId: string;
    entries: Iterable<SmithCreateJournalEntry>;
  }> {
    for (const requestId of this.records.keys()) {
      yield { requestId, entries: this.inspect(requestId)! };
    }
  }

  read(
    requestId: string,
    entry: SmithCreateJournalEntry,
    maxBytes: number,
  ): string {
    const name = entry.name as SmithRoutingEditJournalFile;
    if (name === this.failRead) throw new Error("injected readback failure");
    if (maxBytes !== SMITH_ROUTING_EDIT_LIMITS.privateRecordBytes)
      throw new Error("unexpected read cap");
    const value = this.records.get(requestId)?.get(name);
    if (value === undefined) throw new Error("missing record");
    return value;
  }

  writeOnce(
    requestId: string,
    file: SmithRoutingEditJournalFile,
    text: string,
  ): void {
    if (file === this.failWrite) throw new Error("injected write failure");
    let files = this.records.get(requestId);
    if (files === undefined) {
      files = new Map();
      this.records.set(requestId, files);
    }
    if (files.has(file)) throw new Error("immutable record already exists");
    files.set(file, text);
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

const owner = {
  version: 1 as const,
  checkout: { path: "C:\\work", dev: "1", ino: "2" },
  profile: "C:\\profile",
  userSelector: "C:\\profile\\config.toml",
  workspaceSelector: "C:\\work\\agent-forge.toml",
};
const request: SmithRoutingEditRequest = {
  requestId: "fe78546c-f433-4331-9d20-3f12a0706d91",
  target: "workspace",
  change: { kind: "default", smith: "claude-master" },
  expectedRevision: {
    version: 1,
    user: "a".repeat(64),
    workspace: "b".repeat(64),
  },
};

function previewFor(
  original: SmithRoutingEditRequest = request,
  before: string | { smith: string; weight: number }[] = "claude-apprentice",
  file = "C:\\work\\agent-forge.toml",
): SmithRoutingEditPreview {
  const after =
    original.change.kind === "bench"
      ? original.change.entries
      : original.change.smith;
  return smithRoutingEditPreviewSchema.parse({
    version: 1,
    target: original.target,
    file,
    expectedRevision: original.expectedRevision,
    candidate: {
      sha256: "c".repeat(64),
      byteLength: 100,
      created: true,
    },
    review: {
      change: original.change,
      targetBefore: before,
      targetAfter: after,
      effectiveBefore: before,
      effectiveAfter: after,
      provenanceBefore: "builtin",
      provenanceAfter: "C:\\work\\agent-forge.toml",
    },
  });
}

test("a durable refusal is an exact original and duplicate lookup skips work", async () => {
  const storage = new MemoryStorage(),
    journal = createSmithRoutingEditJournalCore(
      storage,
      owner,
      () => "2026-10-26T12:00:00.000Z",
    );
  let workCalls = 0;
  const refused = await journal.reserve(request, async (writer) => {
      workCalls++;
      writer.refuse("stale-revision");
    }),
    duplicate = await journal.reserve(request, async () => {
      workCalls++;
    });

  expect(refused.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
  });
  expect(refused.original).toEqual(request);
  expect(journal.readOriginal(request.requestId)).toEqual(refused);
  expect(duplicate).toEqual(refused);
  expect(workCalls).toBe(1);
  expect([...storage.records.get(request.requestId)!.keys()].sort()).toEqual([
    "intent.json",
    "refused.json",
  ]);
});

test("UUID reuse with a different canonical routing body conflicts", async () => {
  const journal = createSmithRoutingEditJournalCore(new MemoryStorage(), owner);
  await journal.reserve(request, (writer) => writer.refuse("stale-revision"));
  await expect(
    journal.reserve(
      { ...request, change: { kind: "default", smith: "claude-apprentice" } },
      async () => {},
    ),
  ).rejects.toBeInstanceOf(SmithRoutingEditJournalError);
});

test("a full success receipt overflow records only the bounded refusal before any attempt", async () => {
  const storage = new MemoryStorage(),
    journal = createSmithRoutingEditJournalCore(storage, owner),
    benchRequest: SmithRoutingEditRequest = {
      ...request,
      requestId: "9b976c1e-753e-44a2-9fef-01eea880cba7",
      change: {
        kind: "bench",
        bench: "low",
        entries: Array.from({ length: 35 }, () => ({
          smith: "r".repeat(240),
          weight: 0.75,
        })),
      },
    },
    rows = Array.from({ length: 900 }, () => ({
      smith: "claude-master",
      weight: 1,
    }));
  let oversized: SmithRoutingEditPreview | undefined;
  for (let count = 1; count <= rows.length; count++) {
    const value = previewFor(benchRequest, rows.slice(0, count));
    const planned = {
      version: 1,
      requestId: benchRequest.requestId,
      ownerScopeHash: "d".repeat(64),
      inputHash: "e".repeat(64),
      createdAt: "2026-10-26T12:00:00.000Z",
      original: benchRequest,
      result: {
        phase: "confirmed",
        completedAt: "2026-10-26T12:00:01.000Z",
        preview: value,
        publication: {
          file: value.file,
          created: value.candidate.created,
          sha256: value.candidate.sha256,
        },
      },
    };
    if (
      new TextEncoder().encode(JSON.stringify(planned)).byteLength >
      SMITH_ROUTING_EDIT_LIMITS.responseBytes
    ) {
      oversized = value;
      break;
    }
  }
  if (oversized === undefined)
    throw new Error("fixture did not exceed receipt cap");

  const receipt = await journal.reserve(benchRequest, (writer) => {
    expect(writer.prepare(oversized!)).toBe(false);
  });

  expect(receipt.result).toMatchObject({
    phase: "refused",
    reason: "success-preview-too-large",
  });
  expect(
    receipt.result.phase === "refused" && "preview" in receipt.result,
  ).toBe(false);
  expect(
    [...storage.records.get(benchRequest.requestId)!.keys()].sort(),
  ).toEqual(["intent.json", "refused.json"]);
});

test("a success receipt whose API envelope overflows is durably refused before attempt", async () => {
  const storage = new MemoryStorage(),
    journal = createSmithRoutingEditJournalCore(
      storage,
      owner,
      () => "2026-10-26T12:00:00.000Z",
    ),
    benchRequest: SmithRoutingEditRequest = {
      ...request,
      requestId: "46b3a741-51aa-4a04-9ccd-bfbf2191b7bb",
      change: {
        kind: "bench",
        bench: "low",
        entries: Array.from({ length: 35 }, () => ({
          smith: "r".repeat(240),
          weight: 0.75,
        })),
      },
    };
  const limit = SMITH_ROUTING_EDIT_LIMITS.responseBytes,
    maxPathPadding =
      SMITH_ROUTING_EDIT_LIMITS.pathLength -
      "C:\\work\\agent-forge.toml".length,
    plannedFor = (preview: SmithRoutingEditPreview) => ({
      version: 1,
      requestId: benchRequest.requestId,
      ownerScopeHash: "d".repeat(64),
      inputHash: "e".repeat(64),
      createdAt: "2026-10-26T12:00:00.000Z",
      original: benchRequest,
      result: {
        phase: "confirmed",
        completedAt: "2026-10-26T12:00:00.000Z",
        preview,
        publication: {
          file: preview.file,
          created: preview.candidate.created,
          sha256: preview.candidate.sha256,
        },
      },
    }),
    dataBytesFor = (preview: SmithRoutingEditPreview) =>
      new TextEncoder().encode(JSON.stringify(plannedFor(preview))).byteLength,
    envelopeBytesFor = (preview: SmithRoutingEditPreview) =>
      new TextEncoder().encode(
        JSON.stringify({ ok: true, data: plannedFor(preview), error: null }),
      ).byteLength;

  let selected: SmithRoutingEditPreview | undefined;
  for (let count = 1; count <= 900 && selected === undefined; count++) {
    const before = Array.from({ length: count }, () => ({
      smith: "claude-master",
      weight: 1,
    }));
    const base = previewFor(benchRequest, before),
      baseBytes = dataBytesFor(base),
      padding = Math.min(
        maxPathPadding,
        Math.max(0, Math.floor((limit - 16 - baseBytes) / 2)),
      );
    const file = `C:\\${"p".repeat("work\\agent-forge.toml".length + padding)}`;
    if (file.length > SMITH_ROUTING_EDIT_LIMITS.pathLength) continue;
    const candidate = previewFor(benchRequest, before, file),
      dataBytes = dataBytesFor(candidate),
      envelopeBytes = envelopeBytesFor(candidate);
    if (dataBytes <= limit && envelopeBytes > limit) selected = candidate;
  }
  if (selected === undefined)
    throw new Error("fixture did not fit data but exceed its API envelope");

  let publishCalls = 0;
  const receipt = await journal.reserve(benchRequest, (writer) => {
    if (writer.prepare(selected!)) {
      writer.attempted();
      publishCalls++;
      writer.confirm({
        file: selected!.file,
        created: selected!.candidate.created,
        sha256: selected!.candidate.sha256,
      });
    }
  });

  expect(receipt.result).toMatchObject({
    phase: "refused",
    reason: "success-preview-too-large",
  });
  expect(publishCalls).toBe(0);
  expect(
    [...storage.records.get(benchRequest.requestId)!.keys()].sort(),
  ).toEqual(["intent.json", "refused.json"]);
  expect(
    new TextEncoder().encode(
      JSON.stringify({ ok: true, data: receipt, error: null }),
    ).byteLength,
  ).toBeLessThanOrEqual(limit);
});

test("uncertain refusal persistence is held and never read as a refusal proof", async () => {
  const storage = new MemoryStorage(),
    journal = createSmithRoutingEditJournalCore(storage, owner);
  storage.failRead = "refused.json";

  await expect(
    journal.reserve(request, (writer) => writer.refuse("stale-revision")),
  ).rejects.toMatchObject({ reason: "held" });
  expect(() => journal.readOriginal(request.requestId)).toThrow(
    /held or unavailable/,
  );
});

test("a refusal record write failure cannot synthesize a refusal or replay permission", async () => {
  const storage = new MemoryStorage(),
    journal = createSmithRoutingEditJournalCore(storage, owner);
  storage.failWrite = "refused.json";

  await expect(
    journal.reserve(request, (writer) => writer.refuse("stale-revision")),
  ).rejects.toMatchObject({ reason: "held" });
  expect(journal.readOriginal(request.requestId)).toMatchObject({
    result: { phase: "held", stage: "intent" },
  });
});

test("attempted publication is confirmed once and exact duplicate cannot call work", async () => {
  const storage = new MemoryStorage(),
    journal = createSmithRoutingEditJournalCore(storage, owner),
    preview = previewFor();
  let workCalls = 0;
  const first = await journal.reserve(request, (writer) => {
      workCalls++;
      expect(writer.prepare(preview)).toBe(true);
      writer.attempted();
      writer.confirm({
        file: preview.file,
        created: preview.candidate.created,
        sha256: preview.candidate.sha256,
      });
    }),
    duplicate = await journal.reserve(request, async () => {
      workCalls++;
    });
  expect(first.result.phase).toBe("confirmed");
  expect(duplicate).toEqual(first);
  expect(workCalls).toBe(1);
});
