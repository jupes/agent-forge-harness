import { readdir, readFile } from "node:fs/promises";

export type ProcessGroupState = "active" | "inactive" | "unknown";

/** Cleanup has its own fixed bound after the reviewed work timer has ended. */
export const PROCESS_GROUP_CLEANUP_MS = 1000;
const MAX_PROC_ENTRIES = 65_536;

export function linuxProcessGroupState(
  group: number,
  stats: readonly string[],
): ProcessGroupState {
  if (!Number.isSafeInteger(group) || group < 1) return "unknown";
  for (const stat of stats) {
    // comm can contain spaces and closing parentheses; the final delimiter wins.
    const delimiter = stat.lastIndexOf(") ");
    const fields = stat.slice(delimiter + 2).split(" ");
    const state = fields[0];
    const memberGroup = fields[2];
    if (
      delimiter < 0 ||
      !state ||
      !/^[A-Za-z]$/.test(state) ||
      !memberGroup ||
      !/^\d+$/.test(memberGroup)
    )
      return "unknown";
    if (Number(memberGroup) === group && state !== "Z") return "active";
  }
  return "inactive";
}

/** Read only the kernel's membership metadata; no command, environment or provider body is read. */
export async function observeOwnedProcessGroup(
  group: number,
  signal: AbortSignal,
): Promise<ProcessGroupState> {
  if (!Number.isSafeInteger(group) || group < 1 || signal.aborted)
    return "unknown";
  if (process.platform !== "linux") {
    try {
      process.kill(-group, 0);
      return "active";
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ESRCH"
        ? "inactive"
        : "unknown";
    }
  }
  try {
    const entries = (await readdir("/proc")).filter((entry) =>
      /^\d+$/.test(entry),
    );
    if (entries.length > MAX_PROC_ENTRIES) return "unknown";
    for (let index = 0; index < entries.length; index += 64) {
      if (signal.aborted) return "unknown";
      const stats = await Promise.all(
        entries.slice(index, index + 64).map(async (pid) => {
          try {
            return await readFile(`/proc/${pid}/stat`, {
              encoding: "utf8",
              signal,
            });
          } catch (error) {
            // A process disappearing during the read is already inactive.
            if (
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ESRCH")
            )
              return null;
            throw error;
          }
        }),
      );
      const state = linuxProcessGroupState(
        group,
        stats.filter((stat) => stat !== null),
      );
      if (state !== "inactive") return state;
    }
    return "inactive";
  } catch {
    return "unknown";
  }
}

/**
 * A kill signal is a request, not an exit witness. The observer is read-only;
 * a timed-out or unreadable observation cannot later confirm completion.
 */
export function waitForOwnedProcessGroup(
  observe: (signal: AbortSignal) => Promise<ProcessGroupState>,
  deadlineMs = PROCESS_GROUP_CLEANUP_MS,
): Promise<void> {
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > PROCESS_GROUP_CLEANUP_MS
  )
    throw new Error("Invalid owned process group cleanup bound.");
  const controller = new AbortController();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      controller.abort();
      if (confirmed) resolve();
      else
        reject(
          new Error("Owned process group cleanup could not be confirmed."),
        );
    };
    const deadline = setTimeout(() => finish(false), deadlineMs);
    const observeUntilInactive = async () => {
      while (!controller.signal.aborted) {
        const state = await observe(controller.signal);
        if (controller.signal.aborted) return;
        if (state === "inactive") return finish(true);
        if (state === "unknown") return finish(false);
        await Bun.sleep(10);
      }
    };
    void observeUntilInactive().catch(() => finish(false));
  });
}
