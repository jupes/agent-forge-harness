/** Test-only phase bounds; this never opens a feed or controls an attempt. */
export function shiftFeedPhase<T>(
  phase: string,
  work: () => Promise<T>,
  withinMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Private Shift feed ${phase} exceeded ${withinMs}ms`)),
      withinMs,
    );
    const started = (() => {
      try {
        return work();
      } catch (cause) {
        return Promise.reject(cause);
      }
    })();
    started
      .then(resolve, (cause: unknown) =>
        reject(new Error(`Private Shift feed ${phase} failed`, { cause })),
      )
      .finally(() => clearTimeout(timer));
  });
}

/** Owns only the test's read observer and undispatched private lease. */
export function createShiftFeedCleanup(options: {
  abortObserver(): void;
  cancelObserver(): Promise<unknown>;
  finishOwner(): Promise<unknown>;
  withinMs?: number;
}) {
  const withinMs = options.withinMs ?? 1000;
  let closing: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  const closeObserver = () => {
    closing ??= shiftFeedPhase(
      "observer cancellation",
      async () => {
        options.abortObserver();
        await options.cancelObserver();
      },
      withinMs,
    );
    return closing;
  };
  return {
    closeObserver,
    release() {
      releasing ??= Promise.allSettled([
        closeObserver(),
        shiftFeedPhase("owner finish", options.finishOwner, withinMs),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "Private Shift feed cleanup failed",
          );
      });
      return releasing;
    },
  };
}
