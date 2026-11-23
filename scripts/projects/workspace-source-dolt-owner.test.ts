import { expect, test } from "bun:test";
import type { WorkspaceOwnerObservation } from "./workspace-source-dolt-owner";
import {
  createWorkspaceOwnerResource,
  readOwnedWorkspaceProjection,
  type WorkspaceOwnerContext,
  type WorkspaceOwnerDeadline,
  type WorkspaceOwnerDeadlineOutcome,
  type WorkspaceOwnerDependencies,
} from "./workspace-source-dolt-owner";
import type { WorkspaceReadOutcome } from "./workspace-source-dolt-read";

type WorkspaceOwnerSentinel = Readonly<{
  marker:
    | "identity"
    | "issues"
    | "durableLabels"
    | "wispLabels"
    | "dependencies";
  sessionId: number;
}>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function cancellableDeadline(): Readonly<{
  deadline: WorkspaceOwnerDeadline;
  finish(): void;
}> {
  const completion = deferred<WorkspaceOwnerDeadlineOutcome>();
  let finished = false;
  return {
    deadline: {
      initiallyExpired: false,
      completion: completion.promise,
      cancel() {
        if (!finished) {
          finished = true;
          completion.resolve("cancelled");
        }
      },
    },
    finish() {
      if (!finished) {
        finished = true;
        completion.resolve("cancelled");
      }
    },
  };
}

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("waits for close and independent observation before publishing a read", async () => {
  const resource = createWorkspaceOwnerResource();
  const finishClose = deferred<void>();
  const finishObservation = deferred<WorkspaceOwnerObservation>();
  const closeEntered = deferred<void>();
  const calls: string[] = [];
  const notes: string[] = [];
  let notify:
    | ((event: "open" | "close" | "loss" | "error") => void)
    | undefined;
  let observerSettled = false;
  const work = cancellableDeadline();
  const cleanup = cancellableDeadline();
  const part = (
    marker: WorkspaceOwnerSentinel["marker"],
  ): WorkspaceOwnerSentinel => ({ marker, sessionId: 17 });
  const context: WorkspaceOwnerContext<WorkspaceOwnerSentinel> = {
    resource,
    driver: {
      async reserveOnce() {
        calls.push("reserve");
        notify?.("open");
        return resource;
      },
      async begin(received) {
        expect(received).toBe(resource);
        calls.push("begin");
      },
      async readIdentity(received) {
        expect(received).toBe(resource);
        calls.push("identity");
        return part("identity");
      },
      async readIssues(received) {
        expect(received).toBe(resource);
        calls.push("issues");
        return part("issues");
      },
      async readDurableLabels(received) {
        expect(received).toBe(resource);
        calls.push("durableLabels");
        return part("durableLabels");
      },
      async readWispLabels(received) {
        expect(received).toBe(resource);
        calls.push("wispLabels");
        return part("wispLabels");
      },
      async readDependencies(received) {
        expect(received).toBe(resource);
        calls.push("dependencies");
        return part("dependencies");
      },
      async rollback(received) {
        expect(received).toBe(resource);
        calls.push("rollback");
      },
      async releaseReservation(received) {
        expect(received).toBe(resource);
        calls.push("release");
      },
      closePool() {
        calls.push("closePool");
        closeEntered.resolve();
        notify?.("close");
        return finishClose.promise;
      },
    },
    retirement: {
      noteLocalBoundary(event) {
        notes.push(event);
      },
      observe(received, cause) {
        expect(received).toBe(resource);
        expect(cause).toBe("healthy");
        calls.push("observe");
        return {
          completion: finishObservation.promise,
          cancel() {
            if (!observerSettled) {
              observerSettled = true;
              finishObservation.resolve({ kind: "cancelled" });
            }
          },
        };
      },
    },
  };
  const dependencies: WorkspaceOwnerDependencies<WorkspaceOwnerSentinel> = {
    contextFactory: {
      create(callback) {
        notify = callback;
        return context;
      },
    },
    continuationGate: {
      async waitAfterIdentity() {
        calls.push("gate");
      },
    },
    deadlineFactory: {
      create(kind) {
        calls.push("deadline:" + kind);
        return kind === "work" ? work.deadline : cleanup.deadline;
      },
    },
  };
  let terminal: WorkspaceReadOutcome<WorkspaceOwnerSentinel> | undefined;
  const operation = readOwnedWorkspaceProjection(dependencies).then(
    (result) => {
      terminal = result;
      return result;
    },
  );

  try {
    await closeEntered.promise;
    expect(notes).toEqual(["token-revoked", "inner-unsubscribed"]);
    expect(calls).toEqual([
      "deadline:work",
      "reserve",
      "begin",
      "identity",
      "gate",
      "issues",
      "durableLabels",
      "wispLabels",
      "dependencies",
      "rollback",
      "release",
      "deadline:cleanup",
      "observe",
      "closePool",
    ]);
    await eventLoopTurn();
    expect(terminal).toBeUndefined();

    finishClose.resolve();
    await eventLoopTurn();
    expect(terminal).toBeUndefined();

    observerSettled = true;
    finishObservation.resolve({ kind: "observed", resource });
    const result = await operation;
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.parts).toEqual({
        identity: part("identity"),
        issues: part("issues"),
        durableLabels: part("durableLabels"),
        wispLabels: part("wispLabels"),
        dependencies: part("dependencies"),
      });
    }
  } finally {
    finishClose.resolve();
    observerSettled = true;
    finishObservation.resolve({ kind: "observed", resource });
    work.finish();
    cleanup.finish();
    await operation;
  }
});
type MatrixEvent = "open" | "close" | "loss" | "error";
type MatrixOperation =
  | "reserve"
  | "begin"
  | "identity"
  | "gate"
  | "issues"
  | "durable"
  | "wisp"
  | "dependencies"
  | "rollback"
  | "release"
  | "close";
type MatrixHeldOperation = Exclude<MatrixOperation, "close">;
type MatrixObservationMode =
  | "good"
  | "wrong"
  | "unavailable"
  | "cancelled"
  | "reject"
  | "pending";
type MatrixFaultMode = "sync" | "reject";
type MatrixSyncThrow =
  | "factory"
  | "workDeadline"
  | "cleanupDeadline"
  | "observe";
