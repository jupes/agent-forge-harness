import { describe, expect, test } from "bun:test";
import { createOperatorPost } from "../../docs/js/operator";
import {
  COLUMN_ORDER,
  DONE_SHOWN,
  moveOutcome,
  workbenchColumns,
} from "../../docs/js/workbench-model";
import type { QueueEntry } from "../../types/hearth";
import { TOKEN_ROUTE } from "../hearth/paths";
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

  test("a label the queue did not write offers propose alone, and says it puts the bead in the queue as proposed", () => {
    const [, , queued] = workbenchColumns(
      [entry("t-1", "queued", { backed: false })],
      none,
      null,
    );
    expect(queued?.cards[0]).toMatchObject({ moves: ["propose"] });
    expect(queued?.cards[0]?.note).toBe(
      "The queue did not write this label (inherited from a parent, or added by hand), so the bead is in no queue state: Propose puts it in the queue as proposed, where it waits for an approval.",
    );
  });

  test("a paused card that can be resumed says where Resume puts it: back where it was, and Queued for a bead paused while running", () => {
    const paused = workbenchColumns(
      [
        entry("t-1", "paused", { resume: "approved" }),
        entry("t-2", "paused", { resume: "queued" }),
        // GET /queue already answers queued for one paused while running; the card says the same for the state it was paused from.
        entry("t-3", "paused", { resume: "running" }),
        entry("t-4", "paused"),
      ],
      none,
      null,
    ).find((column) => column.state === "paused");
    expect(
      paused?.cards.map((card) => [card.id, card.moves, card.resumes ?? null]),
    ).toEqual([
      [
        "t-1",
        ["resume", "reassign"],
        { to: "approved", says: "Resume returns it to Approved." },
      ],
      [
        "t-2",
        ["resume", "reassign"],
        {
          to: "queued",
          says: "Resume puts it in Queued, where a shift starts it. A bead paused while it was running goes there too: nothing runs it after a pause.",
        },
      ],
      [
        "t-3",
        ["resume", "reassign"],
        {
          to: "queued",
          says: "Resume puts it in Queued, where a shift starts it. A bead paused while it was running goes there too: nothing runs it after a pause.",
        },
      ],
      ["t-4", ["reassign"], null],
    ]);
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
    expect(
      await moveOutcome("t-1", "propose", answering(200, envelope(true))),
    ).toEqual({ tone: "done", message: "Proposed t-1." });
  });

  test("a resume that is done says where the bead went, from the answer", async () => {
    const resumed = (to: unknown) =>
      answering(
        200,
        JSON.stringify({
          ok: true,
          data: { id: "t-1", action: "resume", from: "paused", to },
          error: null,
        }),
      );
    expect(await moveOutcome("t-1", "resume", resumed("queued"))).toEqual({
      tone: "done",
      message: "Resumed t-1 to Queued.",
    });
    // An answer that names no state is still done, and says no more than that.
    expect(await moveOutcome("t-1", "resume", resumed("nowhere"))).toEqual({
      tone: "done",
      message: "Resumed t-1.",
    });
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

  const tokenRefused = () =>
    Response.json(
      { ok: false, data: null, error: "the control plane is starting" },
      { status: 503 },
    );
  const tokenGiven = () =>
    Response.json({ ok: true, data: { token: "t" }, error: null });
  const notSent = {
    tone: "failed" as const,
    message:
      "Not sent (approve): the page could not get an operator token from the control plane (the control plane is starting). Nothing was changed.",
  };

  test("a move whose operator token cannot be had is a failure that says it was not sent, and no POST is made", async () => {
    const calls: string[] = [];
    const post = createOperatorPost(async (input, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      return input === TOKEN_ROUTE
        ? tokenRefused()
        : Response.json({ ok: true, data: {}, error: null });
    });
    expect(
      await moveOutcome("t-1", "approve", () =>
        post("/__agent-forge/queue/t-1/approve", {}),
      ),
    ).toEqual(notSent);
    expect(calls).toEqual([`GET ${TOKEN_ROUTE}`]);
  });

  test("a move refused with a 403 whose token cannot be had again is said as not sent", async () => {
    const calls: string[] = [];
    let tokens = 0;
    const post = createOperatorPost(async (input, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${input}`);
      if (input !== TOKEN_ROUTE)
        return Response.json(
          { ok: false, data: null, error: "token" },
          { status: 403 },
        );
      return tokens++ === 0 ? tokenGiven() : tokenRefused();
    });
    expect(
      await moveOutcome("t-1", "approve", () =>
        post("/__agent-forge/queue/t-1/approve", {}),
      ),
    ).toEqual(notSent);
    expect(calls).toEqual([
      `GET ${TOKEN_ROUTE}`,
      "POST /__agent-forge/queue/t-1/approve",
      `GET ${TOKEN_ROUTE}`,
    ]);
  });

  test("a move whose POST fails after the token was had is still not known", async () => {
    const post = createOperatorPost(async (input) => {
      if (input === TOKEN_ROUTE) return tokenGiven();
      throw new TypeError("Failed to fetch");
    });
    expect(
      await moveOutcome("t-1", "approve", () =>
        post("/__agent-forge/queue/t-1/approve", {}),
      ),
    ).toEqual({
      tone: "unknown",
      message:
        "Outcome not known (approve). Check with `bd show t-1` before trying again.",
    });
  });
});

test("a paused card that cannot be resumed says why", () => {
  const paused = workbenchColumns([entry("t-1", "paused")], none, null).find(
    (column) => column.state === "paused",
  );
  expect(paused?.cards[0]?.moves).toEqual(["reassign"]);
  expect(paused?.cards[0]?.note).toContain("queue_resume");
});
