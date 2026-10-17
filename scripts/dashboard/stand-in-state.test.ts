/**
 * The browser suite's `bd` stand-in state (`tests/e2e/bd-stand-in-state.ts`):
 * whole-file replacement and the retries that keep it working on Windows,
 * where a file another process holds open cannot always be replaced.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNED_LOCK_MS,
  processStarted,
  readComments,
  readState,
  type StandInState,
  withRetries,
  withStateLock,
  writeState,
} from "../../tests/e2e/bd-stand-in-state";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "af-stand-in-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const sharing = (code: string) =>
  Object.assign(new Error(`${code}: busy`), { code });

/** A pid that was a process's and is no longer: one that has exited. */
async function exitedPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

/** Leave a lock in `dir` as a holder that never released it would. */
function plantLock(
  dir: string,
  owner?: { pid: number; at: number; token: string; started?: string },
): string {
  const lock = join(dir, "state.lock");
  mkdirSync(lock);
  if (owner !== undefined)
    writeFileSync(ownerPath(lock, owner), JSON.stringify(owner));
  return lock;
}

const ownerPath = (
  lock: string,
  owner: { pid: number; token: string },
): string => join(lock, `owner-${owner.pid}-${owner.token}.json`);

describe("withStateLock", () => {
  test.each([
    "remove-owner",
    "remove-empty",
  ] as const)("a delayed %s cannot remove a fresh breaker or main holder", async (phase) => {
    const dir = scratch();
    const dead = { pid: await exitedPid(), at: Date.now(), token: "dead" };
    const lock = plantLock(dir, dead);
    const breaker = `${lock}.break`;
    mkdirSync(breaker);
    writeFileSync(ownerPath(breaker, dead), JSON.stringify(dead));
    const fresh = { pid: process.pid, at: Date.now(), token: "fresh-breaker" };
    let interleaved = false;
    expect(() =>
      withStateLock(dir, () => "never", {
        waitMs: 100,
        step(at, path) {
          if (path !== breaker || at !== phase || interleaved) return;
          interleaved = true;
          // The first waiter finishes clearing the dead breaker, and a third
          // publishes its populated breaker before this delayed waiter resumes.
          if (phase === "remove-owner") unlinkSync(ownerPath(breaker, dead));
          rmdirSync(breaker);
          mkdirSync(breaker);
          writeFileSync(ownerPath(breaker, fresh), JSON.stringify(fresh));
        },
      }),
    ).toThrow("timed out");
    expect(interleaved).toBe(true);
    expect(JSON.parse(readFileSync(ownerPath(breaker, fresh), "utf8"))).toEqual(
      fresh,
    );
    expect(JSON.parse(readFileSync(ownerPath(lock, dead), "utf8"))).toEqual(
      dead,
    );
  });

  test("an empty breaker left after unlink is recovered without waiting for the age bound", async () => {
    const dir = scratch();
    const lock = plantLock(dir, {
      pid: await exitedPid(),
      at: Date.now(),
      token: "dead",
    });
    mkdirSync(`${lock}.break`);
    const start = Date.now();
    expect(withStateLock(dir, () => "entered", { waitMs: 2000 })).toBe(
      "entered",
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("killed holders and breakers recover promptly under multiprocess contention, with execution and overlap witnesses", async () => {
    const dir = scratch();
    const work = scratch();
    const worker = join(work, "chaos.ts");
    const module = join(
      import.meta.dir,
      "..",
      "..",
      "tests",
      "e2e",
      "bd-stand-in-state.ts",
    );
    writeFileSync(
      worker,
      `
      import { closeSync, existsSync, openSync, rmSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { readState, withStateLock, writeState } from ${JSON.stringify(module)};
      const [dir, mode, witness] = process.argv.slice(2);
      const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
      writeFileSync(witness + ".started", String(process.pid));
      if (mode === "holder") withStateLock(dir, () => { writeFileSync(witness, "held"); pause(); });
      else if (mode === "breaker") withStateLock(dir, () => { throw new Error("breaker entered transaction"); }, {
        step(phase) { if (phase === "break-owned") { writeFileSync(witness, "breaking"); pause(); } }
      });
      else {
        while (!existsSync(join(dir, "go"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        let overlaps = 0;
        for (let i = 0; i < 30; i++) withStateLock(dir, () => {
          let marker;
          try { marker = openSync(join(dir, "inside"), "wx"); } catch { overlaps++; }
          const count = Number(readState(dir)["c"]?.title ?? "0") + 1;
          writeState(dir, { c: { id: "c", title: String(count), issue_type: "task", priority: 2, status: "open", created_at: "", updated_at: "" } });
          if (marker !== undefined) { closeSync(marker); rmSync(join(dir, "inside")); }
        }, { waitMs: 20000 });
        writeFileSync(witness, JSON.stringify({ pid: process.pid, transactions: 30, overlaps }));
      }
    `,
    );
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const launch = (mode: string, name: string) => {
      const witness = join(work, name);
      const child = Bun.spawn([process.execPath, worker, dir, mode, witness], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      return { child, witness };
    };
    const waitFor = async (path: string) => {
      const until = Date.now() + 10000;
      while (!existsSync(path)) {
        if (Date.now() > until)
          throw new Error(`missing execution witness: ${path}`);
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    try {
      const holder = launch("holder", "holder");
      await waitFor(holder.witness);
      expect(readFileSync(holder.witness, "utf8")).toBe("held");
      holder.child.kill("SIGKILL");
      await holder.child.exited;
      const breaker = launch("breaker", "breaker");
      await waitFor(breaker.witness);
      expect(readFileSync(breaker.witness, "utf8")).toBe("breaking");
      const owner = JSON.parse(
        readFileSync(
          join(
            dir,
            "state.lock.break",
            readdirSync(join(dir, "state.lock.break"))[0] ?? "missing",
          ),
          "utf8",
        ),
      );
      expect(owner.pid).toBe(breaker.child.pid);
      expect(owner.token).toBeString();
      // The real process's start, so a later process given its pid is told apart.
      expect(owner.started).toBe(processStarted(breaker.child.pid));
      breaker.child.kill("SIGKILL");
      await breaker.child.exited;
      const survivors = Array.from({ length: 8 }, (_, i) =>
        launch("writer", `writer-${i}`),
      );
      await Promise.all(
        survivors.map(({ witness }) => waitFor(`${witness}.started`)),
      );
      const start = Date.now();
      writeFileSync(join(dir, "go"), "go");
      const results = await Promise.all(
        survivors.map(async ({ child, witness }) => {
          const [code, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
          // Exit zero alone cannot prove Bun executed the worker under load.
          return JSON.parse(readFileSync(witness, "utf8"));
        }),
      );
      expect(results).toEqual(
        survivors.map(({ child }) => ({
          pid: child.pid,
          transactions: 30,
          overlaps: 0,
        })),
      );
      expect(readState(dir)["c"]?.title).toBe("240");
      expect(Date.now() - start).toBeLessThan(20000);
      expect(readdirSync(dir).sort()).toEqual(["go", "issues.json"]);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  }, 60000);

  test("the state lock is released when a transaction throws", () => {
    const dir = scratch();
    expect(() =>
      withStateLock(dir, () => {
        throw new Error("write failed");
      }),
    ).toThrow("write failed");
    expect(withStateLock(dir, () => "next writer")).toBe("next writer");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a sharing error from making the lock is waited out, as a held lock is, and any other error is thrown at once", () => {
    const dir = scratch();
    const codes = ["EPERM", "EACCES", "EBUSY"];
    let calls = 0;
    const value = withStateLock(dir, () => "entered", {
      mkdir: (path) => {
        const code = codes[calls++];
        if (code !== undefined) throw sharing(code);
        mkdirSync(path);
      },
    });
    expect({ value, calls }).toEqual({ value: "entered", calls: 4 });
    expect(readdirSync(dir)).toEqual([]);

    expect(() =>
      withStateLock(dir, () => "never", {
        mkdir: () => {
          throw sharing("ENOENT");
        },
      }),
    ).toThrow("ENOENT");
    expect(() =>
      withStateLock(dir, () => "never", {
        waitMs: 100,
        mkdir: () => {
          throw sharing("EPERM");
        },
      }),
    ).toThrow("timed out waiting for stand-in state lock");
  });

  test("a lock left by a holder whose process has exited is broken at once, and the transaction runs", async () => {
    const dir = scratch();
    plantLock(dir, { pid: await exitedPid(), at: Date.now(), token: "dead" });
    const started = Date.now();
    expect(withStateLock(dir, () => "entered", { waitMs: 3_000 })).toBe(
      "entered",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readdirSync(dir)).toEqual([]);
  });

  // Where no start can be read (macOS) the age bound decides instead (the
  // OWNED_LOCK_MS test below); Linux and Windows read one (processStarted test).
  test.skipIf(processStarted(process.pid) === undefined)(
    "a lock whose pid now names a different process (the holder died and its pid was reused) is broken at once",
    () => {
      const dir = scratch();
      // This test's own process is running, but it is not the process that
      // started at the recorded time: as a killed holder's pid handed on.
      const reused = {
        pid: process.pid,
        at: Date.now(),
        token: "reused",
        started: "0",
      };
      plantLock(dir, reused);
      const started = Date.now();
      expect(withStateLock(dir, () => "entered", { waitMs: 3_000 })).toBe(
        "entered",
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  test.skipIf(processStarted(process.pid) === undefined)(
    "a live holder whose recorded start matches its process is not age-broken, however old its lock",
    () => {
      const dir = scratch();
      const live = {
        pid: process.pid,
        at: Date.now() - 2 * OWNED_LOCK_MS,
        token: "live-old",
        started: processStarted(process.pid) ?? "unread",
      };
      const lock = plantLock(dir, live);
      expect(() =>
        withStateLock(dir, () => "never", { waitMs: 300, staleMs: 1 }),
      ).toThrow("timed out waiting for stand-in state lock");
      expect(JSON.parse(readFileSync(ownerPath(lock, live), "utf8"))).toEqual(
        live,
      );
    },
  );

  test("a running pid whose start cannot be compared is trusted for OWNED_LOCK_MS, then broken", () => {
    // As a holder under Node on Windows records it: no start time.
    const fresh = { pid: process.pid, at: Date.now() - 60_000, token: "fresh" };
    const kept = scratch();
    const lock = plantLock(kept, fresh);
    expect(() => withStateLock(kept, () => "never", { waitMs: 300 })).toThrow(
      "timed out waiting for stand-in state lock",
    );
    expect(JSON.parse(readFileSync(ownerPath(lock, fresh), "utf8"))).toEqual(
      fresh,
    );

    const old = scratch();
    plantLock(old, {
      pid: process.pid,
      at: Date.now() - OWNED_LOCK_MS - 1_000,
      token: "old",
    });
    expect(withStateLock(old, () => "entered", { waitMs: 3_000 })).toBe(
      "entered",
    );
    expect(readdirSync(old)).toEqual([]);
  });

  test("a lock in the earlier format (one owner.json) left by a dead holder is broken and removed", async () => {
    const dir = scratch();
    const lock = join(dir, "state.lock");
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: await exitedPid(), at: Date.now(), token: "old" }),
    );
    expect(withStateLock(dir, () => "entered", { waitMs: 3_000 })).toBe(
      "entered",
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  test("processStarted reads one start for a process on Linux and Windows, the same each time, and another for a different process", async () => {
    const own = processStarted(process.pid);
    if (process.platform === "linux" || process.platform === "win32")
      expect(own).toBeString();
    if (own === undefined) return;
    expect(processStarted(process.pid)).toBe(own);
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const other = processStarted(child.pid);
      expect(other).toBeString();
      expect(other).not.toBe(own);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("an owned lock is not broken by staleMs; only an old lock with no owner is", () => {
    const old = { pid: process.pid, at: Date.now() - 5_000, token: "old" };
    const dir = scratch();
    const held = plantLock(dir, old);
    expect(() =>
      withStateLock(dir, () => "never", { waitMs: 100, staleMs: 1 }),
    ).toThrow("timed out");
    expect(JSON.parse(readFileSync(ownerPath(held, old), "utf8"))).toEqual(old);

    const ownerless = scratch();
    const lock = plantLock(ownerless);
    const then = new Date(Date.now() - 5_000);
    utimesSync(lock, then, then);
    expect(
      withStateLock(ownerless, () => "entered", {
        waitMs: 3_000,
        staleMs: 1_000,
      }),
    ).toBe("entered");
    expect(readdirSync(ownerless)).toEqual([]);
  });

  test("a fresh lock of a running process is not broken: the waiter times out and the lock is left as it was", () => {
    const dir = scratch();
    const live = { pid: process.pid, at: Date.now(), token: "live" };
    const lock = plantLock(dir, live);
    expect(() => withStateLock(dir, () => "never", { waitMs: 300 })).toThrow(
      "timed out waiting for stand-in state lock",
    );
    expect(JSON.parse(readFileSync(ownerPath(lock, live), "utf8"))).toEqual(
      live,
    );
  });

  test("a holder whose lock was broken and taken by another does not remove the other's lock", () => {
    const dir = scratch();
    const other = { pid: process.pid, at: Date.now(), token: "other" };
    withStateLock(dir, () => {
      const lock = join(dir, "state.lock");
      for (const file of readdirSync(lock)) unlinkSync(join(lock, file));
      writeFileSync(ownerPath(lock, other), JSON.stringify(other));
    });
    expect(
      JSON.parse(
        readFileSync(ownerPath(join(dir, "state.lock"), other), "utf8"),
      ),
    ).toEqual(other);
  });

  test("processes that all find one stale lock break it once between them: no two are ever inside together and no write is lost", async () => {
    const dir = scratch();
    const work = scratch();
    plantLock(dir, { pid: await exitedPid(), at: Date.now(), token: "dead" });
    const worker = join(work, "worker.ts");
    // Each transaction makes a marker only one process can make, so a second
    // process inside the lock at the same time is counted.
    writeFileSync(
      worker,
      `import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
       import { join } from "node:path";
       import { readState, withStateLock, writeState } from ${JSON.stringify(
         join(
           import.meta.dir,
           "..",
           "..",
           "tests",
           "e2e",
           "bd-stand-in-state.ts",
         ),
       )};
       const dir = process.argv[2];
       let overlaps = 0;
       for (let i = 0; i < 20; i++)
         withStateLock(dir, () => {
           let marker;
           try { marker = openSync(join(dir, "inside"), "wx"); } catch { overlaps++; }
           const count = Number(readState(dir)["c"]?.title ?? "0") + 1;
           writeState(dir, { c: { id: "c", title: String(count), issue_type: "task", priority: 2, status: "open", created_at: "", updated_at: "" } });
           if (marker !== undefined) { closeSync(marker); rmSync(join(dir, "inside")); }
         }, { waitMs: 20_000 });
       console.log(JSON.stringify({ overlaps }));`,
    );
    const children = Array.from({ length: 8 }, () =>
      Bun.spawn([process.execPath, worker, dir], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return code === 0 ? JSON.parse(stdout) : { code, stdout, stderr };
      }),
    );
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ overlaps: 0 })));
    expect(readState(dir)["c"]?.title).toBe(String(8 * 20));
    expect(readdirSync(dir)).toEqual(["issues.json"]);
  }, 60_000);
});

describe("withRetries", () => {
  test("tries again after a sharing error, and answers what the work answers once it succeeds", () => {
    let calls = 0;
    const value = withRetries(
      () => {
        calls++;
        if (calls < 3) throw sharing(calls === 1 ? "EPERM" : "EBUSY");
        return "done";
      },
      { waitMs: 1 },
    );
    expect({ value, calls }).toEqual({ value: "done", calls: 3 });
  });

  test("gives up after the bound, with the last error", () => {
    let calls = 0;
    expect(() =>
      withRetries(
        () => {
          calls++;
          throw sharing("EACCES");
        },
        { tries: 4, waitMs: 1 },
      ),
    ).toThrow("EACCES");
    expect(calls).toBe(4);
  });

  test("any other error is thrown at once", () => {
    let calls = 0;
    expect(() =>
      withRetries(() => {
        calls++;
        throw sharing("ENOENT");
      }),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
  });
});

describe("readState and writeState", () => {
  test("a state written is the state read, and no temporary file is left", () => {
    const dir = scratch();
    expect(readState(dir)).toEqual({});
    const state: StandInState = {
      "e2e-1": {
        id: "e2e-1",
        title: "one",
        issue_type: "task",
        priority: 2,
        status: "open",
        created_at: "2026-10-12T00:00:00Z",
        updated_at: "2026-10-12T00:00:00Z",
        labels: ["queue:proposed"],
        metadata: { queue_state: "proposed" },
      },
    };
    writeState(dir, state);
    expect(readState(dir)).toEqual(state);
    expect(readdirSync(dir)).toEqual(["issues.json"]);
  });

  test("200 replacements while another process reads the file in a loop all succeed, and every read parses", async () => {
    const dir = scratch();
    writeState(dir, {});
    // The reader parses what it reads, so a half-written file would fail it.
    const reader = spawn(
      "bun",
      [
        "-e",
        `const { readFileSync } = require("node:fs");
         const file = ${JSON.stringify(join(dir, "issues.json"))};
         const until = Date.now() + 4000;
         let reads = 0, sharingErrors = 0;
         while (Date.now() < until) {
           try { JSON.parse(readFileSync(file, "utf8")); reads++; }
           catch (error) {
             if (["EPERM", "EBUSY", "EACCES"].includes(error.code)) sharingErrors++;
             else { console.log(JSON.stringify({ failed: String(error) })); process.exit(1); }
           }
         }
         console.log(JSON.stringify({ reads, sharingErrors }));`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    reader.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    const exited = new Promise<number | null>((done) =>
      reader.on("close", done),
    );
    await new Promise((done) => setTimeout(done, 300));
    for (let i = 0; i < 200; i++)
      writeState(dir, {
        [`e2e-${i}`]: {
          id: `e2e-${i}`,
          title: "x".repeat(2000),
          issue_type: "task",
          priority: 2,
          status: "open",
          created_at: "",
          updated_at: "",
        },
      });
    expect(Object.keys(readState(dir))).toEqual(["e2e-199"]);
    expect(await exited).toBe(0);
    expect(JSON.parse(out.trim())).toMatchObject({ reads: expect.any(Number) });
  }, 30_000);
});

describe("the stand-in's comments, and its create under a parent", () => {
  const STAND_IN = join(
    import.meta.dir,
    "..",
    "..",
    "tests",
    "e2e",
    "bd-stand-in.ts",
  );
  /** Run the stand-in itself, as the hearth runs `bd`: an argument array, no shell. */
  const bd = (dir: string, args: string[]) => {
    const run = spawnSync(process.execPath, [STAND_IN, ...args], {
      env: { ...process.env, BD_STAND_IN_STATE: dir },
      encoding: "utf8",
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };
  const issue = (id: string): StandInState[string] => ({
    id,
    title: id,
    issue_type: "task",
    priority: 2,
    status: "open",
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:00:00Z",
  });

  test("concurrent adds and creates wait for the state lock and preserve every write", async () => {
    const dir = scratch();
    writeState(dir, { "e2e-1": issue("e2e-1") });
    const spawnStandIn = (args: string[]) =>
      Bun.spawn([process.execPath, STAND_IN, ...args], {
        env: { ...process.env, BD_STAND_IN_STATE: dir },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    const children: ReturnType<typeof spawnStandIn>[] = [];
    /** 0 for a child that succeeded; what it printed, for one that did not. */
    const outcome = async (child: ReturnType<typeof spawnStandIn>) => {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return code === 0 ? 0 : { code, stdout, stderr };
    };
    try {
      withStateLock(dir, () => {
        for (const args of [
          ["comments", "add", "--json", "--", "e2e-1", "first"],
          ["comments", "add", "--json", "--", "e2e-1", "second"],
          ["create", "--title=first", "--type=task", "--priority=2", "--json"],
          ["create", "--title=second", "--type=task", "--priority=2", "--json"],
        ])
          children.push(spawnStandIn(args));
        // Give all children time to reach the held lock. Without a transaction
        // lock they write immediately, even though the fixture owns the lock.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        expect(readState(dir)).toEqual({ "e2e-1": issue("e2e-1") });
        expect(readComments(dir)).toEqual({});
      });
      // A child that failed shows its exit code and what it printed.
      expect(await Promise.all(children.map(outcome))).toEqual([0, 0, 0, 0]);
      expect(
        readComments(dir)
          ["e2e-1"]?.map((comment) => comment.text)
          .sort(),
      ).toEqual(["first", "second"]);
      expect(
        Object.values(readState(dir))
          .map((value) => value.title)
          .sort(),
      ).toEqual(["e2e-1", "first", "second"]);
      expect(readdirSync(dir).sort()).toEqual([
        "calls.jsonl",
        "comments.json",
        "issues.json",
      ]);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  }, 15_000);

  test("what `comments add` writes is printed back by the comments read, oldest first and as bd prints it; an issue with none prints none, and the issues are left as they were", () => {
    const dir = scratch();
    const issues: StandInState = {
      "e2e-1": issue("e2e-1"),
      "e2e-2": issue("e2e-2"),
    };
    writeState(dir, issues);
    const first = bd(dir, [
      "comments",
      "add",
      "--json",
      "--",
      "e2e-1",
      "review: COUNCIL c-1 PASS",
    ]);
    expect(first.status).toBe(0);
    const added = JSON.parse(first.stdout) as { id: string; issue_id: string };
    expect(added.issue_id).toBe("e2e-1");
    // A text that looks like an option is kept as a text.
    expect(
      bd(dir, ["comments", "add", "--json", "--", "e2e-1", "--help"]).status,
    ).toBe(0);

    const read = bd(dir, ["--readonly", "comments", "e2e-1", "--json"]);
    expect(read.status).toBe(0);
    const second = expect.stringMatching(/^[0-9a-f-]{36}$/);
    const time = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    // bd prints a read's fields in this order, timed to the second.
    expect(Object.keys(JSON.parse(read.stdout)[0] ?? {})).toEqual([
      "id",
      "issue_id",
      "author",
      "text",
      "created_at",
    ]);
    expect(JSON.parse(read.stdout)).toEqual([
      {
        id: added.id,
        issue_id: "e2e-1",
        author: "operator",
        text: "review: COUNCIL c-1 PASS",
        created_at: time,
      },
      {
        id: second,
        issue_id: "e2e-1",
        author: "operator",
        text: "--help",
        created_at: time,
      },
    ]);
    expect(
      JSON.parse(bd(dir, ["--readonly", "comments", "e2e-2", "--json"]).stdout),
    ).toEqual([]);
    expect(readState(dir)).toEqual(issues);
  }, 30_000);

  test("create --parent copies every label of the parent onto the child, a queue label included, and none of its metadata, as bd does", () => {
    const dir = scratch();
    writeState(dir, {
      "e2e-1": {
        ...issue("e2e-1"),
        labels: ["queue:queued", "area"],
        metadata: { queue_state: "queued" },
      },
      "e2e-2": issue("e2e-2"),
    });
    const created = bd(dir, [
      "create",
      "--title=A child",
      "--type=task",
      "--priority=2",
      "--parent=e2e-1",
      "--json",
    ]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      id: "e2e-1.1",
      labels: ["area", "queue:queued"],
    });
    expect(JSON.parse(created.stdout)).not.toHaveProperty("metadata");
    const kept = readState(dir)["e2e-1.1"];
    expect(kept?.labels).toEqual(["area", "queue:queued"]);
    expect(kept).not.toHaveProperty("metadata");

    // A parent with no labels gives a child with none.
    const plain = bd(dir, [
      "create",
      "--title=Another child",
      "--type=task",
      "--priority=2",
      "--parent=e2e-2",
      "--json",
    ]);
    expect(plain.status).toBe(0);
    expect(JSON.parse(plain.stdout)).not.toHaveProperty("labels");
  }, 30_000);

  test("a comment on an issue the stand-in does not know is refused as bd refuses it, and nothing is kept", () => {
    const dir = scratch();
    writeState(dir, { "e2e-1": issue("e2e-1") });
    const refused = bd(dir, [
      "comments",
      "add",
      "--json",
      "--",
      "e2e-9",
      "review: nowhere",
    ]);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      error: 'resolving e2e-9: no issue found matching "e2e-9"',
    });
    expect(readComments(dir)).toEqual({});
  }, 30_000);
});
