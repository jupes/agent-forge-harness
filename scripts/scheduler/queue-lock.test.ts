import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withQueueLock } from "./queue-lock";

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/**
 * This file is also its own child process. With a role in the environment it
 * contends for the lock around an exclusive marker file and exits, before any
 * test is registered.
 */
const role = process.env["QUEUE_LOCK_TEST_ROLE"];
if (role !== undefined) {
  const dir = process.env["QUEUE_LOCK_TEST_DIR"] ?? "";
  const file = join(dir, "queue-lock.db");
  const marker = join(dir, "marker");
  if (role === "hold") {
    // Take the lock, say so, and wait to be killed while holding it.
    await withQueueLock(file, async () => {
      writeFileSync(join(dir, "holding"), String(process.pid));
      await sleep(60_000);
    });
    process.exit(0);
  }
  let held = 0;
  let collided = 0;
  let busy = 0;
  for (let round = 0; round < 12; round++) {
    const exitWhileHolding = role === "contend-and-die" && round === 8;
    const locked = await withQueueLock(file, async () => {
      try {
        closeSync(openSync(marker, "wx"));
      } catch {
        collided++;
        return;
      }
      await sleep(Math.random() * 8);
      rmSync(marker);
      held++;
      if (exitWhileHolding) {
        process.stdout.write(JSON.stringify({ held, collided, busy }));
        process.exit(0);
      }
    });
    if (!locked.ok) busy++;
  }
  process.stdout.write(JSON.stringify({ held, collided, busy }));
  process.exit(0);
}

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-queue-lock-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function child(dir: string, childRole: string) {
  return Bun.spawn(["bun", import.meta.path], {
    env: {
      ...process.env,
      QUEUE_LOCK_TEST_ROLE: childRole,
      QUEUE_LOCK_TEST_DIR: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("withQueueLock", () => {
  test("runs the work and answers its value, creating the lock's directory", async () => {
    const file = join(scratch(), "not", "there", "yet", "queue-lock.db");
    const locked = await withQueueLock(file, async () => 42);
    expect(locked).toEqual({ ok: true, value: 42 });
    expect(existsSync(file)).toBe(true);
  });

  test("twenty callers in one process run one at a time, in order, and none is busy", async () => {
    const file = join(scratch(), "queue-lock.db");
    let inside = 0;
    let most = 0;
    const order: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        withQueueLock(file, async () => {
          inside++;
          most = Math.max(most, inside);
          await sleep(5);
          order.push(index);
          inside--;
          return index;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(order).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(results.every((result) => result.ok)).toBe(true);
  });

  test("the lock is released when the work throws, and the error is the caller's", async () => {
    const file = join(scratch(), "queue-lock.db");
    await expect(
      withQueueLock(file, async () => {
        throw new Error("the work failed");
      }),
    ).rejects.toThrow("the work failed");
    expect(await withQueueLock(file, async () => "next")).toEqual({
      ok: true,
      value: "next",
    });
  });

  test("a caller that cannot have the lock in time is busy, and its work is never called", async () => {
    const file = join(scratch(), "queue-lock.db");
    let release: () => void = () => undefined;
    const holding = withQueueLock(
      file,
      () => new Promise<string>((done) => (release = () => done("first"))),
    );
    await sleep(20);
    let called = false;
    const second = await withQueueLock(
      file,
      async () => {
        called = true;
      },
      { waitMs: 150 },
    );
    expect(second.ok).toBe(false);
    expect(second.ok ? "" : second.reason).toBe("busy");
    expect(called).toBe(false);
    release();
    expect(await holding).toEqual({ ok: true, value: "first" });
    // A caller that gave up does not hold up the one after it.
    expect((await withQueueLock(file, async () => "third")).ok).toBe(true);
  });

  test("a caller whose turn comes after its deadline is busy without an attempt, even with the lock free", async () => {
    const file = join(scratch(), "queue-lock.db");
    // The first holder blocks the event loop past the second caller's
    // deadline, so the second caller's turn comes before its timer can fire.
    const first = withQueueLock(file, async () => {
      const end = Date.now() + 100;
      while (Date.now() < end) {
        // Hold the event loop.
      }
      return "first";
    });
    let called = false;
    const second = withQueueLock(
      file,
      async () => {
        called = true;
      },
      { waitMs: 20 },
    );
    expect(await first).toEqual({ ok: true, value: "first" });
    const late = await second;
    expect(late.ok ? "" : late.reason).toBe("busy");
    expect(called).toBe(false);
    // The lock was free all along: the next caller takes it at once.
    expect(await withQueueLock(file, async () => "next")).toEqual({
      ok: true,
      value: "next",
    });
  });

  test("a lock held by another connection of this process is waited for, not shared, as a second process's would be", async () => {
    const dir = scratch();
    const file = join(dir, "queue-lock.db");
    const { Database } = await import("bun:sqlite");
    const other = new Database(file, { create: true });
    other.exec("BEGIN EXCLUSIVE");
    let called = false;
    const waiting = withQueueLock(
      file,
      async () => {
        called = true;
        return "after";
      },
      { waitMs: 5000 },
    );
    await sleep(200);
    expect(called).toBe(false);
    other.exec("COMMIT");
    other.close();
    expect(await waiting).toEqual({ ok: true, value: "after" });
  });

  test("a lock file that is not a database is unusable: the work is not called, nothing throws, and the answer names no path", async () => {
    const dir = scratch();
    const file = join(dir, "queue-lock.db");
    writeFileSync(
      file,
      "this is not a database, and it is long enough to be read as one",
    );
    let called = false;
    const locked = await withQueueLock(file, async () => {
      called = true;
    });
    expect(locked.ok).toBe(false);
    expect(locked.ok ? "" : locked.reason).toBe("unusable");
    expect(locked.ok ? "" : locked.error).toContain(
      "the queue lock could not be taken",
    );
    expect(locked.ok ? "" : locked.error).not.toContain("queue-lock.db");
    expect(locked.ok ? "" : locked.error).not.toContain(dir);
    expect(called).toBe(false);
  });

  test("a lock whose directory cannot be made is unusable, and the answer names no path", async () => {
    const dir = scratch();
    // A file where the directory should be.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const locked = await withQueueLock(
      join(blocker, "inside", "queue-lock.db"),
      async () => "no",
    );
    expect(locked.ok ? "" : locked.reason).toBe("unusable");
    expect(locked.ok ? "" : locked.error).toContain(
      "its directory could not be made",
    );
    expect(locked.ok ? "" : locked.error).not.toContain(dir);
  });

  test("real processes: five contend around an exclusive marker, two exit while holding, and no two ever hold at once", async () => {
    const dir = scratch();
    const children = [
      "contend",
      "contend-and-die",
      "contend",
      "contend-and-die",
      "contend",
    ].map((childRole) => child(dir, childRole));
    const reports = await Promise.all(
      children.map(async (process) => {
        const [out, err] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ]);
        await process.exited;
        if (out === "") throw new Error(`a child printed nothing: ${err}`);
        return JSON.parse(out) as {
          held: number;
          collided: number;
          busy: number;
        };
      }),
    );
    expect(reports.map((report) => report.collided)).toEqual([0, 0, 0, 0, 0]);
    expect(reports.map((report) => report.busy)).toEqual([0, 0, 0, 0, 0]);
    // 12 rounds each; the two that exit do so inside their ninth hold.
    expect(reports.map((report) => report.held)).toEqual([12, 9, 12, 9, 12]);
  }, 30_000);

  test("a holder killed from outside frees the lock, and the journal it leaves does no harm", async () => {
    const dir = scratch();
    const file = join(dir, "queue-lock.db");
    const holder = child(dir, "hold");
    for (let waited = 0; !existsSync(join(dir, "holding")); waited += 20) {
      if (waited > 10_000) throw new Error("the holder never took the lock");
      await sleep(20);
    }
    const blocked = await withQueueLock(file, async () => "no", {
      waitMs: 200,
    });
    expect(blocked.ok).toBe(false);
    holder.kill("SIGKILL");
    await holder.exited;
    const after = await withQueueLock(file, async () => "freed", {
      waitMs: 5000,
    });
    expect(after).toEqual({ ok: true, value: "freed" });
  }, 30_000);
});
