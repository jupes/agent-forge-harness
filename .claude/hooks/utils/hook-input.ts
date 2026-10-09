/**
 * Reading the JSON a hook receives on stdin.
 *
 * The host pipes one JSON object to every hook command. A hook must never
 * hang or crash the session over it, so the read is bounded in time (and in
 * size, when the caller asks) and a terminal is never read. `readHookStdin` says what stdin held;
 * `readHookInput` is the same read for hooks that treat anything unusable as
 * "no input".
 */

import type { HookInput } from "../../../scripts/ledger/hook-events";

export type { HookInput };

type Env = Readonly<Record<string, string | undefined>>;

/** How long a hook waits for stdin before carrying on without it. */
const STDIN_WAIT_MS = 500;

/**
 * True inside a headless child an adapter spawned. The adapter records that
 * child's events itself, so its hooks must not record them a second time.
 */
export function isAdapterChild(env: Env = process.env): boolean {
  return env.AGENT_FORGE_ADAPTER === "1";
}

export type SessionHookEvent = "SessionStart" | "SessionEnd";

function isSessionHookEvent(value: unknown): value is SessionHookEvent {
  return value === "SessionStart" || value === "SessionEnd";
}

/**
 * Which session event a run of the session script is for, and who said so.
 * The host's payload wins; without one that names the event (stdin missing,
 * late or unreadable) the event named on the command line is used, so a
 * registration that passes it can never have its SessionEnd mistaken for a
 * start. With neither, the script was run by hand and acts as SessionStart.
 */
export function sessionEventOf(
  input: HookInput | null,
  argv: readonly string[],
): { event: SessionHookEvent; source: "stdin" | "argv" | "default" } {
  const named = input?.hook_event_name;
  if (isSessionHookEvent(named)) return { event: named, source: "stdin" };
  const token = argv.find(isSessionHookEvent);
  if (token !== undefined) return { event: token, source: "argv" };
  return { event: "SessionStart", source: "default" };
}

/** Where the payload is read from. Replaced in tests; a hook uses its own stdin. */
export interface HookStdinSource {
  isTTY?: boolean;
  stream(): ReadableStream<Uint8Array>;
}

/**
 * What stdin amounted to. `none` is not an error: a terminal (the script was
 * run by hand), a pipe that closed empty, or one that stayed silent for the
 * whole wait. `malformed` is input that arrived and cannot be a payload.
 */
export type HookStdin =
  | { kind: "none"; reason: "terminal" | "empty" | "silent" }
  | { kind: "payload"; input: HookInput }
  | { kind: "malformed"; error: string };

function isHookInput(value: unknown): value is HookInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object in `text`, or null when it is empty, not JSON, or not an object. */
export function parseHookInput(text: string): HookInput | null {
  if (text.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isHookInput(value) ? value : null;
  } catch {
    return null;
  }
}

const processStdin: HookStdinSource = {
  get isTTY() {
    return process.stdin.isTTY;
  },
  stream: () => Bun.stdin.stream(),
};

/**
 * Read stdin once, within a bound on time, and say what it held. A terminal
 * is never read. `maxBytes` bounds the size for a caller whose payloads are
 * small; without it the payload is read whole (a tool call's payload carries
 * the tool's output). A read that outlives the wait is abandoned, so the
 * caller should end with `process.exit`. Rejects only if the source itself
 * throws.
 */
export async function readHookStdin(
  opts: { waitMs?: number; maxBytes?: number; source?: HookStdinSource } = {},
): Promise<HookStdin> {
  const source = opts.source ?? processStdin;
  if (source.isTTY) return { kind: "none", reason: "terminal" };
  const waitMs = opts.waitMs ?? STDIN_WAIT_MS;
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;

  const reader = source.stream().getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  let text = "";
  let bytes = 0;
  let closed = false;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "timeout") break;
      if (next.done) {
        closed = true;
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        return {
          kind: "malformed",
          error: `stdin is larger than ${maxBytes} bytes`,
        };
      }
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Not awaited: cancelling a pipe nobody closes may itself never settle.
    void reader.cancel().catch(() => undefined);
  }
  text += decoder.decode();

  if (text.trim().length === 0) {
    return { kind: "none", reason: closed ? "empty" : "silent" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      kind: "malformed",
      error: closed
        ? "stdin is not valid JSON"
        : `stdin did not close within ${waitMs} ms and held incomplete JSON`,
    };
  }
  return isHookInput(value)
    ? { kind: "payload", input: value }
    : { kind: "malformed", error: "stdin is not a JSON object" };
}

/**
 * The hook payload on stdin, or null when there is none: a terminal (the
 * script was run by hand), nothing within the wait, or unusable content.
 * Never throws. A read that outlives the wait is abandoned, so the caller
 * should end with `process.exit`.
 */
export async function readHookInput(
  opts: { waitMs?: number; source?: HookStdinSource } = {},
): Promise<HookInput | null> {
  try {
    const read = await readHookStdin(opts);
    return read.kind === "payload" ? read.input : null;
  } catch {
    return null;
  }
}
