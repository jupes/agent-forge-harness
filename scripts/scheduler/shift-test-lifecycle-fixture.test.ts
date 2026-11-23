import { expect, test } from "bun:test";
import {
  createShiftTestLifecycle,
  type ShiftTestCleanupPhase,
} from "./shift-test-lifecycle-fixture";

test("each test disposes only its own ledgers and roots, once, before the next test scope", () => {
  const calls: string[] = [];
  const phases: ShiftTestCleanupPhase[] = [];
  const scope = createShiftTestLifecycle({
    closeLedger: (path) => calls.push(`close ${path}`),
    removeRoot: (path) => calls.push(`remove ${path}`),
    report: (phase) => phases.push(phase),
  });
  scope.root("first root");
  scope.ledger("first ledger");
  expect(scope.cleanup()).toEqual({ ledgers: 1, roots: 1 });
  expect(calls).toEqual(["close first ledger", "remove first root"]);
  scope.root("second root");
  scope.ledger("second ledger");
  expect(scope.cleanup()).toEqual({ ledgers: 1, roots: 1 });
  expect(calls).toEqual([
    "close first ledger",
    "remove first root",
    "close second ledger",
    "remove second root",
  ]);
  expect(scope.cleanup()).toEqual({ ledgers: 0, roots: 0 });
  expect(calls).toHaveLength(4);
  expect(
    phases.map(({ phase, ordinal, ok }) => ({ phase, ordinal, ok })),
  ).toEqual([
    { phase: "ledger-close", ordinal: 1, ok: true },
    { phase: "root-remove", ordinal: 1, ok: true },
    { phase: "ledger-close", ordinal: 1, ok: true },
    { phase: "root-remove", ordinal: 1, ok: true },
  ]);
  expect(phases.every((phase) => phase.elapsedMs >= 0)).toBe(true);
});

test("a failed close or removal retains both causes and cannot skip later owned resources", () => {
  const closeFailure = Error("close refused");
  const removeFailure = Error("remove refused");
  const calls: string[] = [];
  const phases: ShiftTestCleanupPhase[] = [];
  const scope = createShiftTestLifecycle({
    closeLedger(path) {
      calls.push(`close ${path}`);
      if (path === "first ledger") throw closeFailure;
    },
    removeRoot(path) {
      calls.push(`remove ${path}`);
      if (path === "first root") throw removeFailure;
    },
    report: (phase) => phases.push(phase),
  });
  scope.root("first root");
  scope.root("second root");
  scope.ledger("first ledger");
  scope.ledger("second ledger");
  let failure: unknown;
  try {
    scope.cleanup();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError))
    throw Error("Missing cleanup failure");
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toMatchObject({
    message: "Shift fixture ledger-close 1 failed.",
    cause: closeFailure,
  });
  expect(failure.errors[1]).toMatchObject({
    message: "Shift fixture root-remove 1 failed.",
    cause: removeFailure,
  });
  expect(calls).toEqual([
    "close first ledger",
    "close second ledger",
    "remove first root",
    "remove second root",
  ]);
  expect(phases.map(({ ok }) => ok)).toEqual([false, true, false, true]);
  expect(scope.cleanup()).toEqual({ ledgers: 0, roots: 0 });
  expect(calls).toHaveLength(4);
});

test("diagnostic failure cannot hide cleanup failure or prevent another resource from closing", () => {
  const closeFailure = Error("close refused");
  const reportFailure = Error("report refused");
  let removed = 0;
  const scope = createShiftTestLifecycle({
    closeLedger() {
      throw closeFailure;
    },
    removeRoot() {
      removed++;
    },
    report() {
      throw reportFailure;
    },
  });
  scope.root("owned root");
  scope.ledger("owned ledger");
  let failure: unknown;
  try {
    scope.cleanup();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError))
    throw Error("Missing cleanup failure");
  expect(failure.errors.map((error: Error) => error.cause)).toEqual([
    closeFailure,
    reportFailure,
    reportFailure,
  ]);
  expect(removed).toBe(1);
  expect(scope.cleanup()).toEqual({ ledgers: 0, roots: 0 });
});
