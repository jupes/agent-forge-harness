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
  function registry(graceMs = 200) {
    const shiftsDir = join(scratch(), "forge home", SHIFTS_DIR);
    const launcher = fakeShifts();
    const starts = createShiftStarts({
      root: "c:/root",
      home: "c:/home",
      shiftsDir,
      workspace: "c:/root",
      environment: { PATH: "c:/bin", AGENT_FORGE_HOME: "c:/elsewhere" },
      launch: launcher.launch,
      mintShiftId: () => launcher.mint(),
      stopGraceMs: graceMs,
    });
    return { shiftsDir, launcher, starts };
  }

  test("a start runs forge:shift run with the id and the flags, in the root, with the environment and the home; it is starting until its record exists, and a launch that exits after its record is forgotten", async () => {
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

  test(`the newest ${KEPT_FAILED_LAUNCHES} launches that failed are kept, newest first; older ones are dropped`, async () => {
    const { launcher, starts } = registry();
    for (let n = 0; n < KEPT_FAILED_LAUNCHES + 2; n++) {
      const started = starts.start(starts.mint(), [], {});
      if (!started.ok) throw new Error(started.error);
      launcher.launches[n]?.exit({ exitCode: 1 });
      await launcher.launches[n]?.done;
      // Distinct start times, a millisecond apart at least.
      await Bun.sleep(2);
    }
    const kept = starts.unrecorded();
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
 *   stop request there close it (`operator`) and exit 0;
 * - `stubborn`: write a running record and never stop.
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
for (;;) {
  await Bun.sleep(50);
  if (mode === "run" && existsSync(join(shifts, id + ".stop"))) {
    save("stopped", "operator");
    process.exit(0);
  }
}
`;

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

  test("closing the hearth ends a shift that has not stopped by the grace, with its process tree; its record stays running for forge:shift recover", async () => {
    const { h, children, startShift, listed } = await hearth(800);
    const id = await startShift("stubborn", {});
    await until(async () =>
      (await listed(id))?.state === "running" ? true : undefined,
    );
    const pid = children[0]?.pid ?? 0;
    const began = Date.now();
    await h.hearth.close();
    expect(Date.now() - began).toBeGreaterThanOrEqual(800);
    expect((await children[0]?.done)?.exitCode).not.toBe(0);
    await until(() => (processAlive(pid) ? undefined : true), 5_000);
    expect(readShiftRecord(join(h.home, SHIFTS_DIR), id)?.state).toBe(
      "running",
    );
  }, 30_000);
});
