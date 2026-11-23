import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import { appendEvent } from "./append";
import {
  createLedgerCompactionService,
  LedgerCompactionError,
} from "./compaction-service";
import { closeLedger } from "./db";

const homes: string[] = [];
afterEach(() => {
  closeLedger();
  for (const home of homes.splice(0)) {
    if (
      dirname(resolve(home)) !== resolve(tmpdir()) ||
      !basename(home).startsWith("forge-compaction-")
    )
      throw Error("Unexpected fixture home");
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  "backup",
  "compact",
  "pending-publication",
  "completion-publication",
] as const)("%s failure leaves durable uncertainty, no replay after recreation, and no raw error", async (failure) => {
  const f = fixture();
  let backups = 0,
    compactions = 0;
  const service = createLedgerCompactionService({
    ...f,
    backup() {
      backups++;
      if (failure === "backup") throw Error("PRIVATE_ERROR");
      return { path: "fixture", pruned: [] };
    },
    compact() {
      compactions++;
      if (failure === "compact") throw Error("PRIVATE_ERROR");
      return { events: 1, days: 1 };
    },
    write(file, content) {
      if (
        failure === "pending-publication" &&
        content.includes('"state":"pending"')
      ) {
        writeOwnerOnly(file, content);
        throw Error("PRIVATE_ERROR");
      }
      if (
        failure === "completion-publication" &&
        content.includes('"state":"completed"')
      )
        throw Error("PRIVATE_ERROR");
      writeOwnerOnly(file, content);
    },
  });
  service.start();
  await expect(service.run(f.request)).rejects.toMatchObject({ status: 504 });
  expect(service.read()).toMatchObject({
    canCompact: false,
    record: { revision: 1, last: { state: "pending" } },
  });
  expect(backups).toBe(failure === "pending-publication" ? 0 : 1);
  expect(compactions).toBe(
    failure === "pending-publication" || failure === "backup" ? 0 : 1,
  );
  const restarted = createLedgerCompactionService({
    ...f,
    backup() {
      throw Error("MUST_NOT_RUN");
    },
  });
  restarted.start();
  await expect(
    restarted.run({
      ...f.request,
      expectedRevision: 1,
      requestId: "aa000000-0000-4000-8000-000000000002",
    }),
  ).rejects.toMatchObject({ status: 504 });
  expect(JSON.stringify(restarted.read())).not.toContain("PRIVATE");
});

test("CAS serializes Settings callers, refuses stale/reused IDs, and allows a distinct acknowledged request after confirmed completion", async () => {
  const f = fixture();
  let calls = 0;
  const deps = {
    ...f,
    backup() {
      calls++;
      return { path: "fixture", pruned: [] };
    },
    compact: () => ({ events: 0, days: 0 }),
  };
  const a = createLedgerCompactionService(deps),
    b = createLedgerCompactionService(deps);
  a.start();
  b.start();
  const answers = await Promise.allSettled([
    a.run(f.request),
    b.run({ ...f.request, requestId: "aa000000-0000-4000-8000-000000000002" }),
  ]);
  expect(answers.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const refused = answers.find((item) => item.status === "rejected");
  expect(
    refused?.status === "rejected" &&
      refused.reason instanceof LedgerCompactionError &&
      refused.reason.status,
  ).toBe(409);
  expect(calls).toBe(1);
  await expect(
    a.run({ ...f.request, expectedRevision: 1 }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    a.run({
      ...f.request,
      expectedRevision: 1,
      requestId: "aa000000-0000-4000-8000-000000000003",
    }),
  ).resolves.toMatchObject({ record: { revision: 2 } });
  expect(calls).toBe(2);
});

test("missing, corrupt, oversized or differently bound history cannot reset or compact; reads never repair it", async () => {
  for (const content of [null, "{broken", "x".repeat(4097)]) {
    const f = fixture();
    writeOwnerOnly(
      join(f.home, "ledger-compaction.initialized"),
      "ledger-compaction-v1\n",
    );
    if (content !== null)
      writeOwnerOnly(join(f.home, "ledger-compaction.json"), content);
    const service = createLedgerCompactionService(f);
    service.start();
    expect(() => service.read()).toThrow(LedgerCompactionError);
    await expect(service.run(f.request)).rejects.toMatchObject({ status: 503 });
    expect(existsSync(f.path)).toBe(false);
    if (content !== null)
      expect(readFileSync(join(f.home, "ledger-compaction.json"), "utf8")).toBe(
        content,
      );
  }
  const f = fixture(),
    service = createLedgerCompactionService(f);
  service.start();
  await service.run(f.request);
  expect(() =>
    createLedgerCompactionService({
      ...f,
      path: join(f.home, "other.db"),
    }).read(),
  ).toThrow(LedgerCompactionError);
});

test("closed or unadmitted service and invalid policy refuse without upkeep, including close while waiting for the mutex", async () => {
  const f = fixture(),
    service = createLedgerCompactionService(f);
  expect(service.read().canCompact).toBe(false);
  await expect(service.run(f.request)).rejects.toMatchObject({ status: 503 });
  service.start();
  for (const bad of [
    { ...f.request, acknowledge90Days: false },
    { ...f.request, path: "other" },
    { ...f.request, expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...f.request, requestId: "wrong" },
  ])
    await expect(service.run(bad)).rejects.toMatchObject({ status: 400 });
  let release = () => {},
    admitted = () => {};
  const entered = new Promise<void>((done) => {
    admitted = done;
  });
  const held = withQueueLock(
    join(f.home, "ledger-compaction.lock"),
    async () => {
      admitted();
      await new Promise<void>((done) => {
        release = done;
      });
    },
  );
  await entered;
  try {
    const pending = service.run(f.request);
    service.close();
    release();
    await held;
    await expect(pending).rejects.toMatchObject({ status: 503 });
    service.start();
    expect(service.read().canCompact).toBe(false);
    expect(existsSync(join(f.home, "ledger-compaction.initialized"))).toBe(
      false,
    );
    expect(existsSync(f.path)).toBe(false);
  } finally {
    release();
    await held;
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-compaction-"));
  homes.push(root);
  const home = join(root, "private");
  ensurePrivateHome(home);
  return {
    home,
    path: join(home, "ledger.db"),
    request: {
      ...request,
      expectedLedgerKey: createHash("sha256")
        .update(resolve(join(home, "ledger.db")))
        .digest("hex"),
    },
    now: () => new Date("2026-11-10T12:00:00.000Z"),
  };
}
const request = {
  requestId: "aa000000-0000-4000-8000-000000000001",
  expectedRevision: 0,
  acknowledge90Days: true,
};
test("a status reviewed for another bound ledger cannot authorize a same-revision compaction", async () => {
  const f = fixture(),
    service = createLedgerCompactionService(f);
  service.start();
  await expect(
    service.run({ ...f.request, expectedLedgerKey: "b".repeat(64) }),
  ).rejects.toMatchObject({ status: 409 });
  expect(existsSync(f.path)).toBe(false);
  expect(existsSync(join(f.home, "ledger-compaction.initialized"))).toBe(false);
});
test("attempted marker failure holds this lifetime even when no history was published", async () => {
  const f = fixture(),
    service = createLedgerCompactionService({
      ...f,
      write() {
        throw Error("PRIVATE_MARKER_FAILURE");
      },
    });
  service.start();
  await expect(service.run(f.request)).rejects.toMatchObject({ status: 504 });
  expect(service.read().canCompact).toBe(false);
  await expect(service.run(f.request)).rejects.toMatchObject({ status: 504 });
  expect(existsSync(f.path)).toBe(false);
});
test("a corrupted receipt cutoff cannot claim the approved retention policy", async () => {
  const f = fixture(),
    service = createLedgerCompactionService(f);
  service.start();
  await service.run(f.request);
  const file = join(f.home, "ledger-compaction.json");
  const changed = readFileSync(file, "utf8").replace(
    "2026-08-12T12:00:00.000Z",
    "2026-11-09T12:00:00.000Z",
  );
  writeOwnerOnly(file, changed);
  expect(() => service.read()).toThrow(LedgerCompactionError);
});
test.each([
  "pending",
  "backup",
])("close during %s publication prevents later upkeep phases", async (phase) => {
  const f = fixture();
  let compactions = 0,
    backups = 0;
  const service = createLedgerCompactionService({
    ...f,
    write(file, text) {
      writeOwnerOnly(file, text);
      if (phase === "pending" && text.includes('"state":"pending"'))
        service.close();
    },
    backup() {
      backups++;
      if (phase === "backup") service.close();
      return { path: "fixture", pruned: [] };
    },
    compact() {
      compactions++;
      return { events: 0, days: 0 };
    },
  });
  service.start();
  await expect(service.run(f.request)).rejects.toMatchObject({ status: 504 });
  expect(compactions).toBe(0);
  expect(backups).toBe(phase === "pending" ? 0 : 1);
});
test("an explicit request backs up the machine ledger, compacts strictly older90day detail, and retains a confirmed receipt across restart", async () => {
  const f = fixture(),
    service = createLedgerCompactionService(f);
  expect(existsSync(f.path)).toBe(false);
  expect(service.read().record.revision).toBe(0);
  expect(existsSync(f.path)).toBe(false);
  for (const ts of [
    "2026-08-12T11:59:59.999Z",
    "2026-08-12T12:00:00.000Z",
    "2026-11-10T11:00:00.000Z",
  ])
    expect(
      appendEvent(
        {
          kind: "operator.action",
          workspace: "c:/scratch",
          ts,
          payload: { action: "fixture", surface: "ui" },
        },
        { path: f.path },
      ).ok,
    ).toBe(true);
  service.start();
  const result = await service.run(f.request);
  expect(result.record).toMatchObject({
    revision: 1,
    last: {
      requestId: request.requestId,
      state: "completed",
      events: 1,
      days: 1,
      cutoffAt: "2026-08-12T12:00:00.000Z",
    },
  });
  const backup = new Database(join(f.home, "backups/ledger-2026-11-10.db"), {
    readonly: true,
  });
  const db = new Database(f.path, { readonly: true });
  try {
    expect(backup.query("SELECT count(*) AS n FROM events").get()).toEqual({
      n: 3,
    });
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({
      n: 2,
    });
    expect(db.query("SELECT count FROM daily_summaries").all()).toEqual([
      { count: 1 },
    ]);
  } finally {
    backup.close();
    db.close();
  }
  service.close();
  expect(createLedgerCompactionService(f).read().record).toEqual(result.record);
});
test("published completion followed by a write error remains unknown to POST but the exact receipt can be read without repeating upkeep", async () => {
  const f = fixture();
  let backups = 0,
    compactions = 0,
    ticks = 0;
  const times: string[] = [];
  const service = createLedgerCompactionService({
    ...f,
    now: () => new Date(f.now().getTime() + ticks++ * 1000),
    backup(options) {
      backups++;
      times.push(options?.now?.().toISOString() ?? "missing");
      return { path: "fixture", pruned: [] };
    },
    compact(options) {
      compactions++;
      times.push(options?.now?.().toISOString() ?? "missing");
      return { events: 1, days: 1 };
    },
    write(file, text) {
      writeOwnerOnly(file, text);
      if (text.includes('"state":"completed"'))
        throw Error("PRIVATE_POST_PUBLICATION");
    },
  });
  service.start();
  await expect(service.run(f.request)).rejects.toMatchObject({ status: 504 });
  const status = service.read();
  expect(status).toMatchObject({
    canCompact: false,
    record: {
      revision: 1,
      last: { state: "completed", requestId: request.requestId },
    },
  });
  expect(times).toEqual([f.now().toISOString(), f.now().toISOString()]);
  await expect(
    service.run({ ...f.request, expectedRevision: 1 }),
  ).rejects.toMatchObject({ status: 504 });
  const restarted = createLedgerCompactionService(f);
  restarted.start();
  expect(restarted.read().record).toEqual(status.record);
  expect(backups).toBe(1);
  expect(compactions).toBe(1);
});
