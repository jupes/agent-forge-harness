const reservationBrand: unique symbol = Symbol("workspace-read-reservation");

/** Opaque unit token only; this type grants no workspace or source authority. */
export type WorkspaceReadReservation = Readonly<{
  [reservationBrand]: true;
}>;

export function createWorkspaceReadReservation(): WorkspaceReadReservation {
  const reservation: WorkspaceReadReservation = { [reservationBrand]: true };
  return Object.freeze(reservation);
}

export type WorkspaceReadEvent = "open" | "close" | "loss" | "error";

/** These generic parts are unit payloads, not validated identity or authority. */
export type WorkspaceReadParts<T> = Readonly<{
  identity: T;
  issues: T;
  durableLabels: T;
  wispLabels: T;
  dependencies: T;
}>;

export type WorkspaceReadOutcome<T> =
  | Readonly<{ kind: "read"; parts: WorkspaceReadParts<T> }>
  | Readonly<{ kind: "unavailable" }>;

export interface WorkspaceReadPort<T> {
  /** Installs a listener and returns a synchronous local unsubscriber. */
  subscribe(listener: (event: WorkspaceReadEvent) => void): () => void;
  reserveOnce(): Promise<WorkspaceReadReservation | null>;
  readIdentity(reservation: WorkspaceReadReservation): Promise<T>;
  readIssues(reservation: WorkspaceReadReservation): Promise<T>;
  readDurableLabels(reservation: WorkspaceReadReservation): Promise<T>;
  readWispLabels(reservation: WorkspaceReadReservation): Promise<T>;
  readDependencies(reservation: WorkspaceReadReservation): Promise<T>;
  closeLocally(reservation: WorkspaceReadReservation): Promise<void>;
}

type StepResult<T> =
  | Readonly<{ kind: "value"; value: T }>
  | Readonly<{ kind: "invalid" }>;

export async function readReservedWorkspaceProjection<T>(
  port: WorkspaceReadPort<T>,
): Promise<WorkspaceReadOutcome<T>> {
  let invalid = false;
  let failed = false;
  let cleanupFailed = false;
  let unsubscribe: (() => void) | undefined;
  let reservation: WorkspaceReadReservation | null = null;
  let parts: WorkspaceReadParts<T> | undefined;

  try {
    unsubscribe = port.subscribe((event) => {
      if (event !== "open") invalid = true;
    });
    if (!invalid) {
      reservation = await port.reserveOnce();
      if (invalid || reservation === null) {
        failed = true;
      } else {
        const acquired = reservation;
        const readStep = async <U>(
          read: () => Promise<U>,
        ): Promise<StepResult<U>> => {
          if (invalid) return { kind: "invalid" };
          const value = await read();
          if (invalid) return { kind: "invalid" };
          return { kind: "value", value };
        };
        const identity = await readStep(() => port.readIdentity(acquired));
        if (identity.kind === "value") {
          const issues = await readStep(() => port.readIssues(acquired));
          if (issues.kind === "value") {
            const durableLabels = await readStep(() =>
              port.readDurableLabels(acquired),
            );
            if (durableLabels.kind === "value") {
              const wispLabels = await readStep(() =>
                port.readWispLabels(acquired),
              );
              if (wispLabels.kind === "value") {
                const dependencies = await readStep(() =>
                  port.readDependencies(acquired),
                );
                if (dependencies.kind === "value") {
                  parts = {
                    identity: identity.value,
                    issues: issues.value,
                    durableLabels: durableLabels.value,
                    wispLabels: wispLabels.value,
                    dependencies: dependencies.value,
                  };
                }
              }
            }
          }
        }
      }
    } else {
      failed = true;
    }
  } catch {
    failed = true;
  }

  if (reservation !== null) {
    try {
      await port.closeLocally(reservation);
      if (invalid) failed = true;
    } catch {
      cleanupFailed = true;
    }
  }
  if (unsubscribe !== undefined) {
    try {
      unsubscribe();
      if (invalid) failed = true;
    } catch {
      cleanupFailed = true;
    }
  }

  if (invalid || failed || cleanupFailed || parts === undefined) {
    return { kind: "unavailable" };
  }
  return { kind: "read", parts };
}
