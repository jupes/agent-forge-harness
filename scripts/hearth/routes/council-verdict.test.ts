import { afterEach, describe, expect, test } from "bun:test";
import type { LedgerEvent } from "../../../types/hearth";
import type { CommandResult, CommandRunner } from "../../council/pr-source";
import type { CouncilServiceJob } from "../../council/service";
import type {
  AggregatedFinding,
  ChairOutput,
  CouncilRun,
} from "../../council/types";
import { hashText } from "../../hash-text";
import { bdAnswers } from "../bd-answers";
import { OPERATOR_HEADER } from "../paths";
import { startTestHearth, type TestHearth } from "../testing";
import { councilVerdictComment } from "./council-verdict";

/**
 * The verdict of a council run on a bead, posted back to the bead by the
 * hearth that started the run (`x1gs.7.2`). What each end of a run posts:
 *
 * - completed: one `review:` comment naming the run, its outcome as the ledger
 *   records it (PASS, FAIL or UNREADABLE) and its findings by severity;
 * - failed or cancelled: nothing at all.
 */

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function start(): Promise<TestHearth> {
  const hearth = await startTestHearth({ councilRuns: true });
  open.push(hearth);
  return hearth;
}

function post(h: TestHearth, path: string, body: unknown): Promise<Response> {
  return fetch(`${h.api}${path}`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify(body),
  });
}

/** A stored run, read with the operator token as the page reads it. */
async function job(h: TestHearth, runId: string): Promise<CouncilServiceJob> {
  const response = await fetch(`${h.api}/council-api/runs/${runId}`, {
    headers: { [OPERATOR_HEADER]: h.hearth.token },
  });
  const body = (await response.json()) as { data: CouncilServiceJob | null };
  if (response.status !== 200 || body.data === null)
    throw new Error(`council run ${runId} could not be read`);
  return body.data;
}

async function startRun(h: TestHearth, body: Record<string, unknown>) {
  const response = await post(h, "/council/runs", body);
  expect(response.status).toBe(202);
}

/** Wait until the run has ended, and answer it as it ended. */
async function ended(h: TestHearth, runId: string): Promise<CouncilServiceJob> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const read = await job(h, runId);
    if (read.status !== "running" && read.status !== "cancelling") return read;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`council run ${runId} did not end`);
}

/** The `comments add` calls the API's bd has been given, oldest first. */
const commentCalls = (h: TestHearth): string[][] =>
  h.bd.calls.filter((call) => call[0] === "comments");

/** Wait until the API's bd has been given `count` comment writes. */
async function commentWrites(h: TestHearth, count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (commentCalls(h).length >= count) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`expected ${count} comment write(s)`);
}

/** Wait until the ledger holds `count` events of `kind`. */
async function eventsOfKind(
  h: TestHearth,
  kind: LedgerEvent["kind"],
  count: number,
): Promise<LedgerEvent[]> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const found = h.events([kind]);
    if (found.length >= count) return found;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`expected ${count} ${kind} event(s)`);
}

const printed = (value: unknown): CommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});

/** The council's two reads of a bead, answered for every id in `ids`. */
function beadReads(ids: string[], hold?: Promise<void>): CommandRunner {
  return async (command) => {
    const [bd, readonly, verb, id] = command;
    if (bd !== "bd" || readonly !== "--readonly" || !ids.includes(id ?? ""))
      return { exitCode: 2, stdout: "", stderr: "not arranged" };
    if (verb === "show") {
      await hold;
      return printed([
        {
          id,
          title: "Teach the kiln to report its temperature",
          acceptance_criteria: "[ ] The reading is in Celsius.",
          status: "in_progress",
          priority: 2,
          issue_type: "task",
        },
      ]);
    }
    return printed([]);
  };
}

/** The verdict text a completed run on `demo-7` is expected to post, read from the run and the ledger. */
function expectedVerdict(read: CouncilServiceJob, outcome: string): string {
  const findings = read.run?.aggregatedFindings ?? [];
  const count = (severity: string) =>
    findings.filter((finding) => finding.severity === severity).length;
  return `review: COUNCIL ${read.runId} ${outcome.toUpperCase()} — findings ${count("blocker")}/${count("high")}/${count("medium")}/${count("low")} (blocker/high/medium/low)`;
}

