import { expect, test } from "bun:test";
import type { GeminiTaskOutcome } from "../../types/gemini-task";
import type { GeminiTaskRuntimeEvent } from "../../types/gemini-task-runtime";
import {
  createGeminiTaskOutputQueue,
  settleGeminiTaskCapture,
} from "./gemini-task-output-queue";

const text = (value: string): GeminiTaskRuntimeEvent => ({
  kind: "text",
  text: value,
  delta: true,
});
const failed: GeminiTaskOutcome = {
  phase: "failed",
  reason: "The Gemini Task did not complete successfully.",
  sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  configuredModel: "reported-native-model",
  usage: null,
};
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test("an accepted tail skipped after Stop makes private capture unknown without draining its writes", async () => {
  const started = deferred(),
    held = deferred(),
    controller = new AbortController(),
    saved: GeminiTaskRuntimeEvent[] = [],
    failures: string[] = [];
  let failure = false;
  const queue = createGeminiTaskOutputQueue({
    ready: Promise.resolve(),
    async persist(event) {
      if (!saved.length) {
        started.release();
        await held.promise;
      }
      saved.push(event);
    },
    mayPersist: () => !failure && !controller.signal.aborted,
    onFailure(cause) {
      failures.push(cause);
      failure = true;
    },
  });
  const first = text("held first write");
  expect(queue.enqueue(first)).toBe(true);
  await started.promise;
  for (let index = 0; index < 200; index++)
    expect(queue.enqueue(text(`accepted tail ${index}`))).toBe(true);
  controller.abort("explicit Stop after accepted backlog");
  held.release();
  const capture = await queue.drain();
  expect(saved).toEqual([first]);
  expect(capture).toEqual({ incomplete: true });
  expect(failures).toHaveLength(200);
  expect(failures.every((cause) => cause === "skipped")).toBe(true);
  expect(
    settleGeminiTaskCapture(failed, failure || capture.incomplete),
  ).toEqual({
    ...failed,
    phase: "unknown",
    reason:
      "The Gemini stream, input or private persistence was interrupted. This Task was not resent.",
  });
});

test("fully captured Stop remains the native failed outcome, including Stop during its sole in-flight write", async () => {
  for (const inFlight of [true, false]) {
    const held = deferred(),
      started = deferred(),
      controller = new AbortController(),
      saved: GeminiTaskRuntimeEvent[] = [],
      failures: string[] = [];
    const queue = createGeminiTaskOutputQueue({
      ready: Promise.resolve(),
      async persist(event) {
        started.release();
        if (inFlight) await held.promise;
        saved.push(event);
      },
      mayPersist: () => !controller.signal.aborted,
      onFailure: (cause) => {
        failures.push(cause);
      },
    });
    expect(queue.enqueue(text("captured first"))).toBe(true);
    await started.promise;
    if (!inFlight) {
      expect(queue.enqueue(text("captured second"))).toBe(true);
      await queue.drain();
    }
    controller.abort("Stop without a missing accepted frame");
    held.release();
    const capture = await queue.drain();
    expect(capture).toEqual({ incomplete: false });
    expect(saved).toHaveLength(inFlight ? 1 : 2);
    expect(failures).toEqual([]);
    expect(settleGeminiTaskCapture(failed, capture.incomplete)).toBe(failed);
    expect(failed.phase).toBe("failed");
  }
});

test("the process-first gate orders accepted private output without adding a persistence deadline", async () => {
  const ready = deferred(),
    saved: GeminiTaskRuntimeEvent[] = [],
    first = text("first"),
    second = text("second");
  const queue = createGeminiTaskOutputQueue({
    ready: ready.promise,
    async persist(event) {
      saved.push(event);
    },
    mayPersist: () => true,
    onFailure() {
      throw Error("Unexpected capture failure");
    },
  });
  expect(queue.enqueue(first)).toBe(true);
  expect(queue.enqueue(second)).toBe(true);
  await Promise.resolve();
  expect(saved).toEqual([]);
  ready.release();
  expect(await queue.drain()).toEqual({ incomplete: false });
  expect(saved).toEqual([first, second]);
});

test("private write rejection skips the accepted tail and retains unknown capture without retrying a write", async () => {
  const attempted: GeminiTaskRuntimeEvent[] = [],
    failures: string[] = [];
  let failure = false;
  const queue = createGeminiTaskOutputQueue({
    ready: Promise.resolve(),
    async persist(event) {
      attempted.push(event);
      throw Error("Closed synthetic private writer");
    },
    mayPersist: () => !failure,
    onFailure(cause) {
      failure = true;
      failures.push(cause);
    },
  });
  const first = text("rejected first");
  expect(queue.enqueue(first)).toBe(true);
  expect(queue.enqueue(text("must be skipped"))).toBe(true);
  const capture = await queue.drain();
  expect(attempted).toEqual([first]);
  expect(failures).toEqual(["write", "skipped"]);
  expect(capture).toEqual({ incomplete: true });
  expect(settleGeminiTaskCapture(failed, capture.incomplete).phase).toBe(
    "unknown",
  );
});

test("the original 256-frame and greater-than-one-MiB pressure bounds refuse before private drain", async () => {
  for (const bound of ["frames", "bytes"]) {
    const ready = deferred(),
      saved: GeminiTaskRuntimeEvent[] = [],
      failures: string[] = [];
    let failure = false;
    const queue = createGeminiTaskOutputQueue({
      ready: ready.promise,
      async persist(event) {
        saved.push(event);
      },
      mayPersist: () => !failure,
      onFailure(cause) {
        failure = true;
        failures.push(cause);
      },
    });
    if (bound === "frames") {
      for (let index = 0; index < 255; index++)
        expect(queue.enqueue(text(`frame ${index}`))).toBe(true);
      expect(queue.enqueue(text("frame 256 must refuse"))).toBe(false);
    } else {
      const overhead = Buffer.byteLength(JSON.stringify(text(""))),
        exact = text("x".repeat(1_048_576 - overhead));
      expect(Buffer.byteLength(JSON.stringify(exact))).toBe(1_048_576);
      expect(queue.enqueue(exact)).toBe(true);
      expect(queue.enqueue(text("next must refuse"))).toBe(false);
    }
    expect(failures).toEqual(["pressure"]);
    ready.release();
    const capture = await queue.drain();
    expect(capture).toEqual({ incomplete: true });
    expect(saved).toEqual([]);
    expect(settleGeminiTaskCapture(failed, capture.incomplete).phase).toBe(
      "unknown",
    );
  }
});

test("external protocol failure still marks an otherwise complete capture unknown without rewriting the native fields", () => {
  const original = structuredClone(failed),
    outcome = settleGeminiTaskCapture(failed, true);
  expect(outcome).toEqual({
    ...failed,
    phase: "unknown",
    reason:
      "The Gemini stream, input or private persistence was interrupted. This Task was not resent.",
  });
  expect(failed).toEqual(original);
});
