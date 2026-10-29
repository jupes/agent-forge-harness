/**
 * The shifts a hearth starts (`POST /shifts`, `x1gs.5.4.5`): each is
 * `bun scripts/scheduler/shift-cli.ts run --id <id> [flags]` as a child the
 * hearth supervises, never a shell, in the hearth's root and with the hearth's
 * environment and `AGENT_FORGE_HOME` set to the hearth's home, so the shift
 * takes the same queue lock and writes the same ledger and shifts directory
 * the hearth reads. The child cannot outlive the hearth: an `exit` hook ends
 * its tree, and the tree guard (`scripts/executors/tree-guard.ts`) ends it for
 * a hearth killed outright. It is not started through `supervise`
 * (`superviseShift` says why). No time limit is set: the shift's own deadline
 * ends it.
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
 * `close()` (the hearth's own, which `SIGINT` and `SIGTERM` run) asks every
 * shift it started that is still running to stop, as `POST /shifts/:id/stop`
 * does, as soon as its record exists, waits up to `SHIFT_STOP_GRACE_MS` for
 * each to exit, and then ends what is left with its process tree. A shift
 * ended that way, or by the exit hook or the tree guard, leaves its beads
 * `running` and its record `running`; `forge:shift recover` gives them back.
 */

import { resolve } from "node:path";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import { buildChildEnv } from "../executors/env";
import {
  observeOwnedProcessGroup,
  waitForOwnedProcessGroup,
} from "../executors/process-group";
import { killTree, STDERR_TAIL_CHARS } from "../executors/supervisor";
import { guardTree, type TreeGuard } from "../executors/tree-guard";
import {
  mintShiftId,
  readShiftRecord,
  requestStop,
  shiftIdInUse,
} from "../scheduler/shift-store";
import { redactSecrets } from "../secret-patterns";
import { createProjectShiftRegistry } from "../shifts/registry";
import { sameProjectShiftOriginal } from "../shifts/start-input";
import { safeMessage } from "./api";

/** The script a hearth starts a shift with: `forge:shift`. */
export const SHIFT_CLI = resolve(
  import.meta.dir,
  "..",
  "scheduler",
  "shift-cli.ts",
);
export const PROJECT_SHIFT_ENTRY = resolve(
  import.meta.dir,
  "..",
  "shifts",
  "execution-entry.ts",
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

/** How many ids minted for a start that has not happened yet are held from a second mint. */
const KEPT_MINTED = 64;

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
  /** Attended launches expose the separately confirmed engine identity; pid remains the owned wrapper root. */
  enginePid?: Promise<number>;
  /** Resolves once it has exited. */
  done: Promise<ShiftChildExit>;
  /** End it and its process tree; resolves once it has exited. */
  stop(): Promise<void>;
}

/** Starts the child; throws when it could not be started. */
export type ShiftLauncher = (spec: ShiftLaunchSpec) => LaunchedShiftChild;

/** The shift children this process started that are still running, by pid. */
const liveShifts = new Set<number>();
let exitHooked = false;

/**
 * End, at once and synchronously, the tree of every shift child this process
 * started that is still running. A second signal during the hearth's close
 * calls it (`closeOnSignal` in `server.ts`), and so does the `exit` hook.
 */
export function endLiveShifts(): void {
  for (const pid of liveShifts) killTree(pid);
  liveShifts.clear();
}

/**
 * End every shift child still running when this process exits by a way that
 * skipped `close()` (an uncaught error, a `process.exit` elsewhere).
 * Synchronous, as an `exit` listener must be. Nothing here listens for
 * `SIGINT` or `SIGTERM`: those are the hearth's own (`closeOnSignal` in
 * `server.ts`), so that its `close()` can ask its shifts to stop first.
 */
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", endLiveShifts);
}

/** Read a stream to its end, keeping only its last `max` characters. */
async function tail(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text = (text + decoder.decode(value, { stream: true })).slice(-max);
    }
  } catch {
    // The child went; what was read is kept.
  }
  return (text + decoder.decode()).slice(-max);
}

/**
 * The real launcher. Not `supervise()` (`scripts/executors/supervisor.ts`),
 * which is made for a provider run: a prompt on stdin, stdout read a line at
 * a time, a time limit. Its `SIGINT`/`SIGTERM` handler, which kills every
 * supervised child and exits 130, waits for the hearth now that the hearth
 * owns those signals (`closeOnSignal` in `server.ts`, `x1gs.5.4.14`). What
 * `supervise` gives that is kept: an argument array and no shell, the tree
 * guard (`guardTree`) for a hearth killed outright, `killTree` for the whole
 * tree, and an `exit` hook. The child gets its own process group outside
 * Windows (a terminal's Ctrl-C then reaches the hearth, not the shift, and
 * `killTree` ends the group). No time limit: the shift's own deadline ends it.
 */