describe("the verdict comment", () => {
  const finding = (severity: AggregatedFinding["severity"]) =>
    // justification: the comment reads only the severity of a finding.
    ({ severity }) as AggregatedFinding;
  const chair = (verdict: ChairOutput["verdict"]) =>
    // justification: the comment reads only the chair's verdict.
    ({ verdict, summary: "the chair's summary" }) as ChairOutput;
  const ended = (
    status: CouncilServiceJob["status"],
    run?: Partial<Pick<CouncilRun, "chair" | "aggregatedFindings">>,
  ) => ({
    runId: "council-1-abcdef01",
    status,
    ...(run === undefined
      ? {}
      : {
          run: {
            status:
              status === "running" || status === "cancelling"
                ? ("completed" as const)
                : status,
            aggregatedFindings: [],
            ...run,
          },
        }),
  });

  test("a completed run names itself, its outcome as the ledger records it, and its findings by severity", () => {
    const cases: Array<[ReturnType<typeof ended>, string]> = [
      [
        ended("completed", {
          chair: chair("pass"),
          aggregatedFindings: [
            finding("low"),
            finding("medium"),
            finding("low"),
          ],
        }),
        "PASS — findings 0/0/1/2",
      ],
      [
        ended("completed", {
          chair: chair("needs_changes"),
          aggregatedFindings: [finding("blocker"), finding("high")],
        }),
        "FAIL — findings 1/1/0/0",
      ],
      [
        ended("completed", { chair: chair("insufficient_evidence") }),
        "UNREADABLE — findings 0/0/0/0",
      ],
      [
        ended("completed", { aggregatedFindings: [finding("high")] }),
        "FAIL — findings 0/1/0/0",
      ],
    ];
    for (const [input, verdict] of cases)
      expect(councilVerdictComment(input)).toBe(
        `review: COUNCIL council-1-abcdef01 ${verdict} (blocker/high/medium/low)`,
      );
  });

  test("a failed, cancelled or unfinished run, or a completed job with no run, has none", () => {
    for (const input of [
      ended("failed", { chair: chair("pass") }),
      ended("failed"),
      ended("cancelled", { chair: chair("pass") }),
      ended("cancelled"),
      ended("running", { chair: chair("pass") }),
      ended("cancelling", { chair: chair("pass") }),
      ended("completed"),
    ])
      expect({ input, comment: councilVerdictComment(input) }).toEqual({
        input,
        comment: null,
      });
  });
});

