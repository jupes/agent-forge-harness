import {
  createWorkspaceReadReservation,
  readReservedWorkspaceProjection,
  type WorkspaceReadEvent,
  type WorkspaceReadOutcome,
  type WorkspaceReadPort,
} from "./workspace-source-dolt-read";

const ownerResourceBrand: unique symbol = Symbol("workspace-owner-resource");

export type WorkspaceOwnerResource = Readonly<{
  [ownerResourceBrand]: true;
}>;

export function createWorkspaceOwnerResource(): WorkspaceOwnerResource {
  return Object.freeze({ [ownerResourceBrand]: true });
}

export type WorkspaceOwnerDeadlineOutcome = "expired" | "cancelled";
export type WorkspaceOwnerDeadline = Readonly<{
  initiallyExpired: boolean;
  completion: Promise<WorkspaceOwnerDeadlineOutcome>;
  cancel(): void;
}>;

export type WorkspaceOwnerObservation =
  | Readonly<{ kind: "observed"; resource: WorkspaceOwnerResource }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "cancelled" }>;

export type WorkspaceOwnerRetirement = Readonly<{
  noteLocalBoundary(event: "token-revoked" | "inner-unsubscribed"): void;
  observe(
    resource: WorkspaceOwnerResource,
    cause: "healthy" | "failed",
  ): Readonly<{
    completion: Promise<WorkspaceOwnerObservation>;
    cancel(): void;
  }>;
}>;

export type WorkspaceOwnerDriver<T> = Readonly<{
  reserveOnce(): Promise<WorkspaceOwnerResource | null>;
  begin(resource: WorkspaceOwnerResource): Promise<void>;
  readIdentity(resource: WorkspaceOwnerResource): Promise<T>;
  readIssues(resource: WorkspaceOwnerResource): Promise<T>;
  readDurableLabels(resource: WorkspaceOwnerResource): Promise<T>;
  readWispLabels(resource: WorkspaceOwnerResource): Promise<T>;
  readDependencies(resource: WorkspaceOwnerResource): Promise<T>;
  rollback(resource: WorkspaceOwnerResource): Promise<void>;
  releaseReservation(resource: WorkspaceOwnerResource): Promise<void>;
  closePool(): Promise<void>;
}>;

export type WorkspaceOwnerContext<T> = Readonly<{
  resource: WorkspaceOwnerResource;
  driver: WorkspaceOwnerDriver<T>;
  retirement: WorkspaceOwnerRetirement;
}>;

export type WorkspaceOwnerContextFactory<T> = Readonly<{
  create(notify: (event: WorkspaceReadEvent) => void): WorkspaceOwnerContext<T>;
}>;

export type WorkspaceOwnerDependencies<T> = Readonly<{
  contextFactory: WorkspaceOwnerContextFactory<T>;
  continuationGate: Readonly<{ waitAfterIdentity(): Promise<void> }>;
  deadlineFactory: Readonly<{
    create(kind: "work" | "cleanup"): WorkspaceOwnerDeadline;
  }>;
}>;

