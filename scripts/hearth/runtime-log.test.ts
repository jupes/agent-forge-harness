import { expect, test } from "bun:test";
import type { LedgerEventInput } from "../../types/hearth";
import {
  HEARTH_LOG_LIMITS,
  hearthLogSnapshotSchema,
} from "../desktop/app-hearth-log-protocol";
import type { AppendResult } from "../ledger/append";
import { createHearthRuntimeLog, observeLedgerAppender } from "./runtime-log";

const event: LedgerEventInput = {
  workspace: "/private/workspace",
  kind: "operator.action",
  payload: {
    action: "fixture.action",
    surface: "api",
    target: "PRIVATE_TARGET",
  },
};
test("runtime log observes stored and duplicate reports without changing return identity or exposing input bodies", () => {
  const log = createHearthRuntimeLog();
  const results: AppendResult[] = [
    { ok: true, id: 1, ulid: "private-ulid" },
    { ok: true, duplicate: true, ulid: "private-ulid" },
  ];
  for (const result of results)
    expect(observeLedgerAppender(() => result, log)(event)).toBe(result);
  const snapshot = log.read();
  expect(snapshot.entries.map((entry) => entry.code)).toEqual([
    "ledger.inserted",
    "ledger.duplicate",
  ]);
  expect(
    snapshot.entries.every((entry) => entry.eventKind === "operator.action"),
  ).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_TARGET");
  expect(JSON.stringify(snapshot)).not.toContain("private-ulid");
  expect(JSON.stringify(snapshot)).not.toContain("/private/workspace");
});

test("even a broken observer cannot replace the appender's return or original throw", () => {
  const originalError = Error("PRIVATE_ORIGINAL_ERROR"),
    result: AppendResult = { ok: false, error: "PRIVATE_RESULT" };
  const broken = {
    ...createHearthRuntimeLog(),
    record() {
      throw Error("observer failure");
    },
    markUnavailable() {
      throw Error("observer marking failure");
    },
  };
  expect(observeLedgerAppender(() => result, broken)(event)).toBe(result);
  let received: unknown;
  try {
    observeLedgerAppender(() => {
      throw originalError;
    }, broken)(event);
  } catch (error) {
    received = error;
  }
  expect(received).toBe(originalError);
});

test("accessor metadata is never evaluated and cannot become trusted log fields", () => {
  const log = createHearthRuntimeLog();
  let reads = 0;
  const secretEvent = Object.defineProperty({ ...event }, "kind", {
    get() {
      reads++;
      return "operator.action";
    },
  });
  const stored: AppendResult = { ok: true, id: 3, ulid: "private" };
  expect(observeLedgerAppender(() => stored, log)(secretEvent)).toBe(stored);
  const accessorResult = Object.defineProperty(
    { ok: true as const, id: 4, ulid: "private" },
    "ok",
    {
      get() {
        reads++;
        return true;
      },
    },
  );
  expect(observeLedgerAppender(() => accessorResult, log)(event)).toBe(
    accessorResult,
  );
  expect(reads).toBe(0);
  expect(log.read().entries.map((entry) => entry.code)).toEqual([
    "ledger.unverified",
    "ledger.unverified",
  ]);
  expect(log.read().entries[0]?.eventKind).toBeNull();
});

test("failed and thrown appends expose only fixed metadata and preserve exact failure identity", () => {
  const log = createHearthRuntimeLog(),
    failure: AppendResult = { ok: false, error: "PRIVATE_CONFIG_VALUE" },
    original = Error("PRIVATE_ERROR_VALUE");
  expect(observeLedgerAppender(() => failure, log)(event)).toBe(failure);
  let observed: unknown;
  try {
    observeLedgerAppender(() => {
      throw original;
    }, log)(event);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(original);
  const snapshot = log.read();
  expect(snapshot.entries.map((entry) => entry.code)).toEqual([
    "ledger.failed",
    "ledger.thrown",
  ]);
  expect(snapshot.entries.every((entry) => entry.level === "warning")).toBe(
    true,
  );
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
});

test("observer clock failure holds log reads while the appender still returns its exact result", () => {
  let fail = false;
  const log = createHearthRuntimeLog({
    now: () => {
      if (fail) throw Error("PRIVATE_CLOCK_ERROR");
      return new Date("2026-11-11T00:00:00Z");
    },
  });
  log.record("runtime.created");
  fail = true;
  const result: AppendResult = { ok: true, id: 1, ulid: "private" };
  expect(observeLedgerAppender(() => result, log)(event)).toBe(result);
  expect(() => log.read()).toThrow("Hearth service log could not be verified.");
  fail = false;
  expect(() => log.read()).toThrow("Hearth service log could not be verified.");
});

test("ring and response bounds expose evicted and omitted history separately, with copied contiguous entries", () => {
  const log = createHearthRuntimeLog();
  expect(log.read().entries).toEqual([]);
  for (let index = 0; index < 301; index++)
    log.record("ledger.inserted", "operator.action");
  const snapshot = log.read();
  expect(snapshot).toMatchObject({
    latestSequence: 301,
    retainedCount: 256,
    evictedCount: 45,
    omittedRetainedCount: 128,
  });
  expect(snapshot.entries).toHaveLength(128);
  expect(snapshot.entries[0]?.sequence).toBe(174);
  expect(snapshot.entries.at(-1)?.sequence).toBe(301);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
    HEARTH_LOG_LIMITS.responseBytes,
  );
  snapshot.entries.pop();
  snapshot.entries[0]!.eventKind = null;
  expect(log.read().entries).toHaveLength(128);
  expect(log.read().entries[0]?.eventKind).toBe("operator.action");
  expect(
    hearthLogSnapshotSchema.safeParse({ ...log.read(), evictedCount: 0 })
      .success,
  ).toBe(false);
  expect(
    hearthLogSnapshotSchema.safeParse({
      ...log.read(),
      entries: [...log.read().entries, log.read().entries[0]],
    }).success,
  ).toBe(false);
});

test("a nonempty lifetime cannot be represented as healthy empty history before ring capacity", () => {
  const empty = createHearthRuntimeLog().read();
  expect(
    hearthLogSnapshotSchema.safeParse({
      ...empty,
      latestSequence: 10,
      retainedCount: 0,
      evictedCount: 10,
      omittedRetainedCount: 0,
      entries: [],
    }).success,
  ).toBe(false);
});