describe("a council run the hearth started on a bead", () => {
  test("start refuses an outcome word as a run id, in any case, before starting a run: no run is stored or recorded, and nothing reaches bd or the council's runner", async () => {
    const h = await start();
    h.commands.answer = beadReads(["demo-7"]);
    for (const runId of [
      "PASS",
      "pass",
      "PaSs",
      "FAIL",
      "fail",
      "FaIl",
      "UNREADABLE",
      "unreadable",
      "UnReAdAbLe",
    ]) {
      const response = await post(h, "/council/runs", {
        sourceType: "bead",
        source: "demo-7",
        runId,
      });
      expect({
        runId,
        status: response.status,
        body: await response.json(),
      }).toMatchObject({
        runId,
        status: 400,
        body: { error: "runId must not be a council outcome word" },
      });
      const read = await fetch(`${h.api}/council-api/runs/${runId}`, {
        headers: { [OPERATOR_HEADER]: h.hearth.token },
      });
      expect(((await read.json()) as { data: unknown }).data).toBeNull();
    }
    expect(h.events(["council.run.started"])).toEqual([]);
    expect(h.bd.calls).toEqual([]);
    expect(h.commands.calls).toEqual([]);
  });

  test("an id that only starts with an outcome word is still a run id: it starts, is read and is cancelled", async () => {
    const h = await start();
    let release = () => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    // Each run is held in its first read of the bead until it is cancelled.
    h.commands.answer = beadReads(["demo-7"], hold);
    const ids = ["PASS-1", "pass-review"];
    for (const runId of ids)
      await startRun(h, { sourceType: "bead", source: "demo-7", runId });
    for (let i = 0; i < 200 && h.commands.calls.length < ids.length; i++)
      await new Promise((done) => setTimeout(done, 10));
    for (const runId of ids) {
      expect((await job(h, runId)).runId).toBe(runId);
      const cancelled = await post(h, `/council/runs/${runId}/cancel`, {});
      expect({ runId, status: cancelled.status }).toEqual({
        runId,
        status: 200,
      });
    }
    release();
    for (const runId of ids)
      expect({ runId, status: (await ended(h, runId)).status }).toEqual({
        runId,
        status: "cancelled",
      });
  }, 20_000);

  test("that completes posts its verdict to the bead once, through the API's bd, after the run's finished event, and records the write as the comment row does", async () => {
    const h = await start();
    h.commands.answer = beadReads(["demo-7"]);
    await startRun(h, {
      sourceType: "bead",
      source: "demo-7",
      runId: "verdict-done",
    });
    const read = await ended(h, "verdict-done");
    expect(read.status).toBe("completed");
    const written = await eventsOfKind(h, "bead.transitioned", 1);
    const [finished] = h
      .events(["council.run.finished"])
      .filter(
        (event) =>
          event.kind === "council.run.finished" &&
          event.payload.councilRunId === "verdict-done",
      );
    if (finished?.kind !== "council.run.finished")
      throw new Error("the run recorded no finished event");
    const text = expectedVerdict(read, finished.payload.outcome);
    // The fake council always finds something, so the count is not all zeros.
    expect(text).not.toContain("findings 0/0/0/0");
    expect(h.bd.calls).toEqual([
      ["comments", "add", "--json", "--", "demo-7", text],
    ]);
    expect(
      written.map((event) => [event.beadId, event.payload, event.id]),
    ).toEqual([
      [
        "demo-7",
        { action: "comment", hash: hashText(text), length: text.length },
        expect.any(Number),
      ],
    ]);
    expect(written[0]?.id ?? 0).toBeGreaterThan(finished.id);
    // The council's own reads went to the council's runner, never the API's bd.
    expect(
      h.commands.calls.map(({ command }) => command.slice(0, 3).join(" ")),
    ).toEqual(["bd --readonly show", "bd --readonly comments"]);
  }, 20_000);

  test("that fails posts nothing: no comment write and no tracker event, while a run on another bead that completes after it does post", async () => {
    const h = await start();
    // demo-7's reads are refused, so its run fails while packing.
    h.commands.answer = beadReads(["demo-8"]);
    await startRun(h, {
      sourceType: "bead",
      source: "demo-7",
      runId: "verdict-failed",
    });
    expect((await ended(h, "verdict-failed")).status).toBe("failed");
    await startRun(h, {
      sourceType: "bead",
      source: "demo-8",
      runId: "verdict-control",
    });
    expect((await ended(h, "verdict-control")).status).toBe("completed");
    await commentWrites(h, 1);
    expect(commentCalls(h).map((call) => call[4])).toEqual(["demo-8"]);
    expect(
      (await eventsOfKind(h, "bead.transitioned", 1)).map(
        (event) => event.beadId,
      ),
    ).toEqual(["demo-8"]);
  }, 20_000);

  test("that is cancelled posts nothing", async () => {
    const h = await start();
    let release = () => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    h.commands.answer = beadReads(["demo-7"], hold);
    await startRun(h, {
      sourceType: "bead",
      source: "demo-7",
      runId: "verdict-cancelled",
    });
    // The run is held in its first read of the bead until it is cancelled.
    for (let i = 0; i < 200 && h.commands.calls.length === 0; i++)
      await new Promise((done) => setTimeout(done, 10));
    const cancelled = await post(
      h,
      "/council/runs/verdict-cancelled/cancel",
      {},
    );
    expect(cancelled.status).toBe(200);
    release();
    expect((await ended(h, "verdict-cancelled")).status).toBe("cancelled");
    h.commands.answer = beadReads(["demo-8"]);
    await startRun(h, {
      sourceType: "bead",
      source: "demo-8",
      runId: "verdict-control",
    });
    expect((await ended(h, "verdict-control")).status).toBe("completed");
    await commentWrites(h, 1);
    expect(commentCalls(h).map((call) => call[4])).toEqual(["demo-8"]);
  }, 20_000);

  test("a run of another source that names a bead only to be recorded against it posts nothing", async () => {
    const h = await start();
    h.commands.answer = beadReads(["demo-8"]);
    await startRun(h, {
      sourceType: "text",
      source: "Review the kiln's temperature report.",
      beadId: "demo-7",
      runId: "verdict-text",
    });
    expect((await ended(h, "verdict-text")).status).toBe("completed");
    await startRun(h, {
      sourceType: "bead",
      source: "demo-8",
      runId: "verdict-control",
    });
    expect((await ended(h, "verdict-control")).status).toBe("completed");
    await commentWrites(h, 1);
    expect(commentCalls(h).map((call) => call[4])).toEqual(["demo-8"]);
  }, 20_000);

  test("a comment bd refuses is not tried again and records no tracker event", async () => {
    const h = await start();
    h.commands.answer = beadReads(["demo-7", "demo-8"]);
    h.bd.answer = (args) =>
      args[0] === "comments" && args[4] === "demo-7"
        ? bdAnswers.refusedOnStdout('no issue found matching "demo-7"', args)
        : undefined;
    await startRun(h, {
      sourceType: "bead",
      source: "demo-7",
      runId: "verdict-refused",
    });
    expect((await ended(h, "verdict-refused")).status).toBe("completed");
    await commentWrites(h, 1);
    await startRun(h, {
      sourceType: "bead",
      source: "demo-8",
      runId: "verdict-control",
    });
    expect((await ended(h, "verdict-control")).status).toBe("completed");
    await commentWrites(h, 2);
    expect(commentCalls(h).map((call) => call[4])).toEqual([
      "demo-7",
      "demo-8",
    ]);
    expect(
      (await eventsOfKind(h, "bead.transitioned", 1)).map(
        (event) => event.beadId,
      ),
    ).toEqual(["demo-8"]);
  }, 20_000);
});
