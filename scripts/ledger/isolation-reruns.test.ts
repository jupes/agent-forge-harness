import { expect, test } from "bun:test";
import type {
  IsolationFailureRecord,
  IsolationRerunProgress,
} from "./isolation-reruns";
import {
  IsolationHardDeadlineError,
  pendingIsolationObligationCount,
  settleIsolationReruns,
} from "./isolation-reruns";

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

test("packaged hearth compilation and timed append each settle alone before every parallel file runs once", async () => {
  const compiled = "scripts/hearth/codex-sync-compiled.test.ts",
    append = "scripts/ledger/append.test.ts",
    files = ["a.test.ts", compiled, append, "b.test.ts"];
  const started: string[] = [],
    active = new Set<string>();
  let releaseCompile = () => {},
    releaseAppend = () => {},
    releaseParallel = () => {},
    appendEntered = () => {},
    parallelEntered = () => {};
  const compileGate = new Promise<void>((resolve) => {
      releaseCompile = resolve;
    }),
    appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    }),
    parallelGate = new Promise<void>((resolve) => {
      releaseParallel = resolve;
    }),
    appendReady = new Promise<void>((resolve) => {
      appendEntered = resolve;
    }),
    parallelReady = new Promise<void>((resolve) => {
      parallelEntered = resolve;
    });
  const work = settleIsolationReruns(files, 2, async (file) => {
    started.push(file);
    if (file === compiled || file === append) expect(active.size).toBe(0);
    else {
      expect(active.has(compiled)).toBe(false);
      expect(active.has(append)).toBe(false);
    }
    active.add(file);
    if (file === compiled) await compileGate;
    else if (file === append) {
      appendEntered();
      await appendGate;
    } else {
      if (active.size === 2) parallelEntered();
      await parallelGate;
    }
    active.delete(file);
    return file;
  });
  try {
    expect(started).toEqual([compiled]);
    releaseCompile();
    await appendReady;
    expect(started).toEqual([compiled, append]);
    releaseAppend();
    await parallelReady;
    expect(started).toEqual([compiled, append, "a.test.ts", "b.test.ts"]);
  } finally {
    releaseCompile();
    releaseAppend();
    releaseParallel();
  }
  expect(await work).toEqual(
    files.map((value) => ({ status: "fulfilled", value })),
  );
  expect(new Set(started).size).toBe(files.length);
  expect(active.size).toBe(0);
});

test("a failed exclusive or parallel file cannot hide failures or prevent the remaining files from running", async () => {
  const files = [
    "a.test.ts",
    "scripts/ledger/append.test.ts",
    "scripts/hearth/codex-sync-compiled.test.ts",
    "b.test.ts",
    "c.test.ts",
  ];
  const started: string[] = [];
  const results = await settleIsolationReruns(files, 2, async (file) => {
    started.push(file);
    if (
      file === "scripts/ledger/append.test.ts" ||
      file === "scripts/hearth/codex-sync-compiled.test.ts" ||
      file === "b.test.ts"
    )
      throw new Error(file);
    return file;
  });
  expect(new Set(started).size).toBe(files.length);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
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

/**
 * Causal RED scaffold: add the typed run-control seam without changing the old
 * queue loop and this test fails only at the invocation-count assertion below.
 * The GREEN coordinator keeps the same fixture and blocks the third dequeue.
 */
test("deadline stops new dequeues while already-started callbacks settle", async () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts"];
  const abort = new AbortController();
  const started: string[] = [];
  let releaseActive = () => {};
  let pairStarted = () => {};
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const pair = new Promise<void>((resolve) => {
    pairStarted = resolve;
  });
  let active = 0;
  const work = settleIsolationReruns(
    files,
    2,
    async (file) => {
      started.push(file);
      active++;
      if (active === 2) pairStarted();
      await activeGate;
      active--;
      return file;
    },
    undefined,
    { signal: abort.signal, deadlineAt: Number.POSITIVE_INFINITY },
  );
  const observed = work.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  try {
    await pair;
    abort.abort(new Error("controlled cancellation"));
    releaseActive();
    const settled = await observed;
    expect("error" in settled).toBe(false);
    if ("result" in settled) {
      expect(started).toEqual(["a.test.ts", "b.test.ts"]);
      expect(settled.result).toHaveLength(3);
      expect(settled.result.slice(0, 2).map((entry) => entry.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(settled.result[2]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          name: "IsolationUnstartedError",
          file: "c.test.ts",
          index: 2,
          kind: "deadline",
        }),
      });
    }
  } finally {
    releaseActive();
    if (!abort.signal.aborted) abort.abort(new Error("fixture cleanup"));
    await observed;
  }
});