type MatrixCancelMode = "normal" | "throw" | "pending";
type MatrixFault = Readonly<{ name: MatrixOperation; mode: MatrixFaultMode }>;
type MatrixReleaseFact = Readonly<{
  acquired: boolean;
  matchesReturnedResource: boolean;
  matchesOwnerResource: boolean;
}>;
type MatrixOptions = Readonly<{
  hold?: MatrixHeldOperation;
  fault?: MatrixFault;
  reservation?: "local" | "null" | "foreign";
  observation?: MatrixObservationMode;
  closeHold?: boolean;
  closeDuringObserve?: boolean;
  observerCancel?: MatrixCancelMode;
  duplicateOpen?: boolean;
  duplicateClose?: boolean;
  preEvent?: MatrixEvent;
  syncThrow?: MatrixSyncThrow;
  workInitiallyExpired?: boolean;
  cleanupInitiallyExpired?: boolean;
  workElapsed?: boolean;
  cleanupElapsed?: boolean;
  workCancel?: MatrixCancelMode;
  cleanupCancel?: MatrixCancelMode;
  completionReject?: "work" | "cleanup";
  noteFailure?: "token-revoked" | "inner-unsubscribed";
}>;

function matrixDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function matrixReject<T>(name: string): Promise<T> {
  return new Promise<T>((_, reject) => reject(new Error(name)));
}

function matrixPart(
  marker: WorkspaceOwnerSentinel["marker"],
): WorkspaceOwnerSentinel {
  return { marker, sessionId: 41 };
}

function matrixExpectedRead(): WorkspaceReadOutcome<WorkspaceOwnerSentinel> {
  return {
    kind: "read",
    parts: {
      identity: matrixPart("identity"),
      issues: matrixPart("issues"),
      durableLabels: matrixPart("durableLabels"),
      wispLabels: matrixPart("wispLabels"),
      dependencies: matrixPart("dependencies"),
    },
  };
}

function matrixArrived(signal: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    signal.then(
      () => true,
      () => true,
    ),
    eventLoopTurn().then(() => false),
  ]);
}