export function superviseShift(
  spec: ShiftLaunchSpec,
  /** The tree guard; a test hands in one that guards nothing, to see the exit hook alone. */
  guardChild: (pid: number) => TreeGuard = guardTree,
): LaunchedShiftChild {
  const proc = Bun.spawn(spec.argv, {
    cwd: spec.cwd,
    env: spec.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(process.platform === "win32" ? {} : { detached: true }),
  });
  hookExit();
  liveShifts.add(proc.pid);
  const guard = guardChild(proc.pid);
  const stdout = tail(proc.stdout, STDOUT_TAIL_CHARS);
  const stderr = tail(proc.stderr, STDERR_TAIL_CHARS);
  let rootExited = false;
  let naturalCompletion = false;
  let stopping: Promise<void> | null = null;
  const rootDone = (async (): Promise<ShiftChildExit> => {
    const code = await proc.exited;
    rootExited = true;
    liveShifts.delete(proc.pid);
    return {
      exitCode: proc.signalCode !== null ? null : code,
      stdout: await stdout,
      stderr: await stderr,
    };
  })();
  const done = rootDone.then(
    async (exit) => {
      if (stopping !== null) {
        try {
          await stopping;
        } catch (error) {
          // Once the root is gone, never use its numeric pid as later authority.
          liveShifts.delete(proc.pid);
          throw error;
        }
      } else {
        naturalCompletion = true;
        guard.release();
        liveShifts.delete(proc.pid);
      }
      return exit;
    },
    (error: unknown) => {
      if (stopping === null) {
        naturalCompletion = true;
        guard.release();
      }
      liveShifts.delete(proc.pid);
      throw error;
    },
  );
  void done.catch(() => undefined);
  const stop = (): Promise<void> => {
    if (stopping !== null) return stopping;
    if (naturalCompletion) {
      stopping = Promise.reject(
        new Error(
          "The Shift exited before its owned process tree could be settled.",
        ),
      );
      void stopping.catch(() => undefined);
      return stopping;
    }

    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    stopping = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    void stopping.catch(() => undefined);

    let settlement: Promise<void>;
    if (process.platform === "win32") {
      if (guard.settleStopped === undefined) {
        rejectStop(
          new Error("Windows owned process cleanup could not be confirmed."),
        );
        return stopping;
      }
      try {
        // This synchronously captures the job generation before requesting termination.
        settlement = guard.settleStopped();
      } catch (error) {
        rejectStop(error);
        return stopping;
      }
    } else {
      if (!rootExited) {
        try {
          // The detached Shift leads its own group. Never fall back to its numeric pid.
          process.kill(-proc.pid, "SIGKILL");
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
          ) {
            rejectStop(
              new Error("Owned process group cleanup could not be confirmed."),
            );
            return stopping;
          }
        }
      }
      settlement = waitForOwnedProcessGroup((signal) =>
        observeOwnedProcessGroup(proc.pid, signal),
      );
    }

    void settlement.then(async () => {
      try {
        await rootDone;
        guard.release();
        liveShifts.delete(proc.pid);
        resolveStop();
      } catch (error) {
        rejectStop(error);
      }
    }, rejectStop);
    return stopping;
  };
  return {
    pid: proc.pid,
    done,
    stop,
  };
}

/** A shift this hearth started that has no record: still starting, or ended before writing one. */
export interface ShiftLaunchEntry {
  shiftId: string;
  state: "starting" | "failed";
  /** The child the hearth started. */
  pid: number;
  wrapperPid?: number;
  enginePid?: number | null;
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
  /** Trusted source/packaged command; original project/UUID are the only appended arguments. */
  projectCommand?: readonly string[] | undefined;
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
  /** Attended project children have a mandatory grant before engine code; ordinary global shifts keep launch. */
  projectLaunch?:
    | ((
        spec: ShiftLaunchSpec,
        original: ProjectShiftIntent,
      ) => LaunchedShiftChild)
    | undefined;
  /** A new shift id; `mintShiftId` at the current second by default. */
  mintShiftId?: (() => string) | undefined;
  stopGraceMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export type StartOutcome =
  | { ok: true; value: ShiftLaunchEntry }
  | { ok: false; kind: "closing" | "duplicate" | "failed"; error: string };

export interface ShiftStarts {
  /** Explicit current-admission call only; recreation and reads never invoke this method. */
  startProject(projectId: string, requestId: string): StartOutcome;
  /** Only the matching held project tree can confirm settlement. Saved numeric PIDs grant no control. */
  stopProject(original: ProjectShiftIntent): Promise<boolean>;
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
  /** This hearth's launches that have no record, newest first: by `startedAt`, then the later launch first. */
  unrecorded(): ShiftLaunchEntry[];
  /** Ask the running ones to stop, wait, end what is left. Starts nothing after it is called. */
  close(): Promise<void>;
}

interface Launch {
  shiftId: string;
  /** This hearth's count of launches when it was started: breaks a tie between equal `startedAt`. */
  seq: number;
  child: LaunchedShiftChild;
  enginePid?: number;
  startedAt: string;
  requested: Record<string, unknown>;
  project?: ProjectShiftIntent;
  stopping?: Promise<boolean>;
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
  let launched = 0;
  /** Ids minted for a start that has not reached `start()` yet. */
  const minted = new Set<string>();

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
      pid: launch.enginePid ?? launch.child.pid,
      ...(launch.child.enginePid
        ? { wrapperPid: launch.child.pid, enginePid: launch.enginePid ?? null }
        : {}),
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

