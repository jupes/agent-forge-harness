/**
 * The shifts a hearth starts (`POST /shifts`, `x1gs.5.4.5`): each is
 * `bun scripts/scheduler/shift-cli.ts run --id <id> [flags]` as a child the
 * hearth supervises, never a shell, in the hearth's root and with the hearth's
 * environment and `AGENT_FORGE_HOME` set to the hearth's home, so the shift
 * takes the same queue lock and writes the same ledger and shifts directory
 * the hearth reads. `supervise` (`scripts/executors/supervisor.ts`) keeps the
 * child from outliving the hearth: its exit hook, and its tree guard for a
 * hearth killed outright. No time limit is set: the shift's own deadline ends
 * it.
 *
 * What the hearth knows of a shift it started is held here, in memory, for as
 * long as the hearth runs:
 * - Until its record exists (`<home>/shifts/<id>.json`, written once the base
 *   is fetched) it is `starting`. `GET /shifts` lists it so, a second start is
 *   refused, and a stop or a recover of it is refused (there is nothing to
 *   stop or give back yet).
 * - Once its record exists, the record is what is listed, as for a shift the
 *   CLI started.
 * - A child that exits with no record is `failed`: the error the shift printed
 *   (its `{ ok: false, error }` envelope on stdout), else the end of its
 *   stderr, secrets redacted and bounded, with its exit code. The newest
 *   `KEPT_FAILED_LAUNCHES` are listed; nothing of a launch outlives the hearth.
 *
 * `close()` (the hearth's own) asks every shift it started that is still
 * running to stop, as `POST /shifts/:id/stop` does, as soon as its record
 * exists, waits up to `SHIFT_STOP_GRACE_MS` for each to exit, and then ends
 * what is left with its process tree. A shift ended that way leaves its beads
 * `running` and its record `running`; `forge:shift recover` gives them back.
 */

import { resolve } from "node:path";
import { supervise } from "../executors/supervisor";
import {
  mintShiftId,
  readShiftRecord,
  requestStop,
  shiftIdInUse,
} from "../scheduler/shift-store";
import { redactSecrets } from "../secret-patterns";
import { safeMessage } from "./api";

/** The script a hearth starts a shift with: `forge:shift`. */
export const SHIFT_CLI = resolve(
  import.meta.dir,
  "..",
  "scheduler",
  "shift-cli.ts",
);

/** How long `close()` waits for the shifts it asked to stop before it ends them. */
export const SHIFT_STOP_GRACE_MS = 30_000;

/** How many launches that failed before writing a record `GET /shifts` keeps listing. */
export const KEPT_FAILED_LAUNCHES = 20;

/** How much of a child's stdout is kept: the end, where the shift prints its envelope. */
const STDOUT_TAIL_CHARS = 16_000;

/** The longest error a failed launch is listed with. */
const ERROR_CHARS = 500;

/** How often `close()` looks for a record to ask to stop, and for the children to have gone. */
const CLOSE_POLL_MS = 100;

/** What starting a shift is: an argument array, never a shell. */
export interface ShiftLaunchSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/** How a started shift's process ended. */
export interface ShiftChildExit {
  /** Null when it was ended by a signal or killed. */
  exitCode: number | null;
  /** The end of what it printed on stdout. */
  stdout: string;
  /** The end of what it printed on stderr. */
  stderr: string;
}

/** A started shift's process. */
export interface LaunchedShiftChild {
  pid: number;
  /** Resolves once it has exited. */
  done: Promise<ShiftChildExit>;
  /** End it and its process tree; resolves once it has exited. */
  stop(): Promise<void>;
}

/** Starts the child; throws when it could not be started. */
export type ShiftLauncher = (spec: ShiftLaunchSpec) => LaunchedShiftChild;

/** The real launcher: the child under `supervise`, with no time limit. */
export function superviseShift(spec: ShiftLaunchSpec): LaunchedShiftChild {
  let stdout = "";
  const child = supervise({
    command: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    onLine: (line) => {
      stdout = `${stdout}${line}\n`.slice(-STDOUT_TAIL_CHARS);
    },
  });
  return {
    pid: child.pid,
    done: child.done.then((exit) => ({
      exitCode: exit.exitCode,
      stdout,
      stderr: exit.stderr,
    })),
    stop: () => child.stop("the hearth is closing"),
  };
}

