import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree } from "../executors/supervisor";
import { guardTree, type TreeGuard } from "../executors/tree-guard";
import {
  processAlive,
  readShiftRecord,
  SHIFTS_DIR,
  type ShiftRecord,
  writeShiftRecord,
} from "../scheduler/shift-store";
import { OPERATOR_HEADER } from "./paths";
import type { ShiftListEntry } from "./routes/shifts";
import {
  createShiftStarts,
  KEPT_FAILED_LAUNCHES,
  type LaunchedShiftChild,
  launchFailure,
  SHIFT_CLI,
  type ShiftLaunchSpec,
  superviseShift,
} from "./shift-launcher";
import { fakeShifts, startTestHearth, type TestHearth } from "./testing";

/**
 * The registry of the shifts a hearth starts, with the test hearth's stand-in
 * launcher (nothing runs), and then the real launcher (`superviseShift`)
 * through a hermetic hearth, starting a stand-in script in place of
 * `shift-cli.ts`: the real CLI would run `bd` in the main checkout and
 * `git fetch` against origin. The stand-in does what the test says and
 * records what it was given.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "af shift launcher "));
  dirs.push(dir);
  return dir;
}

/** A token that `redactSecrets` finds. */
const TOKEN = `ghp_${"Zq9".repeat(12)}`;

function record(
  shiftId: string,
  workspace: string,
  more: Partial<ShiftRecord> = {},
): ShiftRecord {
  return {
    shiftId,
    pid: 2_000_000_000,
    workspace,
    startedAt: "2026-10-15T12:00:00.000Z",
    deadline: "2026-10-15T14:00:00.000Z",
    state: "running",
    options: {
      concurrency: 2,
      forMs: 7_200_000,
      maxBeads: 4,
      maxUsd: 10,
      repairs: 3,
    },
    spentUsd: 0,
    unpriced: 0,
    beads: [],
    ...more,
  };
}

/** Wait for `read` to give a value, polling, for at most `ms`. */
async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`nothing within ${ms} ms`);
    await Bun.sleep(25);
  }
}

describe("launchFailure", () => {
  test("names the error the shift printed in its envelope, secrets redacted", () => {
    const error = launchFailure({
      exitCode: 1,
      stdout: `${JSON.stringify(
        {
          ok: false,
          data: null,
          error: `the base could not be fetched (fatal: ${TOKEN}); nothing was started`,
        },
        null,
        2,
      )}\n`,
      stderr: "anything\n",
    });
    expect(error).toBe(
      "the shift exited 1 before it wrote its record: the base could not be fetched (fatal: [REDACTED:github-token]); nothing was started",
    );
  });

  test("an error the shift printed is cut to 500 characters, from its start", () => {
    const error = launchFailure({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        data: null,
        error: `the config could not be read: ${"y".repeat(2000)}`,
      }),
      stderr: "",
    });
    expect(error.length).toBe(500);
    expect(
      error.startsWith(
        "the shift exited 1 before it wrote its record: the config could not be read: yyy",
      ),
    ).toBe(true);
  });

  test("with no envelope, names the end of its stderr without the line that announced the id; with nothing printed, how it exited", () => {
    const long = "x".repeat(2000);
    const error = launchFailure({
      exitCode: 2,
      stdout: "not json\n",
      stderr: `{"shiftId":"shift-20261015-120000-0001","stop":"bun run forge:shift stop"}\n${long}\nError: the end ${TOKEN}\n`,
    });
    expect(error.length).toBeLessThanOrEqual(500);
    expect(
      error.startsWith("the shift exited 2 before it wrote its record: …"),
    ).toBe(true);
    expect(error.endsWith("Error: the end [REDACTED:github-token]")).toBe(true);
    expect(error).not.toContain("shiftId");
    expect(launchFailure({ exitCode: null, stdout: "", stderr: "" })).toBe(
      "the shift was ended before it wrote its record",
    );
    expect(
      launchFailure({
        exitCode: 1,
        stdout: JSON.stringify({ ok: true, data: {}, error: null }),
        stderr: `{"shiftId":"shift-20261015-120000-0001","stop":"x"}\n`,
      }),
    ).toBe("the shift exited 1 before it wrote its record");
  });
});

