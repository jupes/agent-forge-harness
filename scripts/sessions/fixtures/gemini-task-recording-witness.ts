import { existsSync, readFileSync } from "node:fs";
import { writeWhole } from "../../executors/fixtures/write-whole";

type ReadWitness = (path: string) => string | undefined;
const readWitness: ReadWitness = (path) =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;

function readyPath(log: string): string {
  return `${log}.help-ready`;
}

/** Publish only after the complete help JSONL append has returned. */
export function publishGeminiTaskHelp(log: string, pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw Error("Invalid Gemini task help witness process identity");
  const path = readyPath(log);
  if (existsSync(path)) throw Error("Gemini task help witness already exists");
  writeWhole(path, JSON.stringify({ kind: "help", pid }));
}

/** Wait on the atomic marker; callers parse the strict aggregate log afterward. */
export async function heldGeminiTaskHelp(
  log: string,
  original: Promise<unknown>,
  read: ReadWitness = readWitness,
): Promise<{ pid: number }> {
  const path = readyPath(log),
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
          throw Error("Invalid Gemini task help witness");
        }
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          Object.keys(value).length !== 2 ||
          !("kind" in value) ||
          value.kind !== "help" ||
          !("pid" in value) ||
          typeof value.pid !== "number" ||
          !Number.isSafeInteger(value.pid) ||
          value.pid <= 0
        )
          throw Error("Invalid Gemini task help witness");
        return { pid: value.pid };
      }
      await Bun.sleep(10);
    }
    return null;
  })();
  try {
    const entry = await Promise.race([
      waiting,
      original.then(() => {
        throw Error("Gemini task preparation settled before help publication");
      }),
    ]);
    if (!entry) throw Error("Gemini task help witness was cancelled");
    return entry;
  } finally {
    controller.abort();
    await waiting;
  }
}