/** A shift this hearth started that has no record: still starting, or ended before writing one. */
export interface ShiftLaunchEntry {
  shiftId: string;
  state: "starting" | "failed";
  /** The child the hearth started. */
  pid: number;
  /** Whether that child is still running. */
  alive: boolean;
  workspace: string;
  /** When the hearth started it (ISO 8601). */
  startedAt: string;
  /** The fields the start was given, as given; a field left out took the shift's default. */
  requested: Record<string, unknown>;
  /** Once the child has exited (ISO 8601). */
  endedAt?: string;
  exitCode?: number | null;
  /** Why it ended without a record: what the shift printed, secrets redacted, bounded. */
  error?: string;
}

export interface ShiftStartsDeps {
  /** The hearth's root: the child's working directory. */
  root: string;
  /** The hearth's home: the child's `AGENT_FORGE_HOME`. */
  home: string;
  /** `<home>/shifts`. */
  shiftsDir: string;
  workspace: string;
  /** The hearth's environment, handed to the child with `AGENT_FORGE_HOME` set to `home`. */
  environment: Readonly<Record<string, string | undefined>>;
  launch: ShiftLauncher;
  /** A new shift id; `mintShiftId` at the current second by default. */
  mintShiftId?: (() => string) | undefined;
  stopGraceMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export type StartOutcome =
  | { ok: true; value: ShiftLaunchEntry }
  | { ok: false; kind: "closing" | "failed"; error: string };

export interface ShiftStarts {
  /** A shift id that no record, stop request or launch of this hearth has. */
  mint(): string;
  /** A launch of this hearth that is still starting (its child runs, it has no record yet), or null. */
  starting(): string | null;
  isStarting(shiftId: string): boolean;
  /** Start `forge:shift run --id <shiftId> ...flags`. */
  start(
    shiftId: string,
    flags: readonly string[],
    requested: Record<string, unknown>,
  ): StartOutcome;
  /** This hearth's launches that have no record, newest first. */
  unrecorded(): ShiftLaunchEntry[];
  /** Ask the running ones to stop, wait, end what is left. Starts nothing after it is called. */
  close(): Promise<void>;
}

interface Launch {
  shiftId: string;
  child: LaunchedShiftChild;
  startedAt: string;
  requested: Record<string, unknown>;
  exit?: { exitCode: number | null; endedAt: string; error: string };
  /** Resolves once `exit` is set. */
  ended: Promise<void>;
}

/** The error a shift prints in its envelope (`{ ok: false, error }`), when stdout is one. */
function printedError(stdout: string): string | null {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { ok?: unknown }).ok === false &&
      typeof (value as { error?: unknown }).error === "string"
    )
      return (value as { error: string }).error;
  } catch {
    // Not an envelope: the shift crashed, or was killed, before printing one.
  }
  return null;
}

/** Text made safe to list: secrets redacted, whitespace folded. */
const plain = (text: string): string =>
  redactSecrets(text).text.replace(/\s+/g, " ").trim();

/**
 * Why a shift that wrote no record ended, from what it printed: its own
 * error, else the end of its stderr (without the line that announces the id),
 * else how it exited.
 */