export async function readOwnedWorkspaceProjection<T>(
  dependencies: WorkspaceOwnerDependencies<T>,
): Promise<WorkspaceReadOutcome<T>> {
  type WorkRace<V> =
    | Readonly<{ kind: "value"; value: V }>
    | Readonly<{ kind: "stopped" }>;
  type CleanupFacts = Readonly<{
    runner: WorkspaceReadOutcome<T>;
    rollback: boolean;
    release: boolean;
    close: boolean;
    observation: WorkspaceOwnerObservation;
  }>;

  let invalid = false;
  let opened = false;
  let closeRequested = false;
  let closeObserved = false;
  let closeCount = 0;
  let innerListener: ((event: WorkspaceReadEvent) => void) | undefined;
  let innerSubscribed = false;
  let token: ReturnType<typeof createWorkspaceReadReservation> | null = null;
  let tokenActive = false;
  let tokenNoteRecorded = false;
  let unsubscribeNoteRecorded = false;
  let gateCalled = false;
  let workDeadline: WorkspaceOwnerDeadline | undefined;
  let workCompletion: Promise<WorkspaceOwnerDeadlineOutcome> | undefined;
  let workOutcome: WorkspaceOwnerDeadlineOutcome | undefined;
  let workExpired = false;
  let workCancelAttempted = false;
  let cleanupDeadline: WorkspaceOwnerDeadline | undefined;
  let cleanupCompletion: Promise<WorkspaceOwnerDeadlineOutcome> | undefined;
  let cleanupOutcome: WorkspaceOwnerDeadlineOutcome | undefined;
  let cleanupAttempted = false;
  let cleanupStarted = false;
  let observer:
    | Readonly<{
        completion: Promise<WorkspaceOwnerObservation>;
        cancel(): void;
      }>
    | undefined;
  let observerCompletion: Promise<WorkspaceOwnerObservation> | undefined;
  let observerResult: WorkspaceOwnerObservation = { kind: "unavailable" };
  let observerCancelAttempted = false;
  let closeCompletion: Promise<void> | undefined;
  let closeResult: Promise<boolean> | undefined;
  let releaseCompletion: Promise<void> | undefined;
  let releaseResult: Promise<boolean> | undefined;
  let rollbackCompletion: Promise<void> | undefined;
  let rollbackResult: Promise<boolean> | undefined;
  let reserveState: "not-requested" | "pending" | "none" | "owned" =
    "not-requested";
  let context: WorkspaceOwnerContext<T> | undefined;
  let runnerDone: Promise<WorkspaceReadOutcome<T>> | undefined;
  let resolveInvalidation!: () => void;
  const invalidation = new Promise<void>((resolve) => {
    resolveInvalidation = resolve;
  });
  const never = new Promise<never>(() => {});

  const invalidate = (event: WorkspaceReadEvent = "error"): void => {
    if (!invalid) {
      invalid = true;
      resolveInvalidation();
    }
    try {
      innerListener?.(event);
    } catch {
      invalid = true;
    }
  };

  const notify = (event: WorkspaceReadEvent): void => {
    if (event === "open") {
      if (opened || closeRequested) {
        invalidate("error");
        return;
      }
      opened = true;
      try {
        innerListener?.("open");
      } catch {
        invalidate("error");
      }
      return;
    }
    if (event === "close") {
      closeCount += 1;
      if (!closeRequested || closeObserved || closeCount !== 1) {
        invalidate("close");
        return;
      }
      closeObserved = true;
      try {
        innerListener?.("close");
      } catch {
        invalidate("error");
      }
      return;
    }
    invalidate(event);
  };

  const noteLocalBoundary = (
    event: "token-revoked" | "inner-unsubscribed",
  ): void => {
    try {
      context?.retirement.noteLocalBoundary(event);
      if (context !== undefined) {
        if (event === "token-revoked") tokenNoteRecorded = true;
        else unsubscribeNoteRecorded = true;
      }
    } catch {
      invalidate("error");
    }
  };

  const trackRaw = <V>(operation: () => Promise<V>): Promise<V> => {
    let raw: Promise<V>;
    try {
      raw = operation();
    } catch {
      invalidate("error");
      const failed = Promise.reject<V>(
        new Error("Workspace operation failed."),
      );
      void failed.catch(() => undefined);
      return failed;
    }
    let tracked: Promise<V>;
    try {
      tracked = raw.then(
        (value) => value,
        () => {
          invalidate("error");
          throw new Error("Workspace operation failed.");
        },
      );
    } catch {
      invalidate("error");
      const failed = Promise.reject<V>(
        new Error("Workspace operation failed."),
      );
      void failed.catch(() => undefined);
      return failed;
    }
    void tracked.catch(() => undefined);
    return tracked;
  };

  const releaseReservation = (): Promise<void> => {
    if (releaseCompletion !== undefined) return releaseCompletion;
    if (reserveState !== "owned" || context === undefined) {
      return Promise.resolve();
    }
    releaseCompletion = trackRaw(() =>
      context!.driver.releaseReservation(context!.resource),
    );
    releaseResult = releaseCompletion.then(
      () => true,
      () => false,
    );
    return releaseCompletion;
  };

  const prepareCleanupDeadline = (): void => {
    if (cleanupAttempted) return;
    cleanupAttempted = true;
    try {
      cleanupDeadline = dependencies.deadlineFactory.create("cleanup");
      cleanupCompletion = cleanupDeadline.completion.then(
        (outcome) => {
          cleanupOutcome = outcome;
          if (outcome === "expired") invalidate("error");
          return outcome;
        },
        () => {
          cleanupOutcome = "expired";
          invalidate("error");
          return "expired";
        },
      );
      void cleanupCompletion.catch(() => undefined);
      if (cleanupDeadline.initiallyExpired) invalidate("error");
    } catch {
      invalidate("error");
    }
  };

  const startCleanup = (cause: "healthy" | "failed"): void => {
    if (cleanupStarted || context === undefined) return;
    cleanupStarted = true;
    prepareCleanupDeadline();
    if (reserveState === "owned") {
      void releaseReservation().catch(() => undefined);
    }
    try {
      observer = context.retirement.observe(context.resource, cause);
      observerCompletion = observer.completion.then(
        (result) => {
          observerResult = result;
          if (
            result.kind !== "observed" ||
            result.resource !== context!.resource
          ) {
            invalidate("error");
          }
          return result;
        },
        () => {
          observerResult = { kind: "unavailable" };
          invalidate("error");
          return observerResult;
        },
      );
      void observerCompletion.catch(() => undefined);
    } catch {
      invalidate("error");
    }
    closeRequested = true;
    closeCompletion = trackRaw(() => context!.driver.closePool());
    closeResult = closeCompletion.then(
      () => true,
      () => false,
    );
  };

  const cancelObserver = (): void => {
    if (observer === undefined || observerCancelAttempted) return;
    observerCancelAttempted = true;
    try {
      observer.cancel();
    } catch {
      invalidate("error");
    }
  };

  const invokeRunner = (): Promise<WorkspaceReadOutcome<T>> => {
    if (runnerDone !== undefined) return runnerDone;
    let raw: Promise<WorkspaceReadOutcome<T>>;
    try {
      raw = readReservedWorkspaceProjection(port);
    } catch {
      invalidate("error");
      raw = Promise.resolve({ kind: "unavailable" });
    }
    runnerDone = raw.then(
      (outcome) => outcome,
      () => {
        invalidate("error");
        return { kind: "unavailable" };
      },
    );
    void runnerDone.catch(() => undefined);
    return runnerDone;
  };

  const raceWork = <V>(operation: Promise<V>): Promise<WorkRace<V>> =>
    Promise.race([
      operation.then(
        (value) => ({ kind: "value" as const, value }),
        () => ({ kind: "stopped" as const }),
      ),
      invalidation.then(() => ({ kind: "stopped" as const })),
      workCompletion?.then(() => ({ kind: "stopped" as const })) ?? never,
    ]);

  const port: WorkspaceReadPort<T> = {
    subscribe(listener) {
      if (innerSubscribed) {
        invalidate("error");
      } else {
        innerSubscribed = true;
        innerListener = listener;
      }
      if (invalid) listener("error");
      else if (opened) listener("open");
      return () => {
        if (!innerSubscribed) {
          invalidate("error");
          return;
        }
        innerSubscribed = false;
        innerListener = undefined;
        noteLocalBoundary("inner-unsubscribed");
      };
    },
    async reserveOnce() {
      if (
        invalid ||
        workExpired ||
        reserveState !== "not-requested" ||
        context === undefined
      ) {
        invalidate("error");
        return null;
      }
      reserveState = "pending";
      let acquired: WorkspaceOwnerResource | null;
      try {
        acquired = await trackRaw(() => context!.driver.reserveOnce());
      } catch {
        reserveState = "none";
        throw new Error("Workspace reservation failed.");
      }
      if (acquired === null) {
        reserveState = "none";
        return null;
      }
      reserveState = "owned";
      if (cleanupStarted) {
        try {
          await releaseReservation();
        } catch {
          return null;
        }
        return null;
      }
      if (acquired !== context.resource || invalid || workExpired) {
        invalidate("error");
        return null;
      }
      await trackRaw(() => context!.driver.begin(context!.resource));
      if (invalid || workExpired) {
        if (cleanupStarted) {
          try {
            await releaseReservation();
          } catch {
            return null;
          }
        }
        return null;
      }
      token = createWorkspaceReadReservation();
      tokenActive = true;
      return token;
    },
    readIdentity: async (reservation) => {
      const value = await readPart(reservation, (resource) =>
        context!.driver.readIdentity(resource),
      );
      if (
        reservation !== token ||
        !tokenActive ||
        reserveState !== "owned" ||
        invalid ||
        workExpired ||
        context === undefined
      ) {
        invalidate("error");
        throw new Error("Workspace read is unavailable.");
      }
      if (!gateCalled) {
        gateCalled = true;
        await trackRaw(() => dependencies.continuationGate.waitAfterIdentity());
      } else {
        invalidate("error");
        throw new Error("Identity gate already used.");
      }
      if (invalid || workExpired) {
        throw new Error("Workspace read is unavailable.");
      }
      return value;
    },
    readIssues: (reservation) =>
      readPart(reservation, (resource) => context!.driver.readIssues(resource)),
    readDurableLabels: (reservation) =>
      readPart(reservation, (resource) =>
        context!.driver.readDurableLabels(resource),
      ),
    readWispLabels: (reservation) =>
      readPart(reservation, (resource) =>
        context!.driver.readWispLabels(resource),
      ),
    readDependencies: (reservation) =>
      readPart(reservation, (resource) =>
        context!.driver.readDependencies(resource),
      ),
    async closeLocally(reservation) {
      if (reservation !== token || !tokenActive) {
        invalidate("error");
        return;
      }
      tokenActive = false;
      token = null;
      noteLocalBoundary("token-revoked");
    },
  };

  const readPart = async (
    reservation: ReturnType<typeof createWorkspaceReadReservation>,
    read: (resource: WorkspaceOwnerResource) => Promise<T>,
  ): Promise<T> => {
    if (
      reservation !== token ||
      !tokenActive ||
      reserveState !== "owned" ||
      invalid ||
      workExpired ||
      context === undefined
    ) {
      invalidate("error");
      throw new Error("Workspace read is unavailable.");
    }
    const value = await trackRaw(() => read(context!.resource));
    if (reservation !== token || !tokenActive || invalid || workExpired) {
      invalidate("error");
      throw new Error("Workspace read is unavailable.");
    }
    return value;
  };

  try {
    context = dependencies.contextFactory.create(notify);
  } catch {
    invalidate("error");
    await invokeRunner();
    return { kind: "unavailable" };
  }

  try {
    workDeadline = dependencies.deadlineFactory.create("work");
    workCompletion = workDeadline.completion.then(
      (outcome) => {
        workOutcome = outcome;
        if (outcome === "expired") {
          workExpired = true;
          invalidate("error");
        }
        return outcome;
      },
      () => {
        workOutcome = "expired";
        workExpired = true;
        invalidate("error");
        return "expired";
      },
    );
    void workCompletion.catch(() => undefined);
    if (workDeadline.initiallyExpired) {
      workExpired = true;
      invalidate("error");
    }
  } catch {
    invalidate("error");
  }

  const runner = invokeRunner();
  if (invalid || workDeadline === undefined || workExpired) {
    if (workDeadline !== undefined && workOutcome === undefined) {
      workCancelAttempted = true;
      try {
        workDeadline.cancel();
      } catch {
        invalidate("error");
      }
    }
    startCleanup("failed");
    return finishUnavailable();
  }

  const runnerFirst = await Promise.race([
    runner.then((outcome) => ({ kind: "runner" as const, outcome })),
    invalidation.then(() => ({ kind: "invalid" as const })),
    workCompletion!.then(() => ({ kind: "deadline" as const })),
  ]);
  if (
    runnerFirst.kind !== "runner" ||
    runnerFirst.outcome.kind !== "read" ||
    invalid ||
    workExpired ||
    !opened ||
    !tokenNoteRecorded ||
    !unsubscribeNoteRecorded
  ) {
    return failAndFinish();
  }

  const rollback = trackRaw(() => context!.driver.rollback(context!.resource));
  rollbackCompletion = rollback;
  rollbackResult = rollback.then(
    () => true,
    () => false,
  );
  const rollbackFirst = await raceWork(rollback);
  if (rollbackFirst.kind !== "value" || invalid || workExpired) {
    return failAndFinish();
  }

  const release = releaseReservation();
  const releaseFirst = await raceWork(release);
  if (releaseFirst.kind !== "value" || invalid || workExpired) {
    return failAndFinish();
  }

  if (workCancelAttempted) {
    invalidate("error");
    return failAndFinish();
  }
  workCancelAttempted = true;
  try {
    workDeadline.cancel();
  } catch {
    invalidate("error");
  }
  prepareCleanupDeadline();
  if (
    invalid ||
    cleanupDeadline === undefined ||
    cleanupCompletion === undefined
  ) {
    return failAndFinish();
  }

  const workFinal = await Promise.race([
    workCompletion!.then((outcome) => ({
      kind: "work" as const,
      outcome,
    })),
    cleanupCompletion.then((outcome) => ({
      kind: "cleanup" as const,
      outcome,
    })),
    invalidation.then(() => ({ kind: "invalid" as const })),
  ]);
  if (
    workFinal.kind !== "work" ||
    workFinal.outcome !== "cancelled" ||
    invalid ||
    workExpired
  ) {
    return failAndFinish();
  }

  startCleanup("healthy");
  const healthyFacts = cleanupFacts();
  const joined = await Promise.race([
    healthyFacts.then((facts) => ({ kind: "facts" as const, facts })),
    cleanupCompletion.then((outcome) => ({
      kind: "deadline" as const,
      outcome,
    })),
    invalidation.then(() => ({ kind: "invalid" as const })),
  ]);
  if (joined.kind !== "facts") {
    return finishUnavailable();
  }
  const facts = joined.facts;
  if (
    !facts.close ||
    !facts.release ||
    !facts.rollback ||
    facts.runner.kind !== "read" ||
    facts.observation.kind !== "observed" ||
    facts.observation.resource !== context.resource ||
    !closeObserved ||
    closeCount !== 1 ||
    invalid ||
    workOutcome !== "cancelled" ||
    workExpired
  ) {
    invalidate("error");
    return finishUnavailable();
  }

  cancelObserver();
  if (cleanupDeadline === undefined || cleanupCompletion === undefined) {
    invalidate("error");
    return { kind: "unavailable" };
  }
  try {
    cleanupDeadline.cancel();
  } catch {
    invalidate("error");
    return { kind: "unavailable" };
  }
  let finalCleanup: WorkspaceOwnerDeadlineOutcome;
  try {
    finalCleanup = await cleanupCompletion;
  } catch {
    finalCleanup = "expired";
    invalidate("error");
  }
  if (finalCleanup === "expired") invalidate("error");

  const publish =
    finalCleanup === "cancelled" &&
    !invalid &&
    !workExpired &&
    opened &&
    closeObserved &&
    closeCount === 1 &&
    tokenNoteRecorded &&
    unsubscribeNoteRecorded &&
    workOutcome === "cancelled" &&
    facts.runner.kind === "read" &&
    facts.release &&
    facts.rollback &&
    facts.close &&
    facts.observation.kind === "observed" &&
    facts.observation.resource === context.resource;
  if (!publish) return { kind: "unavailable" };
  return facts.runner;

  async function failAndFinish(): Promise<WorkspaceReadOutcome<T>> {
    if (!invalid) invalidate("error");
    if (
      workDeadline !== undefined &&
      workOutcome === undefined &&
      !workCancelAttempted
    ) {
      workCancelAttempted = true;
      try {
        workDeadline.cancel();
      } catch {
        invalidate("error");
      }
    }
    startCleanup("failed");
    return finishUnavailable();
  }

  async function finishUnavailable(): Promise<WorkspaceReadOutcome<T>> {
    if (context === undefined) return { kind: "unavailable" };
    if (!cleanupStarted) startCleanup("failed");
    if (cleanupCompletion === undefined) {
      cancelObserver();
      return { kind: "unavailable" };
    }
    const first = await Promise.race([
      cleanupFacts().then(() => "facts" as const),
      cleanupCompletion.then(() => "deadline" as const),
    ]);
    if (first === "deadline" && cleanupOutcome === "expired") {
      cancelObserver();
      return { kind: "unavailable" };
    }
    cancelObserver();
    if (cleanupOutcome === undefined && cleanupDeadline !== undefined) {
      try {
        cleanupDeadline.cancel();
      } catch {
        invalidate("error");
        return { kind: "unavailable" };
      }
      try {
        cleanupOutcome = await cleanupCompletion;
      } catch {
        cleanupOutcome = "expired";
        invalidate("error");
      }
    }
    if (cleanupOutcome === "expired") invalidate("error");
    return { kind: "unavailable" };
  }

  function cleanupFacts(): Promise<CleanupFacts> {
    const runnerSettlement =
      runnerDone ?? Promise.resolve({ kind: "unavailable" as const });
    const rollbackSettlement = rollbackResult ?? Promise.resolve(true);
    const releaseSettlement =
      releaseResult ??
      Promise.resolve(reserveState !== "owned" && reserveState !== "pending");
    const closeSettlement = closeResult ?? Promise.resolve(false);
    const observationSettlement =
      observerCompletion ?? Promise.resolve({ kind: "unavailable" as const });
    return Promise.all([
      runnerSettlement,
      rollbackSettlement,
      releaseSettlement,
      closeSettlement,
      observationSettlement,
    ]).then(
      ([
        runnerValue,
        rollbackValue,
        releaseValue,
        closeValue,
        observationValue,
      ]) => ({
        runner: runnerValue,
        rollback: rollbackValue,
        release: releaseValue,
        close: closeValue,
        observation: observationValue,
      }),
    );
  }
}
