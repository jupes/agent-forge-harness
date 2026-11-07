/** Keep packaged hearth compilation and timed durable append apart from concurrent rerun work. */
const EXCLUSIVE = new Set([
  "scripts/ledger/append.test.ts",
  "scripts/hearth/codex-sync-compiled.test.ts",
]);
const diagnosticName = (file: string) => {
  const clean = file.replace(/[\p{Cc}\p{Cs}]/gu, "?");
  return clean.length > 160 ? clean.slice(0, 157) + "..." : clean;
};

export interface IsolationRerunProgress {
  event: "started" | "finished" | "unstarted" | "complete" | "incomplete";
  phase: "exclusive" | "parallel" | "deadline" | "complete";
  file: string | null;
  total: number;
  completed: number;
  startedCount: number;
  finishedCount: number;
  unstartedCount: number;
  cleanupFailureCount: number;
  elapsedMs: number;
  activeCount: number;
  active: ReadonlyArray<{ file: string; elapsedMs: number }>;
  pendingCount: number;
  pending: readonly string[];
}

/** Structural owner only: the coordinator never imports process supervision. */
export interface IsolationOwnedOwner {
  readonly done: Promise<unknown>;
  stop(reason: string): Promise<void>;
}

export interface IsolationFailureRecord {
  readonly file: string;
  primary: unknown;
  hasPrimary: boolean;
  readonly secondaryErrors: unknown[];
}

export type IsolationSettlement<T> = PromiseSettledResult<T> & {
  failureRecord?: IsolationFailureRecord;
};

export interface IsolationRerunControl {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly retirementDeadlineAt: number;
  now(): number;
  registerOwner(owner: IsolationOwnedOwner): boolean;
  registerObligation<T>(promise: Promise<T>): Promise<T>;
  failFatal(reason: unknown): void;
}

export interface IsolationRerunOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  hardDeadlineAt?: number;
  now?: () => number;
  onHardDeadline?: (pending: number) => void;
  onPendingChange?: (pending: number) => void;
}

/** Live obligations survive a returned hard-deadline failure until they settle. */
const retainedPromises = new Set<Promise<unknown>>();
export function pendingIsolationObligationCount(): number {
  return retainedPromises.size;
}

function observe<T>(
  promise: Promise<T>,
  local?: Set<Promise<unknown>>,
  onChange?: () => void,
): Promise<T> {
  retainedPromises.add(promise);
  local?.add(promise);
  onChange?.();
  void promise.then(
    () => {
      retainedPromises.delete(promise);
      local?.delete(promise);
      onChange?.();
    },
    () => {
      retainedPromises.delete(promise);
      local?.delete(promise);
      onChange?.();
    },
  );
  return promise;
}

export class IsolationUnstartedError extends Error {
  readonly file: string;
  readonly index: number;
  readonly kind: "deadline" | "fatal";

  constructor(file: string, index: number, kind: "deadline" | "fatal") {
    super(
      "Isolation rerun was not started (" + kind + "): " + diagnosticName(file),
    );
    this.name = "IsolationUnstartedError";
    this.file = file;
    this.index = index;
    this.kind = kind;
  }
}

export class IsolationHardDeadlineError extends Error {
  readonly pending: number;
  constructor(pending: number) {
    super(
      "Isolation retirement hard deadline reached with " +
        pending +
        " obligations unsettled.",
    );
    this.name = "IsolationHardDeadlineError";
    this.pending = pending;
  }
}

