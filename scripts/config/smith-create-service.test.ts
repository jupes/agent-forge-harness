import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SmithConfigCreateRequest } from "../../types/smith-config-create";
import { scratchDirs } from "../test-scratch";
import type {
  SmithCreateJournalEntry,
  SmithCreateJournalStorage,
} from "./smith-create-journal-core";
import { createSmithCreateService } from "./smith-create-service";
import type { ConfigWriteTransaction } from "./transaction";
import { readConfigTransactionSources } from "./transaction";
import {
  buildSmithCreateCandidate,
  type SmithCreateCandidateOutcome,
} from "./write";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const smith = {
  name: "service-smith",
  provider: "custom",
  model: "reviewed-model",
  effort: "high",
  enabled: true,
  tags: ["reviewed"],
};

class MemoryStorage implements SmithCreateJournalStorage {
  readonly records = new Map<string, Map<string, string>>();
  readonly events: string[] = [];
  exclusiveCalls = 0;
  failWrite: { file: string; afterWrite: boolean } | null = null;
  #inside = false;

  inspect(requestId: string): Iterable<SmithCreateJournalEntry> | null {
    const record = this.records.get(requestId);
    return record === undefined
      ? null
      : [...record].map(([name, text]) => ({
          name,
          bytes: Buffer.byteLength(text),
          plain: true,
        }));
  }

  *operations() {
    for (const [requestId, record] of this.records)
      yield {
        requestId,
        entries: [...record].map(([name, text]) => ({
          name,
          bytes: Buffer.byteLength(text),
          plain: true,
        })),
      };
  }

  read(requestId: string, entry: SmithCreateJournalEntry, maxBytes: number) {
    const text = this.records.get(requestId)?.get(entry.name);
    if (text === undefined || Buffer.byteLength(text) > maxBytes)
      throw new Error("missing or oversized memory record");
    return text;
  }

  writeOnce(requestId: string, file: string, text: string): void {
    if (!this.#inside) throw new Error("memory journal lock required");
    this.events.push(`write:${file}`);
    if (this.failWrite?.file === file && !this.failWrite.afterWrite)
      throw new Error(`injected ${file} write failure`);
    const record = this.records.get(requestId) ?? new Map<string, string>();
    if (record.has(file)) throw new Error("immutable record already exists");
    record.set(file, text);
    this.records.set(requestId, record);
    if (this.failWrite?.file === file && this.failWrite.afterWrite)
      throw new Error(`injected uncertain ${file} write failure`);
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#inside) throw new Error("memory journal lock is not reentrant");
    this.#inside = true;
    this.exclusiveCalls++;
    this.events.push("private.enter");
    try {
      return await work();
    } finally {
      this.events.push("private.leave");
      this.#inside = false;
    }
  }
}

function fixture(storage = new MemoryStorage(), profileName = "profile") {
  const base = scratch.make("smith-create-service-"),
    checkoutPath = join(base, "checkout"),
    profilePath = join(base, profileName),
    homePath = join(base, "os-home");
  mkdirSync(checkoutPath);
  mkdirSync(profilePath);
  mkdirSync(homePath);
  const checkout = realpathSync.native(checkoutPath),
    profile = realpathSync.native(profilePath),
    home = realpathSync.native(homePath),
    coordinationRoot = join(base, "coordination"),
    events = storage.events;
  let globalCalls = 0,
    publishCalls = 0;
  const withTransaction = async <T>(
    context: Parameters<typeof readConfigTransactionSources>[0],
    work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
  ): Promise<T> => {
    globalCalls++;
    events.push("global.enter");
    try {
      const found = readConfigTransactionSources(context),
        target = context.target,
        transaction: ConfigWriteTransaction = {
          sources: found.sources,
          revision: found.revision,
          publish(bytes) {
            publishCalls++;
            events.push("publish");
            return {
              file: context.files[target],
              created: found.revision[target].leaf === null,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          },
        };
      const result = work(transaction);
      if (result !== null && typeof result === "object" && "then" in result)
        throw new Error("coordinator awaited inside the global config lock");
      return result as T;
    } finally {
      events.push("global.leave");
    }
  };
  const create = (controls: Record<string, unknown> = {}) =>
    createSmithCreateService(
      { options: { harnessRoot: checkout, home, env: {} } },
      {
        profileHome: profile,
        coordinationRoot,
        storage,
        now: () => "2026-10-25T12:00:00.000Z",
        withTransaction,
        ...controls,
      },
    );
  return {
    base,
    checkout,
    profile,
    home,
    coordinationRoot,
    storage,
    events,
    create,
    counts: () => ({ globalCalls, publishCalls }),
  };
}

async function requestFor(
  service: ReturnType<ReturnType<typeof fixture>["create"]>,
): Promise<SmithConfigCreateRequest> {
  const reviewed = service.preview({ target: "workspace", smith });
  return {
    requestId: randomUUID().toLowerCase(),
    target: "workspace",
    smith,
    expectedRevision: reviewed.expectedRevision,
  };
}

test("preview is read-only; create orders original, locks, attempted and one publication", async () => {
  const f = fixture(),
    service = f.create(),
    request = await requestFor(service),
    coordination = f.coordinationRoot;
  expect(existsSync(join(f.profile, "smith-create-journal"))).toBe(false);
  expect(existsSync(coordination)).toBe(false);
  expect(existsSync(join(f.checkout, "agent-forge.toml"))).toBe(false);

  const receipt = await service.create(request);
  expect(receipt.result.phase).toBe("confirmed");
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 1 });
  expect(f.events.indexOf("write:intent.json")).toBeLessThan(
    f.events.indexOf("global.enter"),
  );
  expect(f.events.indexOf("global.enter")).toBeLessThan(
    f.events.indexOf("write:prepared.json"),
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
  expect(f.events.indexOf("write:confirmed.json")).toBeLessThan(
    f.events.indexOf("global.leave"),
  );
  expect(f.events.indexOf("global.leave")).toBeLessThan(
    f.events.indexOf("private.leave"),
  );

  const heldLockCount = f.storage.exclusiveCalls;
  expect(await service.create(request)).toEqual(receipt);
  expect(f.storage.exclusiveCalls).toBe(heldLockCount);
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 1 });
});