function matrixFixture(options: MatrixOptions = {}) {
  const resource = createWorkspaceOwnerResource();
  const foreign = createWorkspaceOwnerResource();
  const calls: string[] = [];
  const sqlAttempts: MatrixOperation[] = [];
  const sqlEffects: MatrixOperation[] = [];
  const notes: string[] = [];
  const events: MatrixEvent[] = [];
  const trace: string[] = [];
  const resourceFacts: string[] = [];
  const releaseAttemptFacts: MatrixReleaseFact[] = [];
  const releaseEffects: MatrixReleaseFact[] = [];
  const acquisitions: string[] = [];
  const receiverChecks: boolean[] = [];
  const held = matrixDeferred<void>();
  const heldEntered = matrixDeferred<MatrixHeldOperation>();
  const closeDone = matrixDeferred<void>();
  const closeEntered = matrixDeferred<void>();
  const observationDone = matrixDeferred<WorkspaceOwnerObservation>();
  const workCancelEntered = matrixDeferred<void>();
  const cleanupCancelEntered = matrixDeferred<void>();
  const cleanupDeadlineEntered = matrixDeferred<void>();
  let notify: ((event: MatrixEvent) => void) | undefined;
  let terminal: WorkspaceReadOutcome<WorkspaceOwnerSentinel> | undefined;
  let acquired = false;
  let returnedResource:
    | WorkspaceOwnerContext<WorkspaceOwnerSentinel>["resource"]
    | null = null;
  let resourceMismatch = false;
  let observationMatches = false;
  let observationResourceMatches = false;
  let observationSettled = false;
  let closeStarted = false;
  let closeCompleted = false;
  const observationCauses: string[] = [];

  const emit = (event: MatrixEvent): void => {
    events.push(event);
    trace.push("event:" + event);
    notify?.(event);
  };
  const finishObservation = (result?: WorkspaceOwnerObservation): void => {
    const finalResult =
      result ??
      (acquired
        ? { kind: "observed" as const, resource }
        : { kind: "unavailable" as const });
    if (finalResult.kind === "observed") {
      observationResourceMatches = finalResult.resource === resource;
    }
    observationSettled = true;
    observationDone.resolve(finalResult);
  };
  const settleObservationAtClose = (): void => {
    if (options.observation === "pending") return;
    const mode = options.observation ?? "good";
    if (mode === "reject") {
      observationSettled = true;
      observationDone.reject(new Error("observation"));
    } else if (mode === "wrong") {
      finishObservation({ kind: "observed", resource: foreign });
    } else if (mode === "unavailable") {
      finishObservation({ kind: "unavailable" });
    } else if (mode === "cancelled") {
      finishObservation({ kind: "cancelled" });
    } else {
      finishObservation();
    }
  };

  const workCompletion = matrixDeferred<WorkspaceOwnerDeadlineOutcome>();
  const cleanupCompletion = matrixDeferred<WorkspaceOwnerDeadlineOutcome>();
  let workFinished = false;
  let cleanupFinished = false;
  const finishWork = (outcome: WorkspaceOwnerDeadlineOutcome): void => {
    if (!workFinished) {
      workFinished = true;
      workCompletion.resolve(outcome);
    }
  };
  const finishCleanup = (outcome: WorkspaceOwnerDeadlineOutcome): void => {
    if (!cleanupFinished) {
      cleanupFinished = true;
      cleanupCompletion.resolve(outcome);
    }
  };
  const rejectWork = (): void => {
    if (!workFinished) {
      workFinished = true;
      workCompletion.reject(new Error("work completion"));
    }
  };
  const rejectCleanup = (): void => {
    if (!cleanupFinished) {
      cleanupFinished = true;
      cleanupCompletion.reject(new Error("cleanup completion"));
    }
  };
  if (options.workInitiallyExpired) finishWork("expired");
  else if (options.completionReject === "work") rejectWork();
  if (options.cleanupInitiallyExpired) finishCleanup("expired");
  else if (options.completionReject === "cleanup") rejectCleanup();

  const makeDeadline = (kind: "work" | "cleanup"): WorkspaceOwnerDeadline => ({
    initiallyExpired:
      kind === "work"
        ? (options.workInitiallyExpired ?? false)
        : (options.cleanupInitiallyExpired ?? false),
    completion:
      kind === "work" ? workCompletion.promise : cleanupCompletion.promise,
    cancel() {
      calls.push("cancel:" + kind);
      trace.push("cancel:" + kind);
      if (kind === "work") workCancelEntered.resolve();
      else cleanupCancelEntered.resolve();
      const mode =
        kind === "work"
          ? (options.workCancel ?? "normal")
          : (options.cleanupCancel ?? "normal");
      if (mode === "throw") throw new Error("cancel:" + kind);
      if (mode === "pending") return;
      const outcome = (
        kind === "work"
          ? (options.workElapsed ?? false)
          : (options.cleanupElapsed ?? false)
      )
        ? "expired"
        : "cancelled";
      if (kind === "work") finishWork(outcome);
      else finishCleanup(outcome);
    },
  });
  const work = makeDeadline("work");
  const cleanup = makeDeadline("cleanup");

  const checkResource = (
    name: string,
    received: WorkspaceOwnerContext<WorkspaceOwnerSentinel>["resource"],
  ): boolean => {
    const matches = received === resource;
    resourceFacts.push(name + ":" + matches);
    if (!matches) resourceMismatch = true;
    return matches;
  };
  const perform = <T>(
    name: MatrixOperation,
    run: () => Promise<T>,
  ): Promise<T> => {
    calls.push(name);
    sqlAttempts.push(name);
    if (name === "rollback" || name === "release")
      trace.push(name + ":attempt");
    if (options.fault?.name === name && options.fault.mode === "sync") {
      throw new Error(name);
    }
    if (options.fault?.name === name && options.fault.mode === "reject") {
      return matrixReject(name);
    }
    const finishEffect = (value: T): T => {
      sqlEffects.push(name);
      if (name === "rollback" || name === "release") {
        trace.push(name + ":fulfilled");
      }
      return value;
    };
    if (options.hold === name) {
      heldEntered.resolve(name);
      return held.promise.then(run).then(finishEffect);
    }
    return run().then(finishEffect);
  };

  type MatrixDriver = WorkspaceOwnerContext<WorkspaceOwnerSentinel>["driver"] &
    Readonly<{ receiver: string }>;
  const driver: MatrixDriver = {
    receiver: "matrix",
    reserveOnce() {
      return perform("reserve", () => {
        const reservation = options.reservation ?? "local";
        if (reservation === "null") return Promise.resolve(null);
        acquired = true;
        returnedResource = reservation === "foreign" ? foreign : resource;
        acquisitions.push(reservation);
        emit("open");
        if (options.duplicateOpen) emit("open");
        return Promise.resolve(returnedResource);
      });
    },
    begin(received) {
      if (!checkResource("begin", received)) {
        throw new Error("foreign begin resource");
      }
      return perform("begin", () => Promise.resolve());
    },
    readIdentity(received) {
      if (!checkResource("identity", received)) {
        throw new Error("foreign identity resource");
      }
      receiverChecks.push(this?.receiver === "matrix");
      return perform("identity", () => Promise.resolve(matrixPart("identity")));
    },
    readIssues(received) {
      if (!checkResource("issues", received)) {
        throw new Error("foreign issues resource");
      }
      receiverChecks.push(this?.receiver === "matrix");
      return perform("issues", () => Promise.resolve(matrixPart("issues")));
    },
    readDurableLabels(received) {
      if (!checkResource("durable", received)) {
        throw new Error("foreign durable resource");
      }
      receiverChecks.push(this?.receiver === "matrix");
      return perform("durable", () =>
        Promise.resolve(matrixPart("durableLabels")),
      );
    },
    readWispLabels(received) {
      if (!checkResource("wisp", received)) {
        throw new Error("foreign wisp resource");
      }
      receiverChecks.push(this?.receiver === "matrix");
      return perform("wisp", () => Promise.resolve(matrixPart("wispLabels")));
    },
    readDependencies(received) {
      if (!checkResource("dependencies", received)) {
        throw new Error("foreign dependency resource");
      }
      receiverChecks.push(this?.receiver === "matrix");
      return perform("dependencies", () =>
        Promise.resolve(matrixPart("dependencies")),
      );
    },
    rollback(received) {
      if (!checkResource("rollback", received)) {
        throw new Error("foreign rollback resource");
      }
      return perform("rollback", () => Promise.resolve());
    },
    releaseReservation(received) {
      const fact = {
        acquired,
        matchesReturnedResource: received === returnedResource,
        matchesOwnerResource: received === resource,
      };
      releaseAttemptFacts.push(fact);
      if (!checkResource("release", received)) {
        throw new Error("foreign release resource");
      }
      return perform("release", () => {
        releaseEffects.push(fact);
        return Promise.resolve();
      });
    },
    closePool() {
      calls.push("close");
      sqlAttempts.push("close");
      closeStarted = true;
      trace.push("close:attempt");
      closeEntered.resolve();
      emit("close");
      if (options.duplicateClose) emit("close");
      settleObservationAtClose();
      if (options.fault?.name === "close" && options.fault.mode === "sync") {
        throw new Error("close");
      }
      if (options.fault?.name === "close" && options.fault.mode === "reject") {
        return matrixReject("close");
      }
      if (!options.closeHold) closeDone.resolve();
      return closeDone.promise.then(() => {
        closeCompleted = true;
        sqlEffects.push("close");
        trace.push("close:fulfilled");
      });
    },
  };

  const retirement = {
    noteLocalBoundary(event: "token-revoked" | "inner-unsubscribed") {
      notes.push(event);
      trace.push("note:" + event);
      if (options.noteFailure === event) throw new Error(event);
    },
    observe(
      received: WorkspaceOwnerContext<WorkspaceOwnerSentinel>["resource"],
      cause: "healthy" | "failed",
    ) {
      calls.push("observe");
      trace.push("observe");
      observationMatches = received === resource;
      observationCauses.push(cause);
      if (options.closeDuringObserve) emit("close");
      if (options.syncThrow === "observe") throw new Error("observe");
      return {
        completion: observationDone.promise,
        cancel() {
          calls.push("cancel:observer");
          trace.push("cancel:observer");
          const mode = options.observerCancel ?? "normal";
          if (mode === "throw") throw new Error("cancel:observer");
          if (mode === "pending") return;
          if (!observationSettled) finishObservation({ kind: "cancelled" });
        },
      };
    },
  };
  const context: WorkspaceOwnerContext<WorkspaceOwnerSentinel> = {
    resource,
    driver,
    retirement,
  };
  const dependencies: WorkspaceOwnerDependencies<WorkspaceOwnerSentinel> = {
    contextFactory: {
      create(callback) {
        calls.push("factory");
        if (options.syncThrow === "factory") throw new Error("factory");
        notify = callback;
        if (options.preEvent !== undefined) emit(options.preEvent);
        return context;
      },
    },
    continuationGate: {
      waitAfterIdentity() {
        return perform("gate", () => Promise.resolve());
      },
    },
    deadlineFactory: {
      create(kind) {
        calls.push(kind + "Deadline");
        trace.push("deadline:" + kind);
        if (kind === "cleanup") cleanupDeadlineEntered.resolve();
        if (options.syncThrow === kind + "Deadline") {
          throw new Error(kind + "Deadline");
        }
        return kind === "work" ? work : cleanup;
      },
    },
  };
  const operation = readOwnedWorkspaceProjection(dependencies).then(
    (result) => {
      terminal = result;
      return result;
    },
  );

  return {
    operation,
    resource,
    calls,
    sqlAttempts,
    sqlEffects,
    notes,
    events,
    trace,
    resourceFacts,
    releaseAttemptFacts,
    releaseEffects,
    acquisitions,
    receiverChecks,
    observationCauses,
    heldEntered: heldEntered.promise,
    closeEntered: closeEntered.promise,
    workCancelEntered: workCancelEntered.promise,
    cleanupCancelEntered: cleanupCancelEntered.promise,
    cleanupDeadlineEntered: cleanupDeadlineEntered.promise,
    terminal: () => terminal,
    closeStarted: () => closeStarted,
    closeCompleted: () => closeCompleted,
    acquired: () => acquired,
    observationSettled: () => observationSettled,
    observationMatches: () => observationMatches,
    observationResourceMatches: () => observationResourceMatches,
    resourceMismatch: () => resourceMismatch,
    workPending: () => !workFinished,
    cleanupPending: () => !cleanupFinished,
    emit,
    finishObservation,
    releaseHeld: () => held.resolve(),
    rejectHeld: () => held.reject(new Error("late held operation")),
    finishClose: () => closeDone.resolve(),
    rejectClose: () => closeDone.reject(new Error("late close rejection")),
    expireWork: () => finishWork("expired"),
    expireCleanup: () => finishCleanup("expired"),
    finishWork: () => finishWork("cancelled"),
    finishCleanup: () => finishCleanup("cancelled"),
    rejectWork: rejectWork,
    rejectCleanup: rejectCleanup,
    finishAll: () => {
      heldEntered.resolve("reserve");
      closeEntered.resolve();
      workCancelEntered.resolve();
      cleanupCancelEntered.resolve();
      cleanupDeadlineEntered.resolve();
      held.resolve();
      closeDone.resolve();
      if (!observationSettled) finishObservation();
      finishWork("cancelled");
      finishCleanup("cancelled");
    },
  };
}
type MatrixFixture = ReturnType<typeof matrixFixture>;
type MatrixCheck = (fixture: MatrixFixture) => Promise<void>;