describe("the registry of the shifts a hearth starts", () => {
  /** Every start of a registry is stamped with this instant: their start times tie. */
  const INSTANT = new Date("2026-10-15T12:00:00.000Z");

  function registry(graceMs = 200) {
    const shiftsDir = join(scratch(), "forge home", SHIFTS_DIR);
    const launcher = fakeShifts();
    const starts = createShiftStarts({
      root: "c:/root",
      home: "c:/home",
      shiftsDir,
      workspace: "c:/root",
      environment: {
        PATH: "c:/bin",
        AGENT_FORGE_HOME: "c:/elsewhere",
        Agent_Forge_Home: "c:/elsewhere too",
        UNSET: undefined,
      },
      launch: launcher.launch,
      mintShiftId: () => launcher.mint(),
      stopGraceMs: graceMs,
      now: () => INSTANT,
    });
    return { shiftsDir, launcher, starts };
  }

  test("a start runs forge:shift run with the id and the flags, in the root, with the environment and the home in place of any spelling of AGENT_FORGE_HOME; it is starting until its record exists, and a launch that exits after its record is forgotten", async () => {
    const { shiftsDir, launcher, starts } = registry();
    const id = starts.mint();
    const started = starts.start(id, ["--for", "2h"], { for: "2h" });
    expect(started).toMatchObject({
      ok: true,
      value: { shiftId: id, state: "starting", requested: { for: "2h" } },
    });
    expect(launcher.launches[0]?.spec).toEqual({
      argv: [process.execPath, SHIFT_CLI, "run", "--id", id, "--for", "2h"],
      cwd: "c:/root",
      env: { PATH: "c:/bin", AGENT_FORGE_HOME: "c:/home" },
    });
    expect([starts.starting(), starts.isStarting(id)]).toEqual([id, true]);
    writeShiftRecord(shiftsDir, record(id, "c:/root"));
    expect([starts.starting(), starts.isStarting(id)]).toEqual([null, false]);
    expect(starts.unrecorded()).toEqual([]);
    launcher.launches[0]?.exit({ exitCode: 0 });
    await launcher.launches[0]?.done;
    rmSync(join(shiftsDir, `${id}.json`));
    // Forgotten once it ended with a record: a record removed later does not bring it back.
    expect(starts.unrecorded()).toEqual([]);
  });

  test("a second start under an id this registry started is refused and starts nothing; an id minted and not yet started is not minted again; close() ends the first", async () => {
    const shiftsDir = join(scratch(), SHIFTS_DIR);
    const launcher = fakeShifts();
    const ids = [
      "shift-20261015-120000-0e31",
      "shift-20261015-120000-0e31",
      "shift-20261015-120000-0e32",
    ];
    let offered = 0;
    const starts = createShiftStarts({
      root: "c:/root",
      home: "c:/home",
      shiftsDir,
      workspace: "c:/root",
      environment: {},
      launch: launcher.launch,
      mintShiftId: () => ids[offered++] ?? "",
      stopGraceMs: 100,
    });
    // Two requests minted before either started: the second gets another id.
    expect([starts.mint(), starts.mint()]).toEqual([
      "shift-20261015-120000-0e31",
      "shift-20261015-120000-0e32",
    ]);
    const id = "shift-20261015-120000-0e31";
    expect(starts.start(id, [], {}).ok).toBe(true);
    expect(starts.start(id, ["--for", "1h"], {})).toEqual({
      ok: false,
      kind: "duplicate",
      error: `${id} was started by this control plane already; no shift was started`,
    });
    expect(launcher.launches).toHaveLength(1);
    await starts.close();
    expect(launcher.launches[0]?.stopped).toBe(true);
  });

  test("an id is minted past any a record, a stop request or a launch has; with none free, minting throws", () => {
    const shiftsDir = join(scratch(), SHIFTS_DIR);
    const launcher = fakeShifts();
    const recorded = "shift-20261015-120000-0001";
    const asked = "shift-20261015-120000-0002";
    const launched = "shift-20261015-120000-0003";
    const free = "shift-20261015-120000-0004";
    const offered: string[] = [];
    const starts = (ids: string[]) =>
      createShiftStarts({
        root: "c:/root",
        home: "c:/home",
        shiftsDir,
        workspace: "c:/root",
        environment: {},
        launch: launcher.launch,
        mintShiftId: () => {
          const id = ids[offered.length % ids.length] ?? "";
          offered.push(id);
          return id;
        },
      });
    writeShiftRecord(shiftsDir, record(recorded, "c:/root"));
    writeFileSync(join(shiftsDir, `${asked}.stop`), "");
    const registry = starts([recorded, asked, launched, free]);
    registry.start(launched, [], {});
    expect(registry.mint()).toBe(free);
    expect(offered).toEqual([recorded, asked, launched, free]);
    offered.length = 0;
    expect(() => starts([recorded]).mint()).toThrow(
      "no free shift id could be minted",
    );
    expect(offered).toHaveLength(20);
  });

  test(`the newest ${KEPT_FAILED_LAUNCHES} launches that failed are kept, the later launch first when their start times tie; older ones are dropped`, async () => {
    const { launcher, starts } = registry();
    for (let n = 0; n < KEPT_FAILED_LAUNCHES + 2; n++) {
      const started = starts.start(starts.mint(), [], {});
      if (!started.ok) throw new Error(started.error);
      launcher.launches[n]?.exit({ exitCode: 1 });
      await launcher.launches[n]?.done;
    }
    const kept = starts.unrecorded();
    expect(
      kept.every((entry) => entry.startedAt === INSTANT.toISOString()),
    ).toBe(true);
    expect(kept.map((entry) => entry.shiftId)).toEqual(
      launcher.minted.slice(2).reverse(),
    );
    expect(kept.every((entry) => entry.state === "failed")).toBe(true);
  });

  test("close() asks a running shift to stop and waits for it to exit on its own; it does not end it", async () => {
    const { shiftsDir, launcher, starts } = registry(10_000);
    const id = starts.mint();
    starts.start(id, [], {});
    writeShiftRecord(shiftsDir, record(id, "c:/root"));
    const began = Date.now();
    const closing = starts.close();
    await until(() =>
      existsSync(join(shiftsDir, `${id}.stop`)) ? true : undefined,
    );
    launcher.launches[0]?.exit({ exitCode: 0 });
    await closing;
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(launcher.launches[0]?.stopped).toBe(false);
  });

  test("close() asks a shift that was still starting once its record appears, and ends one that has not exited by the grace", async () => {
    const { shiftsDir, launcher, starts } = registry(600);
    const late = starts.mint();
    starts.start(late, [], {});
    const stubborn = starts.mint();
    starts.start(stubborn, [], {});
    const began = Date.now();
    const closing = starts.close();
    // No record yet: nothing to ask.
    await Bun.sleep(150);
    expect(existsSync(join(shiftsDir, `${late}.stop`))).toBe(false);
    writeShiftRecord(shiftsDir, record(late, "c:/root"));
    await until(() =>
      existsSync(join(shiftsDir, `${late}.stop`)) ? true : undefined,
    );
    launcher.launches[0]?.exit({ exitCode: 0 });
    await closing;
    expect(Date.now() - began).toBeGreaterThanOrEqual(600);
    expect(launcher.launches.map((child) => child.stopped)).toEqual([
      false,
      true,
    ]);
    expect(existsSync(join(shiftsDir, `${stubborn}.stop`))).toBe(false);
  });

  test("once closing, nothing more is started; with nothing running, close() is at once", async () => {
    const { launcher, starts } = registry(10_000);
    const began = Date.now();
    await starts.close();
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(starts.start(starts.mint(), [], {})).toEqual({
      ok: false,
      kind: "closing",
      error: "The control plane is closing; no shift was started",
    });
    expect(launcher.launches).toEqual([]);
  });
});