  function startLaunch(
    shiftId: string,
    argv: string[],
    requested: Record<string, unknown>,
    project?: ProjectShiftIntent,
  ): StartOutcome {
    if (closing)
      return {
        ok: false,
        kind: "closing",
        error: "The control plane is closing; no shift was started",
      };
    // Two starts under one id would leave the first out of `close()`.
    if (launches.has(shiftId))
      return {
        ok: false,
        kind: "duplicate",
        error: `${shiftId} was started by this control plane already; no shift was started`,
      };
    minted.delete(shiftId);
    // The hearth's home replaces any other, in any letter case (Windows
    // names are case-insensitive, and two spellings would both be passed).
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      project ? buildChildEnv(deps.environment, []) : deps.environment,
    ))
      if (value !== undefined && name.toUpperCase() !== "AGENT_FORGE_HOME")
        env[name] = value;
    env["AGENT_FORGE_HOME"] = deps.home;
    let child: LaunchedShiftChild;
    try {
      const spec = {
        argv,
        cwd: deps.root,
        env,
      };
      child =
        project && deps.projectLaunch
          ? deps.projectLaunch(spec, project)
          : deps.launch(spec);
    } catch (error) {
      return {
        ok: false,
        kind: "failed",
        error: `The shift could not be started: ${safeMessage(error)}`,
      };
    }
    let settle = (): void => undefined;
    launched += 1;
    const launch: Launch = {
      shiftId,
      seq: launched,
      child,
      startedAt: now().toISOString(),
      requested: { ...requested },
      ...(project ? { project: structuredClone(project) } : {}),
      ended: new Promise<void>((done) => {
        settle = done;
      }),
    };
    launches.set(shiftId, launch);
    void child.enginePid
      ?.then((pid) => {
        if (!launch.exit) launch.enginePid = pid;
      })
      .catch(() => {});
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
  }

  return {
    mint() {
      // The second and four random hex digits make a clash unlikely, not
      // impossible; an id minted for a request still on its way to `start`
      // is held too.
      for (let attempt = 0; attempt < 20; attempt++) {
        const id = mint();
        if (
          shiftIdInUse(deps.shiftsDir, id) ||
          launches.has(id) ||
          minted.has(id)
        )
          continue;
        minted.add(id);
        // A request refused after its mint (its audit row not stored) never
        // starts: only the newest few are held.
        for (const old of [...minted].slice(0, -KEPT_MINTED))
          minted.delete(old);
        return id;
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
      return startLaunch(
        shiftId,
        [process.execPath, SHIFT_CLI, "run", "--id", shiftId, ...flags],
        requested,
      );
    },
    startProject(projectId, requestId) {
      if (closing)
        return {
          ok: false,
          kind: "closing",
          error: "The shift launcher is closing. Check the original request.",
        };
      try {
        const intent = createProjectShiftRegistry({
          home: deps.home,
          root: deps.root,
        }).read(projectId, requestId);
        if (
          intent.attemptedAt === null ||
          intent.startupStop ||
          intent.executionStartedAt ||
          shiftIdInUse(deps.shiftsDir, intent.shiftId)
        )
          return {
            ok: false,
            kind: "duplicate",
            error:
              "The original Start is not eligible for another child launch. Read its current outcome.",
          };
        const command = deps.projectCommand ?? [
          process.execPath,
          PROJECT_SHIFT_ENTRY,
        ];
        if (
          !command.length ||
          command.some((part) => !part || part.includes("\0"))
        )
          return {
            ok: false,
            kind: "failed",
            error: "The trusted shift child command is unavailable.",
          };
        return startLaunch(
          intent.shiftId,
          [...command, projectId, requestId],
          { ...intent.request.options },
          intent,
        );
      } catch {
        return {
          ok: false,
          kind: "failed",
          error:
            "The original project shift Start could not be verified. Read its current outcome before trying anything else.",
        };
      }
    },
    async stopProject(original) {
      const saved = createProjectShiftRegistry({
        home: deps.home,
        root: deps.root,
      }).read(original.projectId, original.request.requestId);
      const launch = launches.get(saved.shiftId),
        held = launch?.project;
      const matches = (value: ProjectShiftIntent) =>
        sameProjectShiftOriginal(value, saved);
      if (!saved.startupStop || !matches(original) || !held || !matches(held))
        return false;
      if (!launch.stopping)
        launch.stopping = (async () => {
          await launch.child.stop();
          // This is held-tree cleanup/drain, never a kill(pid, 0) inference or wrapper-exit guess.
          await launch.child.done;
          return true;
        })();
      return launch.stopping;
    },
    unrecorded() {
      prune();
      // Newest first: by start time, and for an equal time (two starts in
      // one millisecond) the later launch first, never the order of a sort.
      return [...launches.values()]
        .filter((launch) => !recorded(launch.shiftId))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.seq - a.seq)
        .map(entry);
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
