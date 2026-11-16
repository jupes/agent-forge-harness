type FailureFacts = { category: string; errorName: string; errorCode: string };
const categories = new Map([
  [
    "Owned process group cleanup could not be confirmed.",
    "owned-process-group-unconfirmed",
  ],
  [
    "Windows owned process cleanup could not be confirmed.",
    "windows-owned-process-unconfirmed",
  ],
  [
    "The private interactive terminal could not be confirmed.",
    "interactive-terminal-unconfirmed",
  ],
]);
const codes = new Set([
  "EACCES",
  "EPERM",
  "ENOENT",
  "ESRCH",
  "EPIPE",
  "EBADF",
  "EINVAL",
]);
function project(error: unknown): FailureFacts {
  try {
    if (
      (typeof error !== "object" && typeof error !== "function") ||
      error === null
    )
      return { category: "other", errorName: "other", errorCode: "none" };
    const own = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const message = own("message"),
      code = own("code");
    return {
      category:
        typeof message === "string" && message.length <= 160
          ? (categories.get(message) ?? "other")
          : "other",
      errorName:
        error instanceof TypeError
          ? "TypeError"
          : error instanceof RangeError
            ? "RangeError"
            : error instanceof SyntaxError
              ? "SyntaxError"
              : error instanceof Error
                ? "Error"
                : "other",
      errorCode:
        code === undefined
          ? "none"
          : typeof code === "string" && code.length <= 16 && codes.has(code)
            ? code
            : "other",
    };
  } catch {
    return {
      category: "unavailable",
      errorName: "unavailable",
      errorCode: "unavailable",
    };
  }
}
/** Test-only metadata; never retains provider errors, bodies, IDs or paths. */
export function createKeeperTransportFailureWitness() {
  let calls = 0;
  let state: "not-entered" | "entered" | "returned" | "threw" = "not-entered";
  let failure: FailureFacts | null = null;
  return {
    async observe<T>(invoke: () => Promise<T>): Promise<T> {
      calls = Math.min(256, calls + 1);
      state = "entered";
      failure = null;
      try {
        const result = await invoke();
        state = "returned";
        return result;
      } catch (error) {
        failure = project(error);
        state = "threw";
        throw error;
      }
    },
    facts() {
      return {
        calls,
        state: calls > 1 ? "ambiguous" : state,
        failure: calls === 1 && failure ? { ...failure } : null,
      };
    },
  };
}