/**
 * Stands in for `forge:shift run`. It writes what it was given to
 * `<cwd>/seen-<id>.json`, then does what `<cwd>/stand-in.json` says:
 * - `fail`: announce, print a refusal envelope holding a token, exit 1;
 * - `run`: write a running record in `<AGENT_FORGE_HOME>/shifts`, and on a
 *   stop request there take a second, as a shift does, then close it
 *   (`operator`) and exit 0;
 * - `stubborn`: write a running record, start a child of its own (its pid in
 *   `<cwd>/grandchild-<id>.json`), and never stop.
 */
const STAND_IN = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const id = args[args.indexOf("--id") + 1] ?? "";
const home = process.env.AGENT_FORGE_HOME ?? "";
writeFileSync(
  join(process.cwd(), "seen-" + id + ".json"),
  JSON.stringify({ args, cwd: process.cwd(), home, path: process.env.PATH ?? null }),
);
const { mode, workspace, token } = JSON.parse(
  readFileSync(join(process.cwd(), "stand-in.json"), "utf8"),
);
const shifts = join(home, "shifts");
const save = (state, reason) =>
  writeFileSync(
    join(shifts, id + ".json"),
    JSON.stringify({
      shiftId: id,
      pid: process.pid,
      workspace,
      startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 3600000).toISOString(),
      state,
      ...(reason ? { reason } : {}),
      options: { concurrency: 1, forMs: 3600000, maxBeads: 1, maxUsd: 1, repairs: 0 },
      spentUsd: 0,
      unpriced: 0,
      beads: [],
    }),
  );