function matrixAssertFixtureFacts(
  fixture: MatrixFixture,
  reservation: "local" | "null" | "foreign",
): void {
  const expectedResourceFacts: string[] = [];
  for (const call of fixture.sqlAttempts) {
    if (
      [
        "begin",
        "identity",
        "issues",
        "durable",
        "wisp",
        "dependencies",
        "rollback",
        "release",
      ].includes(call)
    ) {
      expectedResourceFacts.push(call + ":true");
    }
  }
  expect(fixture.resourceFacts).toEqual(expectedResourceFacts);
  expect(fixture.resourceMismatch()).toBe(false);
  expect(fixture.releaseAttemptFacts).toHaveLength(
    fixture.sqlAttempts.filter((call) => call === "release").length,
  );
  const acquired = fixture.acquisitions.length > 0;
  const returnedMatches = acquired && reservation !== "foreign";
  for (const fact of fixture.releaseAttemptFacts) {
    expect(fact.acquired).toBe(acquired);
    expect(fact.matchesReturnedResource).toBe(returnedMatches);
    expect(fact.matchesOwnerResource).toBe(true);
  }
  expect(fixture.releaseEffects).toHaveLength(
    fixture.sqlEffects.filter((call) => call === "release").length,
  );
}

function matrixTest(
  options: MatrixOptions,
  check: MatrixCheck,
): () => Promise<void> {
  return async () => {
    const fixture = matrixFixture(options);
    try {
      await check(fixture);
      matrixAssertFixtureFacts(fixture, options.reservation ?? "local");
    } finally {
      fixture.finishAll();
      await fixture.operation;
    }
  };
}

const matrixHealthySql: MatrixOperation[] = [
  "reserve",
  "begin",
  "identity",
  "gate",
  "issues",
  "durable",
  "wisp",
  "dependencies",
  "rollback",
  "release",
  "close",
];
const matrixFailureSql: Readonly<Record<MatrixOperation, MatrixOperation[]>> = {
  reserve: ["reserve", "close"],
  begin: ["reserve", "begin", "release", "close"],
  identity: ["reserve", "begin", "identity", "release", "close"],
  gate: ["reserve", "begin", "identity", "gate", "release", "close"],
  issues: [
    "reserve",
    "begin",
    "identity",
    "gate",
    "issues",
    "release",
    "close",
  ],
  durable: [
    "reserve",
    "begin",
    "identity",
    "gate",
    "issues",
    "durable",
    "release",
    "close",
  ],
  wisp: [
    "reserve",
    "begin",
    "identity",
    "gate",
    "issues",
    "durable",
    "wisp",
    "release",
    "close",
  ],
  dependencies: [
    "reserve",
    "begin",
    "identity",
    "gate",
    "issues",
    "durable",
    "wisp",
    "dependencies",
    "release",
    "close",
  ],
  rollback: [
    "reserve",
    "begin",
    "identity",
    "gate",
    "issues",
    "durable",
    "wisp",
    "dependencies",
    "rollback",
    "release",
    "close",
  ],
  release: [
    "reserve",
    "begin",
    "identity",
    "gate",
    "issues",
    "durable",
    "wisp",
    "dependencies",
    "rollback",
    "release",
    "close",
  ],
  close: matrixHealthySql,
};
const matrixSyncSql: Readonly<Record<MatrixSyncThrow, MatrixOperation[]>> = {
  factory: [],
  workDeadline: ["close"],
  cleanupDeadline: matrixHealthySql,
  observe: matrixHealthySql,
};
const matrixFaultOperations: readonly MatrixOperation[] = [
  "reserve",
  "begin",
  "identity",
  "gate",
  "issues",
  "durable",
  "wisp",
  "dependencies",
  "rollback",
  "release",
  "close",
];
const matrixFaultModes: readonly MatrixFaultMode[] = ["sync", "reject"];

