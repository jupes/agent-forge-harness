/**
 * The browser suite's `bd` stand-in state (`tests/e2e/bd-stand-in-state.ts`):
 * whole-file replacement and the retries that keep it working on Windows,
 * where a file another process holds open cannot always be replaced.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  owner?: { pid: number; at: number; token: string },
): string {
  const lock = join(dir, "state.lock");
  mkdirSync(lock);
  if (owner !== undefined)
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  return lock;
}

describe("withStateLock", () => {
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

  test("a lock older than the stale bound is broken although its holder's process runs, and so is an old lock with no owner written", () => {
    const old = { pid: process.pid, at: Date.now() - 5_000, token: "old" };
    const dir = scratch();
    plantLock(dir, old);
    expect(
      withStateLock(dir, () => "entered", { waitMs: 3_000, staleMs: 1_000 }),
    ).toBe("entered");
    expect(readdirSync(dir)).toEqual([]);

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
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual(
      live,
    );
  });

  test("a holder whose lock was broken and taken by another does not remove the other's lock", () => {
    const dir = scratch();
    const other = { pid: process.pid, at: Date.now(), token: "other" };
    withStateLock(dir, () => {
      writeFileSync(
        join(dir, "state.lock", "owner.json"),
        JSON.stringify(other),
      );
    });
    expect(
      JSON.parse(readFileSync(join(dir, "state.lock", "owner.json"), "utf8")),
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
