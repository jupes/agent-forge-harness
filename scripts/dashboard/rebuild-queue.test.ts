import { describe, expect, test } from "bun:test";
import { createRebuildQueue, type RebuildOutcome } from "./rebuild-queue";

/** Builds that finish only when the test says so. */
function heldBuilds(): {
  build: () => Promise<RebuildOutcome>;
  started: () => number;
  finish: (index: number, outcome: RebuildOutcome) => void;
} {
  const finishers: ((outcome: RebuildOutcome) => void)[] = [];
  return {
    build: () =>
      new Promise<RebuildOutcome>((resolve) => {
        finishers.push(resolve);
      }),
    started: () => finishers.length,
    finish: (index, outcome) => {
      const done = finishers[index];
      if (!done) throw new Error(`build ${index} has not started`);
      done(outcome);
    },
  };
}

/** Let settled promises run their callbacks. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("createRebuildQueue", () => {
  test("a request with nothing running starts a build and gets its outcome", async () => {
    const held = heldBuilds();
    const queue = createRebuildQueue(held.build);

    const answer = queue.request();
    expect(held.started()).toBe(1);
    held.finish(0, { ok: true, output: "one" });

    expect(await answer).toEqual({ ok: true, output: "one" });
  });

  test("requests made while a build runs start no second build until it ends, then share one more build", async () => {
    const held = heldBuilds();
    const queue = createRebuildQueue(held.build);

    const first = queue.request();
    const second = queue.request();
    const third = queue.request();
    expect(held.started()).toBe(1);

    held.finish(0, { ok: true, output: "first" });
    expect(await first).toEqual({ ok: true, output: "first" });
    await settle();
    expect(held.started()).toBe(2);

    held.finish(1, { ok: true, output: "second" });
    expect(await second).toEqual({ ok: true, output: "second" });
    expect(await third).toEqual({ ok: true, output: "second" });
    await settle();
    expect(held.started()).toBe(2);
  });

  test("a request after everything has finished starts a new build", async () => {
    const held = heldBuilds();
    const queue = createRebuildQueue(held.build);

    const first = queue.request();
    held.finish(0, { ok: true, output: "first" });
    await first;
    await settle();

    const later = queue.request();
    expect(held.started()).toBe(2);
    held.finish(1, { ok: false, output: "later" });
    expect(await later).toEqual({ ok: false, output: "later" });
  });

  test("a build that throws or rejects is answered as a failed outcome, and the queue keeps working", async () => {
    let calls = 0;
    const queue = createRebuildQueue(() => {
      calls += 1;
      if (calls === 1) throw new Error("could not spawn");
      if (calls === 2) return Promise.reject(new Error("went away"));
      return Promise.resolve({ ok: true, output: "fine" });
    });

    expect(await queue.request()).toEqual({
      ok: false,
      output: "could not spawn",
    });
    expect(await queue.request()).toEqual({ ok: false, output: "went away" });
    expect(await queue.request()).toEqual({ ok: true, output: "fine" });
  });
});
