import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BEAD_TYPES as BUILDER_TYPES } from "@docs/bead-builder";
import type {
  BeadPriorityOption,
  BeadWriteResult,
  LedgerEvent,
  OperatorEnvelope,
} from "../../../types/hearth";
import { hashText } from "../../hash-text";
import { type BdIssue, bdAnswers, bdTime } from "../bd-answers";
import {
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "../testing";
import { validateOperatorEnvelope } from "../validate";
import { BEAD_PRIORITIES, BEAD_TYPES, DEFAULT_BEAD_PRIORITY } from "./beads";
import type { BdResult } from "./dev-api";

/**
 * The Beads write rows, through a hermetic hearth: a request goes in over
 * HTTP, and what is checked is the answer, the argument arrays `bd` was given
 * and what the ledger holds. `bd` here is the recorder of `../testing`; nothing
 * reaches a tracker.
 */

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function start(options: TestHearthOptions = {}): Promise<TestHearth> {
  const hearth = await startTestHearth(options);
  open.push(hearth);
  return hearth;
}

interface Answer<T> {
  status: number;
  body: OperatorEnvelope<T>;
}

async function post<T = BeadWriteResult>(
  h: TestHearth,
  path: string,
  body: unknown,
): Promise<Answer<T>> {
  const response = await fetch(`${h.api}${path}`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  const checked = validateOperatorEnvelope(parsed);
  if (!checked.ok) throw new Error(`not an envelope: ${checked.error}`);
  // justification: the guard above proved the envelope; `T` is the caller's claim about `data`.
  return {
    status: response.status,
    body: checked.value as OperatorEnvelope<T>,
  };
}

/** What the ledger holds, reduced to what these tests compare. */
function recorded(
  h: TestHearth,
): Array<Pick<LedgerEvent, "kind" | "beadId" | "payload">> {
  return h.events().map((event) => ({
    kind: event.kind,
    ...(event.beadId !== undefined ? { beadId: event.beadId } : {}),
    payload: event.payload,
  })) as Array<Pick<LedgerEvent, "kind" | "beadId" | "payload">>;
}

describe("POST /beads", () => {
  test("with a parent and a priority: 201 with the id bd printed, one bd call, the audit row and then bead.transitioned for the new bead", async () => {
    const h = await start();

    const answer = await post(h, "/beads", {
      title: "Wire the lantern",
      type: "feature",
      priority: "P1",
      parent: "demo-epic",
      description: "Two lines\nof context",
      acceptance: "- [ ] it lights\n- [ ] it stays lit",
    });

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({
      ok: true,
      data: {
        id: "demo-epic.1",
        action: "create",
        status: "open",
        recorded: true,
      },
      error: null,
    });
    expect(h.bd.calls).toEqual([
      [
        "create",
        "--title=Wire the lantern",
        "--type=feature",
        "--priority=1",
        "--parent=demo-epic",
        "--description=Two lines\nof context",
        "--acceptance=- [ ] it lights\n- [ ] it stays lit",
        "--json",
      ],
    ]);
    expect(recorded(h)).toEqual([
      {
        kind: "operator.action",
        beadId: "demo-epic",
        payload: { action: "bead.create", surface: "api", target: "demo-epic" },
      },
      {
        kind: "bead.transitioned",
        beadId: "demo-epic.1",
        payload: {
          action: "create",
          hash: hashText("Wire the lantern"),
          length: 16,
        },
      },
    ]);
  });
});

/** The rubric as the priority skill's own table has it: one option per `P` value. */
function rubricOfTheSkill(): BeadPriorityOption[] {
  const skill = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      ".claude",
      "skills",
      "beads-priority-assignment",
      "SKILL.md",
    ),
    "utf8",
  );
  const options: BeadPriorityOption[] = [];
  for (const line of skill.split(/\r?\n/)) {
    const row = /^\| \*\*(\w+)\*\* \| (.+?) \| (.+?) \|$/.exec(line);
    if (!row) continue;
    const [, tier = "", inputs = "", meaning = ""] = row;
    const values = [...inputs.matchAll(/`P(\d)`/g)].map((found) =>
      Number(found[1]),
    );
    for (let n = Math.min(...values); n <= Math.max(...values); n++)
      options.push({
        value: `P${n}`,
        tier: tier.toLowerCase() as BeadPriorityOption["tier"],
        meaning,
      });
  }
  return options;
}