test(
  "observation can arrive before raw close and still joins exact parts",
  matrixTest({ observation: "pending", closeHold: true }, async (fixture) => {
    const closeReached = await matrixArrived(fixture.closeEntered);
    fixture.finishObservation();
    await eventLoopTurn();
    const stayedPending = fixture.terminal() === undefined;
    fixture.finishClose();
    const result = await fixture.operation;
    expect(closeReached).toBe(true);
    expect(stayedPending).toBe(true);
    expect(result).toEqual(matrixExpectedRead());
    expect(fixture.observationResourceMatches()).toBe(true);
    expect(fixture.resourceMismatch()).toBe(false);
  }),
);

const invalidObservationModes: readonly MatrixObservationMode[] = [
  "wrong",
  "unavailable",
  "cancelled",
  "reject",
];
for (const mode of invalidObservationModes) {
  test(
    "refuses " + mode + " observation",
    matrixTest({ observation: mode }, async (fixture) => {
      const result = await fixture.operation;
      expect(result.kind).toBe("unavailable");
      expect(fixture.sqlAttempts).toEqual(matrixHealthySql);
      if (mode === "wrong") {
        expect(fixture.observationResourceMatches()).toBe(false);
      }
    }),
  );
}

const terminalEvents: readonly MatrixEvent[] = ["close", "loss", "error"];
for (const event of terminalEvents) {
  test(
    "absorbs early " + event + " before reservation",
    matrixTest({ preEvent: event }, async (fixture) => {
      const result = await fixture.operation;
      expect(result.kind).toBe("unavailable");
      expect(fixture.sqlAttempts).toEqual(["close"]);
      expect(fixture.sqlAttempts).not.toContain("reserve");
    }),
  );
  test(
    "absorbs " + event + " during a held read and stops later SQL",
    matrixTest({ hold: "issues" }, async (fixture) => {
      const heldReached = await matrixArrived(fixture.heldEntered);
      fixture.emit(event);
      fixture.releaseHeld();
      const result = await fixture.operation;
      expect(heldReached).toBe(true);
      expect(result.kind).toBe("unavailable");
      expect(fixture.sqlAttempts).toEqual(matrixFailureSql.issues);
    }),
  );
  test(
    "absorbs late " + event + " after observation while close is held",
    matrixTest({ observation: "pending", closeHold: true }, async (fixture) => {
      const closeReached = await matrixArrived(fixture.closeEntered);
      fixture.finishObservation();
      await eventLoopTurn();
      const observationFinished = fixture.observationSettled();
      fixture.emit(event);
      fixture.finishClose();
      const result = await fixture.operation;
      expect(closeReached).toBe(true);
      expect(observationFinished).toBe(true);
      expect(result.kind).toBe("unavailable");
      expect(fixture.sqlAttempts).toEqual(matrixHealthySql);
    }),
  );
}

test(
  "duplicate open is absorbing",
  matrixTest({ duplicateOpen: true }, async (fixture) => {
    const result = await fixture.operation;
    expect(result.kind).toBe("unavailable");
    expect(fixture.sqlAttempts).toHaveLength(3);
    expect(fixture.sqlAttempts[0]).toBe("reserve");
    expect([...fixture.sqlAttempts.slice(1)].sort()).toEqual([
      "close",
      "release",
    ]);
    expect(fixture.acquisitions).toEqual(["local"]);
  }),
);

test(
  "duplicate close is absorbing",
  matrixTest({ duplicateClose: true }, async (fixture) => {
    const result = await fixture.operation;
    expect(result.kind).toBe("unavailable");
    expect(fixture.sqlAttempts).toEqual(matrixHealthySql);
  }),
);

test(
  "close during observer setup invalidates before the actual close attempt",
  matrixTest({ closeDuringObserve: true }, async (fixture) => {
    const result = await fixture.operation;
    expect(result.kind).toBe("unavailable");
    expect(fixture.sqlAttempts).toEqual(matrixHealthySql);
    expect(fixture.trace.indexOf("event:close")).toBeLessThan(
      fixture.trace.indexOf("close:attempt"),
    );
    expect(fixture.calls.filter((call) => call === "close")).toHaveLength(1);
  }),
);

for (const name of matrixFaultOperations) {
  for (const mode of matrixFaultModes) {
    test(
      "contains " +
        mode +
        " failure at " +
        name +
        " with exact later-call prefix",
      matrixTest({ fault: { name, mode } }, async (fixture) => {
        const result = await fixture.operation;
        expect(result.kind).toBe("unavailable");
        expect(fixture.sqlAttempts).toEqual(matrixFailureSql[name]);
        expect(fixture.calls.filter((call) => call === name)).toHaveLength(1);
        if (name === "reserve") {
          expect(fixture.releaseAttemptFacts).toEqual([]);
        } else {
          expect(fixture.releaseAttemptFacts).toHaveLength(1);
        }
        if (name === "release") {
          expect(fixture.releaseEffects).toEqual([]);
        } else if (name !== "reserve") {
          expect(fixture.releaseEffects).toHaveLength(1);
        }
      }),
    );
  }
}

const syncThrowModes: readonly MatrixSyncThrow[] = [
  "factory",
  "workDeadline",
  "cleanupDeadline",
  "observe",
];
for (const name of syncThrowModes) {
  test(
    "contains synchronous " + name + " failure",
    matrixTest({ syncThrow: name }, async (fixture) => {
      const result = await fixture.operation;
      expect(result.kind).toBe("unavailable");
      expect(fixture.sqlAttempts).toEqual(matrixSyncSql[name]);
      if (name === "factory") {
        expect(fixture.calls).not.toContain("reserve");
      } else {
        expect(fixture.sqlAttempts).toContain("close");
      }
    }),
  );
}

for (const name of ["work", "cleanup"] as const) {
  test(
    "contains rejected " + name + " deadline completion",
    matrixTest({ completionReject: name }, async (fixture) => {
      const result = await fixture.operation;
      expect(result.kind).toBe("unavailable");
      expect(fixture.sqlAttempts).toContain("close");
    }),
  );
}

