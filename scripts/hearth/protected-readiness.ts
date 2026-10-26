export interface ProtectedReadinessIdentity {
  pid: number;
  url: string;
  token: string;
}

export type ProtectedReadinessProbe<T> =
  | { kind: "ready"; status: 200 | 404; value: T }
  | { kind: "refused"; status: number; publicError?: string };

/**
 * Wait for the published process generation to answer one protected read.
 * A 403 only triggers a fresh lock/token read; it never retries a write.
 */
export async function waitForProtectedReadiness<T>(options: {
  expectedPid: number;
  readIdentity(): ProtectedReadinessIdentity | null;
  probe(
    identity: ProtectedReadinessIdentity,
  ): Promise<ProtectedReadinessProbe<T>>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{ identity: ProtectedReadinessIdentity; value: T }> {
  const timeoutMs = options.timeoutMs ?? 10_000,
    intervalMs = options.intervalMs ?? 50,
    deadline = options.now() + timeoutMs;
  let lastStatus: number | null = null,
    observedExpectedPid = false;
  for (;;) {
    const remaining = deadline - options.now();
    if (remaining <= 0) break;
    const identity = options.readIdentity();
    if (identity !== null && identity.pid === options.expectedPid)
      observedExpectedPid = true;
    if (
      identity !== null &&
      observedExpectedPid &&
      identity.pid !== options.expectedPid
    )
      throw new Error("The published server process changed during readiness.");
    if (
      identity !== null &&
      identity.pid === options.expectedPid &&
      identity.url &&
      identity.token
    ) {
      let outcome: ProtectedReadinessProbe<T>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        outcome = await Promise.race([
          options.probe(identity),
          new Promise<never>(
            (_resolve, reject) =>
              (timer = setTimeout(
                () => reject(new Error("probe deadline")),
                Math.max(1, remaining),
              )),
          ),
        ]);
      } catch {
        if (options.now() >= deadline)
          throw new Error("The protected readiness read timed out.");
        throw new Error("The protected readiness read could not be completed.");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (outcome.kind === "ready") return { identity, value: outcome.value };
      lastStatus = outcome.status;
      if (outcome.status !== 403) {
        const message = outcome.publicError
          ?.replaceAll(identity.token, "[redacted]")
          ?.split("")
          .map((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127 ? " " : character;
          })
          .join("")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        throw new Error(
          `The protected readiness read returned HTTP ${outcome.status}${message ? `: ${message}` : ""}.`,
        );
      }
    }
    await options.sleep(
      Math.min(intervalMs, Math.max(0, deadline - options.now())),
    );
  }
  throw new Error(
    `The protected readiness read did not succeed before its ${timeoutMs} ms deadline${lastStatus === null ? "" : ` (last HTTP ${lastStatus})`}.`,
  );
}