test("a stale paired revision refuses before candidate preparation or publication", async () => {
  const f = fixture(),
    service = f.create(),
    request = await requestFor(service);
  writeFileSync(
    join(f.checkout, "agent-forge.toml"),
    "# changed after review\n",
  );

  const receipt = await service.create(request);

  expect(receipt.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
  });
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 0 });
  expect(f.events).not.toContain("write:prepared.json");
});

test("oversized candidates are refused before the prepared or attempted markers", async () => {
  const f = fixture();
  let candidateCalls = 0;
  const service = f.create({
    buildCandidate(request: Parameters<typeof buildSmithCreateCandidate>[0]) {
      const outcome = buildSmithCreateCandidate(request);
      if (!outcome.ok || ++candidateCalls === 1) return outcome;
      const bytes = Buffer.alloc(1_048_577, 0x61);
      return {
        ok: true,
        value: {
          ...outcome.value,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      } satisfies SmithCreateCandidateOutcome;
    },
  });
  const request = await requestFor(service),
    receipt = await service.create(request);

  expect(receipt.result).toMatchObject({
    phase: "refused",
    reason: "invalid-candidate",
  });
  expect(f.events).not.toContain("write:prepared.json");
  expect(f.events).not.toContain("write:attempted.json");
  expect(f.counts().publishCalls).toBe(0);
});

test("failed prepared, attempted, publication and completion writes stay held", async () => {
  for (const failure of [
    { file: "prepared.json", afterWrite: false, expectedStage: "intent" },
    { file: "attempted.json", afterWrite: false, expectedStage: "prepared" },
    { file: "confirmed.json", afterWrite: false, expectedStage: "attempted" },
  ] as const) {
    const f = fixture();
    f.storage.failWrite = failure;
    const service = f.create(),
      request = await requestFor(service),
      receipt = await service.create(request);
    expect(receipt.result).toMatchObject({
      phase: "held",
      stage: failure.expectedStage,
    });
    expect(receipt.result.phase === "refused").toBe(false);
    if (failure.file === "attempted.json")
      expect(f.counts().publishCalls).toBe(0);
    if (failure.file === "confirmed.json")
      expect(f.counts().publishCalls).toBe(1);
  }

  const f = fixture(),
    service = f.create(),
    request = await requestFor(service);
  const throwingRunner = async <T>(
    _context: Parameters<typeof readConfigTransactionSources>[0],
    _work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
  ): Promise<T> => {
    throw new Error("injected publication preparation failure");
  };
  const broken = f.create({ withTransaction: throwingRunner });
  const receipt = await broken.create(request);
  expect(receipt.result).toMatchObject({
    phase: "refused",
    reason: "source-unavailable",
  });
  expect(f.counts().publishCalls).toBe(0);
});

test("an uncertain attempted write and a failed publisher never become refusal", async () => {
  const f = fixture();
  f.storage.failWrite = { file: "attempted.json", afterWrite: true };
  const service = f.create(),
    request = await requestFor(service),
    receipt = await service.create(request);
  expect(receipt.result).toMatchObject({ phase: "held", stage: "attempted" });
  expect(f.counts().publishCalls).toBe(0);

  const failed = fixture(),
    request2 = await requestFor(failed.create());
  const failingPublisher = async <T>(
    context: Parameters<typeof readConfigTransactionSources>[0],
    work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
  ): Promise<T> => {
    const found = readConfigTransactionSources(context),
      transaction: ConfigWriteTransaction = {
        sources: found.sources,
        revision: found.revision,
        publish() {
          throw new Error("injected rename failure");
        },
      };
    return work(transaction) as T;
  };
  const service2 = failed.create({ withTransaction: failingPublisher });
  const afterRenameError = await service2.create(request2);
  expect(afterRenameError.result).toMatchObject({
    phase: "held",
    stage: "attempted",
  });
  expect(afterRenameError.result.phase).not.toBe("refused");
});

test("a changed original or trusted owner cannot reuse the same request identity", async () => {
  const f = fixture(),
    service = f.create(),
    request = await requestFor(service);
  await service.create(request);
  const changed: SmithConfigCreateRequest = {
    ...request,
    smith: { ...request.smith, model: "different-model" },
  };
  await expect(service.create(changed)).rejects.toMatchObject({
    reason: "conflict",
  });
  const otherProfilePath = join(f.base, "other-profile");
  mkdirSync(otherProfilePath);
  const otherOwner = f.create({
    profileHome: realpathSync.native(otherProfilePath),
  });
  await expect(otherOwner.create(request)).rejects.toMatchObject({
    reason: "conflict",
  });
  expect(f.counts()).toEqual({ globalCalls: 1, publishCalls: 1 });
});

test("real private journal and config publication survive recreation after current config is corrupt", async () => {
  const base = scratch.make("smith-create-service-real-"),
    checkoutPath = join(base, "checkout"),
    profilePath = join(base, "profile"),
    homePath = join(base, "os-home"),
    coordinationRoot = join(base, "global-lock");
  mkdirSync(checkoutPath);
  mkdirSync(profilePath);
  mkdirSync(homePath);
  const checkout = realpathSync.native(checkoutPath),
    profile = realpathSync.native(profilePath),
    home = realpathSync.native(homePath),
    options = { harnessRoot: checkout, home, env: {} },
    controls = { profileHome: profile, coordinationRoot },
    first = createSmithCreateService({ options }, controls),
    preview = first.preview({ target: "workspace", smith }),
    request: SmithConfigCreateRequest = {
      requestId: randomUUID().toLowerCase(),
      target: "workspace",
      smith,
      expectedRevision: preview.expectedRevision,
    };

  expect(existsSync(join(profile, "smith-create-journal"))).toBe(false);
  expect(existsSync(coordinationRoot)).toBe(false);
  expect(existsSync(join(checkout, "agent-forge.toml"))).toBe(false);
  const created = await first.create(request);
  expect(created.result.phase).toBe("confirmed");

  const workspaceFile = join(checkout, "agent-forge.toml"),
    corrupt = Buffer.from("[[[\n");
  writeFileSync(workspaceFile, corrupt);
  const recreated = createSmithCreateService({ options }, controls),
    beforeDuplicate = readFileSync(workspaceFile),
    duplicate = await recreated.create(request);
  expect(duplicate).toEqual(created);
  expect(readFileSync(workspaceFile)).toEqual(beforeDuplicate);
  expect(beforeDuplicate).toEqual(corrupt);
});