process.stderr.write(JSON.stringify({ shiftId: id, stop: "bun run forge:shift stop " + id }) + "\\n");
if (mode === "fail") {
  console.log(JSON.stringify({ ok: false, data: null, error: "the base could not be fetched (fatal: " + token + "); nothing was started" }, null, 2));
  process.exit(1);
}
mkdirSync(shifts, { recursive: true });
save("running");
if (mode === "stubborn") {
  // A run of its own, as a shift has: the hearth must end it with the shift.
  // Detached on Windows only: there Bun puts a child it starts in a job that
  // ends it with its parent, so it would die with this process whoever ended
  // it; elsewhere it stays in this process's group, which the hearth ends.
  const run = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: process.platform === "win32",
  });
  writeFileSync(join(process.cwd(), "grandchild-" + id + ".json"), JSON.stringify({ pid: run.pid }));
}
for (;;) {
  await Bun.sleep(50);
  if (mode === "run" && existsSync(join(shifts, id + ".stop"))) {
    // A shift takes a while to stop: it ends its runs and gives their beads back.
    await Bun.sleep(1000);
    save("stopped", "operator");
    process.exit(0);
  }
}
`;

describe("an explicitly stopped Shift child", () => {
  test("generic Shift Stop waits for its retained native tree settlement", async () => {
    if (process.platform !== "win32") return;

    let releaseSettlement: (() => void) | undefined;
    const settlement = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    let signalSettlementStarted: (() => void) | undefined;
    const settlementStarted = new Promise<void>((resolve) => {
      signalSettlementStarted = resolve;
    });
    let settlementCalls = 0;
    let releaseCalls = 0;
    const child = superviseShift(
      {
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: scratch(),
        env: { PATH: process.env["PATH"] ?? "" },
      },
      (pid) => {
        const guard = guardTree(pid);
        return {
          release: () => {
            releaseCalls += 1;
            guard.release();
          },
          ...(guard.terminate ? { terminate: () => guard.terminate?.() } : {}),
          settleStopped: async () => {
            settlementCalls += 1;
            if (!guard.settleStopped)
              throw new Error(
                "The inert Shift has no native settlement guard.",
              );
            await guard.settleStopped();
            signalSettlementStarted?.();
            await settlement;
          },
        };
      },
    );
    let stop: Promise<void> | undefined;
    try {
      stop = child.stop();
      expect(child.stop()).toBe(stop);
      const first = await Promise.race([
        settlementStarted.then(() => "settlement" as const),
        stop.then(() => "stopped" as const),
        Bun.sleep(5_000).then(() => "timeout" as const),
      ]);
      expect(first).toBe("settlement");

      let publicDone = false;
      let stopDone = false;
      void child.done.then(() => {
        publicDone = true;
      });
      void stop.then(() => {
        stopDone = true;
      });
      await Bun.sleep(25);
      expect(stopDone).toBe(false);
      expect(publicDone).toBe(false);

      releaseSettlement?.();
      await stop;
      await child.done;
      expect(publicDone).toBe(true);
      expect(stopDone).toBe(true);
      expect(settlementCalls).toBe(1);
      expect(releaseCalls).toBe(1);
    } finally {
      releaseSettlement?.();
      if (stop) await stop.catch(() => undefined);
      await child.done.catch(() => undefined);
    }
  });

  test("Windows Stop refuses missing or rejected native settlement without releasing the guard", async () => {
    if (process.platform !== "win32") return;

    for (const witness of ["missing", "rejected"] as const) {
      const owner: {
        guard: TreeGuard | null;
        releases: number;
        settlements: number;
      } = { guard: null, releases: 0, settlements: 0 };
      const child = superviseShift(
        {
          argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          cwd: scratch(),
          env: { PATH: process.env["PATH"] ?? "" },
        },
        (pid) => {
          const guard = guardTree(pid);
          owner.guard = guard;
          return {
            release: () => {
              owner.releases += 1;
              guard.release();
            },
            ...(guard.terminate
              ? { terminate: () => guard.terminate?.() }
              : {}),
            ...(witness === "rejected"
              ? {
                  settleStopped: () => {
                    owner.settlements += 1;
                    return Promise.reject(
                      new Error(
                        "Windows owned process cleanup could not be confirmed.",
                      ),
                    );
                  },
                }
              : {}),
          };
        },
      );
      const stopping = child.stop();
      try {
        expect(child.stop()).toBe(stopping);
        await expect(stopping).rejects.toThrow(
          "Windows owned process cleanup could not be confirmed.",
        );
        expect(owner.settlements).toBe(witness === "rejected" ? 1 : 0);
        expect(owner.releases).toBe(0);
        expect(processAlive(child.pid)).toBe(true);
      } finally {
        owner.guard?.terminate?.();
        await child.done.catch(() => undefined);
      }
    }
  });

  test("a naturally completed Shift refuses later Stop without disturbing its orphan", async () => {
    const cwd = scratch();
    const childRecord = join(cwd, "orphan.json");
    const entry = join(cwd, "natural-exit.ts");
    writeFileSync(
      entry,
      `