export async function settleIsolationReruns<T>(
  files: readonly string[],
  workers: number,
  run: (file: string, control: IsolationRerunControl) => Promise<T>,
  onProgress?: (progress: IsolationRerunProgress) => void,
  options: IsolationRerunOptions = {},
): Promise<IsolationSettlement<T>[]> {
  if (!Number.isInteger(workers) || workers < 1)
    throw new Error("Expected a positive isolation worker count");

  const entries = files.map((file, index) => ({ file, index }));
  const results = new Array<IsolationSettlement<T>>(files.length);
  const started = performance.now();
  const now = options.now ?? (() => performance.now());
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const hardDeadlineAt = options.hardDeadlineAt ?? Number.POSITIVE_INFINITY;
  const pending = new Set(entries.map((entry) => entry.index));
  const failureRecords = new Map<number, IsolationFailureRecord>();
  for (const entry of entries)
    failureRecords.set(entry.index, {
      file: diagnosticName(entry.file),
      primary: undefined,
      hasPrimary: false,
      secondaryErrors: new Array<unknown>(),
    });
  const localObligations = new Set<Promise<unknown>>();
  const active = new Map<number, { file: string; started: number }>();
  const owners = new Map<number, Set<IsolationOwnedOwner>>();
  const ownerStops = new Map<number, Set<Promise<void>>>();
  const ownerEntry = new Map<IsolationOwnedOwner, number>();
  const callbackOutcomes = new Map<
    number,
    | { ok: true; value: unknown }
    | { ok: false; reason: unknown; observedAt: number }
  >();
  const stopRequested = new Set<IsolationOwnedOwner>();
  const controller = new AbortController();
  let completed = 0;
  let startedCount = 0;
  let finishedCount = 0;
  let unstartedCount = 0;
  let cleanupFailureCount = 0;
  let halted = false;
  let haltedReason: unknown = null;
  let haltKind: "deadline" | "fatal" | null = null;
  let fatalReason: unknown = null;
  let cleanupFailure: unknown = null;
  let hardExpired = false;
  let hardDeadlineError: IsolationHardDeadlineError | null = null;
  let resolveHard!: () => void;
  const hardSignal = new Promise<void>((resolve) => {
    resolveHard = resolve;
  });

  const pendingChanged = () => {
    try {
      options.onPendingChange?.(localObligations.size);
    } catch (error) {
      if (!halted) halt(error, "fatal");
      else cleanupFailureCount++;
    }
  };
  const keepFailure = (index: number, error: unknown, secondary: boolean) => {
    const record = failureRecords.get(index);
    if (!record) return;
    if (!record.hasPrimary) {
      record.primary = error;
      record.hasPrimary = true;
    } else if (secondary && record.primary !== error)
      record.secondaryErrors.push(error);
  };
  const rejected = (index: number, reason: unknown): IsolationSettlement<T> => {
    const record = failureRecords.get(index);
    if (record && !record.hasPrimary) {
      record.primary = reason;
      record.hasPrimary = true;
    }
    return {
      status: "rejected",
      reason,
      ...(record ? { failureRecord: record } : {}),
    };
  };

  const report = (
    event: IsolationRerunProgress["event"],
    phase: IsolationRerunProgress["phase"],
    file: string | null,
  ) => {
    if (!onProgress) return;
    const current = now();
    try {
      onProgress({
        event,
        phase,
        file: file === null ? null : diagnosticName(file),
        total: files.length,
        completed,
        startedCount,
        finishedCount,
        unstartedCount,
        cleanupFailureCount,
        elapsedMs: Math.max(0, Math.round(current - started)),
        activeCount: active.size,
        active: [...active.values()].slice(0, 4).map((entry) => ({
          file: diagnosticName(entry.file),
          elapsedMs: Math.max(0, Math.round(current - entry.started)),
        })),
        pendingCount: pending.size,
        pending: entries
          .filter((entry) => pending.has(entry.index))
          .slice(0, 8)
          .map((entry) => diagnosticName(entry.file)),
      });
    } catch {
      // Diagnostics must never skip a file or change its settled result.
    }
  };

  const stopOwner = (owner: IsolationOwnedOwner) => {
    if (stopRequested.has(owner)) return;
    stopRequested.add(owner);
    const entryIndex = ownerEntry.get(owner);
    try {
      const stopping = Promise.resolve(
        owner.stop("isolation rerun retirement"),
      );
      const observedStop = stopping.catch((error: unknown) => {
        if (entryIndex !== undefined) keepFailure(entryIndex, error, true);
        if (!halted) halt(error, "fatal");
        else {
          cleanupFailureCount++;
          if (cleanupFailure === null) cleanupFailure = error;
        }
      });
      observe(observedStop, localObligations, pendingChanged);
      if (entryIndex !== undefined)
        ownerStops.get(entryIndex)?.add(observedStop);
    } catch (error) {
      if (entryIndex !== undefined) keepFailure(entryIndex, error, true);
      if (!halted) halt(error, "fatal");
      else {
        cleanupFailureCount++;
        if (cleanupFailure === null) cleanupFailure = error;
      }
    }
  };

  const halt = (reason: unknown, kind: "deadline" | "fatal") => {
    if (!halted) {
      halted = true;
      haltedReason = reason;
      haltKind = kind;
      if (kind === "fatal") fatalReason = reason;
      controller.abort(reason);
    }
    for (const [index] of active) keepFailure(index, reason, false);
    for (const set of owners.values())
      for (const owner of set) stopOwner(owner);
  };

  const expireHardDeadline = (pendingCount: number) => {
    if (hardDeadlineError === null)
      hardDeadlineError = new IsolationHardDeadlineError(pendingCount);
    hardExpired = true;
    halt(hardDeadlineError, "deadline");
    try {
      options.onHardDeadline?.(hardDeadlineError.pending);
    } catch (cleanupError) {
      cleanupFailureCount++;
      if (fatalReason === null) fatalReason = cleanupError;
    }
    resolveHard();
  };

  const checkOpen = (): boolean => {
    if (!halted && options.signal?.aborted)
      halt(
        options.signal.reason ?? new Error("Isolation rerun cancelled"),
        "deadline",
      );
    if (!halted && now() >= deadlineAt)
      halt(new Error("Isolation rerun work cutoff reached"), "deadline");
    return !halted;
  };

  const externalAbort = () =>
    halt(
      options.signal?.reason ?? new Error("Isolation rerun cancelled"),
      "deadline",
    );
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  checkOpen();

  const hardDelay = Math.max(0, hardDeadlineAt - now());
  const hardTimer = Number.isFinite(hardDeadlineAt)
    ? setTimeout(() => {
        const outstanding = localObligations.size;
        if (active.size === 0) {
          resolveHard();
          return;
        }
        if (outstanding === 0) return;
        expireHardDeadline(outstanding);
      }, hardDelay)
    : undefined;

  const softDelay = Math.max(0, deadlineAt - now());
  const softTimer = Number.isFinite(deadlineAt)
    ? setTimeout(() => {
        if (!halted)
          halt(new Error("Isolation rerun work cutoff reached"), "deadline");
      }, softDelay)
    : undefined;

  const visit = async (
    entry: { file: string; index: number },
    phase: "exclusive" | "parallel",
  ) => {
    if (!checkOpen()) return false;
    pending.delete(entry.index);
    active.set(entry.index, { file: entry.file, started: now() });
    startedCount++;
    const entryOwners = new Set<IsolationOwnedOwner>();
    const entryDone = new Set<Promise<unknown>>();
    const entryStopPromises = new Set<Promise<void>>();
    const entryObligations = new Set<Promise<unknown>>();
    owners.set(entry.index, entryOwners);
    ownerStops.set(entry.index, entryStopPromises);
    report("started", phase, entry.file);
    const control: IsolationRerunControl = {
      signal: controller.signal,
      deadlineAt,
      retirementDeadlineAt: hardDeadlineAt,
      now,
      registerOwner(owner) {
        const done = observe(
          Promise.resolve(owner.done),
          localObligations,
          pendingChanged,
        );
        entryOwners.add(owner);
        entryDone.add(done);
        ownerEntry.set(owner, entry.index);
        if (!owners.has(entry.index)) {
          stopOwner(owner);
          return false;
        }
        void done.catch((error: unknown) => {
          keepFailure(entry.index, error, true);
          if (!halted) halt(error, "fatal");
          else {
            cleanupFailureCount++;
            if (cleanupFailure === null) cleanupFailure = error;
          }
        });
        if (!checkOpen()) {
          stopOwner(owner);
          return false;
        }
        return true;
      },
      registerObligation(promise) {
        const tracked = observe(
          Promise.resolve(promise),
          localObligations,
          pendingChanged,
        );
        entryObligations.add(tracked);
        void tracked.catch((error: unknown) => {
          keepFailure(entry.index, error, true);
          if (!halted) halt(error, "fatal");
        });
        return tracked;
      },
      failFatal(reason) {
        keepFailure(entry.index, reason, true);
        halt(reason, "fatal");
      },
    };

    let resolveWork!: (value: T | PromiseLike<T>) => void;
    let rejectWork!: (reason?: unknown) => void;
    const work = new Promise<T>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    observe(work, localObligations, pendingChanged);
    try {
      // Fence callback work before synchronously invoking acquisition/setup.
      Promise.resolve(run(entry.file, control)).then(resolveWork, rejectWork);
    } catch (error) {
      rejectWork(error);
    }
    const outcome = work.then(
      (value) => ({ ok: true as const, value }),
      (reason: unknown) => ({ ok: false as const, reason, observedAt: now() }),
    );
    void outcome.then((value) => {
      callbackOutcomes.set(entry.index, value);
      if (!value.ok && value.observedAt < deadlineAt) {
        const record = failureRecords.get(entry.index);
        if (record) {
          if (record.hasPrimary && record.primary !== value.reason)
            record.secondaryErrors.unshift(record.primary);
          record.primary = value.reason;
          record.hasPrimary = true;
        }
      }
    });
    void outcome.catch(() => undefined);

    try {
      let settled: PromiseSettledResult<unknown>[] = [];
      for (;;) {
        const snapshot: Promise<unknown>[] = [
          outcome,
          ...entryDone,
          ...entryStopPromises,
          ...entryObligations,
        ];
        const all = Promise.allSettled(snapshot);
        settled = await Promise.race([
          all,
          hardSignal.then(() => {
            throw hardDeadlineError;
          }),
        ]);
        if (hardExpired) return true;
        checkOpen();
        if (
          snapshot.length ===
          1 + entryDone.size + entryStopPromises.size + entryObligations.size
        )
          break;
      }
      const failedObligation = settled
        .slice(1)
        .find((receipt) => receipt.status === "rejected");
      if (failedObligation?.status === "rejected" && !halted)
        halt(failedObligation.reason, "fatal");
      const result =
        settled[0]?.status === "fulfilled"
          ? (settled[0].value as Awaited<typeof outcome>)
          : {
              ok: false as const,
              reason: (settled[0] as PromiseRejectedResult).reason,
              observedAt: now(),
            };
      if (!result.ok && result.observedAt < deadlineAt) {
        // Preserve the exact callback failure even if later cleanup stops global admission.
        results[entry.index] = rejected(entry.index, result.reason);
      } else if (halted) {
        results[entry.index] = rejected(entry.index, haltedReason);
      } else if (result.ok) {
        results[entry.index] = { status: "fulfilled", value: result.value };
      } else {
        halt(new Error("Isolation rerun work cutoff reached"), "deadline");
        results[entry.index] = rejected(entry.index, haltedReason);
      }
    } catch (reason) {
      if (!hardExpired && !halted && now() >= deadlineAt)
        halt(new Error("Isolation rerun work cutoff reached"), "deadline");
      if (!hardExpired)
        results[entry.index] = rejected(
          entry.index,
          haltedReason ?? fatalReason ?? reason,
        );
    } finally {
      if (!hardExpired) {
        for (const owner of entryOwners) ownerEntry.delete(owner);
        owners.delete(entry.index);
        ownerStops.delete(entry.index);
        active.delete(entry.index);
        completed++;
        finishedCount++;
        report("finished", phase, entry.file);
      }
    }
    return true;
  };

  const exclusiveEntries = entries.filter((item) => EXCLUSIVE.has(item.file));
  const queue = entries.filter((item) => !EXCLUSIVE.has(item.file));
  const parallelWorker = async () => {
    for (;;) {
      if (!checkOpen()) return;
      const entry = queue.shift();
      if (entry === undefined) return;
      await visit(entry, "parallel");
      if (hardExpired || halted) return;
    }
  };
  const allWorkers = (async () => {
    for (const entry of exclusiveEntries) {
      if (!checkOpen()) return;
      await visit(entry, "exclusive");
      if (hardExpired || halted) return;
    }
    await Promise.all(
      Array.from({ length: Math.min(workers, queue.length) }, () =>
        parallelWorker(),
      ),
    );
  })();
  void allWorkers.catch(() => undefined);
  await Promise.race([allWorkers, hardSignal]);
  if (!hardExpired && !halted && now() >= deadlineAt)
    halt(new Error("Isolation rerun work cutoff reached"), "deadline");
  if (!hardExpired && now() >= hardDeadlineAt) {
    if (active.size > 0) expireHardDeadline(localObligations.size);
  }

  if (hardExpired) {
    for (const entry of entries) {
      if (results[entry.index] !== undefined) continue;
      if (pending.delete(entry.index)) {
        results[entry.index] = rejected(
          entry.index,
          new IsolationUnstartedError(entry.file, entry.index, "deadline"),
        );
        unstartedCount++;
        completed++;
        continue;
      }
      const prior = callbackOutcomes.get(entry.index);
      const record = failureRecords.get(entry.index);
      const reason =
        prior && !prior.ok && prior.observedAt < deadlineAt
          ? prior.reason
          : record?.hasPrimary
            ? record.primary
            : hardDeadlineError;
      results[entry.index] = rejected(entry.index, reason);
    }
    report("incomplete", "deadline", null);
  } else {
    if (halted) {
      const kind = haltKind ?? "deadline";
      for (const entry of entries) {
        if (!pending.delete(entry.index)) continue;
        results[entry.index] = rejected(
          entry.index,
          new IsolationUnstartedError(entry.file, entry.index, kind),
        );
        completed++;
        unstartedCount++;
        report("unstarted", "deadline", entry.file);
      }
    }
    report("complete", "complete", null);
  }
  if (hardTimer) clearTimeout(hardTimer);
  if (softTimer) clearTimeout(softTimer);
  options.signal?.removeEventListener("abort", externalAbort);
  return results.map(
    (result, index): IsolationSettlement<T> =>
      result ??
      rejected(
        index,
        new IsolationUnstartedError(
          entries[index]?.file ?? "unknown",
          index,
          "deadline",
        ),
      ),
  );
}
