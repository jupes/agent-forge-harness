import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LedgerEventInput, OperatorEnvelope } from "../../../types/hearth";
import { appendEvent } from "../../ledger/append";
import { activeReservations } from "../../ledger/query";
import { createQueue } from "../../scheduler/queue";
import { type QueueTracker, queueTracker } from "../../scheduler/queue-fixture";
import { reserve } from "../../scheduler/reservations";
import type { Recovery } from "../../scheduler/shift-recover";
import {
  type ListedShift,
  readShiftRecord,
  SHIFTS_DIR,
  type ShiftRecord,
  writeShiftRecord,
} from "../../scheduler/shift-store";
import { OPERATOR_HEADER } from "../paths";
import { SHIFT_CLI, type ShiftLaunchEntry } from "../shift-launcher";
import {
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "../testing";
import { validateOperatorEnvelope } from "../validate";
import { QUEUE_LOCK_FILE } from "./queue";
import type { ShiftListEntry } from "./shifts";

/**
 * The shift rows, through a hermetic hearth: the records are written into the
 * hearth's own home as a shift would write them, and what is checked is the
 * answer, the stop request on disk, the tracker, the ledger and the audit
 * rows. No shift runs here: the loop that honours a stop request is tested in
 * `scripts/scheduler/shift.test.ts`, and recovery itself in
 * `scripts/scheduler/shift-recover.test.ts`.
 */

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function start(options: TestHearthOptions = {}): Promise<TestHearth> {
  const h = await startTestHearth(options);
  open.push(h);
  return h;
}

/** The instant every start of a hearth given it is stamped with: their `startedAt` tie. */
const INSTANT = "2026-10-15T12:00:00.000Z";

/** A hearth whose starts all happen in one millisecond, so only the tie-break orders them. */
const oneInstant = (): Promise<TestHearth> =>
  start({ api: { shiftNow: () => new Date(INSTANT) } });

const shifts = (h: TestHearth) => join(h.home, SHIFTS_DIR);

function record(
  shiftId: string,
  workspace: string,
  more: Partial<ShiftRecord> = {},
): ShiftRecord {
  return {
    shiftId,
    pid: process.pid,
    workspace,
    startedAt: `2026-10-14T${shiftId.slice(15, 17)}:00:00.000Z`,
    deadline: "2026-10-14T23:00:00.000Z",
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

async function answer<T>(
  response: Response,
): Promise<{ status: number; body: OperatorEnvelope<T> }> {
  const checked = validateOperatorEnvelope(await response.json());
  if (!checked.ok) throw new Error(`not an envelope: ${checked.error}`);
  // justification: the guard above proved the envelope; `T` is the caller's claim about `data`.
  return {
    status: response.status,
    body: checked.value as OperatorEnvelope<T>,
  };
}

const post = async (
  h: TestHearth,
  path: string,
  token: string | null = h.hearth.token,
) =>
  answer<{ shiftId: string; already: boolean }>(
    await fetch(`${h.api}${path}`, {
      method: "POST",
      headers: h.headers(token),
      body: "{}",
    }),
  );

describe("GET /shifts", () => {
  test("lists this workspace's shift records, newest first, each saying whether its process is alive; another workspace's are not listed", async () => {
    const h = await start();
    writeShiftRecord(
      shifts(h),
      record("shift-20261014-090000-0001", h.workspace, {
        pid: 2_000_000_000,
        state: "stopped",
        reason: "elapsed",
      }),
    );
    writeShiftRecord(
      shifts(h),
      record("shift-20261014-100000-0001", h.workspace),
    );
    writeShiftRecord(
      shifts(h),
      record("shift-20261014-110000-0001", "c:/another/checkout"),
    );
    const listed = await answer<ListedShift[]>(
      await fetch(`${h.api}/shifts`, { headers: h.headers() }),
    );
    expect(listed.status).toBe(200);
    expect(
      listed.body.data?.map((each) => [each.shiftId, each.state, each.alive]),
    ).toEqual([
      ["shift-20261014-100000-0001", "running", true],
      ["shift-20261014-090000-0001", "stopped", false],
    ]);
  });

  test("with no shift ever run, the list is empty", async () => {
    const h = await start();
    const listed = await answer<ListedShift[]>(
      await fetch(`${h.api}/shifts`, { headers: h.headers() }),
    );
    expect(listed).toEqual({
      status: 200,
      body: { ok: true, data: [], error: null },
    });
  });
});

describe("POST /shifts", () => {
  /** A token that `redactSecrets` finds. */
  const TOKEN = `ghp_${"Zq9".repeat(12)}`;

  const startShift = async (
    h: TestHearth,
    body: unknown,
    headers: Record<string, string> = h.headers(h.hearth.token),
  ) =>
    answer<ShiftLaunchEntry & { stop: string; recover: string }>(
      await fetch(`${h.api}/shifts`, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  const list = async (h: TestHearth) =>
    (
      await answer<ShiftListEntry[]>(
        await fetch(`${h.api}/shifts`, { headers: h.headers() }),
      )
    ).body.data ?? [];

  test("{} starts forge:shift run with only the minted id: bun and the shift CLI as an argument array, in the hearth's root, with the hearth's environment and its home; 202 names the id", async () => {
    const h = await start();
    const id = h.shifts.next();
    const started = await startShift(h, {});
    expect(started.status).toBe(202);
    expect(started.body.data).toEqual({
      shiftId: id,
      state: "starting",
      pid: h.shifts.launches[0]?.pid ?? -1,
      alive: true,
      workspace: h.workspace,
      startedAt: expect.any(String),
      requested: {},
      stop: `/shifts/${id}/stop`,
      recover: `/shifts/${id}/recover`,
    });
    const [launch] = h.shifts.launches;
    expect(h.shifts.launches).toHaveLength(1);
    expect(launch?.spec.argv).toEqual([
      process.execPath,
      SHIFT_CLI,
      "run",
      "--id",
      id,
    ]);
    expect(SHIFT_CLI).toBe(
      resolve(import.meta.dir, "..", "..", "scheduler", "shift-cli.ts"),
    );
    expect(existsSync(SHIFT_CLI)).toBe(true);
    expect(launch?.spec.cwd).toBe(h.root);
    // The hearth's own environment, with its home in place of any other.
    const { AGENT_FORGE_HOME: _given, ...hearthEnv } = process.env;
    expect(launch?.spec.env).toEqual({
      ...Object.fromEntries(
        Object.entries(hearthEnv).filter(([, value]) => value !== undefined),
      ),
      AGENT_FORGE_HOME: h.home,
    });
  });

  test("only the fields the body gave become flags, each named as forge:shift run names it, so the CLI applies its own defaults to the rest", async () => {
    const h = await start();
    const every = {
      for: "90m",
      concurrency: 3,
      maxBeads: 5,
      maxUsd: 2.5,
      repairs: 0,
      epic: "demo-epic",
      smith: "claude-master",
      runTimeout: "20m",
      base: "release/next",
    };
    expect((await startShift(h, every)).status).toBe(202);
    // A shift with a record is no longer starting, so the next start may go.
    writeShiftRecord(shifts(h), record(h.shifts.minted[0] ?? "", h.workspace));
    const some = await startShift(h, { maxUsd: 4, epic: "demo-epic" });
    expect(some.status).toBe(202);
    expect(some.body.data?.requested).toEqual({ maxUsd: 4, epic: "demo-epic" });
    expect(
      h.shifts.launches.map((launch) => launch.spec.argv.slice(5)),
    ).toEqual([
      [
        "--for",
        "90m",
        "--concurrency",
        "3",
        "--max-beads",
        "5",
        "--max-usd",
        "2.5",
        "--repairs",
        "0",
        "--epic",
        "demo-epic",
        "--smith",
        "claude-master",
        "--run-timeout",
        "20m",
        "--base",
        "release/next",
      ],
      ["--max-usd", "4", "--epic", "demo-epic"],
    ]);
  });

  test("a body forge:shift run or the shift's own check would refuse is 400 naming the field, with no audit row, no id minted and nothing started", async () => {
    const h = await start();
    const refused: Array<[unknown, string]> = [
      [{ filter: { epic: "demo-epic" } }, "Unknown field"],
      [{ concurrency: 2, merge: true }, "Unknown field"],
      [[], "Expected a JSON object"],
      [{ for: "soon" }, "for: expected a duration such as 90s, 30m or 2h"],
      [{ for: 7200000 }, "for: expected a duration such as 90s, 30m or 2h"],
      [{ for: "25h" }, "for (in milliseconds): expected a whole number from 1"],
      [{ runTimeout: "1d" }, "runTimeout: expected a duration"],
      [{ concurrency: "2" }, "concurrency: expected a number"],
      [{ concurrency: 0 }, "concurrency: expected a whole number from 1 to 8"],
      [{ concurrency: 1.5 }, "concurrency: expected a whole number"],
      [{ maxBeads: 101 }, "maxBeads: expected a whole number from 1 to 100"],
      [{ maxUsd: 0 }, "maxUsd: expected dollars above 0"],
      [{ maxUsd: 1001 }, "maxUsd: expected dollars above 0, at most 1000"],
      [{ repairs: -1 }, "repairs: expected a whole number from 0 to 10"],
      [{ epic: "not an id" }, "epic: expected a Beads issue id"],
      [{ epic: "--help" }, "epic needs a value"],
      [{ smith: "-x" }, "smith: expected the name of a configured smith"],
      [{ smith: 5 }, "smith: expected a string"],
      // Names a smith or a branch may take, but that read as a token.
      [{ smith: TOKEN }, "smith: must not look like a secret"],
      [{ base: TOKEN }, "base: must not look like a secret"],
      [{ base: "HEAD" }, "base: expected the name of a branch on origin"],
      [
        { base: "shift/shift-20261015-120000-0001/demo-1" },
        "base: expected the name of a branch on origin",
      ],
      [{ base: "-x" }, "base: expected the name of a branch on origin"],
    ];
    for (const [body, error] of refused) {
      const response = await startShift(h, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect({ body, error: response.body.error }).toEqual({
        body,
        error: expect.stringContaining(error),
      });
    }
    expect(h.events()).toEqual([]);
    expect(h.shifts.minted).toEqual([]);
    expect(h.shifts.launches).toEqual([]);
  });

  test("the audit row names the minted id and is stored before the child is started", async () => {
    const h = await start();
    const id = h.shifts.next();
    // What the ledger held as each child was started.
    const atLaunch: unknown[][] = [];
    h.shifts.onLaunch = () => {
      atLaunch.push(h.events().map((event) => event.payload));
    };
    const started = await startShift(h, { for: "2h" });
    const audit = {
      action: "shift.start",
      surface: "api" as const,
      target: id,
    };
    expect(atLaunch).toEqual([[audit]]);
    expect(started.status).toBe(202);
    expect(h.events().map((event) => [event.kind, event.payload])).toEqual([
      ["operator.action", audit],
    ]);
  });

  test("without the operator token, or from another origin, it is 403: no audit row, no id minted and nothing started", async () => {
    const h = await start();
    for (const headers of [
      h.headers(),
      h.headers("0".repeat(h.hearth.token.length)),
      { ...h.headers(h.hearth.token), Origin: "https://evil.example" },
      {
        "Content-Type": "application/json",
        [OPERATOR_HEADER]: h.hearth.token,
      },
    ])
      expect((await startShift(h, {}, headers)).status).toBe(403);
    expect(h.events()).toEqual([]);
    expect(h.shifts.minted).toEqual([]);
    expect(h.shifts.launches).toEqual([]);
  });

  test("a second start while one this hearth started has no record yet is 409 and starts nothing; once the first has its record, or has failed, a start goes, and two shifts run at once", async () => {
    // All in one millisecond: the later start is listed first by the tie-break, not by the clock.
    const h = await oneInstant();
    const first = h.shifts.next();
    expect((await startShift(h, {})).status).toBe(202);
    const busy = await startShift(h, { concurrency: 1 });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toContain(`${first} is still starting`);
    expect(busy.body.error).toContain("Nothing was started.");
    expect(h.shifts.launches).toHaveLength(1);
    // The refusal is the effect's: the attempt was audited, as every refused effect is.
    expect(h.events(["operator.action"])).toHaveLength(2);

    // The first writes its record (its base was fetched): it is running, and a second may start.
    writeShiftRecord(
      shifts(h),
      record(first, h.workspace, { startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    const second = h.shifts.next();
    expect((await startShift(h, {})).status).toBe(202);
    // The second ends before writing one: failed, so it holds nothing up either.
    h.shifts.launches[1]?.exit({ exitCode: 1 });
    await h.shifts.launches[1]?.done;
    expect((await startShift(h, {})).status).toBe(202);
    expect(h.shifts.launches).toHaveLength(3);
    const third = h.shifts.minted.at(-1) ?? "";
    expect((await list(h)).map((each) => [each.shiftId, each.state])).toEqual([
      [third, "starting"],
      [second, "failed"],
      [first, "running"],
    ]);
  });

  test("a shift that ends before writing its record is listed as failed, with its exit code and the error it printed, secrets redacted; one that printed none, with the end of its stderr; neither is listed once its record exists", async () => {
    const h = await oneInstant();
    const printed = h.shifts.next();
    await startShift(h, {});
    h.shifts.launches[0]?.exit({
      exitCode: 1,
      stdout: `${JSON.stringify(
        {
          ok: false,
          data: null,
          error: `the base could not be fetched (git fetch origin master failed: fatal: https://x:${TOKEN}@github.com/a/b.git denied); nothing was started`,
        },
        null,
        2,
      )}\n`,
      stderr: `${JSON.stringify({ shiftId: printed, stop: "bun run forge:shift stop" })}\n`,
    });
    await h.shifts.launches[0]?.done;
    const crashed = h.shifts.next();
    await startShift(h, { base: "master" });
    h.shifts.launches[1]?.exit({
      exitCode: 3,
      stdout: "",
      stderr: `${JSON.stringify({ shiftId: crashed, stop: "x" })}\nTypeError: boom near ${TOKEN}\n    at run (shift-cli.ts:1:1)\n`,
    });
    await h.shifts.launches[1]?.done;

    const [printedPid = -1, crashedPid = -1] = h.shifts.launches.map(
      (child) => child.pid,
    );
    const listed = await list(h);
    expect(listed).toEqual([
      {
        shiftId: crashed,
        state: "failed",
        pid: crashedPid,
        alive: false,
        workspace: h.workspace,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        requested: { base: "master" },
        exitCode: 3,
        error:
          "the shift exited 3 before it wrote its record: TypeError: boom near [REDACTED:github-token] at run (shift-cli.ts:1:1)",
      },
      {
        shiftId: printed,
        state: "failed",
        pid: printedPid,
        alive: false,
        workspace: h.workspace,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        requested: {},
        exitCode: 1,
        error:
          "the shift exited 1 before it wrote its record: the base could not be fetched (git fetch origin master failed: fatal: https://x:[REDACTED:github-token]@github.com/a/b.git denied); nothing was started",
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);

    // A record under the id (one the shift wrote and then failed after) is what is listed.
    writeShiftRecord(
      shifts(h),
      record(printed, h.workspace, { state: "stopped", reason: "halted" }),
    );
    expect((await list(h)).map((each) => [each.shiftId, each.state])).toEqual([
      [crashed, "failed"],
      [printed, "stopped"],
    ]);
  });

  test("a start under an id this hearth has started already (two requests that minted it at once) is 409 and starts nothing", async () => {
    const h = await start();
    const row = h.hearth.routes.find(
      (route) => route.kind === "action" && route.path === "/shifts",
    );
    if (row?.kind !== "action") throw new Error("POST /shifts is not mounted");
    const id = "shift-20261015-120000-0e33";
    // Both requests passed validation with the same id; the first has its record by the time the second starts.
    const first = await row.effect({ shiftId: id, flags: [], requested: {} });
    expect(first.status).toBe(202);
    writeShiftRecord(shifts(h), record(id, h.workspace));
    const second = await row.effect({
      shiftId: id,
      flags: ["--for", "1h"],
      requested: { for: "1h" },
    });
    expect(second).toEqual({
      status: 409,
      error: `${id} was started by this control plane already; no shift was started`,
    });
    expect(h.shifts.launches).toHaveLength(1);
  });

  test("a child that cannot be started is 502 with the reason, after its audit row, and is not listed", async () => {
    const h = await start();
    h.shifts.onLaunch = () => {
      throw new Error(`spawn ENOENT near ${TOKEN}`);
    };
    const failed = await startShift(h, {});
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe(
      "The shift could not be started: spawn ENOENT near [REDACTED:github-token]",
    );
    expect(h.events(["operator.action"])).toHaveLength(1);
    expect(await list(h)).toEqual([]);
  });

  test("GET /shifts lists CLI-started records and this hearth's starts together, newest first, and only this workspace's records", async () => {
    const h = await oneInstant();
    writeShiftRecord(
      shifts(h),
      record("shift-20261014-090000-0001", h.workspace, {
        pid: 2_000_000_000,
        state: "stopped",
        reason: "elapsed",
      }),
    );
    writeShiftRecord(
      shifts(h),
      record("shift-20261014-110000-0001", "c:/another/checkout"),
    );
    const starting = h.shifts.next();
    await startShift(h, {});
    expect(
      (await list(h)).map((each) => [each.shiftId, each.state, each.alive]),
    ).toEqual([
      [starting, "starting", true],
      ["shift-20261014-090000-0001", "stopped", false],
    ]);
  });

  test("GET /shifts breaks a tie in startedAt the same way every time: this hearth's starts first, the later launch first, then records by id, descending", async () => {
    const h = await oneInstant();
    // Written in the order that would come out of a sort by time alone.
    for (const id of [
      "shift-20261015-120000-0a01",
      "shift-20261015-120000-0b02",
    ])
      writeShiftRecord(
        shifts(h),
        record(id, h.workspace, { startedAt: INSTANT }),
      );
    const earlier = h.shifts.next();
    await startShift(h, {});
    h.shifts.launches[0]?.exit({ exitCode: 1 });
    await h.shifts.launches[0]?.done;
    const later = h.shifts.next();
    await startShift(h, {});
    const listed = await list(h);
    expect(listed.every((each) => each.startedAt === INSTANT)).toBe(true);
    expect(listed.map((each) => [each.shiftId, each.state])).toEqual([
      [later, "starting"],
      [earlier, "failed"],
      ["shift-20261015-120000-0b02", "running"],
      ["shift-20261015-120000-0a01", "running"],
    ]);
  });

  test("a stop or a recover of a start that has no record yet is 409 and writes no stop request; another workspace's shift is still 404", async () => {
    const h = await start();
    const id = h.shifts.next();
    await startShift(h, {});
    const stopped = await post(h, `/shifts/${id}/stop`);
    expect(stopped.status).toBe(409);
    expect(stopped.body.error).toContain(`${id} is still starting`);
    const recovered = await post(h, `/shifts/${id}/recover`);
    expect(recovered.status).toBe(409);
    expect(recovered.body.error).toContain(`${id} is still starting`);
    expect(existsSync(join(shifts(h), `${id}.stop`))).toBe(false);
    expect(h.bd.calls).toEqual([]);
    const other = "shift-20261015-090000-0e20";
    writeShiftRecord(shifts(h), record(other, "c:/another/checkout"));
    expect((await post(h, `/shifts/${other}/stop`)).status).toBe(404);
  });
});

describe("POST /shifts/:id/stop", () => {
  test("asks a running shift to stop: the audit row first, then the stop request the shift looks for; a second ask says it was asked already", async () => {
    const h = await start();
    const id = "shift-20261014-100000-0002";
    writeShiftRecord(shifts(h), record(id, h.workspace));
    const first = await post(h, `/shifts/${id}/stop`);
    expect(first).toEqual({
      status: 200,
      body: { ok: true, data: { shiftId: id, already: false }, error: null },
    });
    expect(existsSync(join(shifts(h), `${id}.stop`))).toBe(true);
    const second = await post(h, `/shifts/${id}/stop`);
    expect(second.body.data).toEqual({ shiftId: id, already: true });
    expect(h.events().map((event) => [event.kind, event.payload])).toEqual([
      ["operator.action", { action: "shift.stop", surface: "api", target: id }],
      ["operator.action", { action: "shift.stop", surface: "api", target: id }],
    ]);
  });

  test("no such shift, and a shift of another workspace, are 404; a stopped one is 409; none of them gets a stop request", async () => {
    const h = await start();
    const other = "shift-20261014-100000-0003";
    const stopped = "shift-20261014-100000-0004";
    writeShiftRecord(shifts(h), record(other, "c:/another/checkout"));
    writeShiftRecord(
      shifts(h),
      record(stopped, h.workspace, { state: "stopped", reason: "drained" }),
    );
    expect(
      (await post(h, "/shifts/shift-20261014-100000-0005/stop")).status,
    ).toBe(404);
    expect((await post(h, `/shifts/${other}/stop`)).status).toBe(404);
    const refused = await post(h, `/shifts/${stopped}/stop`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("has stopped already (drained)");
    for (const id of [other, stopped])
      expect(existsSync(join(shifts(h), `${id}.stop`))).toBe(false);
  });

  test("an id that is not a shift's is 400 and writes nothing; without the operator token it is 403 and writes nothing", async () => {
    const h = await start();
    const id = "shift-20261014-100000-0006";
    writeShiftRecord(shifts(h), record(id, h.workspace));
    expect((await post(h, "/shifts/shift-nope/stop")).status).toBe(400);
    expect((await post(h, `/shifts/${id}/stop`, null)).status).toBe(403);
    expect(existsSync(join(shifts(h), `${id}.stop`))).toBe(false);
    expect(h.events()).toEqual([]);
  });
});

describe("POST /shifts/:id/recover", () => {
  /** No process has this id. */
  const DEAD = 2_000_000_000;

  /**
   * A shift of this workspace that died running `h-1`: the bead started as
   * the scheduler and its reservation taken, each event with its run id, as
   * the shift writes them; the hearth's bd answers from the same tracker.
   */
  async function deadShift(
    h: TestHearth,
    id: string,
  ): Promise<{ tracker: QueueTracker; runId: string }> {
    const tracker = queueTracker([
      {
        id: "h-1",
        labels: ["queue:queued"],
        metadata: { queue_state: "queued" },
      },
    ]);
    h.bd.answer = (args) => tracker.answer(args) ?? tracker.answerComment(args);
    const runId = `h-1-${id}`;
    const append = (event: LedgerEventInput) =>
      appendEvent({ ...event, runId }, { path: h.ledger });
    const lockFile = join(h.home, QUEUE_LOCK_FILE);
    const started = await createQueue({
      workspace: h.workspace,
      runBd: tracker.run,
      appendEvent: append,
      lockFile,
    }).move("h-1", "start", "scheduler");
    if (!started.ok) throw new Error(started.error);
    const worktree = join(h.root, "trees", `${id}-1`);
    const reserved = await reserve(
      { beadId: "h-1", worktree, globs: ["src/h-1/**"] },
      {
        workspace: h.workspace,
        ledgerPath: h.ledger,
        appendEvent: append,
        lockFile,
      },
    );
    if (!reserved.ok) throw new Error(reserved.error);
    writeShiftRecord(
      shifts(h),
      record(id, h.workspace, {
        pid: DEAD,
        beads: [
          { beadId: "h-1", runId, outcome: "running", attempts: 1, worktree },
        ],
      }),
    );
    return { tracker, runId };
  }

  const recover = async (
    h: TestHearth,
    id: string,
    token: string | null = h.hearth.token,
  ) =>
    answer<Recovery>(
      await fetch(`${h.api}/shifts/${id}/recover`, {
        method: "POST",
        headers: h.headers(token),
        body: "{}",
      }),
    );

  test("recovers a dead shift of this workspace: the audit row first, then its bead released to queued, its reservation freed and shift.stopped recorded; the record is closed", async () => {
    const h = await start();
    const id = "shift-20261015-090000-0e01";
    const { tracker, runId } = await deadShift(h, id);
    const seen = h.events().length;

    const recovered = await recover(h, id);
    expect(recovered.status).toBe(200);
    expect(recovered.body.data).toMatchObject({
      shiftId: id,
      complete: true,
      stopped: "recorded",
      beads: [{ beadId: "h-1", runId, outcome: "released" }],
      reservations: [{ beadId: "h-1", outcome: "released" }],
    });
    expect(
      h
        .events()
        .slice(seen)
        .map((event) => [event.kind, event.payload]),
    ).toEqual([
      [
        "operator.action",
        { action: "shift.recover", surface: "api", target: id },
      ],
      [
        "bead.transitioned",
        { from: "running", to: "queued", reason: "release:scheduler" },
      ],
      [
        "reservation.released",
        {
          worktree: expect.any(String),
          globs: ["src/h-1/**"],
        },
      ],
      ["shift.stopped", { shiftId: id, reason: "recovered" }],
    ]);
    expect(tracker.beads.get("h-1")?.labels).toEqual(["queue:queued"]);
    expect(tracker.beads.get("h-1")?.comments).toHaveLength(1);
    expect(
      activeReservations({ workspace: h.workspace }, { path: h.ledger }),
    ).toEqual([]);
    expect(readShiftRecord(shifts(h), id)).toMatchObject({
      state: "stopped",
      reason: "recovered",
    });
  });

  test("no such shift and another workspace's are 404; a stopped one, one whose process is alive and one whose record it cannot read are 409; an id that is not a shift's is 400 with no audit row; none of them moves a bead or changes a record", async () => {
    const h = await start();
    const other = "shift-20261015-090000-0e02";
    const stopped = "shift-20261015-090000-0e03";
    const alive = "shift-20261015-090000-0e04";
    writeShiftRecord(
      shifts(h),
      record(other, "c:/another/checkout", { pid: DEAD }),
    );
    writeShiftRecord(
      shifts(h),
      record(stopped, h.workspace, { state: "stopped", reason: "drained" }),
    );
    writeShiftRecord(shifts(h), record(alive, h.workspace));
    const files = [other, stopped, alive].map((id) =>
      readFileSync(join(shifts(h), `${id}.json`), "utf8"),
    );

    expect((await recover(h, "shift-nope")).status).toBe(400);
    expect(h.events()).toEqual([]);
    expect((await recover(h, "shift-20261015-090000-0e05")).status).toBe(404);
    expect((await recover(h, other)).status).toBe(404);
    const done = await recover(h, stopped);
    expect(done.status).toBe(409);
    expect(done.body.error).toContain("has stopped already (drained)");
    const running = await recover(h, alive);
    expect(running.status).toBe(409);
    expect(running.body.error).toContain(`pid ${process.pid}) is running`);
    expect((await recover(h, alive, null)).status).toBe(403);
    // A record whose fields are not a shift's is refused, not a 500.
    const broken = "shift-20261015-090000-0e07";
    // justification: a field the record's type does not allow is the case under test.
    writeShiftRecord(shifts(h), {
      ...record(broken, h.workspace, { pid: DEAD }),
      workspace: 5,
    } as unknown as ShiftRecord);
    const unreadable = await recover(h, broken);
    expect(unreadable.status).toBe(409);
    expect(unreadable.body.error).toContain("is not one recovery can read");

    expect(h.bd.calls).toEqual([]);
    expect(h.events().map((event) => event.kind)).toEqual([
      "operator.action",
      "operator.action",
      "operator.action",
      "operator.action",
      "operator.action",
    ]);
    expect(
      [other, stopped, alive].map((id) =>
        readFileSync(join(shifts(h), `${id}.json`), "utf8"),
      ),
    ).toEqual(files);
  });

  test("a recovery that cannot finish is 502, says what is left, and leaves the record running and the bead running", async () => {
    const h = await start();
    const id = "shift-20261015-090000-0e06";
    const { tracker } = await deadShift(h, id);
    h.bd.answer = (args) =>
      args[0] === "update"
        ? { status: 1, stdout: "", stderr: "Error: database is locked\n" }
        : (tracker.answer(args) ?? tracker.answerComment(args));
    const recovered = await recover(h, id);
    expect(recovered.status).toBe(502);
    expect(recovered.body.error).toContain(`${id} is not recovered yet`);
    expect(recovered.body.error).toContain("h-1: release:");
    expect(recovered.body.error).toContain("recover it again");
    expect(tracker.beads.get("h-1")?.labels).toEqual(["queue:running"]);
    expect(readShiftRecord(shifts(h), id)?.state).toBe("running");
    expect(h.events(["shift.stopped"])).toEqual([]);
  });
});
