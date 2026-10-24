import { expect, test } from "bun:test";
import type { IsolationRerunProgress } from "./isolation-reruns";
import { settleIsolationReruns } from "./isolation-reruns";

test("the timed append file runs alone before bounded parallel home-safety work", async () => {
  const files = [
    "a.test.ts",
    "scripts/ledger/append.test.ts",
    "b.test.ts",
    "c.test.ts",
  ];
  const started: string[] = [];
  let releaseExclusive = () => {};
  let releaseParallel = () => {};
  let pairStarted = () => {};
  const exclusive = new Promise<void>((resolve) => {
    releaseExclusive = resolve;
  });
  const parallel = new Promise<void>((resolve) => {
    releaseParallel = resolve;
  });
  const pair = new Promise<void>((resolve) => {
    pairStarted = resolve;
  });
  let exclusiveActive = false;
  let active = 0;
  let maximum = 0;
  const work = settleIsolationReruns(files, 2, async (file) => {
    started.push(file);
    if (file === "scripts/ledger/append.test.ts") {
      expect(active).toBe(0);
      exclusiveActive = true;
      await exclusive;
      exclusiveActive = false;
    } else {
      expect(exclusiveActive).toBe(false);
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) pairStarted();
      await parallel;
      active--;
    }
    return file;
  });
  expect(started).toEqual(["scripts/ledger/append.test.ts"]);
  releaseExclusive();
  await pair;
  expect(started).toEqual([
    "scripts/ledger/append.test.ts",
    "a.test.ts",
    "b.test.ts",
  ]);
  releaseParallel();
  const results = await work;
  expect(maximum).toBe(2);
  expect(started).toHaveLength(files.length);
  expect(results).toEqual(
    files.map((value) => ({ status: "fulfilled", value })),
  );
});

test("a failed exclusive or parallel file cannot hide failures or prevent the remaining files from running", async () => {
  const files = [
    "a.test.ts",
    "scripts/ledger/append.test.ts",
    "b.test.ts",
    "c.test.ts",
  ];
  const started: string[] = [];
  const results = await settleIsolationReruns(files, 2, async (file) => {
    started.push(file);
    if (file === "scripts/ledger/append.test.ts" || file === "b.test.ts")
      throw new Error(file);
    return file;
  });
  expect(new Set(started).size).toBe(files.length);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
    "rejected",
    "fulfilled",
  ]);
});

test("progress names the exact exclusive and active files before waiting and retains counts through every settlement", async () => {
  const files = ["a.test.ts", "scripts/ledger/append.test.ts", "b.test.ts"];
  const progress: IsolationRerunProgress[] = [];
  let releaseExclusive = () => {},
    releaseParallel = () => {},
    paired = () => {};
  const exclusive = new Promise<void>((resolve) => {
    releaseExclusive = resolve;
  });
  const parallel = new Promise<void>((resolve) => {
    releaseParallel = resolve;
  });
  const pair = new Promise<void>((resolve) => {
    paired = resolve;
  });
  let active = 0;
  const work = settleIsolationReruns(
    files,
    2,
    async (file) => {
      if (file === "scripts/ledger/append.test.ts") await exclusive;
      else {
        if (++active === 2) paired();
        await parallel;
        if (file === "b.test.ts") throw Error("PRIVATE CHILD FAILURE BODY");
      }
      return "PRIVATE CHILD RESULT BODY";
    },
    (event) => {
      progress.push(event);
    },
  );
  expect(progress).toEqual([
    expect.objectContaining({
      event: "started",
      phase: "exclusive",
      file: "scripts/ledger/append.test.ts",
      total: 3,
      completed: 0,
      activeCount: 1,
      pendingCount: 2,
      active: [
        {
          file: "scripts/ledger/append.test.ts",
          elapsedMs: expect.any(Number),
        },
      ],
      pending: ["a.test.ts", "b.test.ts"],
      elapsedMs: expect.any(Number),
    }),
  ]);
  releaseExclusive();
  await pair;
  expect(progress.at(-1)).toMatchObject({
    event: "started",
    phase: "parallel",
    file: "b.test.ts",
    total: 3,
    completed: 1,
    activeCount: 2,
    pendingCount: 0,
    active: [
      { file: "a.test.ts", elapsedMs: expect.any(Number) },
      { file: "b.test.ts", elapsedMs: expect.any(Number) },
    ],
    pending: [],
  });
  releaseParallel();
  expect((await work).map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "rejected",
  ]);
  expect(progress.filter((event) => event.event === "finished")).toHaveLength(
    3,
  );
  expect(progress.at(-1)).toMatchObject({
    event: "complete",
    phase: "complete",
    file: null,
    total: 3,
    completed: 3,
    activeCount: 0,
    pendingCount: 0,
    active: [],
    pending: [],
  });
  expect(JSON.stringify(progress)).not.toContain("PRIVATE CHILD");
});

test("progress stays bounded while all full file names still execute and diagnostic failures cannot hide results", async () => {
  const files = Array.from(
    { length: 40 },
    (_, index) => `${index}-${"長".repeat(500)}.test.ts`,
  );
  const progress: IsolationRerunProgress[] = [];
  const visited: string[] = [];
  const result = await settleIsolationReruns(
    files,
    16,
    async (file) => {
      visited.push(file);
      return file;
    },
    (event) => {
      progress.push(event);
    },
  );
  expect(visited).toEqual(files);
  expect(result).toEqual(
    files.map((value) => ({ status: "fulfilled", value })),
  );
  for (const event of progress) {
    expect(event.active.length).toBeLessThanOrEqual(4);
    expect(event.pending.length).toBeLessThanOrEqual(8);
    expect(event.file?.length ?? 0).toBeLessThanOrEqual(160);
    expect(
      new TextEncoder().encode(JSON.stringify(event)).byteLength,
    ).toBeLessThanOrEqual(8192);
    expect(event.completed + event.activeCount + event.pendingCount).toBe(
      files.length,
    );
  }
  expect(
    progress.some((event) => event.activeCount > event.active.length),
  ).toBe(true);
  const failedDiagnostics = await settleIsolationReruns(
    ["a", "b"],
    1,
    async (file) => {
      if (file === "b") throw Error("actual child failure");
      return file;
    },
    () => {
      throw Error("diagnostic output unavailable");
    },
  );
  expect(failedDiagnostics.map((entry) => entry.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
});