const heldOperations: readonly MatrixHeldOperation[] = [
  "reserve",
  "begin",
  "identity",
  "gate",
  "issues",
  "durable",
  "wisp",
  "dependencies",
  "rollback",
  "release",
];
for (const name of heldOperations) {
  test(
    "requests independent teardown while held " + name + " settles",
    matrixTest(
      { hold: name, observation: "pending", closeHold: true },
      async (fixture) => {
        const heldReached = await matrixArrived(fixture.heldEntered);
        fixture.expireWork();
        await eventLoopTurn();
        const cleanupCreatedWhileHeld =
          fixture.calls.filter((call) => call === "cleanupDeadline").length ===
          1;
        const closeWhileHeld = fixture.closeStarted();
        const releaseAttemptsWhileHeld = fixture.releaseAttemptFacts.length;
        fixture.releaseHeld();
        await eventLoopTurn();
        const closeReached = await matrixArrived(fixture.closeEntered);
        fixture.finishObservation();
        fixture.finishClose();
        const result = await fixture.operation;
        expect(heldReached).toBe(true);
        expect(cleanupCreatedWhileHeld).toBe(true);
        expect(closeWhileHeld).toBe(true);
        expect(result.kind).toBe("unavailable");
        expect(fixture.sqlAttempts).toEqual(
          name === "reserve"
            ? ["reserve", "close", "release"]
            : matrixFailureSql[name],
        );
        if (name === "reserve") {
          expect(releaseAttemptsWhileHeld).toBe(0);
          expect(closeReached).toBe(true);
        }
      },
    ),
  );
}

test(
  "late acquired R is released once after close and never before acquisition",
  matrixTest(
    { hold: "reserve", observation: "pending", closeHold: true },
    async (fixture) => {
      const heldReached = await matrixArrived(fixture.heldEntered);
      fixture.expireWork();
      const closeReachedWhileHeld = await matrixArrived(fixture.closeEntered);
      const noEarlyRelease = fixture.releaseAttemptFacts.length === 0;
      fixture.releaseHeld();
      await eventLoopTurn();
      fixture.finishObservation();
      fixture.finishClose();
      const result = await fixture.operation;
      expect(heldReached).toBe(true);
      expect(closeReachedWhileHeld).toBe(true);
      expect(noEarlyRelease).toBe(true);
      expect(result.kind).toBe("unavailable");
      expect(fixture.acquisitions).toEqual(["local"]);
      expect(fixture.sqlAttempts).toEqual(["reserve", "close", "release"]);
      expect(fixture.releaseAttemptFacts).toEqual([
        {
          acquired: true,
          matchesReturnedResource: true,
          matchesOwnerResource: true,
        },
      ]);
      expect(fixture.releaseEffects).toEqual(fixture.releaseAttemptFacts);
    },
  ),
);

test(
  "late R is cleaned up once after owner already returned unavailable",
  matrixTest(
    { hold: "reserve", observation: "pending", closeHold: true },
    async (fixture) => {
      const heldReached = await matrixArrived(fixture.heldEntered);
      fixture.expireWork();
      const closeReached = await matrixArrived(fixture.closeEntered);
      const cleanupCreated =
        fixture.calls.filter((call) => call === "cleanupDeadline").length === 1;
      fixture.expireCleanup();
      const unavailableBeforeAcquire = await matrixArrived(
        fixture.operation.then(() => undefined),
      );
      const terminalBeforeAcquire = fixture.terminal();
      const noEarlyRelease = fixture.releaseAttemptFacts.length === 0;
      fixture.releaseHeld();
      await eventLoopTurn();
      const releaseAfterAcquire = fixture.releaseAttemptFacts.slice();
      const sqlAfterAcquire = fixture.sqlAttempts.slice();
      const remainsUnavailable = fixture.terminal()?.kind === "unavailable";
      fixture.finishObservation();
      fixture.finishClose();
      const result = await fixture.operation;
      expect(heldReached).toBe(true);
      expect(closeReached).toBe(true);
      expect(cleanupCreated).toBe(true);
      expect(unavailableBeforeAcquire).toBe(true);
      expect(terminalBeforeAcquire?.kind).toBe("unavailable");
      expect(noEarlyRelease).toBe(true);
      expect(fixture.acquisitions).toEqual(["local"]);
      expect(releaseAfterAcquire).toEqual([
        {
          acquired: true,
          matchesReturnedResource: true,
          matchesOwnerResource: true,
        },
      ]);
      expect(sqlAfterAcquire).toEqual(["reserve", "close", "release"]);
      expect(fixture.sqlAttempts).not.toContain("begin");
      expect(fixture.sqlAttempts).not.toContain("identity");
      expect(fixture.sqlAttempts).not.toContain("issues");
      expect(fixture.sqlAttempts).not.toContain("rollback");
      expect(remainsUnavailable).toBe(true);
      expect(result.kind).toBe("unavailable");
    },
  ),
);

test(
  "late null reservation is never released",
  matrixTest(
    {
      hold: "reserve",
      reservation: "null",
      observation: "pending",
      closeHold: true,
    },
    async (fixture) => {
      const heldReached = await matrixArrived(fixture.heldEntered);
      fixture.expireWork();
      const closeReached = await matrixArrived(fixture.closeEntered);
      const noEarlyRelease = fixture.releaseAttemptFacts.length === 0;
      fixture.releaseHeld();
      await eventLoopTurn();
      fixture.finishObservation();
      fixture.finishClose();
      const result = await fixture.operation;
      expect(heldReached).toBe(true);
      expect(closeReached).toBe(true);
      expect(noEarlyRelease).toBe(true);
      expect(result.kind).toBe("unavailable");
      expect(fixture.releaseAttemptFacts).toEqual([]);
      expect(fixture.sqlAttempts).toEqual(["reserve", "close"]);
    },
  ),
);

test(
  "foreign reservation is refused and cleanup releases only owner R",
  matrixTest({ reservation: "foreign" }, async (fixture) => {
    const result = await fixture.operation;
    expect(result.kind).toBe("unavailable");
    expect(fixture.sqlAttempts).toEqual(["reserve", "release", "close"]);
    expect(fixture.resourceFacts).toEqual(["release:true"]);
    expect(fixture.resourceMismatch()).toBe(false);
    expect(fixture.releaseAttemptFacts).toEqual([
      {
        acquired: true,
        matchesReturnedResource: false,
        matchesOwnerResource: true,
      },
    ]);
    expect(fixture.releaseEffects).toEqual(fixture.releaseAttemptFacts);
  }),
);

