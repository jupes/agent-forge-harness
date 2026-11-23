export interface ProtectedReadinessIdentity {
  pid: number;
  url: string;
  token: string;
}

export type ProtectedReadinessProbe<T> =
  | { kind: "ready"; status: 200 | 404; value: T }
  | { kind: "refused"; status: number; publicError?: string };

export function sanitizeProtectedReadinessError(
  value: string | undefined,
  token: string,
): string | undefined {
  if (value === undefined) return undefined;
  return value
    .replaceAll(token, "[redacted]")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export async function readProtectedResponseBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  if (signal.aborted) throw new Error("The protected response was aborted.");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        reject(new Error("The protected response was aborted."));
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (signal.aborted)
        throw new Error("The protected response was aborted.");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(
          "The protected response exceeded its diagnostic bound.",
        );
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    try {
      reader.releaseLock();
    } catch {
      /* A cancelled stream may already have released its reader. */
    }
  }
}

/**
 * Wait for the published process generation to answer one protected read.
 * A 403 only triggers a fresh lock/token read; it never retries a write.
 */
export async function waitForProtectedReadiness<T>(options: {
  expectedPid: number;
  readIdentity(): ProtectedReadinessIdentity | null;
  probe(
    identity: ProtectedReadinessIdentity,
    signal: AbortSignal,
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
    lastPublicError: string | undefined,
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
      const controller = new AbortController();
      let deadlineExpired = false;
      try {
        outcome = await Promise.race([
          options.probe(identity, controller.signal),
          new Promise<never>(
            (_resolve, reject) =>
              (timer = setTimeout(
                () => {
                  deadlineExpired = true;
                  controller.abort();
                  reject(new Error("probe deadline"));
                },
                Math.max(1, remaining),
              )),
          ),
        ]);
      } catch {
        if (deadlineExpired || options.now() >= deadline)
          throw new Error(
            `The protected readiness read timed out${lastStatus === null ? "" : ` (last HTTP ${lastStatus}${lastPublicError ? `: ${lastPublicError}` : ""})`}.`,
          );
        throw new Error("The protected readiness read could not be completed.");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (outcome.kind === "ready") return { identity, value: outcome.value };
      lastStatus = outcome.status;
      lastPublicError = sanitizeProtectedReadinessError(
        outcome.publicError,
        identity.token,
      );
      if (outcome.status !== 403) {
        throw new Error(
          `The protected readiness read returned HTTP ${outcome.status}${lastPublicError ? `: ${lastPublicError}` : ""}.`,
        );
      }
    }
    await options.sleep(
      Math.min(intervalMs, Math.max(0, deadline - options.now())),
    );
  }
  throw new Error(
    `The protected readiness read did not succeed before its ${timeoutMs} ms deadline${lastStatus === null ? "" : ` (last HTTP ${lastStatus}${lastPublicError ? `: ${lastPublicError}` : ""})`}.`,
  );
}
