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

interface ProcessGroupHost {
  platform: NodeJS.Platform;
  probe(group: number): void;
  entries(): Promise<readonly string[]>;
  stat(pid: string, signal: AbortSignal): Promise<string>;
}

export interface ProcessGroupDiagnostic {
  phase:
    | "target"
    | "aborted"
    | "probe"
    | "entries"
    | "entry-limit"
    | "stat"
    | "parse";
}

/** Only the kernel boundary is injected; callers still receive a membership fact, never process bodies. */
export function createProcessGroupObserver(
  host: ProcessGroupHost,
  report?: (fact: ProcessGroupDiagnostic) => void,
) {
  const unknown = (
    phase: ProcessGroupDiagnostic["phase"],
  ): ProcessGroupState => {
    try {
      report?.({ phase });
    } catch {
      // Diagnostic persistence must never change the ownership refusal.
    }
    return "unknown";
  };
  return async (
    group: number,
    signal: AbortSignal,
  ): Promise<ProcessGroupState> => {
    // -1 names every permitted process, not process group one.
    if (!Number.isSafeInteger(group) || group < 2) return unknown("target");
    if (signal.aborted) return unknown("aborted");
    // Signal zero sends nothing. ESRCH is a direct kernel absence witness;
    // a present Linux group still needs zombie-aware membership verification.
    try {
      host.probe(group);
    } catch (error) {
      if (signal.aborted) return unknown("aborted");
      return error instanceof Error && "code" in error && error.code === "ESRCH"
        ? "inactive"
        : unknown("probe");
    }
    if (signal.aborted) return unknown("aborted");
    if (host.platform !== "linux") return "active";
    let phase: "entries" | "stat" = "entries";
    try {
      const entries = (await host.entries()).filter((entry) =>
        /^\d+$/.test(entry),
      );
      if (signal.aborted) return unknown("aborted");
      if (entries.length > MAX_PROC_ENTRIES) return unknown("entry-limit");
      phase = "stat";
      for (let index = 0; index < entries.length; index += 64) {
        if (signal.aborted) return unknown("aborted");
        const stats = await Promise.all(
          entries.slice(index, index + 64).map(async (pid) => {
            try {
              return await host.stat(pid, signal);
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
        if (signal.aborted) return unknown("aborted");
        const state = linuxProcessGroupState(
          group,
          stats.filter((stat) => stat !== null),
        );
        if (state === "unknown") return unknown("parse");
        if (state !== "inactive") return state;
      }
      return "inactive";
    } catch {
      return unknown(signal.aborted ? "aborted" : phase);
    }
  };
}

/** Read only kernel membership metadata; never commands, environment or provider bodies. */
export const observeOwnedProcessGroup = createProcessGroupObserver(
  {
    platform: process.platform,
    probe(group) {
      process.kill(-group, 0);
    },
    entries: () => readdir("/proc"),
    stat: (pid, signal) =>
      readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal }),
  },
  (fact) => console.error(`[owned-process-group] ${JSON.stringify(fact)}`),
);

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