test(
  "null reservation is refused without release",
  matrixTest({ reservation: "null" }, async (fixture) => {
    const result = await fixture.operation;
    expect(result.kind).toBe("unavailable");
    expect(fixture.sqlAttempts).toEqual(["reserve", "close"]);
    expect(fixture.releaseAttemptFacts).toEqual([]);
  }),
);

for (const name of ["rollback", "release"] as const) {
  test(
    "loss then open after unsubscribe while " + name + " is held stays invalid",
    matrixTest(
      { hold: name, observation: "pending", closeHold: true },
      async (fixture) => {
        const heldReached = await matrixArrived(fixture.heldEntered);
        const unsubscribedBeforeHold =
          fixture.trace.indexOf("note:inner-unsubscribed") <
          fixture.trace.indexOf(name + ":attempt");
        fixture.emit("loss");
        fixture.emit("open");
        fixture.releaseHeld();
        const closeReached = await matrixArrived(fixture.closeEntered);
        fixture.finishObservation();
        fixture.finishClose();
        const result = await fixture.operation;
        expect(heldReached).toBe(true);
        expect(unsubscribedBeforeHold).toBe(true);
        expect(closeReached).toBe(true);
        expect(result.kind).toBe("unavailable");
        expect(fixture.notes).toEqual(["token-revoked", "inner-unsubscribed"]);
        expect(fixture.sqlAttempts).toEqual(matrixHealthySql);
        expect(
          fixture.sqlAttempts.filter((call) =>
            ["identity", "issues", "durable", "wisp", "dependencies"].includes(
              call,
            ),
          ),
        ).toHaveLength(5);
      },
    ),
  );
}

test(
  "late reserve rejection is handled after cleanup expiry and unavailable",
  matrixTest(
    { hold: "reserve", observation: "pending", closeHold: true },
    async (fixture) => {
      const heldReached = await matrixArrived(fixture.heldEntered);
      fixture.expireWork();
      const closeReached = await matrixArrived(fixture.closeEntered);
      fixture.expireCleanup();
      const unavailableBeforeReject = await matrixArrived(
        fixture.operation.then(() => undefined),
      );
      const resultBeforeReject = fixture.terminal();
      const sqlBeforeReject = fixture.sqlAttempts.slice();
      const releasesBeforeReject = fixture.releaseAttemptFacts.slice();
      fixture.rejectHeld();
      await eventLoopTurn();
      expect(heldReached).toBe(true);
      expect(closeReached).toBe(true);
      expect(unavailableBeforeReject).toBe(true);
      expect(resultBeforeReject?.kind).toBe("unavailable");
      expect(fixture.terminal()?.kind).toBe("unavailable");
      expect(fixture.sqlAttempts).toEqual(sqlBeforeReject);
      expect(fixture.releaseAttemptFacts).toEqual(releasesBeforeReject);
    },
  ),
);

test(
  "late held read rejection is handled after cleanup expiry and unavailable",
  matrixTest(
    { hold: "issues", observation: "pending", closeHold: true },
    async (fixture) => {
      const heldReached = await matrixArrived(fixture.heldEntered);
      fixture.expireWork();
      const closeReached = await matrixArrived(fixture.closeEntered);
      fixture.expireCleanup();
      const unavailableBeforeReject = await matrixArrived(
        fixture.operation.then(() => undefined),
      );
      const resultBeforeReject = fixture.terminal();
      const sqlBeforeReject = fixture.sqlAttempts.slice();
      fixture.rejectHeld();
      await eventLoopTurn();
      expect(heldReached).toBe(true);
      expect(closeReached).toBe(true);
      expect(unavailableBeforeReject).toBe(true);
      expect(resultBeforeReject?.kind).toBe("unavailable");
      expect(fixture.terminal()?.kind).toBe("unavailable");
      expect(fixture.sqlAttempts).toEqual(sqlBeforeReject);
      expect(fixture.sqlAttempts).not.toContain("durable");
    },
  ),
);

test(
  "held close rejection is handled after cleanup expiry and unavailable",
  matrixTest({ closeHold: true }, async (fixture) => {
    const closeReached = await matrixArrived(fixture.closeEntered);
    fixture.expireCleanup();
    const unavailableBeforeReject = await matrixArrived(
      fixture.operation.then(() => undefined),
    );
    const resultBeforeReject = fixture.terminal();
    const sqlBeforeReject = fixture.sqlAttempts.slice();
    fixture.rejectClose();
    await eventLoopTurn();
    expect(closeReached).toBe(true);
    expect(unavailableBeforeReject).toBe(true);
    expect(resultBeforeReject?.kind).toBe("unavailable");
    expect(fixture.terminal()?.kind).toBe("unavailable");
    expect(fixture.sqlAttempts).toEqual(sqlBeforeReject);
  }),
);

test(
  "cleanup expiry returns unavailable while work final remains held",
  matrixTest(
    {
      workCancel: "pending",
      observation: "pending",
      closeHold: true,
    },
    async (fixture) => {
      const cancelEntered = await matrixArrived(fixture.workCancelEntered);
      const cleanupCreated = await matrixArrived(
        fixture.cleanupDeadlineEntered,
      );
      fixture.expireCleanup();
      const closeAfterExpiry = await matrixArrived(fixture.closeEntered);
      const unavailableBeforeWorkFinal = await matrixArrived(
        fixture.operation.then(() => undefined),
      );
      const resultBeforeWorkFinal = fixture.terminal();
      const workStillHeld = fixture.workPending();
      expect(cancelEntered).toBe(true);
      expect(cleanupCreated).toBe(true);
      expect(closeAfterExpiry).toBe(true);
      expect(unavailableBeforeWorkFinal).toBe(true);
      expect(resultBeforeWorkFinal?.kind).toBe("unavailable");
      expect(workStillHeld).toBe(true);
    },
  ),
);

test(
  "work cancellation throw leaves its final held until cleanup expiry refusal",
  matrixTest(
    {
      workCancel: "throw",
      observation: "pending",
      closeHold: true,
    },
    async (fixture) => {
      const cancelEntered = await matrixArrived(fixture.workCancelEntered);
      const cleanupCreated = await matrixArrived(
        fixture.cleanupDeadlineEntered,
      );
      fixture.expireCleanup();
      const closeAfterExpiry = await matrixArrived(fixture.closeEntered);
      const unavailableBeforeWorkFinal = await matrixArrived(
        fixture.operation.then(() => undefined),
      );
      const resultBeforeWorkFinal = fixture.terminal();
      const workStillHeld = fixture.workPending();
      expect(cancelEntered).toBe(true);
      expect(cleanupCreated).toBe(true);
      expect(closeAfterExpiry).toBe(true);
      expect(unavailableBeforeWorkFinal).toBe(true);
      expect(resultBeforeWorkFinal?.kind).toBe("unavailable");
      expect(workStillHeld).toBe(true);
    },
  ),
);

