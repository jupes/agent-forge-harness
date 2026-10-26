import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SmithConfigEditRequest } from "../../types/smith-config-edit";
import { scratchDirs } from "../test-scratch";
import type {
  SmithCreateJournalEntry,
  SmithCreateJournalStorage,
} from "./smith-create-journal-core";
import {
  createSmithEditService,
  type SmithEditServiceControls,
} from "./smith-edit-service";
import type {
  ConfigWriteTransaction,
  PreparedConfigTransaction,
} from "./transaction";
import { readConfigTransactionSources } from "./transaction";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const originalSmith = {
  name: "editable-service-smith",
  provider: "custom",
  model: "before-model",
  effort: "high",
  enabled: true,
  tags: ["old"],
};
const editedSmith = { ...originalSmith, model: "after-model", tags: ["new"] };
const workspaceText = `[smiths.editable-service-smith]
provider = "custom"
model = "before-model"
effort = "high"
enabled = true
tags = ["old"]
`;

function memory(events: string[]) {
  const records = new Map<string, Map<string, string>>();
  let inside = false,
    failAttemptAfterWrite = false;
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
      if (!inside) throw new Error("memory journal lock required");
      events.push(`write:${name}`);
      const files = records.get(id) ?? new Map<string, string>();
      if (files.has(name)) throw new Error("immutable record already exists");
      files.set(name, text);
      records.set(id, files);
      if (name === "attempted.json" && failAttemptAfterWrite)
        throw new Error("injected lost attempted write response");
    },
    exclusive: async (work) => {
      if (inside) throw new Error("memory journal lock is not reentrant");
      inside = true;
      events.push("private.enter");
      try {
        return await work();
      } finally {
        events.push("private.leave");
        inside = false;
      }
    },
  };
  return {
    storage,
    failAttemptAfterWrite(value: boolean) {
      failAttemptAfterWrite = value;
    },
  };
}

function fixture(extra: Partial<SmithEditServiceControls> = {}) {
  const base = scratch.make("smith-edit-service-"),
    checkout = join(base, "checkout"),
    profile = join(base, "profile"),
    home = join(base, "home"),
    coordinationRoot = join(base, "coordination"),
    events: string[] = [];
  for (const path of [checkout, profile, home]) mkdirSync(path);
  writeFileSync(join(checkout, "agent-forge.toml"), workspaceText);
  const journal = memory(events);
  let globalCalls = 0,
    publishCalls = 0,
    published: Uint8Array | null = null;
  const withTransaction: NonNullable<
    SmithEditServiceControls["withTransaction"]
  > = async <T>(
    context: PreparedConfigTransaction,
    work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
  ): Promise<T> => {
    globalCalls++;
    events.push("global.enter");
    try {
      const found = readConfigTransactionSources(context),
        transaction: ConfigWriteTransaction = {
          sources: found.sources,
          revision: found.revision,
          publish(bytes) {
            publishCalls++;
            published = Buffer.from(bytes);
            events.push("publish");
            return {
              file: context.files[context.target],
              created: found.revision[context.target].leaf === null,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          },
        };
      return work(transaction) as T;
    } finally {
      events.push("global.leave");
    }
  };
  const options = { harnessRoot: checkout, home, env: {} };
  const create = (controls: Partial<SmithEditServiceControls> = {}) =>
    createSmithEditService(
      { options },
      {
        profileHome: profile,
        coordinationRoot,
        storage: journal.storage,
        withTransaction,
        now: () => "2026-10-25T12:00:00.000Z",
        ...extra,
        ...controls,
      },
    );
  return {
    checkout,
    events,
    create,
    journal,
    counts: () => ({ globalCalls, publishCalls }),
    published: () => published,
  };
}

async function requestFor(
  service: ReturnType<ReturnType<typeof fixture>["create"]>,
): Promise<SmithConfigEditRequest> {
  const reviewed = service.preview({
    target: "workspace",
    name: originalSmith.name,
    smith: editedSmith,
  });
  return {
    requestId: randomUUID().toLowerCase(),
    target: "workspace",
    name: originalSmith.name,
    smith: editedSmith,
    expectedRevision: reviewed.expectedRevision,
  };
}

test("edit journals original before global lock and attempted before one full candidate publication", async () => {
  const f = fixture(),
    service = f.create(),
    request = await requestFor(service),
    receipt = await service.edit(request);

  expect(receipt.result.phase).toBe("confirmed");
  expect(receipt.original).toEqual(request);
  expect(
    receipt.result.phase === "confirmed" && receipt.result.preview.review,
  ).toMatchObject({
    name: request.name,
    effectiveAfter: request.smith,
    targetAfter: request.smith,
  });
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 1 });
  expect(f.published()).not.toBeNull();
  expect(Buffer.from(f.published()!).toString("utf8")).toContain(
    'model = "after-model"',
  );
  expect(f.events.indexOf("write:intent.json")).toBeLessThan(
    f.events.indexOf("global.enter"),
  );
  expect(f.events.indexOf("write:prepared.json")).toBeLessThan(
    f.events.indexOf("write:attempted.json"),
  );
  expect(f.events.indexOf("write:attempted.json")).toBeLessThan(
    f.events.indexOf("publish"),
  );
  expect(f.events.indexOf("publish")).toBeLessThan(
    f.events.indexOf("write:confirmed.json"),
  );
  expect(f.events.indexOf("global.leave")).toBeLessThan(
    f.events.indexOf("private.leave"),
  );

  const beforeDuplicate = [...f.events];
  expect(await service.edit(request)).toEqual(receipt);
  expect(f.events).toEqual(beforeDuplicate);
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 1 });
});

test("stale paired revision refuses before prepare, attempt or publication", async () => {
  const f = fixture(),
    service = f.create(),
    request = await requestFor(service);
  writeFileSync(
    join(f.checkout, "agent-forge.toml"),
    `${workspaceText}\n# changed`,
  );

  const receipt = await service.edit(request);
  expect(receipt.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
    preview: null,
  });
  expect(f.events).not.toContain("write:prepared.json");
  expect(f.events).not.toContain("write:attempted.json");
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 0 });
});

test("lost attempted-write response returns a sticky held receipt and skips publication", async () => {
  const f = fixture();
  f.journal.failAttemptAfterWrite(true);
  const service = f.create(),
    request = await requestFor(service),
    receipt = await service.edit(request);

  expect(receipt.result).toMatchObject({ phase: "held", stage: "attempted" });
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 0 });
  const beforeDuplicate = [...f.events];
  expect(await service.edit(request)).toEqual(receipt);
  expect(f.events).toEqual(beforeDuplicate);
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 0 });
});

test("publisher failure after the attempted fence remains held rather than refused", async () => {
  const f = fixture({
      withTransaction: async <T>(
        context: PreparedConfigTransaction,
        work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
      ): Promise<T> => {
        const found = readConfigTransactionSources(context),
          transaction: ConfigWriteTransaction = {
            sources: found.sources,
            revision: found.revision,
            publish() {
              throw new Error("injected publish failure");
            },
          };
        return work(transaction) as T;
      },
    }),
    service = f.create(),
    request = await requestFor(service),
    receipt = await service.edit(request);

  expect(receipt.result).toMatchObject({ phase: "held", stage: "attempted" });
  expect(f.events).not.toContain("write:confirmed.json");
});