test("an already-aborted signal returns ordered explicit unstarted failures without invoking a callback", async () => {
  const abort = new AbortController();
  abort.abort(new Error("pre-aborted"));
  let calls = 0;
  const files = ["a.test.ts", "b.test.ts"];
  const result = await settleIsolationReruns(
    files,
    2,
    async (file) => {
      calls++;
      return file;
    },
    undefined,
    { signal: abort.signal, deadlineAt: Number.POSITIVE_INFINITY },
  );
  expect(calls).toBe(0);
  expect(result).toHaveLength(files.length);
  expect(result.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
  const indexes = result.map((entry) => {
    if (entry.status !== "rejected")
      throw new Error("Expected an explicit unstarted rejection");
    const reason = entry.reason;
    if (!(reason instanceof Error) || !("index" in reason))
      throw new Error("Expected the indexed unstarted reason");
    return reason.index;
  });
  expect(indexes).toEqual([0, 1]);
});

test("the absolute cutoff is checked before the first dequeue", async () => {
  let calls = 0;
  const result = await settleIsolationReruns(
    ["a.test.ts", "b.test.ts"],
    1,
    async (file) => {
      calls++;
      return file;
    },
    undefined,
    { deadlineAt: 10, now: () => 10 },
  );
  expect(calls).toBe(0);
  expect(result.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
  const kinds = result.map((entry) => {
    if (entry.status !== "rejected")
      throw new Error("Expected a cutoff rejection");
    const reason = entry.reason;
    if (!(reason instanceof Error) || !("kind" in reason))
      throw new Error("Expected the bounded cutoff classification");
    return reason.kind;
  });
  expect(kinds).toEqual(["deadline", "deadline"]);
});

test("a registered owner receives one exact stop and its done settlement is awaited", async () => {
  const abort = new AbortController();
  let stopCalls = 0;
  let releaseDone = () => {};
  let entered = () => {};
  const done = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resultPromise = settleIsolationReruns(
    ["a.test.ts", "b.test.ts"],
    1,
    async (file, control) => {
      if (file === "a.test.ts") {
        const owner = {
          done,
          stop: async (_reason: string) => {
            stopCalls++;
            releaseDone();
          },
        };
        expect(control.registerOwner(owner)).toBe(true);
        entered();
        await done;
      }
      return file;
    },
    undefined,
    { signal: abort.signal, deadlineAt: Number.POSITIVE_INFINITY },
  );
  const observed = resultPromise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  try {
    await started;
    abort.abort(new Error("stop owner"));
    const settled = await observed;
    expect("error" in settled).toBe(false);
    expect(stopCalls).toBe(1);
    if ("result" in settled) {
      expect(settled.result.map((entry) => entry.status)).toEqual([
        "rejected",
        "rejected",
      ]);
    }
  } finally {
    releaseDone();
    if (!abort.signal.aborted) abort.abort(new Error("fixture cleanup"));
    await observed;
  }
});

test("an explicit fatal channel stops admission while ordinary callback rejection remains nonfatal", async () => {
  const fatal = new Error("controlled owner failure");
  const started: string[] = [];
  const fatalResult = await settleIsolationReruns(
    ["a.test.ts", "b.test.ts", "c.test.ts"],
    1,
    async (file, control) => {
      started.push(file);
      control.failFatal(fatal);
      throw fatal;
    },
  );
  expect(started).toEqual(["a.test.ts"]);
  expect(fatalResult).toHaveLength(3);
  const fatalFirst = fatalResult[0];
  if (fatalFirst?.status !== "rejected")
    throw new Error("Expected fatal first result.");
  expect(fatalFirst).toEqual({
    status: "rejected",
    reason: fatal,
    failureRecord: {
      file: "a.test.ts",
      primary: fatal,
      hasPrimary: true,
      secondaryErrors: [],
    },
  });
  expect(fatalFirst.reason).toBe(fatal);
  expect(fatalFirst.failureRecord?.primary).toBe(fatal);
  expect(fatalResult.slice(1).map((entry) => entry.status)).toEqual([
    "rejected",
    "rejected",
  ]);

  const ordinary = new Error("ordinary callback rejection");
  const ordinaryStarted: string[] = [];
  const ordinaryResult = await settleIsolationReruns(
    ["a.test.ts", "b.test.ts", "c.test.ts"],
    1,
    async (file) => {
      ordinaryStarted.push(file);
      if (file === "b.test.ts") throw ordinary;
      return file;
    },
  );
  expect(ordinaryStarted).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
  const ordinarySecond = ordinaryResult[1];
  if (ordinarySecond?.status !== "rejected")
    throw new Error("Expected ordinary callback rejection.");
  expect(ordinarySecond).toEqual({
    status: "rejected",
    reason: ordinary,
    failureRecord: {
      file: "b.test.ts",
      primary: ordinary,
      hasPrimary: true,
      secondaryErrors: [],
    },
  });
  expect(ordinarySecond.reason).toBe(ordinary);
  expect(ordinarySecond.failureRecord?.primary).toBe(ordinary);
});

test("exclusive cutoff blocks every parallel dequeue and returns explicit ordered unstarted failures", async () => {
  const abort = new AbortController();
  const started: string[] = [];
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signal = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = settleIsolationReruns(
    ["a.test.ts", "scripts/ledger/append.test.ts", "b.test.ts"],
    2,
    async (file) => {
      started.push(file);
      entered();
      await gate;
      return file;
    },
    undefined,
    { signal: abort.signal, deadlineAt: Number.POSITIVE_INFINITY },
  );
  try {
    await signal;
    expect(started).toEqual(["scripts/ledger/append.test.ts"]);
    abort.abort(new Error("exclusive cutoff"));
    release();
    const results = await work;
    expect(started).toEqual(["scripts/ledger/append.test.ts"]);
    expect(results.map((entry) => entry.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
  } finally {
    release();
    if (!abort.signal.aborted) abort.abort(new Error("fixture cleanup"));
    await work;
  }
});

test("callback and Stop can finish while the same owner done remains held", async () => {
  const abort = new AbortController();
  let releaseDone = () => {};
  let entered = () => {};
  let stopCalls = 0;
  const done = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let returned = false;
  const work = settleIsolationReruns(
    ["owned.test.ts", "unstarted.test.ts"],
    1,
    async (_file, control) => {
      expect(
        control.registerOwner({
          done,
          stop: async () => {
            stopCalls++;
          },
        }),
      ).toBe(true);
      entered();
      return "callback returned";
    },
    undefined,
    { signal: abort.signal, deadlineAt: Number.POSITIVE_INFINITY },
  ).then((result) => {
    returned = true;
    return result;
  });
  try {
    await started;
    abort.abort(new Error("controlled retirement"));
    await Promise.resolve();
    await Promise.resolve();
    expect(stopCalls).toBe(1);
    expect(returned).toBe(false);
    releaseDone();
    const result = await work;
    expect(returned).toBe(true);
    expect(result.map((entry) => entry.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  } finally {
    releaseDone();
    if (!abort.signal.aborted) abort.abort(new Error("fixture cleanup"));
    await work;
  }
});

test("hard retirement expiry returns failure but retains the exact pending done obligation", async () => {
  let releaseDone = () => {};
  let rejectDone = (_error: Error) => {};
  let entered = () => {};
  const done = new Promise<void>((resolve, reject) => {
    releaseDone = resolve;
    rejectDone = reject;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let stopCalls = 0;
  const baselineObligations = pendingIsolationObligationCount();
  let retainedAtHard = 0;
  let retainScratch = false;
  let pendingNow = 0;
  const progress: IsolationRerunProgress[] = [];
  const work = settleIsolationReruns(
    ["held.test.ts"],
    1,
    async (_file, control) => {
      control.registerOwner({
        done,
        stop: async () => {
          stopCalls++;
        },
      });
      entered();
      return "callback settled";
    },
    (event) => progress.push(event),
    {
      deadlineAt: Number.POSITIVE_INFINITY,
      hardDeadlineAt: performance.now() + 40,
      onHardDeadline(pending) {
        retainedAtHard = pending;
        if (pending > 0) retainScratch = true;
      },
      onPendingChange(pending) {
        pendingNow = pending;
      },
    },
  );
  let resultRecord: IsolationFailureRecord | undefined;
  let resultReason: unknown;
  try {
    await started;
    const result = await work;
    resultRecord = result[0]?.failureRecord;
    expect(stopCalls).toBe(1);
    expect(retainedAtHard).toBeGreaterThan(0);
    expect(retainScratch).toBe(true);
    expect(pendingIsolationObligationCount()).toBeGreaterThan(
      baselineObligations,
    );
    expect(result[0]?.status).toBe("rejected");
    expect(pendingNow).toBeGreaterThan(0);
    if (result[0]?.status !== "rejected")
      throw new Error("Expected hard-deadline rejection");
    resultReason = result[0].reason;
    expect(result[0].reason).toBeInstanceOf(IsolationHardDeadlineError);
    expect(result[0].reason).toMatchObject({
      name: "IsolationHardDeadlineError",
      pending: retainedAtHard,
    });
    const retainedFailureRecord = result[0].failureRecord;
    expect(retainedFailureRecord?.primary).toBe(result[0].reason);
    expect(retainedFailureRecord?.secondaryErrors).toEqual([]);
    expect(progress.at(-1)).toMatchObject({
      event: "incomplete",
      completed: 0,
      finishedCount: 0,
      activeCount: 1,
    });
    expect(progress.some((event) => event.event === "complete")).toBe(false);
  } finally {
    const lateFailure = new Error("late done rejection");
    rejectDone(lateFailure);
    await work;
    await Promise.resolve();
    await Promise.resolve();
    expect(resultRecord?.secondaryErrors).toContain(lateFailure);
    expect(resultRecord?.primary).toBe(resultReason);
    expect(pendingNow).toBe(0);
  }
  await Promise.resolve();
  expect(pendingIsolationObligationCount()).toBeLessThanOrEqual(
    baselineObligations,
  );
});

test("a refused owner registration still observes done after Stop and preserves cutoff precedence", async () => {
  const abort = new AbortController();
  let rejectDone = (_error: Error) => {};
  let entered = () => {};
  let stopCalls = 0;
  const done = new Promise<void>((_resolve, reject) => {
    rejectDone = reject;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let returned = false;
  const work = settleIsolationReruns(
    ["refused.test.ts"],
    1,
    async (_file, control) => {
      abort.abort(new Error("primary cutoff"));
      expect(
        control.registerOwner({
          done,
          stop: async () => {
            stopCalls++;
          },
        }),
      ).toBe(false);
      entered();
      return "refused";
    },
    undefined,
    { signal: abort.signal, deadlineAt: Number.POSITIVE_INFINITY },
  ).then((result) => {
    returned = true;
    return result;
  });
  try {
    await started;
    await Promise.resolve();
    expect(stopCalls).toBe(1);
    expect(returned).toBe(false);
    rejectDone(new Error("late owner cleanup error"));
    const result = await work;
    expect(returned).toBe(true);
    expect(result[0]?.status).toBe("rejected");
    if (result[0]?.status !== "rejected")
      throw new Error("Expected cutoff rejection");
    const reason = result[0].reason;
    if (!(reason instanceof Error))
      throw new Error("Expected the latched cutoff Error");
    expect(reason.message).toBe("primary cutoff");
  } finally {
    rejectDone(new Error("fixture cleanup"));
    if (!abort.signal.aborted) abort.abort(new Error("fixture cleanup"));
    await work;
  }
});

test("a Stop failure is separately counted and cannot replace an already-latched cutoff", async () => {
  const abort = new AbortController();
  const primary = new Error("primary cutoff");
  const stopFailure = new Error("cleanup stop failed");
  let releaseDone = () => {};
  let entered = () => {};
  const done = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const progress: IsolationRerunProgress[] = [];
  const work = settleIsolationReruns(
    ["stop-failure.test.ts"],
    1,
    async (_file, control) => {
      control.registerOwner({
        done,
        stop: async () => {
          throw stopFailure;
        },
      });
      entered();
      await done;
      return "settled";
    },
    (event) => progress.push(event),
    { signal: abort.signal, deadlineAt: Number.POSITIVE_INFINITY },
  );
  try {
    await started;
    abort.abort(primary);
    releaseDone();
    const result = await work;
    expect(result[0]?.status).toBe("rejected");
    if (result[0]?.status !== "rejected")
      throw new Error("Expected cutoff rejection");
    expect(result[0].reason).toBe(primary);
    expect(progress.at(-1)?.cleanupFailureCount).toBe(1);
  } finally {
    releaseDone();
    if (!abort.signal.aborted) abort.abort(new Error("fixture cleanup"));
    await work;
  }
});

test("a callback error observed before cutoff stays primary while its owner remains unsettled", async () => {
  const callbackFailure = new Error("ordinary callback failure before cutoff");
  let releaseDone = () => {};
  let entered = () => {};
  const done = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const start = performance.now();
  const work = settleIsolationReruns(
    ["ordinary-before-cutoff.test.ts"],
    1,
    async (_file, control) => {
      control.registerOwner({ done, stop: async () => {} });
      entered();
      throw callbackFailure;
    },
    undefined,
    { deadlineAt: start + 20, hardDeadlineAt: start + 60 },
  );
  try {
    await started;
    const result = await work;
    expect(result[0]?.status).toBe("rejected");
    if (result[0]?.status !== "rejected")
      throw new Error("Expected callback rejection");
    expect(result[0].reason).toBe(callbackFailure);
  } finally {
    releaseDone();
    await work;
  }
});

test("an independent capture obligation fences one active entry through Stop and owner completion", async () => {
  const abort = new AbortController();
  let releaseCapture = () => {};
  let heldStarted = () => {};
  let peerFinished = () => {};
  let stopCalls = 0;
  let completed = false;
  let observedPending = 0;
  let pendingAtPeerFinish = 0;
  const capture = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const held = new Promise<void>((resolve) => {
    heldStarted = resolve;
  });
  const peer = new Promise<void>((resolve) => {
    peerFinished = resolve;
  });
  const work = settleIsolationReruns(
    ["held.test.ts", "peer.test.ts"],
    2,
    async (file, control) => {
      if (file === "peer.test.ts") return "peer";
      control.registerOwner({
        done: Promise.resolve(),
        stop: async () => {
          stopCalls++;
        },
      });
      control.registerObligation(capture);
      heldStarted();
      return "callback returned before capture";
    },
    (event) => {
      if (event.event === "finished" && event.file === "peer.test.ts") {
        pendingAtPeerFinish = observedPending;
        peerFinished();
      }
      if (event.event === "complete") completed = true;
    },
    {
      signal: abort.signal,
      deadlineAt: Number.POSITIVE_INFINITY,
      onPendingChange(pending) {
        observedPending = pending;
      },
    },
  );
  try {
    await Promise.all([held, peer]);
    abort.abort(new Error("controlled cutoff"));
    await Promise.resolve();
    await Promise.resolve();
    expect(stopCalls).toBe(1);
    expect(pendingAtPeerFinish).toBeGreaterThan(0);
    expect(completed).toBe(false);
    releaseCapture();
    const results = await work;
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    expect(completed).toBe(true);
  } finally {
    releaseCapture();
    if (!abort.signal.aborted) abort.abort(new Error("fixture cleanup"));
    await work;
  }
});

test("a final monotonic check catches cutoff when its timer has not fired", async () => {
  let clock = 0;
  const results = await settleIsolationReruns(
    ["clock.test.ts"],
    1,
    async () => {
      clock = 1_000;
      return "late";
    },
    undefined,
    {
      deadlineAt: 1_000,
      hardDeadlineAt: Number.POSITIVE_INFINITY,
      now: () => clock,
    },
  );
  expect(results[0]?.status).toBe("rejected");
  if (results[0]?.status !== "rejected")
    throw new Error("Expected final cutoff rejection");
  expect(results[0].reason).toMatchObject({
    message: "Isolation rerun work cutoff reached",
  });
});

test("callback identity stays primary while later Stop and done failures stay attached", async () => {
  const callbackFailure = new Error("original callback object");
  const doneFailure = new Error("later done object");
  const stopFailure = new Error("later Stop object");
  let rejectDone = (_error: Error) => {};
  let entered = () => {};
  const done = new Promise<void>((_resolve, reject) => {
    rejectDone = reject;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = settleIsolationReruns(
    ["failure.test.ts"],
    1,
    async (_file, control) => {
      control.registerOwner({
        done,
        stop: async () => {
          throw stopFailure;
        },
      });
      entered();
      throw callbackFailure;
    },
    undefined,
    { deadlineAt: Number.POSITIVE_INFINITY },
  );
  try {
    await started;
    await Promise.resolve();
    await Promise.resolve();
    rejectDone(doneFailure);
    const results = await work;
    expect(results[0]?.status).toBe("rejected");
    if (results[0]?.status !== "rejected")
      throw new Error("Expected original callback failure");
    expect(results[0].reason).toBe(callbackFailure);
    expect(results[0].failureRecord?.primary).toBe(callbackFailure);
    expect(results[0].failureRecord?.secondaryErrors).toEqual([
      doneFailure,
      stopFailure,
    ]);
  } finally {
    rejectDone(new Error("fixture cleanup"));
    await work;
  }
});

test("an already-authorized grant gap may start late but remains the same owned settlement", async () => {
  const abort = new AbortController();
  let releaseGap = () => {};
  let releaseDone = () => {};
  let granted = () => {};
  const gap = new Promise<void>((resolve) => {
    releaseGap = resolve;
  });
  const done = new Promise<void>((resolve) => {
    releaseDone = resolve;
  });
  const grant = new Promise<void>((resolve) => {
    granted = resolve;
  });
  let launchedAfterCutoff = false;
  let stopCalls = 0;
  const work = settleIsolationReruns(
    ["authorized-gap.test.ts"],
    1,
    async (_file, control) => {
      control.registerOwner({
        done,
        stop: async () => {
          stopCalls++;
        },
      });
      granted();
      await gap;
      // Models the already-authorized write gap: it may produce a child after cutoff.
      launchedAfterCutoff = abort.signal.aborted;
      await done;
      return "settled";
    },
    undefined,
    { signal: abort.signal, deadlineAt: Number.POSITIVE_INFINITY },
  );
  try {
    await grant;
    abort.abort(new Error("cutoff after authorization"));
    releaseGap();
    await Promise.resolve();
    expect(launchedAfterCutoff).toBe(true);
    expect(stopCalls).toBe(1);
    releaseDone();
    const result = await work;
    expect(result[0]?.status).toBe("rejected");
    expect(result).toHaveLength(1);
  } finally {
    releaseGap();
    releaseDone();
    if (!abort.signal.aborted) abort.abort(new Error("fixture cleanup"));
    await work;
  }
});

test("three-worker reruns hold the fourth, refill FIFO, and retain indexed failures", async () => {
  const append = "scripts/ledger/append.test.ts";
  const files = [
    "a.test.ts",
    append,
    "b.test.ts",
    "c.test.ts",
    "d.test.ts",
    "e.test.ts",
  ];
  const started: string[] = [];
  const settled: string[] = [];
  const progress: IsolationRerunProgress[] = [];
  const gates = new Map<
    string,
    { promise: Promise<void>; release: () => void }
  >();
  for (const file of files) {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(file, { promise, release });
  }

  let signalThree = () => {};
  let signalFourth = () => {};
  let signalFifth = () => {};
  const threeStarted = new Promise<void>((resolve) => {
    signalThree = resolve;
  });
  const fourthStarted = new Promise<void>((resolve) => {
    signalFourth = resolve;
  });
  const fifthStarted = new Promise<void>((resolve) => {
    signalFifth = resolve;
  });
  const ordinary = new Error("ordinary callback identity");
  let active = 0;
  let maximum = 0;
  const work = settleIsolationReruns(
    files,
    3,
    async (file) => {
      started.push(file);
      const gate = gates.get(file);
      if (!gate) throw new Error(`Missing gate for ${file}`);
      if (file === append) {
        expect(active).toBe(0);
        await gate.promise;
        settled.push(file);
        return file;
      }
      active++;
      maximum = Math.max(maximum, active);
      if (active === 3) signalThree();
      if (file === "d.test.ts") signalFourth();
      if (file === "e.test.ts") signalFifth();
      try {
        await gate.promise;
        if (file === "b.test.ts") throw ordinary;
        return file;
      } finally {
        active--;
        settled.push(file);
      }
    },
    (event) => progress.push(event),
  );

  try {
    expect(started).toEqual([append]);
    expect(progress[0]).toMatchObject({
      event: "started",
      phase: "exclusive",
      file: append,
      activeCount: 1,
      pendingCount: 5,
    });
    gates.get(append)!.release();
    await threeStarted;
    expect(started).toEqual([append, "a.test.ts", "b.test.ts", "c.test.ts"]);
    expect(maximum).toBe(3);
    expect(progress.at(-1)).toMatchObject({
      event: "started",
      phase: "parallel",
      file: "c.test.ts",
      activeCount: 3,
      pendingCount: 2,
    });

    gates.get("c.test.ts")!.release();
    await fourthStarted;
    expect(started).toEqual([
      append,
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
    ]);
    gates.get("b.test.ts")!.release();
    await fifthStarted;
    expect(started).toEqual([
      append,
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
      "e.test.ts",
    ]);

    gates.get("e.test.ts")!.release();
    gates.get("d.test.ts")!.release();
    gates.get("a.test.ts")!.release();
    const results = await work;
    expect(started).toEqual([
      append,
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
      "e.test.ts",
    ]);
    expect(settled).toEqual([
      append,
      "c.test.ts",
      "b.test.ts",
      "e.test.ts",
      "d.test.ts",
      "a.test.ts",
    ]);
    expect(maximum).toBe(3);
    expect(active).toBe(0);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(
      results.map((result) =>
        result.status === "fulfilled" ? result.value : result.reason,
      ),
    ).toEqual([
      "a.test.ts",
      append,
      ordinary,
      "c.test.ts",
      "d.test.ts",
      "e.test.ts",
    ]);
    const ordinaryResult = results[2];
    if (ordinaryResult?.status !== "rejected")
      throw new Error("Expected ordinary callback rejection.");
    expect(ordinaryResult.reason).toBe(ordinary);
    expect(progress.at(-1)).toMatchObject({
      event: "complete",
      phase: "complete",
      completed: files.length,
      activeCount: 0,
      pendingCount: 0,
    });
  } finally {
    for (const gate of gates.values()) gate.release();
    await work;
  }
});
