import { expect, test } from "bun:test";
import {
  createShiftFeedCleanup,
  shiftFeedPhase,
} from "./shift-attempt-feed-fixture";

const failures = (error: unknown) => {
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw error;
  return error.errors.map((entry: unknown) =>
    entry instanceof Error ? entry.message : String(entry),
  );
};

test("a healthy reader closes before fetch abort can error its cancellation", async () => {
  const observer = new AbortController();
  const calls: string[] = [];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      observer.signal.addEventListener("abort", () => {
        calls.push("abort fetch");
        controller.error(observer.signal.reason);
      });
    },
    cancel() {
      calls.push("cancel healthy reader");
    },
  });
  const reader = source.getReader();
  const cleanup = createShiftFeedCleanup({
    abortObserver: () => observer.abort(),
    cancelObserver: () => reader.cancel(),
    async finishOwner() {
      calls.push("finish owner");
    },
  });
  const closed = cleanup.closeObserver();
  const error: unknown = await cleanup
    .release()
    .catch((cause: unknown) => cause);
  expect(error).toBeUndefined();
  await closed;
  expect(calls).toEqual([
    "cancel healthy reader",
    "abort fetch",
    "finish owner",
  ]);
});

test("a held observer cancellation cannot hold the private owner's release", async () => {
  const calls: string[] = [];
  let releaseCancel = () => {};
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const cleanup = createShiftFeedCleanup({
    abortObserver: () => calls.push("abort observer"),
    cancelObserver: () => {
      calls.push("cancel observer");
      return cancelled;
    },
    async finishOwner() {
      calls.push("finish owner");
    },
  });
  const releasing = cleanup.release();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toEqual([
      "cancel observer",
      "abort observer",
      "finish owner",
    ]);
  } finally {
    releaseCancel();
    await releasing;
  }
});

test("never-settling cancellation refuses within its bound after releasing the owner", async () => {
  let finished = false;
  const cleanup = createShiftFeedCleanup({
    abortObserver() {},
    cancelObserver: () => new Promise(() => {}),
    async finishOwner() {
      finished = true;
    },
    withinMs: 10,
  });
  const error: unknown = await cleanup
    .release()
    .catch((cause: unknown) => cause);
  expect(finished).toBe(true);
  expect(failures(error)).toEqual([
    "Private Shift feed observer cancellation exceeded 10ms",
  ]);
});

test("rejected cancellation and a held owner finish surface both phase failures", async () => {
  let finished = 0;
  const cleanup = createShiftFeedCleanup({
    abortObserver() {},
    cancelObserver: () => Promise.reject(new Error("fixture cancel refusal")),
    finishOwner() {
      finished++;
      return new Promise(() => {});
    },
    withinMs: 10,
  });
  const error: unknown = await cleanup
    .release()
    .catch((cause: unknown) => cause);
  expect(finished).toBe(1);
  expect(failures(error)).toEqual([
    "Private Shift feed observer cancellation failed",
    "Private Shift feed owner finish exceeded 10ms",
  ]);
});

test("normal observer closure and repeated cleanup close and finish exactly once", async () => {
  const calls: string[] = [];
  const cleanup = createShiftFeedCleanup({
    abortObserver: () => calls.push("abort"),
    async cancelObserver() {
      calls.push("cancel");
    },
    async finishOwner() {
      calls.push("finish");
    },
  });
  const closed = cleanup.closeObserver();
  expect(cleanup.closeObserver()).toBe(closed);
  await closed;
  expect(calls).toEqual(["cancel", "abort"]);
  const released = cleanup.release();
  expect(cleanup.release()).toBe(released);
  await released;
  await cleanup.release();
  expect(calls).toEqual(["cancel", "abort", "finish"]);
});

test("an observer abort failure cannot skip owner release or retry cleanup", async () => {
  let aborted = 0;
  let cancelled = 0;
  let finished = 0;
  const cleanup = createShiftFeedCleanup({
    abortObserver() {
      aborted++;
      throw new Error("fixture abort refusal");
    },
    async cancelObserver() {
      cancelled++;
    },
    async finishOwner() {
      finished++;
    },
  });
  const released = cleanup.release();
  const error: unknown = await released.catch((cause: unknown) => cause);
  expect(cleanup.release()).toBe(released);
  expect(failures(error)).toEqual([
    "Private Shift feed observer cancellation failed",
  ]);
  expect({ aborted, cancelled, finished }).toEqual({
    aborted: 1,
    cancelled: 1,
    finished: 1,
  });
});

test("synchronous cancellation and abort refusals are both retained while owner release starts", async () => {
  const cancelCause = new Error("fixture synchronous cancel refusal");
  const abortCause = new Error("fixture abort refusal");
  const calls: string[] = [];
  const cleanup = createShiftFeedCleanup({
    cancelObserver() {
      calls.push("cancel");
      throw cancelCause;
    },
    abortObserver() {
      calls.push("abort");
      throw abortCause;
    },
    async finishOwner() {
      calls.push("finish");
    },
  });
  const releasing = cleanup.release();
  expect(calls).toEqual(["cancel", "abort", "finish"]);
  const error: unknown = await releasing.catch((cause: unknown) => cause);
  expect(failures(error)).toEqual([
    "Private Shift feed observer cancellation failed",
  ]);
  if (!(error instanceof AggregateError)) throw error;
  const closeFailure: unknown = error.errors[0];
  if (
    !(closeFailure instanceof Error) ||
    !(closeFailure.cause instanceof AggregateError)
  )
    throw error;
  expect(closeFailure.cause.errors).toEqual([cancelCause, abortCause]);
});

test("phase bounds name the blocked operation and preserve its original refusal", async () => {
  const cause = new Error("fixture read refusal");
  const refused: unknown = await shiftFeedPhase(
    "persisted frame observation",
    () => Promise.reject(cause),
    1000,
  ).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
  if (!(refused instanceof Error)) throw refused;
  expect(refused.message).toBe(
    "Private Shift feed persisted frame observation failed",
  );
  expect(refused.cause).toBe(cause);
  await expect(
    shiftFeedPhase("generic Stop refusal", () => new Promise(() => {}), 10),
  ).rejects.toThrow("Private Shift feed generic Stop refusal exceeded 10ms");
});