import { writeFileSync } from "node:fs";
const orphan = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 1200)"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
  detached: process.platform === "win32",
});
writeFileSync(${JSON.stringify(childRecord)}, JSON.stringify({ pid: orphan.pid }));
process.exit(0);
`,
    );
    let settlements = 0;
    const child = superviseShift(
      {
        argv: [process.execPath, entry],
        cwd,
        env: { PATH: process.env["PATH"] ?? "" },
      },
      (pid) => {
        const guard = guardTree(pid);
        return {
          release: () => guard.release(),
          settleStopped: async () => {
            settlements += 1;
            if (!guard.settleStopped)
              throw new Error("The Shift has no native settlement witness.");
            await guard.settleStopped();
          },
        };
      },
    );

    await child.done;
    const orphan = (
      JSON.parse(readFileSync(childRecord, "utf8")) as { pid: number }
    ).pid;
    try {
      expect(processAlive(orphan)).toBe(true);
      const stopping = child.stop();
      await expect(stopping).rejects.toThrow(
        "The Shift exited before its owned process tree could be settled.",
      );
      expect(settlements).toBe(0);
      expect(processAlive(orphan)).toBe(true);
      await until(() => (!processAlive(orphan) ? true : undefined), 5_000);
    } finally {
      await child.done.catch(() => undefined);
    }
  });
});

/** A path as the file system names it, so two spellings of one directory compare equal. */
function real(path: string): string {
  const resolved = realpathSync.native(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

describe("a shift started through a hearth, with the real launcher and a stand-in for the shift CLI", () => {
  const open: TestHearth[] = [];
  afterEach(async () => {
    for (const hearth of open.splice(0)) await hearth.close();
  });

  async function hearth(graceMs: number) {
    const standIn = join(scratch(), "stand-in.ts");
    writeFileSync(standIn, STAND_IN);
    const specs: ShiftLaunchSpec[] = [];
    const children: LaunchedShiftChild[] = [];
    const h = await startTestHearth({
      api: {
        // The real launcher, given the stand-in in place of the shift CLI.
        launchShift: (spec) => {
          specs.push(spec);
          const child = superviseShift({
            ...spec,
            argv: [spec.argv[0] ?? "", standIn, ...spec.argv.slice(2)],
          });
          children.push(child);
          return child;
        },
        shiftStopGraceMs: graceMs,
      },
    });
    open.push(h);
    const startShift = async (mode: string, body: unknown) => {
      writeFileSync(
        join(h.root, "stand-in.json"),
        JSON.stringify({ mode, workspace: h.workspace, token: TOKEN }),
      );
      const response = await fetch(`${h.api}/shifts`, {
        method: "POST",
        headers: { ...h.headers(), [OPERATOR_HEADER]: h.hearth.token },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(202);
      return ((await response.json()) as { data: { shiftId: string } }).data
        .shiftId;
    };
    const listed = async (id: string): Promise<ShiftListEntry | undefined> => {
      const response = await fetch(`${h.api}/shifts`, {
        headers: h.headers(),
      });
      const body = (await response.json()) as { data: ShiftListEntry[] };
      return body.data.find((entry) => entry.shiftId === id);
    };
    return { h, specs, children, startShift, listed };
  }

  test("explicit generic Stop settles a real Shift descendant before resolving", async () => {
    const { h, children, startShift, listed } = await hearth(800);
    const id = await startShift("stubborn", {});
    const running = await until(async () => {
      const entry = await listed(id);
      return entry?.state === "running" ? entry : undefined;
    });
    const grandchild = await until(() => {
      try {
        return (
          JSON.parse(
            readFileSync(join(h.root, `grandchild-${id}.json`), "utf8"),
          ) as { pid: number }
        ).pid;
      } catch {
        return undefined;
      }
    });
    const child = children[0];
    if (!child) throw new Error("The real Shift child was not retained.");
    expect(child.pid).toBe(running.pid);
    expect(processAlive(child.pid)).toBe(true);
    expect(processAlive(grandchild)).toBe(true);

    await child.stop();
    await child.done;
    expect(processAlive(child.pid)).toBe(false);
    expect(processAlive(grandchild)).toBe(false);
    expect(readShiftRecord(join(h.home, SHIFTS_DIR), id)?.state).toBe(
      "running",
    );
  }, 30_000);

  test("the child runs in the hearth's root with the hearth's home and PATH and the argv it was given; one that ends before writing its record is listed failed, with its exit code and its printed error redacted", async () => {
    const { h, specs, children, startShift, listed } = await hearth(5_000);
    const id = await startShift("fail", { concurrency: 1 });
    expect(specs[0]?.argv.slice(0, 2)).toEqual([process.execPath, SHIFT_CLI]);
    const failed = await until(async () => {
      const entry = await listed(id);
      return entry?.state === "failed" ? entry : undefined;
    });
    expect(failed).toMatchObject({
      shiftId: id,
      state: "failed",
      alive: false,
      pid: children[0]?.pid,
      exitCode: 1,
      error:
        "the shift exited 1 before it wrote its record: the base could not be fetched (fatal: [REDACTED:github-token]); nothing was started",
    });
    const seen = JSON.parse(
      readFileSync(join(h.root, `seen-${id}.json`), "utf8"),
    ) as { args: string[]; cwd: string; home: string; path: string | null };
    expect(seen.args).toEqual(["run", "--id", id, "--concurrency", "1"]);
    expect(real(seen.cwd)).toBe(real(h.root));
    expect(seen.home).toBe(h.home);
    expect(seen.path).toBe(process.env["PATH"] ?? null);
  }, 30_000);

  test("closing the hearth asks a shift it started to stop and waits: the shift finds the stop request in the hearth's home, closes its record and exits 0 on its own", async () => {
    const { h, children, startShift, listed } = await hearth(15_000);
    const id = await startShift("run", {});
    const running = await until(async () => {
      const entry = await listed(id);
      return entry?.state === "running" ? entry : undefined;
    });
    expect(running).toMatchObject({ alive: true, pid: children[0]?.pid });
    const began = Date.now();
    await h.hearth.close();
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(existsSync(join(h.home, SHIFTS_DIR, `${id}.stop`))).toBe(true);
    expect(readShiftRecord(join(h.home, SHIFTS_DIR), id)).toMatchObject({
      state: "stopped",
      reason: "operator",
    });
    expect((await children[0]?.done)?.exitCode).toBe(0);
    expect(processAlive(children[0]?.pid ?? 0)).toBe(false);
  }, 30_000);

  test("closing the hearth ends a shift that has not stopped by the grace, with its process tree (the child it started too); its record stays running for forge:shift recover", async () => {
    const { h, children, startShift, listed } = await hearth(800);
    const id = await startShift("stubborn", {});
    await until(async () =>
      (await listed(id))?.state === "running" ? true : undefined,
    );
    const grandchild = await until(() => {
      try {
        return (
          JSON.parse(
            readFileSync(join(h.root, `grandchild-${id}.json`), "utf8"),
          ) as { pid: number }
        ).pid;
      } catch {
        return undefined;
      }
    });
    const pid = children[0]?.pid ?? 0;
    try {
      expect(processAlive(grandchild)).toBe(true);
      const began = Date.now();
      await h.hearth.close();
      expect(Date.now() - began).toBeGreaterThanOrEqual(800);
      expect((await children[0]?.done)?.exitCode).not.toBe(0);
      await until(() => (processAlive(pid) ? undefined : true), 5_000);
      await until(() => (processAlive(grandchild) ? undefined : true), 5_000);
      expect(readShiftRecord(join(h.home, SHIFTS_DIR), id)?.state).toBe(
        "running",
      );
    } finally {
      // Left running only when the test failed.
      for (const left of [grandchild, pid])
        if (processAlive(left)) killTree(left);
    }
  }, 30_000);
});

/**
 * A hearth as `bun run hearth` runs one, in a process of its own: started,
 * then `closeOnSignal`, the shutdown `main()` installs. Its launcher is the
 * real one, given the stand-in, with the real tree guard or, when asked
 * (`none`), one that guards nothing, so that only the exit hook can end the
 * shift. Asked (`supervised`), it also runs a child through `supervise()`
 * (the fake provider, hanging), as any provider run made in the hearth's own
 * process would: that installs the supervisor's own SIGINT and SIGTERM
 * handler. It prints where it listens and what it uses, then reads its stdin a
 * line at a time: `signal` emits the signal it was given (`process.emit`: no
 * signal can be sent to a process on Windows), and `exit` calls
 * `process.exit(3)`, a way out that skips `close()`.
 */
const HEARTH_MAIN = (standIn: string) => `
import { supervise } from ${JSON.stringify(join(import.meta.dir, "..", "executors", "supervisor.ts"))};
import { closeOnSignal } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
import { superviseShift } from ${JSON.stringify(join(import.meta.dir, "shift-launcher.ts"))};
import { startTestHearth } from ${JSON.stringify(join(import.meta.dir, "testing.ts"))};
const [signal = "", guard = "real", extra = ""] = process.argv.slice(2);
const unguarded = () => ({ release: () => undefined });
const h = await startTestHearth({
  api: {
    launchShift: (spec) => {
      const given = { ...spec, argv: [spec.argv[0], ${JSON.stringify(standIn)}, ...spec.argv.slice(2)] };
      return guard === "none" ? superviseShift(given, unguarded) : superviseShift(given);
    },
    shiftStopGraceMs: 15000,
  },
});
closeOnSignal(h.hearth);
const supervised = extra === "supervised"
  ? supervise({
      command: [process.execPath, ${JSON.stringify(join(import.meta.dir, "..", "executors", "fixtures", "fake-cli.ts"))}, "--fake-mode", "hang"],
      cwd: h.root,
      env: { PATH: process.env.PATH ?? "" },
      onLine: () => undefined,
    }).pid
  : null;