describe("the priority rubric and the issue types", () => {
  test("the rubric the route serves is the table of the priority skill, value for value", () => {
    const fromSkill = rubricOfTheSkill();
    expect(fromSkill.map((option) => option.value)).toEqual([
      "P0",
      "P1",
      "P2",
      "P3",
      "P4",
    ]);
    expect([...BEAD_PRIORITIES]).toEqual(fromSkill);
    expect(BEAD_PRIORITIES.map((option) => option.tier)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "low",
    ]);
  });

  test("each priority reaches bd as its digit, the default is P2, and anything else is refused", async () => {
    const h = await start();
    for (const option of BEAD_PRIORITIES) {
      const answer = await post(h, "/beads", {
        title: "A bead",
        priority: option.value,
      });
      expect(answer.status).toBe(201);
      expect(h.bd.calls.at(-1)).toContain(
        `--priority=${option.value.slice(1)}`,
      );
    }
    await post(h, "/beads", { title: "A bead" });
    expect(h.bd.calls.at(-1)).toContain("--priority=2");
    expect(DEFAULT_BEAD_PRIORITY).toBe("P2");

    const calls = h.bd.calls.length;
    for (const priority of ["P5", "p1", "1", 1, "critical", "", null, ["P1"]]) {
      const answer = await post(h, "/beads", { title: "A bead", priority });
      expect({ priority, status: answer.status }).toEqual({
        priority,
        status: 400,
      });
    }
    expect(h.bd.calls.length).toBe(calls);
  });

  test("the issue types are the bead builder's own list, epic among them", () => {
    expect<string[]>([...BEAD_TYPES]).toEqual([...BUILDER_TYPES]);
    expect(BEAD_TYPES).toContain("epic");
  });
});

describe("GET /beads/options", () => {
  test("answers the types, the rubric, the default priority and the longest text each field takes", async () => {
    const h = await start();
    const response = await fetch(`${h.api}/beads/options`, {
      headers: h.headers(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        types: ["task", "feature", "bug", "chore", "epic"],
        priorities: rubricOfTheSkill(),
        defaultPriority: "P2",
        limits: {
          title: 200,
          description: 4000,
          acceptance: 2000,
          comment: 4000,
          reason: 1000,
        },
      },
      error: null,
    });
    // A read: nothing is recorded and bd is not asked.
    expect(h.events()).toEqual([]);
    expect(h.bd.calls).toEqual([]);
  });
});

const BD_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe("POST /beads/:id/claim", () => {
  test("one bd update --claim, the id after the terminator; the status and assignee bd answered; bead.transitioned with no hash", async () => {
    const h = await start();

    const answer = await post(h, "/beads/demo-task/claim", {});

    expect(answer.status).toBe(200);
    expect(answer.body.data).toEqual({
      id: "demo-task",
      action: "claim",
      status: "in_progress",
      assignee: "operator",
      updatedAt: expect.stringMatching(BD_TIME),
      recorded: true,
    });
    expect(h.bd.calls).toEqual([
      ["update", "--claim", "--json", "--", "demo-task"],
    ]);
    expect(recorded(h)).toEqual([
      {
        kind: "operator.action",
        beadId: "demo-task",
        payload: { action: "bead.claim", surface: "api", target: "demo-task" },
      },
      {
        kind: "bead.transitioned",
        beadId: "demo-task",
        payload: { action: "claim" },
      },
    ]);
  });
});

describe("POST /beads/:id/comment", () => {
  const TEXT = "worklog: looked at the lantern\nthe wick is short";

  test("one bd comments add, the id and the text after the terminator; bead.transitioned carries the text's hash and length", async () => {
    const h = await start();

    const answer = await post(h, "/beads/demo-task/comment", { text: TEXT });

    expect(answer.status).toBe(201);
    expect(answer.body.data).toEqual({
      id: "demo-task",
      action: "comment",
      comment: {
        id: expect.any(String),
        author: "operator",
        createdAt: expect.stringMatching(BD_TIME),
      },
      recorded: true,
    });
    expect(h.bd.calls).toEqual([
      ["comments", "add", "--json", "--", "demo-task", TEXT],
    ]);
    expect(recorded(h)).toEqual([
      {
        kind: "operator.action",
        beadId: "demo-task",
        payload: {
          action: "bead.comment",
          surface: "api",
          target: "demo-task",
        },
      },
      {
        kind: "bead.transitioned",
        beadId: "demo-task",
        payload: {
          action: "comment",
          hash: hashText(TEXT),
          length: TEXT.length,
        },
      },
    ]);
  });

  test("a comment with no text is refused before anything is recorded", async () => {
    const h = await start();
    for (const body of [{}, { text: "" }, { text: "  \n\t " }, { text: 7 }]) {
      const answer = await post(h, "/beads/demo-task/comment", body);
      expect({ body, status: answer.status }).toEqual({ body, status: 400 });
    }
    expect(h.events()).toEqual([]);
    expect(h.bd.calls).toEqual([]);
  });
});

