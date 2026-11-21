import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendEvent } from "./append";
import { backupLedger } from "./backup";
import { createLedgerBackupScheduler } from "./backup-scheduler";
import { closeLedger } from "./db";

const roots: string[] = [];
afterEach(() => {
  closeLedger();
  for (const root of roots.splice(0)) {
    if (!basename(root).startsWith("forge-nightly-backup-"))
      throw Error("Unexpected fixture root");
    rmSync(root, { recursive: true, force: true });
  }
});
function fakeClock(at = "2026-11-10T23:59:59.000Z") {
  let now = Date.parse(at);
  const timers = new Set<() => void>();
  const callbacks: (() => void)[] = [];
  return {
    now: () => now,
    setTimer(run: () => void, delay: number) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(60_000);
      timers.add(run);
      callbacks.push(run);
      return () => {
        timers.delete(run);
      };
    },
    wake(at: string) {
      now = Date.parse(at);
      const pending = [...timers];
      timers.clear();
      for (const run of pending) run();
    },
    get pending() {
      return timers.size;
    },
    get lastCallback() {
      return callbacks[callbacks.length - 1]!;
    },
  };
}

test("nightly backup starts only when activated, snapshots the captured ledger at UTC midnight, and stops", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-nightly-backup-"));
  roots.push(root);
  const path = join(root, "ledger.db");
  const clock = fakeClock();
  const scheduler = createLedgerBackupScheduler({ path, clock });
  expect(scheduler.read()).toEqual({
    phase: "inactive",
    nextAttemptAt: null,
    lastAttempt: null,
  });
  expect(clock.pending).toBe(0);
  expect(existsSync(path)).toBe(false);
  appendEvent(
    {
      kind: "operator.action",
      workspace: root,
      payload: { action: "test.nightly", surface: "ui" },
    },
    { path },
  );
  scheduler.start();
  scheduler.start();
  expect(clock.pending).toBe(1);
  expect(scheduler.read()).toEqual({
    phase: "scheduled",
    nextAttemptAt: "2026-11-11T00:00:00.000Z",
    lastAttempt: null,
  });
  expect(existsSync(join(root, "backups"))).toBe(false);
  clock.wake("2026-11-11T00:00:00.000Z");
  const backup = join(root, "backups", "ledger-2026-11-11.db");
  const db = new Database(backup, { readonly: true });
  try {
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({
      n: 1,
    });
  } finally {
    db.close();
  }
  expect(scheduler.read()).toEqual({
    phase: "scheduled",
    nextAttemptAt: "2026-11-12T00:00:00.000Z",
    lastAttempt: {
      startedAt: "2026-11-11T00:00:00.000Z",
      outcome: "completed",
    },
  });
  expect(clock.pending).toBe(1);
  const late = clock.lastCallback;
  scheduler.stop();
  scheduler.stop();
  scheduler.start();
  late();
  clock.wake("2026-11-12T00:00:00.000Z");
  expect(scheduler.read().phase).toBe("stopped");
  expect(scheduler.read().nextAttemptAt).toBeNull();
  expect(clock.pending).toBe(0);
  expect(readdirSync(join(root, "backups"))).toEqual(["ledger-2026-11-11.db"]);
});

test("late wakes attempt only the current UTC day; clock rollback and stale callbacks never replay an attempt", () => {
  const clock = fakeClock();
  const calls: { path: string; at: string }[] = [];
  const scheduler = createLedgerBackupScheduler({
    path: "/fixed/ledger.db",
    clock,
    backup(options) {
      calls.push({ path: options.path, at: options.now().toISOString() });
    },
  });
  scheduler.start();
  const stale = clock.lastCallback;
  clock.wake("2026-11-14T03:04:05.000Z");
  stale();
  expect(calls).toEqual([
    { path: "/fixed/ledger.db", at: "2026-11-14T03:04:05.000Z" },
  ]);
  clock.wake("2026-11-12T12:00:00.000Z");
  expect(scheduler.read().nextAttemptAt).toBe("2026-11-15T00:00:00.000Z");
  clock.wake("2026-11-13T00:00:00.000Z");
  clock.wake("2026-11-14T00:00:00.000Z");
  expect(calls).toHaveLength(1);
  clock.wake("2026-11-15T00:00:00.000Z");
  expect(calls.map((call) => call.at)).toEqual([
    "2026-11-14T03:04:05.000Z",
    "2026-11-15T00:00:00.000Z",
  ]);
  scheduler.stop();
});

test("post-publication failures are unconfirmed, retain no raw error, and do not trigger same-day retries", () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createLedgerBackupScheduler({
    path: "/fixed/ledger.db",
    clock,
    backup() {
      calls++;
      throw Error(
        "PRIVATE_PATH_OR_CONTENT: pruning could fail after publication",
      );
    },
  });
  scheduler.start();
  clock.wake("2026-11-11T00:00:00.000Z");
  const status = scheduler.read();
  expect(status.lastAttempt).toEqual({
    startedAt: "2026-11-11T00:00:00.000Z",
    outcome: "unconfirmed",
  });
  expect(JSON.stringify(status)).not.toContain("PRIVATE");
  // A reader cannot mutate the scheduler's private result.
  if (status.lastAttempt) status.lastAttempt.outcome = "completed";
  expect(scheduler.read().lastAttempt?.outcome).toBe("unconfirmed");
  clock.wake("2026-11-11T12:00:00.000Z");
  expect(calls).toBe(1);
  clock.wake("2026-11-12T00:00:00.000Z");
  expect(calls).toBe(2);
  scheduler.stop();
});

test("two schedulers sharing a scratch ledger retain independent attempt status and readable snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-nightly-backup-"));
  roots.push(root);
  const path = join(root, "ledger.db");
  appendEvent(
    {
      kind: "operator.action",
      workspace: root,
      payload: { action: "test.shared-nightly", surface: "ui" },
    },
    { path },
  );
  const clock = fakeClock();
  const first = createLedgerBackupScheduler({ path, clock });
  const second = createLedgerBackupScheduler({ path, clock });
  first.start();
  second.start();
  clock.wake("2026-11-11T00:00:00.000Z");
  expect(first.read().lastAttempt?.outcome).toBe("completed");
  expect(second.read().lastAttempt?.outcome).toBe("completed");
  expect(readdirSync(join(root, "backups"))).toEqual(["ledger-2026-11-11.db"]);
  // Existing throwing helper remains the same publication and retention owner.
  expect(
    backupLedger({ path, now: () => new Date("2026-11-11T00:00:00Z") }).pruned,
  ).toEqual([]);
  first.stop();
  second.stop();
});
