/**
 * Reading the JSON a hook receives on stdin.
 *
 * The host pipes one JSON object to every hook command. A hook must never
 * hang or crash the session over it, so the read gives up after a bound, a
 * terminal is never read, and anything that is not a JSON object reads as
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

/** The object in `text`, or null when it is empty, not JSON, or not an object. */
export function parseHookInput(text: string): HookInput | null {
  if (text.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    // justification: a non-null, non-array object is a record of unknown fields.
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as HookInput)
      : null;
  } catch {
    return null;
  }
}

/**
 * The hook payload on stdin, or null when there is none: a terminal (the
 * script was run by hand), nothing within the wait, or unusable content.
 * Never throws. A read that outlives the wait is abandoned, so the caller
 * should end with `process.exit`.
 */
export async function readHookInput(
  opts: { waitMs?: number } = {},
): Promise<HookInput | null> {
  if (process.stdin.isTTY) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.waitMs ?? STDIN_WAIT_MS);
    });
    const text = await Promise.race([Bun.stdin.text(), timeout]);
    return text === null ? null : parseHookInput(text);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