console.log(JSON.stringify({ api: h.api, url: h.hearth.url, token: h.hearth.token, home: h.home, root: h.root, configHome: h.configHome, workspace: h.workspace, supervised }));
const decoder = new TextDecoder();
let text = "";
for await (const chunk of Bun.stdin.stream()) {
  text += decoder.decode(chunk);
  let end = text.indexOf("\\n");
  while (end !== -1) {
    const line = text.slice(0, end).trim();
    text = text.slice(end + 1);
    if (line === "signal") process.emit(signal);
    if (line === "exit") process.exit(3);
    end = text.indexOf("\\n");
  }
}
`;

/** Where a hearth process listens and what it uses, as it prints them. */
interface HearthWhere {
  api: string;
  url: string;
  token: string;
  home: string;
  root: string;
  configHome: string;
  workspace: string;
  /** The pid of the child it runs through `supervise()`, when asked to. */
  supervised: number | null;
}

/** A shift a hearth process started, once its record says it runs. */
interface StartedShift {
  id: string;
  pid: number;
  /** The pid of the child the stand-in started (`stubborn` only). */
  grandchild: number | null;
}

/** Start `HEARTH_MAIN` in a bun process of its own and read where it listens. */
async function hearthProcess(
  signal: string,
  guard: "real" | "none" = "real",
  extra: "" | "supervised" = "",
) {
  const dir = scratch();
  const standIn = join(dir, "stand-in.ts");
  const main = join(dir, "hearth-main.ts");
  writeFileSync(standIn, STAND_IN);
  writeFileSync(main, HEARTH_MAIN(standIn));
  const proc = Bun.spawn([process.execPath, main, signal, guard, extra], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const left: number[] = [];
  const reader = proc.stdout.getReader();
  let first = "";
  while (!first.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    first += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const where = JSON.parse(first.split(/\r?\n/)[0] ?? "") as HearthWhere;
  for (const made of [where.home, where.root, where.configHome])
    dirs.push(made);
  if (where.supervised !== null) left.push(where.supervised);
  return {
    proc,
    where,
    send(line: string): void {
      proc.stdin.write(`${line}\n`);
      proc.stdin.flush();
    },
    async startShift(mode: "run" | "stubborn"): Promise<StartedShift> {
      writeFileSync(
        join(where.root, "stand-in.json"),
        JSON.stringify({ mode, workspace: where.workspace }),
      );
      const started = await fetch(`${where.api}/shifts`, {
        method: "POST",
        headers: {
          Origin: where.url,
          "Content-Type": "application/json",
          [OPERATOR_HEADER]: where.token,
        },
        body: "{}",
      });
      expect(started.status).toBe(202);
      const id = ((await started.json()) as { data: { shiftId: string } }).data
        .shiftId;
      const running = await until(async () => {
        const listed = (await (
          await fetch(`${where.api}/shifts`, {
            headers: { Origin: where.url },
          })
        ).json()) as { data: ShiftListEntry[] };
        const entry = listed.data.find((each) => each.shiftId === id);
        return entry?.state === "running" ? entry : undefined;
      });
      left.push(running.pid);
      const grandchild =
        mode === "stubborn"
          ? await until(() => {
              try {
                return (
                  JSON.parse(
                    readFileSync(
                      join(where.root, `grandchild-${id}.json`),
                      "utf8",
                    ),
                  ) as { pid: number }
                ).pid;
              } catch {
                return undefined;
              }
            })
          : null;
      if (grandchild !== null) left.push(grandchild);
      return { id, pid: running.pid, grandchild };
    },
    /** End what a failed test left running: the hearth, the shift, its child. */
    cleanup(): void {
      proc.kill();
      for (const pid of left) if (processAlive(pid)) killTree(pid);
    },
  };
}

/** Wait until neither process runs; fails the test after 5 s. */
async function gone(...pids: Array<number | null>): Promise<void> {
  for (const pid of pids)
    if (pid !== null)
      await until(() => (processAlive(pid) ? undefined : true), 5_000);
}

describe("a hearth that gets SIGINT or SIGTERM", () => {
  for (const signal of ["SIGTERM", "SIGINT"])
    test(`${signal} runs the hearth's close: the shift it started gets its stop request, closes its record and exits 0 on its own, and the hearth exits 0`, async () => {
      const hearth = await hearthProcess(signal);
      try {
        const shift = await hearth.startShift("run");
        hearth.send("signal");
        expect(await hearth.proc.exited).toBe(0);
        const shifts = join(hearth.where.home, SHIFTS_DIR);
        expect(existsSync(join(shifts, `${shift.id}.stop`))).toBe(true);
        expect(readShiftRecord(shifts, shift.id)).toMatchObject({
          state: "stopped",
          reason: "operator",
        });
        expect(processAlive(shift.pid)).toBe(false);
      } finally {
        hearth.cleanup();
      }
    }, 40_000);

  for (const signal of ["SIGTERM", "SIGINT"])
    test(`${signal} in a hearth that also runs a child through supervise() still runs its close first: the shift it started stops on its own, the supervised child is ended, and the hearth exits 0`, async () => {
      // supervise() installs a handler that kills and exits 130 at once; the
      // hearth owns the signal (ownInterrupts), so that handler waits for it.
      const hearth = await hearthProcess(signal, "real", "supervised");
      const supervised = hearth.where.supervised ?? 0;
      try {
        expect(processAlive(supervised)).toBe(true);
        const shift = await hearth.startShift("run");
        hearth.send("signal");
        expect(await hearth.proc.exited).toBe(0);
        const shifts = join(hearth.where.home, SHIFTS_DIR);
        expect(existsSync(join(shifts, `${shift.id}.stop`))).toBe(true);
        expect(readShiftRecord(shifts, shift.id)).toMatchObject({
          state: "stopped",
          reason: "operator",
        });
        await gone(shift.pid, supervised);
      } finally {
        hearth.cleanup();
      }
    }, 40_000);

  test("a second signal while the hearth closes ends its shifts at once, with the child each started, and the hearth exits 130 long before the grace", async () => {
    // The grace is 15 s, and the shift never stops when asked.
    const hearth = await hearthProcess("SIGINT");
    try {
      const shift = await hearth.startShift("stubborn");
      const began = Date.now();
      hearth.send("signal");
      // The close has begun: it has asked the shift to stop, and now waits.
      await until(() =>
        existsSync(join(hearth.where.home, SHIFTS_DIR, `${shift.id}.stop`))
          ? true
          : undefined,
      );
      hearth.send("signal");
      expect(await hearth.proc.exited).toBe(130);
      expect(Date.now() - began).toBeLessThan(8_000);
      await gone(shift.pid, shift.grandchild);
    } finally {
      hearth.cleanup();
    }
  }, 40_000);
});

describe("a hearth that ends without closing", () => {
  test("one that exits some other way (process.exit) ends the shifts it started, with the child each started, through its exit hook alone (no tree guard)", async () => {
    const hearth = await hearthProcess("SIGINT", "none");
    try {
      const shift = await hearth.startShift("stubborn");
      hearth.send("exit");
      expect(await hearth.proc.exited).toBe(3);
      await gone(shift.pid, shift.grandchild);
    } finally {
      hearth.cleanup();
    }
  }, 40_000);

  test("one killed outright (TerminateProcess on Windows, SIGKILL elsewhere: no code of its own runs) ends the shifts it started, with the child each started, through the tree guard", async () => {
    const hearth = await hearthProcess("SIGINT");
    try {
      const shift = await hearth.startShift("stubborn");
      if (process.platform === "win32")
        Bun.spawnSync(["taskkill", "/F", "/PID", String(hearth.proc.pid)], {
          stdout: "ignore",
          stderr: "ignore",
        });
      else process.kill(hearth.proc.pid, "SIGKILL");
      await hearth.proc.exited;
      await gone(shift.pid, shift.grandchild);
    } finally {
      hearth.cleanup();
    }
  }, 40_000);
});