describe("POST /beads/:id/close", () => {
  const REASON = "Verified: the lantern lights and stays lit";

  test("one bd close with the reason as a flag value and the id after the terminator; bead.transitioned carries the reason's hash and length", async () => {
    const h = await start();

    const answer = await post(h, "/beads/demo-task/close", { reason: REASON });

    expect(answer.status).toBe(200);
    expect(answer.body.data).toEqual({
      id: "demo-task",
      action: "close",
      status: "closed",
      updatedAt: expect.stringMatching(BD_TIME),
      recorded: true,
    });
    expect(h.bd.calls).toEqual([
      ["close", `--reason=${REASON}`, "--json", "--", "demo-task"],
    ]);
    expect(recorded(h)).toEqual([
      {
        kind: "operator.action",
        beadId: "demo-task",
        payload: { action: "bead.close", surface: "api", target: "demo-task" },
      },
      {
        kind: "bead.transitioned",
        beadId: "demo-task",
        payload: {
          action: "close",
          hash: hashText(REASON),
          length: REASON.length,
        },
      },
    ]);
  });

  test("a close without a reason is refused before anything is recorded: absent, empty, or only whitespace", async () => {
    const h = await start();
    for (const body of [
      {},
      { reason: "" },
      { reason: "   " },
      { reason: "\n\t" },
      { reason: null },
      { reason: ["done"] },
    ]) {
      const answer = await post(h, "/beads/demo-task/close", body);
      expect({ body, status: answer.status }).toEqual({ body, status: 400 });
    }
    expect(h.events()).toEqual([]);
    expect(h.bd.calls).toEqual([]);
  });
});

describe("bd acts on a partial id", () => {
  // Measured: given `o88`, bd 1.1.0 claims, comments on and closes `probe-o88`
  // and prints the full id. The bead that was written is the one bd printed.
  const FULL = "demo-o88";
  const issue = (status: string, extra: Partial<BdIssue> = {}): BdIssue => ({
    id: FULL,
    title: "A bead",
    issue_type: "task",
    priority: 2,
    status,
    created_at: bdTime(),
    updated_at: bdTime(),
    ...extra,
  });
  const cases: Array<[string, unknown, number, BdResult, string]> = [
    [
      "claim",
      {},
      200,
      bdAnswers.claimed(issue("in_progress", { assignee: "operator" })),
      "bead.claim",
    ],
    [
      "comment",
      { text: "worklog: by a short id" },
      201,
      bdAnswers.commented({
        id: "comment-1",
        issueId: FULL,
        author: "operator",
        text: "worklog: by a short id",
        createdAt: bdTime(),
      }),
      "bead.comment",
    ],
    [
      "close",
      { reason: "Verified by a short id" },
      200,
      bdAnswers.closed(
        issue("closed", {
          close_reason: "Verified by a short id",
          closed_at: bdTime(),
        }),
      ),
      "bead.close",
    ],
  ];

  for (const [verb, body, status, printed, action] of cases)
    test(`${verb}: the answer and the outcome event name the bead bd printed; the audit row keeps the id as it was given`, async () => {
      const h = await start();
      h.bd.answer = () => printed;

      const answer = await post(h, `/beads/o88/${verb}`, body);

      expect(answer.status).toBe(status);
      expect(answer.body.data?.id).toBe(FULL);
      expect(recorded(h).map(({ kind, beadId }) => ({ kind, beadId }))).toEqual(
        [
          { kind: "operator.action", beadId: "o88" },
          { kind: "bead.transitioned", beadId: FULL },
        ],
      );
      expect(recorded(h)[0]?.payload).toEqual({
        action,
        surface: "api",
        target: "o88",
      });
      expect(h.bd.calls.length).toBe(1);
    });
});