export function launchFailure(exit: ShiftChildExit): string {
  const how =
    exit.exitCode === null
      ? "the shift was ended before it wrote its record"
      : `the shift exited ${exit.exitCode} before it wrote its record`;
  const printed = printedError(exit.stdout);
  if (printed !== null && plain(printed) !== "")
    return `${how}: ${plain(printed)}`.slice(0, ERROR_CHARS);
  const stderr = plain(
    exit.stderr
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('{"shiftId":'))
      .join("\n"),
  );
  if (stderr === "") return how;
  const room = ERROR_CHARS - how.length - 2;
  return `${how}: ${stderr.length > room ? `…${stderr.slice(-(room - 1))}` : stderr}`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export function createShiftStarts(deps: ShiftStartsDeps): ShiftStarts {
  const launches = new Map<string, Launch>();
  const now = deps.now ?? (() => new Date());
  const mint = deps.mintShiftId ?? (() => mintShiftId(now()));
  const graceMs = deps.stopGraceMs ?? SHIFT_STOP_GRACE_MS;
  let closing = false;

  const recorded = (id: string): boolean =>
    readShiftRecord(deps.shiftsDir, id) !== null;

  const startingNow = (launch: Launch): boolean =>
    launch.exit === undefined && !recorded(launch.shiftId);

  /** Drop what no longer needs listing: an ended launch with a record, and failed ones past the newest few. */
  function prune(): void {
    const failed: Launch[] = [];
    for (const launch of launches.values()) {
      if (launch.exit === undefined) continue;
      if (recorded(launch.shiftId)) launches.delete(launch.shiftId);
      else failed.push(launch);
    }
    for (const launch of failed.slice(0, -KEPT_FAILED_LAUNCHES))
      launches.delete(launch.shiftId);
  }

  function entry(launch: Launch): ShiftLaunchEntry {
    return {
      shiftId: launch.shiftId,
      state: launch.exit === undefined ? "starting" : "failed",
      pid: launch.child.pid,
      alive: launch.exit === undefined,
      workspace: deps.workspace,
      startedAt: launch.startedAt,
      requested: { ...launch.requested },
      ...(launch.exit !== undefined
        ? {
            endedAt: launch.exit.endedAt,
            exitCode: launch.exit.exitCode,
            error: launch.exit.error,
          }
        : {}),
    };
  }

  return {
    mint() {
      // The second and four random hex digits make a clash unlikely, not impossible.
      for (let attempt = 0; attempt < 20; attempt++) {
        const id = mint();
        if (!shiftIdInUse(deps.shiftsDir, id) && !launches.has(id)) return id;
      }
      throw new Error("no free shift id could be minted");
    },

    starting() {
      for (const launch of launches.values())
        if (startingNow(launch)) return launch.shiftId;
      return null;
    },

    isStarting(shiftId) {
      const launch = launches.get(shiftId);
      return launch !== undefined && startingNow(launch);
    },

    start(shiftId, flags, requested) {
      if (closing)
        return {
          ok: false,
          kind: "closing",
          error: "The control plane is closing; no shift was started",
        };
      // The hearth's home replaces any other, in any letter case (Windows
      // names are case-insensitive, and two spellings would both be passed).
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(deps.environment))
        if (value !== undefined && name.toUpperCase() !== "AGENT_FORGE_HOME")
          env[name] = value;
      env["AGENT_FORGE_HOME"] = deps.home;
      let child: LaunchedShiftChild;
      try {
        child = deps.launch({
          argv: [process.execPath, SHIFT_CLI, "run", "--id", shiftId, ...flags],
          cwd: deps.root,
          env,
        });
      } catch (error) {
        return {
          ok: false,
          kind: "failed",
          error: `The shift could not be started: ${safeMessage(error)}`,
        };
      }
      let settle = (): void => undefined;
      const launch: Launch = {
        shiftId,
        child,
        startedAt: now().toISOString(),
        requested: { ...requested },
        ended: new Promise<void>((done) => {
          settle = done;
        }),
      };
      launches.set(shiftId, launch);
      const exited = (exit: ShiftChildExit): void => {
        launch.exit = {
          exitCode: exit.exitCode,
          endedAt: now().toISOString(),
          error: launchFailure(exit),
        };
        settle();
        prune();
      };
      child.done.then(exited, (error: unknown) =>
        exited({ exitCode: null, stdout: "", stderr: safeMessage(error) }),
      );
      return { ok: true, value: entry(launch) };
    },

    unrecorded() {
      prune();
      return [...launches.values()]
        .filter((launch) => !recorded(launch.shiftId))
        .map(entry)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },

    async close() {
      closing = true;
      const live = [...launches.values()].filter(
        (launch) => launch.exit === undefined,
      );
      const asked = new Set<string>();
      const deadline = Date.now() + graceMs;
      for (;;) {
        const running = live.filter((launch) => launch.exit === undefined);
        if (running.length === 0) return;
        for (const launch of running) {
          if (asked.has(launch.shiftId)) continue;
          // No record yet: nothing to ask; looked at again on the next round.
          const stop = requestStop(deps.shiftsDir, launch.shiftId);
          if (stop.ok || stop.kind === "stopped") asked.add(launch.shiftId);
        }
        const left = deadline - Date.now();
        if (left <= 0) break;
        await Promise.race([
          Promise.all(running.map((launch) => launch.ended)),
          sleep(Math.min(left, CLOSE_POLL_MS)),
        ]);
      }
      await Promise.all(
        live
          .filter((launch) => launch.exit === undefined)
          .map((launch) => launch.child.stop()),
      );
    },
  };
}
