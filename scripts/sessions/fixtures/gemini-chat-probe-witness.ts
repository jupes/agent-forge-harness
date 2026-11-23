import { existsSync, readFileSync } from "node:fs";
import { writeWhole } from "../../executors/fixtures/write-whole";

type ReadProbeFile = (path: string) => string | undefined;
const readProbeFile: ReadProbeFile = (path) =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;

function ownedNonce(nonce: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      nonce,
    )
  )
    throw Error("Invalid owned help-probe nonce");
}

function readyPath(log: string, nonce: string): string {
  ownedNonce(nonce);
  return `${log}.help-ready-${nonce}`;
}

/** Published once, after aggregate recording has finished, and never replaced. */
export function publishHelpEntry(
  log: string,
  nonce: string,
  pid: number,
): void {
  const path = readyPath(log, nonce);
  if (existsSync(path)) throw Error("The help-probe witness already exists");
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw Error("Invalid owned help-probe process witness");
  writeWhole(path, JSON.stringify({ kind: "help", nonce, pid }));
}

export function probeFailureMetadata(
  stage: "version" | "help",
  error: unknown,
): { stage: "version" | "help"; code: string } {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  return {
    stage,
    code:
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)
        ? code
        : "UNKNOWN",
  };
}

/** Failure-only context; no message, path, prompt or provider output is retained. */
export function publishProbeFailure(
  log: string,
  nonce: string,
  stage: "version" | "help",
  error: unknown,
): void {
  ownedNonce(nonce);
  const path = `${log}.probe-failure-${nonce}`;
  if (existsSync(path)) return;
  writeWhole(path, JSON.stringify(probeFailureMetadata(stage, error)));
}

export function readProbeFailure(
  log: string,
  nonce: string,
): { stage: "version" | "help" | "unknown"; code: string } {
  ownedNonce(nonce);
  try {
    const text = readProbeFile(`${log}.probe-failure-${nonce}`);
    if (text !== undefined && Buffer.byteLength(text) <= 512) {
      const value: unknown = JSON.parse(text);
      if (
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 2 &&
        "stage" in value &&
        (value.stage === "version" || value.stage === "help") &&
        "code" in value
      )
        return probeFailureMetadata(value.stage, value);
    }
  } catch {
    // A failed diagnostic cannot replace the original owned run's refusal.
  }
  return { stage: "unknown", code: "UNRECORDED" };
}

/** The original supervised run bounds readiness; no second deadline is invented here. */
export async function heldHelpEntry(
  log: string,
  nonce: string,
  original: Promise<unknown>,
  read: ReadProbeFile = readProbeFile,
): Promise<{ pid: number }> {
  const path = readyPath(log, nonce),
    controller = new AbortController();
  const waiting = (async () => {
    while (!controller.signal.aborted) {
      const text = read(path);
      if (text !== undefined) {
        let value: unknown;
        try {
          if (Buffer.byteLength(text) > 512) throw Error();
          value = JSON.parse(text);
        } catch {
          throw Error("Invalid owned help-probe witness");
        }
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          Object.keys(value).length !== 3 ||
          !("kind" in value) ||
          value.kind !== "help" ||
          !("nonce" in value) ||
          !("pid" in value)
        )
          throw Error("Invalid owned help-probe witness");
        if (value.nonce === nonce) {
          const pid = value.pid;
          if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
            throw Error("Invalid owned help-probe process witness");
          return { pid };
        }
      }
      await Bun.sleep(10);
    }
    return null;
  })();
  try {
    const entry = await Promise.race([
      waiting,
      original.then(() => {
        throw Error(
          "The original run settled before its held help-probe entry",
        );
      }),
    ]);
    if (!entry) throw Error("The help-probe witness was cancelled");
    return entry;
  } finally {
    controller.abort();
    await waiting;
  }
}
