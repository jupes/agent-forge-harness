import { afterEach, describe, expect, test } from "bun:test";
import { dashboardSections } from "../../../docs/js/islands/issues-views-model";
import type { BeadsPayload } from "../../../types/beads";
import type { BeadCounts, OperatorEnvelope } from "../../../types/hearth";
import {
  issuesAndDepsFromExportRows,
  parseBdExportStdout,
  payloadFromIssuesDepsComments,
} from "../../beads-dashboard";
import { startTestHearth, type TestHearth } from "../testing";
import type { BdResult } from "./dev-api";

/**
 * `GET /beads/counts`: the dashboard's four Beads cards, read from the
 * tracker through the hearth's `bd` runner. The `bd` here is the test
 * hearth's recorder; nothing reaches a tracker.
 */

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function start(): Promise<TestHearth> {
  const hearth = await startTestHearth();
  open.push(hearth);
  return hearth;
}

async function read(
  h: TestHearth,
  path = "/beads/counts",
): Promise<{ status: number; body: OperatorEnvelope<BeadCounts> }> {
  const response = await fetch(`${h.api}${path}`, { headers: h.headers() });
  return {
    status: response.status,
    // justification: the envelope's data is the route's own type; the test reads it as such.
    body: (await response.json()) as OperatorEnvelope<BeadCounts>,
  };
}

const exportCalls = (h: TestHearth): string[][] =>
  h.bd.calls.filter((call) => call[0] === "export");

/** One `bd export` line: an issue with the dependencies it has, as bd prints them. */
function row(
  id: string,
  status: string,
  dependsOn: Array<[string, string]> = [],
): string {
  return JSON.stringify({
    id,
    title: `Title ${id}`,
    status,
    priority: 2,
    issue_type: "task",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    dependencies: dependsOn.map(([on, type]) => ({
      issue_id: id,
      depends_on_id: on,
      type,
    })),
  });
}

/**
 * A tracker that exercises each rule of the snapshot's four cards: a deferred
 * issue is open; an issue is blocked by a `blocks` or `requires` blocker that
 * is not closed, whatever its own status, and not by a closed blocker or by
 * its parent; a stored status of `blocked` alone counts in no card.
 */
const EXPORT = [
  row("o-1", "open"),
  row("o-2", "deferred"),
  row("p-1", "in_progress"),
  row("c-1", "closed"),
  row("c-2", "closed"),
  row("b-1", "open", [["p-1", "blocks"]]),
  row("b-3", "in_progress", [["o-1", "requires"]]),
  row("b-2", "open", [["c-1", "blocks"]]),
  row("k-1", "open", [["p-1", "parent-child"]]),
  row("s-1", "blocked"),
].join("\n");

const exported = (stdout: string): BdResult => ({
  status: 0,
  stdout,
  stderr: "",
});

/** Wait, at most a second, until `ready` holds. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("waited a second for nothing");
    await Bun.sleep(5);
  }
}

describe("GET /beads/counts", () => {
  test("answers the four cards from one read-only bd export, by the snapshot builder's rules", async () => {
    const h = await start();
    h.bd.answer = (args) =>
      args[0] === "export" ? exported(`${EXPORT}\n`) : undefined;

    const answer = await read(h);

    expect(answer.status).toBe(200);
    expect(answer.body.data).toEqual({
      open: 5,
      inProgress: 2,
      blocked: 2,
      closed: 2,
    });
    // The same numbers the dashboard draws from a snapshot built from these rows.
    const { issues, deps } = issuesAndDepsFromExportRows(
      parseBdExportStdout(EXPORT),
    );
    const payload: BeadsPayload = {
      version: "1.0.0",
      generatedAt: "2026-10-01T00:00:00.000Z",
      ...payloadFromIssuesDepsComments(issues, deps, []),
    };
    expect(answer.body.data).toEqual(dashboardSections(payload, "all").stats);
    expect(exportCalls(h)).toEqual([["export", "--readonly", "--no-memories"]]);
  });

  test("is not a stream collection", async () => {
    const h = await start();
    const row = h.hearth.routes.find(
      (route) => route.method === "GET" && route.path === "/beads/counts",
    );
    expect(row?.kind).toBe("read");
    expect(
      row?.kind === "read" ? row.collection : "not a read",
    ).toBeUndefined();
  });

  test("answers 502 with bd's error when bd fails, not zero counts", async () => {
    const h = await start();
    h.bd.answer = (args) =>
      args[0] === "export"
        ? { status: 1, stdout: "", stderr: "Error: database is locked\n" }
        : undefined;

    const answer = await read(h);

    expect(answer.status).toBe(502);
    expect(answer.body.ok).toBe(false);
    expect(answer.body.data).toBeNull();
    expect(answer.body.error).toContain("database is locked");
  });

  test("refuses a query parameter without calling bd", async () => {
    const h = await start();

    const answer = await read(h, "/beads/counts?status=open");

    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain("status");
    expect(exportCalls(h)).toEqual([]);
  });

  test("reads that arrive while bd is running share one next call: three reads, two calls", async () => {
    const h = await start();
    const held: Array<(result: BdResult) => void> = [];
    h.bd.answer = (args) =>
      args[0] === "export"
        ? new Promise<BdResult>((done) => held.push(done))
        : undefined;

    const first = read(h);
    await until(() => held.length === 1);
    const second = read(h);
    const third = read(h);
    // Both later reads are waiting; neither has started a call of its own.
    await Bun.sleep(50);
    expect(exportCalls(h)).toHaveLength(1);

    held[0]?.(exported(`${row("o-1", "open")}\n`));
    await until(() => held.length === 2);
    held[1]?.(exported(`${row("o-1", "open")}\n${row("c-1", "closed")}\n`));

    const answers = await Promise.all([first, second, third]);
    expect(answers.map((answer) => answer.body.data)).toEqual([
      { open: 1, inProgress: 0, blocked: 0, closed: 0 },
      { open: 1, inProgress: 0, blocked: 0, closed: 1 },
      { open: 1, inProgress: 0, blocked: 0, closed: 1 },
    ]);
    expect(exportCalls(h)).toHaveLength(2);
  });
});
