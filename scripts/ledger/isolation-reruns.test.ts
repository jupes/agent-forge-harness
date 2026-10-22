import { expect, test } from "bun:test";
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