test(
  "cleanup cancellation throw remains held until cleanup expiry refusal",
  matrixTest({ cleanupCancel: "throw" }, async (fixture) => {
    const cancelEntered = await matrixArrived(fixture.cleanupCancelEntered);
    const closeWasComplete = fixture.closeCompleted();
    const cleanupWasHeld = fixture.cleanupPending();
    fixture.expireCleanup();
    const unavailableBeforeFinally = await matrixArrived(
      fixture.operation.then(() => undefined),
    );
    const resultBeforeFinally = fixture.terminal();
    expect(cancelEntered).toBe(true);
    expect(closeWasComplete).toBe(true);
    expect(cleanupWasHeld).toBe(true);
    expect(unavailableBeforeFinally).toBe(true);
    expect(resultBeforeFinally?.kind).toBe("unavailable");
  }),
);

test(
  "cleanup cancellation cannot publish before its held final completion",
  matrixTest({ cleanupCancel: "pending" }, async (fixture) => {
    const cancelEntered = await matrixArrived(fixture.cleanupCancelEntered);
    await eventLoopTurn();
    const closeCompleted = fixture.closeCompleted();
    const terminalBeforeFinal = fixture.terminal();
    fixture.finishCleanup();
    const result = await fixture.operation;
    expect(cancelEntered).toBe(true);
    expect(closeCompleted).toBe(true);
    expect(terminalBeforeFinal).toBeUndefined();
    expect(result).toEqual(matrixExpectedRead());
  }),
);

test(
  "observer cancellation throw refuses publication",
  matrixTest({ observerCancel: "throw" }, async (fixture) => {
    const result = await fixture.operation;
    expect(result.kind).toBe("unavailable");
    expect(fixture.calls).toContain("cancel:observer");
  }),
);

test(
  "observer completion may remain held after cleanup expiry without revival",
  matrixTest(
    {
      observation: "pending",
      observerCancel: "pending",
      closeHold: true,
    },
    async (fixture) => {
      const closeReached = await matrixArrived(fixture.closeEntered);
      fixture.expireCleanup();
      const unavailable = await matrixArrived(
        fixture.operation.then(() => undefined),
      );
      const beforeObservation = fixture.terminal();
      const observationStillHeld = !fixture.observationSettled();
      fixture.finishObservation();
      await eventLoopTurn();
      expect(closeReached).toBe(true);
      expect(unavailable).toBe(true);
      expect(beforeObservation?.kind).toBe("unavailable");
      expect(observationStillHeld).toBe(true);
      expect(fixture.terminal()?.kind).toBe("unavailable");
    },
  ),
);

const deadlineCases: readonly Readonly<{
  name: string;
  options: MatrixOptions;
  noReserve: boolean;
}>[] = [
  {
    name: "initial work expiry",
    options: { workInitiallyExpired: true },
    noReserve: true,
  },
  {
    name: "initial cleanup expiry",
    options: { cleanupInitiallyExpired: true },
    noReserve: false,
  },
  {
    name: "elapsed undelivered work expiry",
    options: { workElapsed: true },
    noReserve: false,
  },
  {
    name: "elapsed undelivered cleanup expiry",
    options: { cleanupElapsed: true },
    noReserve: false,
  },
];
for (const scenario of deadlineCases) {
  test(
    "refuses " + scenario.name,
    matrixTest(scenario.options, async (fixture) => {
      const result = await fixture.operation;
      expect(result.kind).toBe("unavailable");
      if (scenario.noReserve) {
        expect(fixture.sqlAttempts).not.toContain("reserve");
      }
      expect(fixture.sqlAttempts).toContain("close");
    }),
  );
}

for (const event of ["token-revoked", "inner-unsubscribed"] as const) {
  test(
    "note failure at " + event + " keeps independent cleanup",
    matrixTest({ noteFailure: event }, async (fixture) => {
      const result = await fixture.operation;
      expect(result.kind).toBe("unavailable");
      expect(fixture.notes).toEqual(["token-revoked", "inner-unsubscribed"]);
      expect(fixture.sqlAttempts).toContain("release");
      expect(fixture.sqlAttempts).toContain("close");
    }),
  );
}

test(
  "healthy result has exact parts, boundary notes, resource and joined order",
  matrixTest({}, async (fixture) => {
    const result = await fixture.operation;
    expect(result).toEqual(matrixExpectedRead());
    expect(fixture.notes).toEqual(["token-revoked", "inner-unsubscribed"]);
    expect(fixture.sqlAttempts).toEqual(matrixHealthySql);
    expect(fixture.resourceFacts).toEqual([
      "begin:true",
      "identity:true",
      "issues:true",
      "durable:true",
      "wisp:true",
      "dependencies:true",
      "rollback:true",
      "release:true",
    ]);
    expect(fixture.releaseAttemptFacts).toEqual([
      {
        acquired: true,
        matchesReturnedResource: true,
        matchesOwnerResource: true,
      },
    ]);
    expect(fixture.releaseEffects).toEqual(fixture.releaseAttemptFacts);
    expect(fixture.observationCauses).toEqual(["healthy"]);
    expect(fixture.trace).toEqual([
      "deadline:work",
      "event:open",
      "note:token-revoked",
      "note:inner-unsubscribed",
      "rollback:attempt",
      "rollback:fulfilled",
      "release:attempt",
      "release:fulfilled",
      "cancel:work",
      "deadline:cleanup",
      "observe",
      "close:attempt",
      "event:close",
      "close:fulfilled",
      "cancel:observer",
      "cancel:cleanup",
    ]);
  }),
);

test(
  "preserves receiver-dependent read methods",
  matrixTest({}, async (fixture) => {
    const result = await fixture.operation;
    expect(result).toEqual(matrixExpectedRead());
    expect(fixture.receiverChecks).toHaveLength(5);
    expect(fixture.receiverChecks.every((passed) => passed)).toBe(true);
  }),
);
