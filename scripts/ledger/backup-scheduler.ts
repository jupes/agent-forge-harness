import type { LedgerBackupSchedule } from "../desktop/app-hearth-protocol";
import { backupLedger } from "./backup";

export interface LedgerBackupClock {
  now(): number;
  setTimer(run: () => void, delayMs: number): () => void;
}
interface Options {
  /** Captured by the owning Hearth, never supplied by a request. */
  path: string;
  clock?: LedgerBackupClock | undefined;
  /** Trusted synchronous test seam; production uses the throwing snapshot owner. */
  backup?: (options: { path: string; now(): Date }) => void;
}
const nextMidnight = (now: number) => {
  const date = new Date(now);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
};

/** Construction is inert. An owned Hearth activates one timer and stops it before closing. */
export function createLedgerBackupScheduler(options: Options) {
  const path = options.path;
  const backup = options.backup ?? backupLedger;
  const clock: LedgerBackupClock = options.clock ?? {
    now: Date.now,
    setTimer(run, delay) {
      const timer = setTimeout(run, delay);
      timer.unref();
      return () => clearTimeout(timer);
    },
  };
  let phase: LedgerBackupSchedule["phase"] = "inactive";
  let next: number | null = null;
  let lastAttempt: LedgerBackupSchedule["lastAttempt"] = null;
  let latestAttemptDay = "";
  let generation = 0;
  let cancel: (() => void) | null = null;

  function arm() {
    if (phase !== "scheduled" || next === null) return;
    const current = ++generation;
    // Recheck the wall clock at least once a minute, including sleep and clock changes.
    cancel = clock.setTimer(
      wake,
      Math.max(1, Math.min(60_000, next - clock.now())),
    );
    function wake() {
      if (phase !== "scheduled" || generation !== current || next === null)
        return;
      cancel = null;
      const now = clock.now();
      const at = new Date(now).toISOString();
      const day = at.slice(0, 10);
      if (now >= next && day > latestAttemptDay) {
        // Spend this observed day before publication. No automatic same-day retry on unknown outcomes.
        latestAttemptDay = day;
        let outcome: "completed" | "unconfirmed" = "unconfirmed";
        try {
          backup({ path, now: () => new Date(now) });
          outcome = "completed";
        } catch {
          // Retention may fail after the snapshot was published. No raw error leaves this boundary.
        }
        lastAttempt = { startedAt: at, outcome };
      }
      if (phase === "scheduled") {
        next = Math.max(
          nextMidnight(now),
          latestAttemptDay
            ? nextMidnight(Date.parse(latestAttemptDay + "T00:00:00.000Z"))
            : 0,
        );
        arm();
      }
    }
  }
  return {
    start() {
      if (phase !== "inactive") return;
      phase = "scheduled";
      next = nextMidnight(clock.now());
      arm();
    },
    stop() {
      phase = "stopped";
      next = null;
      generation++;
      cancel?.();
      cancel = null;
    },
    read(): LedgerBackupSchedule {
      return {
        phase,
        nextAttemptAt: next === null ? null : new Date(next).toISOString(),
        lastAttempt: lastAttempt ? { ...lastAttempt } : null,
      };
    },
  };
}
