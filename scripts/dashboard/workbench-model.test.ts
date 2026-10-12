import { describe, expect, test } from "bun:test";
import {
  COLUMN_ORDER,
  DONE_SHOWN,
  moveOutcome,
  workbenchColumns,
} from "../../docs/js/workbench-model";
import type { QueueEntry } from "../../types/hearth";
import type { Eligibility } from "../scheduler/eligibility";

const entry = (
  beadId: string,
  state: QueueEntry["state"],
  more: Partial<QueueEntry> = {},
): QueueEntry => ({
  beadId,
  title: `title of ${beadId}`,
  state,
  status: "open",
  backed: true,
  ...more,
});

const none: Eligibility = { eligible: [], waiting: [], stale: [] };

describe("workbenchColumns", () => {
  test("one column per state, in the queue's own order", () => {
    const columns = workbenchColumns([], none, "claude-journeyman");
    expect(columns.map((column) => column.state)).toEqual([...COLUMN_ORDER]);
    expect(COLUMN_ORDER).toEqual([
      "proposed",
      "approved",
      "queued",
      "running",
      "review",
      "paused",
      "halted",
      "done",
    ]);
  });

  test("a card carries its moves and its smith, saying when the smith is only the default", () => {
    const columns = workbenchColumns(
      [
        entry("t-1", "proposed"),
        entry("t-2", "approved", { smith: "codex-journeyman" }),
        entry("t-3", "paused", { resume: "queued" }),
      ],
      none,
      "claude-journeyman",
    );
    const card = (id: string) =>
      columns.flatMap((column) => column.cards).find((c) => c.id === id);
    expect(card("t-1")).toMatchObject({
      moves: ["approve", "pause", "reassign"],
      smith: "claude-journeyman",
      smithIsDefault: true,
    });
    expect(card("t-2")).toMatchObject({
      moves: ["queue", "pause", "reassign"],
      smith: "codex-journeyman",
      smithIsDefault: false,
    });
    expect(card("t-3")?.moves).toEqual(["resume", "reassign"]);
  });

  test("a label the queue did not write offers nothing and says so", () => {
    const [proposed] = workbenchColumns(
      [entry("t-1", "proposed", { backed: false })],
      none,
      null,
    );
    expect(proposed?.cards[0]).toMatchObject({ moves: [] });
    expect(proposed?.cards[0]?.note).toContain("did not write");
  });

  test("a bead with two queue labels is shown in both columns, offers nothing, and is marked", () => {
    const columns = workbenchColumns(
      [entry("t-1", "approved"), entry("t-1", "queued")],
      none,
      null,
    );
    const shown = columns.flatMap((column) =>
      column.cards.map((card) => [column.state, card.id, card.moves.length]),
    );
    expect(shown).toEqual([
      ["approved", "t-1", 0],
      ["queued", "t-1", 0],
    ]);
    expect(columns[1]?.cards[0]?.note).toContain("two queue labels");
  });

  test("a queued bead that cannot start says why and on whom it waits; one that can says so", () => {
    const [, , queued] = workbenchColumns(
      [entry("t-1", "queued"), entry("t-2", "queued")],
      {
        eligible: [{ id: "t-1", globs: ["src/**"], conservative: false }],
        waiting: [
          {
            id: "t-2",
            why: "its src/a.ts overlaps src/**, claimed by t-1",
            waitsOn: "t-1",
          },
        ],
        stale: [],
      },
      null,
    );
    expect(queued?.cards.map((card) => [card.id, card.start])).toEqual([
      ["t-1", { may: true }],
      [
        "t-2",
        {
          may: false,
          why: "its src/a.ts overlaps src/**, claimed by t-1",
          waitsOn: "t-1",
        },
      ],
    ]);
  });

  test("Done shows its first entries in natural id order and counts the rest", () => {
    const done = Array.from({ length: DONE_SHOWN + 3 }, (_, i) =>
      entry(`d-${i + 1}`, "done", { status: "closed" }),
    );
    const column = workbenchColumns(done.reverse(), none, null).at(-1);
    expect(column?.cards.length).toBe(DONE_SHOWN);
    expect(column?.cards[0]?.id).toBe("d-1");
    expect(column?.cards[1]?.id).toBe("d-2");
    expect(column?.hidden).toBe(3);
  });

  test("without an eligibility answer, no queued card claims it may or may not start", () => {
    const [, , queued] = workbenchColumns([entry("t-1", "queued")], null, null);
    expect(queued?.cards[0]?.start).toBeUndefined();
  });
});

describe("moveOutcome", () => {
  const answering =
    (status: number, body: string) => async (): Promise<Response> =>
      new Response(body, { status });
  const envelope = (ok: boolean, error: string | null = null) =>
    JSON.stringify({ ok, data: ok ? {} : null, error });

  test("an ok envelope is done", async () => {
    expect(
      await moveOutcome("t-1", "approve", answering(200, envelope(true))),
    ).toEqual({ tone: "done", message: "Approved t-1." });
  });

  test("a refusal is said in the hearth's words; without them, by its status", async () => {
    for (const status of [400, 404, 409, 500, 502, 503])
      expect(
        await moveOutcome(
          "t-1",
          "queue",
          answering(status, envelope(false, `refused with ${status}`)),
        ),
      ).toEqual({ tone: "failed", message: `refused with ${status}` });
    expect(
      await moveOutcome("t-1", "queue", answering(503, "<html>busy</html>")),
    ).toEqual({ tone: "failed", message: "The control plane answered 503." });
  });

  test("a 504, no answer, or a success that is not the envelope: the outcome is not known", async () => {
    const unknown = {
      tone: "unknown" as const,
      message:
        "Outcome not known (pause). Check with `bd show t-1` before trying again.",
    };
    expect(
      await moveOutcome("t-1", "pause", answering(504, envelope(false, "x"))),
    ).toEqual(unknown);
    expect(
      await moveOutcome("t-1", "pause", async () => {
        throw new Error("network down");
      }),
    ).toEqual(unknown);
    expect(
      await moveOutcome("t-1", "pause", answering(200, "<html>proxy</html>")),
    ).toEqual(unknown);
  });
});

test("a paused card that cannot be resumed says why", () => {
  const paused = workbenchColumns([entry("t-1", "paused")], none, null).find(
    (column) => column.state === "paused",
  );
  expect(paused?.cards[0]?.moves).toEqual(["reassign"]);
  expect(paused?.cards[0]?.note).toContain("queue_resume");
});
