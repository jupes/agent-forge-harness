import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BEAD_TYPES as BUILDER_TYPES } from "@docs/bead-builder";
import type {
  BeadPriorityOption,
  BeadWriteResult,
  LedgerEvent,
  OperatorEnvelope,
} from "../../../types/hearth";
import { hashText } from "../../hash-text";
import { type AppendResult, appendEvent } from "../../ledger/append";
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

/** How bd times an issue in what it prints for a claim or a close: to the second. */
const BD_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** How bd times a comment: to a fraction of a second. */
const BD_TIME_FRACTION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;

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
        // A comment is timed to a fraction of a second; an issue to the second.
        createdAt: expect.stringMatching(BD_TIME_FRACTION),
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
  // Each answer is built when bd is called, as bd times it: a write is told
  // from an earlier one by its time, and a time stamped when this file was
  // loaded is an earlier one by the time a slow run reaches the test.
  const cases: Array<[string, unknown, number, () => BdResult, string]> = [
    [
      "claim",
      {},
      200,
      () => bdAnswers.claimed(issue("in_progress", { assignee: "operator" })),
      "bead.claim",
    ],
    [
      "comment",
      { text: "worklog: by a short id" },
      201,
      () =>
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
      () =>
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
      h.bd.answer = printed;

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

// Built from code points, so this file holds no invisible character.
const ESC = String.fromCodePoint(0x1b);
const BELL = String.fromCodePoint(0x07);
const NUL = String.fromCodePoint(0x00);
const C1 = String.fromCodePoint(0x9b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const LONE_SURROGATE = String.fromCharCode(0xd83d);
const THREE_BYTES = String.fromCodePoint(0x6f22);

type Refusal = [label: string, path: string, body: unknown];

/** Every request is refused with a 400, nothing is recorded and bd is never asked. */
async function refusedBeforeAnything(
  h: TestHearth,
  requests: Refusal[],
): Promise<void> {
  for (const [label, path, body] of requests) {
    const answer = await post(h, path, body);
    expect({ label, status: answer.status, ok: answer.body.ok }).toEqual({
      label,
      status: 400,
      ok: false,
    });
  }
  expect(h.events()).toEqual([]);
  expect(h.bd.calls).toEqual([]);
}

describe("hostile ids", () => {
  const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
  const NOT_IDS: Array<[string, string]> = [
    ["an option", "-rf"],
    ["a long option", "--help"],
    ["an option with a value", "--db=x"],
    ["a space inside", "demo%20task"],
    ["a NUL inside", "demo%00task"],
    ["a newline inside", "demo%0Atask"],
    ["a quote", "demo%22task"],
    ["a leading dot", ".demo"],
    ["122 characters", "d".repeat(122)],
    ["shaped like a secret", secret],
  ];

  test("an id on the path that is not a Beads id never reaches bd, for any of the three rows", async () => {
    const h = await start();
    await refusedBeforeAnything(
      h,
      NOT_IDS.flatMap(([label, id]): Refusal[] => [
        [`claim, ${label}`, `/beads/${id}/claim`, {}],
        [`comment, ${label}`, `/beads/${id}/comment`, { text: "a comment" }],
        [`close, ${label}`, `/beads/${id}/close`, { reason: "a reason" }],
      ]),
    );
  });

  test("a parent that is not a Beads id never reaches bd", async () => {
    const h = await start();
    await refusedBeforeAnything(h, [
      ...NOT_IDS.map(
        ([label, id]): Refusal => [
          `parent, ${label}`,
          "/beads",
          { title: "A bead", parent: decodeURIComponent(id) },
        ],
      ),
      ["parent, a number", "/beads", { title: "A bead", parent: 7 }],
      ["parent, null", "/beads", { title: "A bead", parent: null }],
      ["parent, empty", "/beads", { title: "A bead", parent: "" }],
      ["parent, padded", "/beads", { title: "A bead", parent: " demo-epic " }],
    ]);
  });

  test("an id is given to bd exactly as it was sent: the longest one, dots and all", async () => {
    const h = await start();
    const longest = `a${".b-c_d".repeat(20)}`;
    expect(longest.length).toBe(121);
    const answer = await post(h, `/beads/${longest}/claim`, {});
    expect(answer.status).toBe(200);
    expect(h.bd.calls).toEqual([
      ["update", "--claim", "--json", "--", longest],
    ]);
  });
});

describe("hostile values", () => {
  const OPTION_LIKE = [
    "--help",
    "-f /etc/hosts",
    "--db=/tmp/x",
    "-- --json",
    "@notes.txt",
    "--",
  ];

  test("text that looks like an option reaches bd as text: inside its own --flag= or after the terminator", async () => {
    const h = await start();
    for (const hostile of OPTION_LIKE) {
      const before = h.bd.calls.length;
      const made = await post(h, "/beads", {
        title: hostile,
        description: hostile,
        acceptance: hostile,
      });
      expect(made.status).toBe(201);
      const commented = await post(h, "/beads/demo-task/comment", {
        text: hostile,
      });
      expect(commented.status).toBe(201);
      const closed = await post(h, "/beads/demo-task/close", {
        reason: hostile,
      });
      expect(closed.status).toBe(200);
      expect(h.bd.calls.slice(before)).toEqual([
        [
          "create",
          `--title=${hostile}`,
          "--type=task",
          "--priority=2",
          `--description=${hostile}`,
          `--acceptance=${hostile}`,
          "--json",
        ],
        ["comments", "add", "--json", "--", "demo-task", hostile],
        ["close", `--reason=${hostile}`, "--json", "--", "demo-task"],
      ]);
    }
  });

  test("a create is refused for a title that is not one clean line, and for a text bd could not take as given", async () => {
    const h = await start();
    const title = (value: unknown): unknown => ({ title: value });
    const described = (value: unknown): unknown => ({
      title: "A bead",
      description: value,
    });
    const accepting = (value: unknown): unknown => ({
      title: "A bead",
      acceptance: value,
    });
    await refusedBeforeAnything(h, [
      ["no title", "/beads", {}],
      ["an empty title", "/beads", title("")],
      ["a blank title", "/beads", title("  \t ")],
      ["a title that is a number", "/beads", title(7)],
      ["a title that is a list", "/beads", title(["A bead"])],
      ["a title with an escape sequence", "/beads", title(`red${ESC}[31m`)],
      ["a title with a bell", "/beads", title(`ring${BELL}`)],
      ["a title with a NUL", "/beads", title(`nul${NUL}after`)],
      ["a title with a C1 control", "/beads", title(`csi${C1}31m`)],
      ["a title of two lines", "/beads", title("one\ntwo")],
      ["a title with a tab", "/beads", title("one\ttwo")],
      [
        "a title with a line separator",
        "/beads",
        title(`one${LINE_SEPARATOR}two`),
      ],
      [
        "a title with a bidirectional override",
        "/beads",
        title(`gpj.${RIGHT_TO_LEFT_OVERRIDE}exe`),
      ],
      [
        "a title with half a surrogate pair",
        "/beads",
        title(`half${LONE_SURROGATE}`),
      ],
      ["a title of 201 characters", "/beads", title("t".repeat(201))],
      ["a description that is a number", "/beads", described(7)],
      ["a description that is null", "/beads", described(null)],
      [
        "a description with an escape sequence",
        "/beads",
        described(`a${ESC}[2J`),
      ],
      ["a description with a NUL", "/beads", described(`a${NUL}b`)],
      [
        "a description with half a surrogate pair",
        "/beads",
        described(LONE_SURROGATE),
      ],
      [
        "a description of 4,001 characters",
        "/beads",
        described("d".repeat(4001)),
      ],
      ["an acceptance text that is an object", "/beads", accepting({ a: 1 })],
      ["an acceptance text with a bell", "/beads", accepting(`a${BELL}`)],
      [
        "an acceptance text of 2,001 characters",
        "/beads",
        accepting("a".repeat(2001)),
      ],
      [
        "a type that is not one",
        "/beads",
        { title: "A bead", type: "decision" },
      ],
      ["a type that is null", "/beads", { title: "A bead", type: null }],
    ]);
  });

  test("a comment and a close reason are refused for the same faults", async () => {
    const h = await start();
    const comment = "/beads/demo-task/comment";
    const close = "/beads/demo-task/close";
    await refusedBeforeAnything(h, [
      ["a comment with an escape sequence", comment, { text: `a${ESC}[2J` }],
      ["a comment with a NUL", comment, { text: `a${NUL}` }],
      [
        "a comment with half a surrogate pair",
        comment,
        { text: `a${LONE_SURROGATE}` },
      ],
      ["a comment of 4,001 characters", comment, { text: "c".repeat(4001) }],
      ["a comment that is a list", comment, { text: ["a"] }],
      ["a reason with a bell", close, { reason: `a${BELL}` }],
      [
        "a reason with half a surrogate pair",
        close,
        { reason: LONE_SURROGATE },
      ],
      ["a reason of 1,001 characters", close, { reason: "r".repeat(1001) }],
    ]);
  });

  test("a body may hold only the fields its row takes: nothing rides along toward bd or the ledger", async () => {
    const h = await start();
    const withExtra = (extra: string): string => `{"title":"A bead",${extra}}`;
    await refusedBeforeAnything(h, [
      ["labels", "/beads", withExtra('"labels":["queue:approved"]')],
      ["repo", "/beads", withExtra('"repo":"./repos/elsewhere"')],
      ["a ledger kind", "/beads", withExtra('"kind":"bead.transitioned"')],
      ["a ledger payload", "/beads", withExtra('"payload":{"to":"approved"}')],
      ["a reason", "/beads", withExtra('"reason":"smuggled"')],
      ["an id", "/beads", withExtra('"id":"demo-chosen"')],
      ["an actor", "/beads", withExtra('"actor":"someone-else"')],
      ["__proto__", "/beads", withExtra('"__proto__":{"title":"x"}')],
      ["constructor", "/beads", withExtra('"constructor":{"prototype":{}}')],
      ["a list for a body", "/beads", [{ title: "A bead" }]],
      ["a string for a body", "/beads", '"A bead"'],
      ["null for a body", "/beads", "null"],
      [
        "a claim with a field",
        "/beads/demo-task/claim",
        { assignee: "someone-else" },
      ],
      ["a claim with a list", "/beads/demo-task/claim", []],
      [
        "a comment with an author",
        "/beads/demo-task/comment",
        { text: "a comment", author: "someone-else" },
      ],
      [
        "a close that forces",
        "/beads/demo-task/close",
        { reason: "a reason", force: true },
      ],
      [
        "a query string on a create",
        "/beads?repo=elsewhere",
        { title: "A bead" },
      ],
      [
        "a query string on a close",
        "/beads/demo-task/close?force=1",
        { reason: "a reason" },
      ],
    ]);
  });

  test("what is handed to bd: the title trimmed, the other texts as given once CR LF is LF, a blank description left out", async () => {
    const h = await start();
    const answer = await post(h, "/beads", {
      title: "  A bead  ",
      description: "  one\r\ntwo\rthree\n\tfour  ",
      acceptance: " \r\n ",
    });
    expect(answer.status).toBe(201);
    expect(h.bd.calls).toEqual([
      [
        "create",
        "--title=A bead",
        "--type=task",
        "--priority=2",
        "--description=  one\ntwo\nthree\n\tfour  ",
        "--json",
      ],
    ]);
    await post(h, "/beads/demo-task/comment", {
      text: "  kept as given \r\n",
    });
    expect(h.bd.calls.at(-1)).toEqual([
      "comments",
      "add",
      "--json",
      "--",
      "demo-task",
      "  kept as given \n",
    ]);
    // The hash and length are of the text bd was handed.
    expect(
      h.events(["bead.transitioned"]).map((event) => event.payload),
    ).toEqual([
      { action: "create", hash: hashText("A bead"), length: 6 },
      {
        action: "comment",
        hash: hashText("  kept as given \n"),
        length: 17,
      },
    ]);
  });
});

describe("a description of exactly a dash", () => {
  test("is refused before the audit row: bd reads it as a request to take the description from standard input", async () => {
    const h = await start();
    const answer = await post(h, "/beads", {
      title: "A bead",
      description: "-",
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain("standard input");
    expect(h.events()).toEqual([]);
    expect(h.bd.calls).toEqual([]);
  });

  test("a dash anywhere else, and a description that is more than a dash, reach bd as given", async () => {
    const h = await start();
    const first = await post(h, "/beads", {
      title: "-",
      acceptance: "-",
      description: " -",
    });
    expect(first.status).toBe(201);
    for (const description of ["--", "-\n", "- ", "\n-"]) {
      const made = await post(h, "/beads", { title: "A bead", description });
      expect({ description, status: made.status }).toEqual({
        description,
        status: 201,
      });
    }
    const commented = await post(h, "/beads/demo-task/comment", { text: "-" });
    expect(commented.status).toBe(201);
    const closed = await post(h, "/beads/demo-task/close", { reason: "-" });
    expect(closed.status).toBe(200);
    const create = (description: string): string[] => [
      "create",
      "--title=A bead",
      "--type=task",
      "--priority=2",
      `--description=${description}`,
      "--json",
    ];
    expect(h.bd.calls).toEqual([
      [
        "create",
        "--title=-",
        "--type=task",
        "--priority=2",
        "--description= -",
        "--acceptance=-",
        "--json",
      ],
      create("--"),
      create("-\n"),
      create("- "),
      create("\n-"),
      ["comments", "add", "--json", "--", "demo-task", "-"],
      ["close", "--reason=-", "--json", "--", "demo-task"],
    ]);
  });
});

describe("the size of a request", () => {
  test("a create at its own limits in three-byte characters is accepted; a body over the row's cap is refused", async () => {
    const h = await start();
    const atLimits = {
      // 498 bytes: a title is also held to the 500 bytes bd itself accepts.
      title: THREE_BYTES.repeat(166),
      description: THREE_BYTES.repeat(4000),
      acceptance: THREE_BYTES.repeat(2000),
    };
    expect(Buffer.byteLength(JSON.stringify(atLimits))).toBeGreaterThan(16_000);
    const accepted = await post(h, "/beads", atLimits);
    expect(accepted.status).toBe(201);
    expect(h.bd.calls.at(-1)?.[1]).toBe(`--title=${atLimits.title}`);

    const calls = h.bd.calls.length;
    const events = h.events().length;
    // Valid in every other respect: only its size can be why it is refused.
    const padded = `{"title":"A bead"${" ".repeat(32_000)}}`;
    const refused = await post(h, "/beads", padded);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("exceeds 32000 bytes");
    expect(h.bd.calls.length).toBe(calls);
    expect(h.events().length).toBe(events);

    // The other rows keep the table's default cap.
    const comment = await post(
      h,
      "/beads/demo-task/comment",
      `{"text":"a comment"${" ".repeat(16_000)}}`,
    );
    expect(comment.status).toBe(400);
    expect(comment.body.error).toContain("exceeds 16000 bytes");
  });
});

/** A text no answer and no ledger row may repeat. */
const MARKER = "BODY-TEXT-MARKER-7f3a";

interface Attempt {
  verb: "create" | "claim" | "comment" | "close";
  path: string;
  body: unknown;
  action: string;
  /** How the answer tells the caller to check before trying again. */
  check: string;
}

const ATTEMPTS: Attempt[] = [
  {
    verb: "create",
    path: "/beads",
    body: {
      title: `Title ${MARKER}`,
      description: `Description ${MARKER}`,
      acceptance: `Acceptance ${MARKER}`,
    },
    action: "bead.create",
    check: "bd list",
  },
  {
    verb: "claim",
    path: "/beads/demo-task/claim",
    body: {},
    action: "bead.claim",
    check: "bd show demo-task",
  },
  {
    verb: "comment",
    path: "/beads/demo-task/comment",
    body: { text: `Comment ${MARKER}` },
    action: "bead.comment",
    check: "bd show demo-task",
  },
  {
    verb: "close",
    path: "/beads/demo-task/close",
    body: { reason: `Reason ${MARKER}` },
    action: "bead.close",
    check: "bd show demo-task",
  },
];

const anIssue = (extra: Partial<BdIssue>): BdIssue => ({
  id: "demo-task",
  title: "A bead",
  issue_type: "task",
  priority: 2,
  status: "open",
  created_at: bdTime(),
  updated_at: bdTime(),
  ...extra,
});

interface Failure {
  label: string;
  /** What bd, or the runner, does with the call. */
  bd(args: string[]): BdResult | Promise<BdResult>;
  status: number;
  /** What the answer must say. */
  says: (attempt: Attempt) => string[];
}

/** Every way a call to bd can go wrong, and the answer each must get. */
const FAILURES: Failure[] = [
  {
    label: "bd refuses, saying why on stderr",
    bd: () => bdAnswers.refusedOnStderr("issue not claimable: status closed"),
    status: 502,
    says: () => ["failed: issue not claimable: status closed"],
  },
  {
    label:
      "bd refuses, saying why as JSON on stdout, and the runner's line on stderr repeats every argument",
    bd: (args) =>
      bdAnswers.refusedOnStdout('no issue found matching "demo-task"', args),
    status: 502,
    says: () => ['failed: no issue found matching "demo-task"'],
  },
  {
    label: "bd exits non-zero and says nothing but the runner's line",
    bd: (args) => ({
      status: 5,
      stdout: "",
      stderr: `Command failed: bd ${args.join(" ")}`,
    }),
    status: 502,
    says: () => ["failed: exit 5"],
  },
  {
    label: "bd is not there to be started",
    bd: () => ({
      status: null,
      stdout: "",
      stderr: 'Executable not found in $PATH: "bd"',
    }),
    status: 502,
    says: () => ["could not be started", "Nothing was changed"],
  },
  {
    label: "the call is killed at the runner's limit",
    bd: (args) => bdAnswers.notFinished(args),
    status: 504,
    says: (attempt) => [
      "did not finish: it was stopped before it answered, or it never started",
      "may still have been made",
      attempt.check,
    ],
  },
  {
    label: "the runner rejects, with a message that repeats an argument",
    bd: (args) => {
      throw new Error(
        `The argument 'args[1]' must be a string without null bytes. Received '${args[1]}'`,
      );
    },
    status: 504,
    says: (attempt) => [
      "did not finish",
      "may still have been made",
      attempt.check,
    ],
  },
  {
    label: "bd exits 0 having printed its help",
    bd: () => bdAnswers.help(),
    status: 504,
    says: (attempt) => ["exited 0 but did not confirm", attempt.check],
  },
  {
    label: "bd exits 0 having printed nothing",
    bd: () => ({ status: 0, stdout: "", stderr: "" }),
    status: 504,
    says: (attempt) => ["exited 0 but did not confirm", attempt.check],
  },
  {
    label: "bd exits 0 having printed JSON that names no bead",
    bd: () => ({ status: 0, stdout: "{}", stderr: "" }),
    status: 504,
    says: () => ["exited 0 but did not confirm"],
  },
  {
    label: "bd exits 0 naming something that is not a Beads id",
    bd: () => ({
      status: 0,
      stdout: JSON.stringify([
        { id: "--force", issue_id: "--force", status: "closed" },
      ]),
      stderr: "",
    }),
    status: 504,
    says: () => ["exited 0 but did not confirm"],
  },
];

describe("when bd does not do what was asked", () => {
  for (const failure of FAILURES)
    test(`${failure.label}: ${failure.status}, the audit row stays, no bead.transitioned, bd is asked once, and the answer repeats nothing that was sent`, async () => {
      const h = await start();
      h.bd.answer = failure.bd;
      for (const attempt of ATTEMPTS) {
        const calls = h.bd.calls.length;
        const audited = h.events(["operator.action"]).length;

        const answer = await post(h, attempt.path, attempt.body);

        const where = `${attempt.verb}: ${failure.label}`;
        expect({ where, status: answer.status, ok: answer.body.ok }).toEqual({
          where,
          status: failure.status,
          ok: false,
        });
        for (const phrase of failure.says(attempt))
          expect({ where, error: answer.body.error }).toEqual({
            where,
            error: expect.stringContaining(phrase),
          });
        expect(answer.body.error).not.toContain(MARKER);
        expect(answer.body.error).not.toContain("Command failed");
        // Asked once, never again; the attempt stays on record; no outcome.
        expect(h.bd.calls.length).toBe(calls + 1);
        expect(h.events(["operator.action"]).length).toBe(audited + 1);
        expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
          action: attempt.action,
        });
      }
      expect(h.events(["bead.transitioned"])).toEqual([]);
    });

  test("a write that bd answers for another state is not confirmed: a claim left open, a close left open, two issues printed", async () => {
    const h = await start();
    const unconfirmed: Array<[string, string, unknown, BdResult]> = [
      [
        "a claim that left the bead open",
        "/beads/demo-task/claim",
        {},
        bdAnswers.claimed(anIssue({ status: "open" })),
      ],
      [
        "a close that left the bead open",
        "/beads/demo-task/close",
        { reason: "a reason" },
        bdAnswers.closed(anIssue({ status: "open" })),
      ],
      [
        "a claim that printed two issues",
        "/beads/demo-task/claim",
        {},
        {
          status: 0,
          stdout: JSON.stringify([
            anIssue({ status: "in_progress" }),
            anIssue({ id: "demo-other", status: "in_progress" }),
          ]),
          stderr: "",
        },
      ],
      [
        "a comment that names no issue",
        "/beads/demo-task/comment",
        { text: "a comment" },
        { status: 0, stdout: JSON.stringify({ id: "c-1" }), stderr: "" },
      ],
      [
        "a create that printed a list",
        "/beads",
        { title: "A bead" },
        bdAnswers.claimed(anIssue({})),
      ],
    ];
    for (const [label, path, body, printed] of unconfirmed) {
      h.bd.answer = () => printed;
      const answer = await post(h, path, body);
      expect({ label, status: answer.status }).toEqual({ label, status: 504 });
      expect(answer.body.error).toContain("exited 0 but did not confirm");
    }
    expect(h.events(["bead.transitioned"])).toEqual([]);
  });
});

describe("a close of an issue that was already closed", () => {
  // bd exits 0 for it, prints the issue and keeps the first reason and time.
  test("is told by a reason that is not the one sent: 409, nothing recorded as done", async () => {
    const h = await start();
    h.bd.answer = () =>
      bdAnswers.closed(
        anIssue({
          status: "closed",
          close_reason: "closed last week, for another reason",
          closed_at: bdTime(),
        }),
      );
    const answer = await post(h, "/beads/demo-task/close", {
      reason: "Verified today",
    });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toContain("already closed");
    expect(answer.body.error).not.toContain("another reason");
    expect(h.events(["bead.transitioned"])).toEqual([]);
    expect(h.events(["operator.action"])).toHaveLength(1);
    expect(h.bd.calls.length).toBe(1);
  });

  test("is told by a closing time before the call began, when the reason is the same", async () => {
    const h = await start();
    const reason = "Verified today";
    h.bd.answer = () =>
      bdAnswers.closed(
        anIssue({
          status: "closed",
          close_reason: reason,
          closed_at: bdTime(new Date(Date.now() - 10_000)),
        }),
      );
    const answer = await post(h, "/beads/demo-task/close", { reason });
    expect(answer.status).toBe(409);
    expect(h.events(["bead.transitioned"])).toEqual([]);
  });

  test("is told by a closing time bd printed three seconds back, just outside the two seconds allowed: 409, nothing recorded", async () => {
    const h = await start();
    const reason = "Verified today";
    // bdTime drops the milliseconds: the time printed is three to four seconds
    // before bd answered. A slack of four seconds or more would take it for
    // this call's close.
    h.bd.answer = () =>
      bdAnswers.closed(
        anIssue({
          status: "closed",
          close_reason: reason,
          closed_at: bdTime(new Date(Date.now() - 3000)),
        }),
      );
    const answer = await post(h, "/beads/demo-task/close", { reason });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toContain("already closed");
    expect(h.events(["bead.transitioned"])).toEqual([]);
  });

  test("a close bd timed within the second it rounds to is the close that was asked for", async () => {
    const h = await start();
    const reason = "Verified today";
    // bd prints whole seconds: up to a second before the call began is this call.
    h.bd.answer = () =>
      bdAnswers.closed(
        anIssue({
          status: "closed",
          close_reason: reason,
          closed_at: bdTime(new Date(Date.now() - 999)),
        }),
      );
    const answer = await post(h, "/beads/demo-task/close", { reason });
    expect(answer.status).toBe(200);
    expect(h.events(["bead.transitioned"])).toHaveLength(1);
  });
});

describe("no outcome of a bead write is a 403", () => {
  // The page posts an action again after a 403 (it takes it for a stale
  // token). That is safe only while a 403 is never the answer of an effect.
  test("whatever bd does, the answer is one of 200, 201, 409, 502, 504", async () => {
    const h = await start();
    const seen = new Set<number>();
    const outcomes: Array<Failure["bd"] | null> = [
      null,
      ...FAILURES.map((failure) => failure.bd),
      () =>
        bdAnswers.closed(
          anIssue({ status: "closed", close_reason: "another" }),
        ),
    ];
    for (const outcome of outcomes) {
      h.bd.answer = outcome;
      for (const attempt of ATTEMPTS)
        seen.add((await post(h, attempt.path, attempt.body)).status);
    }
    expect([...seen].sort()).toEqual([200, 201, 409, 502, 504]);
  });
});

describe("when the outcome event cannot be stored", () => {
  const refusals: Array<[string, () => AppendResult]> = [
    ["refuses", () => ({ ok: false, error: "the ledger is read-only" })],
    ["reports a duplicate", () => ({ ok: true, duplicate: true, ulid: "x" })],
    [
      "answers nothing at all",
      // justification: a broken appender, not a typed one.
      () => null as unknown as AppendResult,
    ],
    [
      "throws",
      () => {
        throw new Error("ledger offline");
      },
    ],
  ];

  for (const [label, refusal] of refusals)
    test(`the ledger ${label}: the write happened, so the answer keeps its status and says it was not recorded`, async () => {
      let ledger = "";
      const h = await start({
        api: {
          appendEvent: (event) =>
            event.kind === "bead.transitioned"
              ? refusal()
              : appendEvent(event, { path: ledger }),
        },
      });
      ledger = h.ledger;
      for (const attempt of ATTEMPTS) {
        const answer = await post(h, attempt.path, attempt.body);
        expect({
          verb: attempt.verb,
          status: answer.status,
          recorded: answer.body.data?.recorded,
          why: typeof answer.body.data?.recordError,
        }).toEqual({
          verb: attempt.verb,
          status:
            attempt.verb === "create" || attempt.verb === "comment" ? 201 : 200,
          recorded: false,
          why: "string",
        });
        expect(answer.body.data?.recordError).not.toContain(MARKER);
      }
      // bd was asked once per write, and nothing was asked again.
      expect(h.bd.calls.length).toBe(ATTEMPTS.length);
      expect(h.events().map((event) => event.kind)).toEqual(
        ATTEMPTS.map(() => "operator.action"),
      );
    });

  test("a ledger that is busy is asked again before the answer says it was not recorded", async () => {
    let ledger = "";
    let asked = 0;
    const h = await start({
      api: {
        appendEvent: (event) => {
          if (event.kind !== "bead.transitioned")
            return appendEvent(event, { path: ledger });
          asked++;
          return asked < 3
            ? { ok: false, error: "database is locked" }
            : appendEvent(event, { path: ledger });
        },
      },
    });
    ledger = h.ledger;
    const answer = await post(h, "/beads/demo-task/claim", {});
    expect(answer.body.data?.recorded).toBe(true);
    expect(asked).toBe(3);
    expect(h.events(["bead.transitioned"])).toHaveLength(1);
    expect(h.bd.calls.length).toBe(1);
  });
});

describe("no body text reaches the ledger", () => {
  /** Whether `needle` is in the ledger's file or its write-ahead log, as UTF-8 or UTF-16. */
  function inLedgerFiles(h: TestHearth, needle: string): boolean {
    return [h.ledger, `${h.ledger}-wal`]
      .filter((file) => existsSync(file))
      .some((file) => {
        const bytes = readFileSync(file);
        return (
          bytes.includes(Buffer.from(needle, "utf8")) ||
          bytes.includes(Buffer.from(needle, "utf16le"))
        );
      });
  }

  test("after all four writes, and after each way one can fail, the ledger's bytes hold no title, description, acceptance text, comment or reason; the hashes are of the texts sent", async () => {
    const h = await start();
    for (const attempt of ATTEMPTS)
      expect((await post(h, attempt.path, attempt.body)).body.ok).toBe(true);
    for (const failure of FAILURES) {
      h.bd.answer = failure.bd;
      for (const attempt of ATTEMPTS) await post(h, attempt.path, attempt.body);
    }
    // A refusal that itself repeats what was sent, on both of bd's channels.
    h.bd.answer = () => ({
      status: 1,
      stdout: JSON.stringify({ error: `refused: ${MARKER}` }),
      stderr: `Error: ${MARKER}`,
    });
    for (const attempt of ATTEMPTS) await post(h, attempt.path, attempt.body);

    // The rows are where this looks: an id every write was about is found.
    expect(inLedgerFiles(h, "bead.transitioned")).toBe(true);
    expect(inLedgerFiles(h, "demo-task")).toBe(true);
    expect(inLedgerFiles(h, MARKER)).toBe(false);
    expect(JSON.stringify(h.events())).not.toContain(MARKER);

    expect(
      h.events(["bead.transitioned"]).map((event) => event.payload),
    ).toEqual([
      {
        action: "create",
        hash: hashText(`Title ${MARKER}`),
        length: `Title ${MARKER}`.length,
      },
      { action: "claim" },
      {
        action: "comment",
        hash: hashText(`Comment ${MARKER}`),
        length: `Comment ${MARKER}`.length,
      },
      {
        action: "close",
        hash: hashText(`Reason ${MARKER}`),
        length: `Reason ${MARKER}`.length,
      },
    ]);
  });
});

describe("the id bd prints for a create", () => {
  test("is taken only when it is a Beads id the ledger would store: anything else is an unconfirmed create, with no event under that name", async () => {
    const h = await start();
    const printedIds: unknown[] = [
      "--force",
      "demo task",
      "",
      `ghp_${"a1B2c3D4e5".repeat(4)}`,
      7,
      null,
    ];
    for (const id of printedIds) {
      h.bd.answer = () => ({
        status: 0,
        stdout: JSON.stringify({ id, status: "open" }),
        stderr: "",
      });
      const answer = await post(h, "/beads", { title: "A bead" });
      expect({ id, status: answer.status }).toEqual({ id, status: 504 });
      expect(answer.body.error).toContain("exited 0 but did not confirm");
      expect(answer.body.error).toContain("bd list");
    }
    expect(h.events(["bead.transitioned"])).toEqual([]);
    expect(h.events(["operator.action"])).toHaveLength(printedIds.length);
  });
});

describe("the description bd prints for a create", () => {
  // `bd create --description=-` reads the description from standard input,
  // which the runner ends at once: bd then makes the issue with none, exit 0.
  test("printed without the description that was sent, with another one, or with one when none was sent: 504 naming the issue bd made, no bead.transitioned, and the text is not repeated", async () => {
    const h = await start();
    const sent = `Two lines\nof context ${MARKER}`;
    const printed: Array<[string, string | undefined, BdIssue]> = [
      ["no description", sent, anIssue({ id: "made-1" })],
      [
        "another description",
        sent,
        anIssue({ id: "made-1", description: "Two" }),
      ],
      [
        "a description when none was sent",
        undefined,
        anIssue({ id: "made-1", description: "Two" }),
      ],
    ];
    for (const [label, description, issue] of printed) {
      h.bd.answer = () => bdAnswers.created(issue);
      const answer = await post(h, "/beads", {
        title: "A bead",
        ...(description !== undefined ? { description } : {}),
      });
      expect({ label, status: answer.status }).toEqual({ label, status: 504 });
      expect(answer.body.error).toContain(
        "made made-1, but the description it printed is not the one that was sent",
      );
      expect(answer.body.error).toContain("bd show made-1");
      expect(answer.body.error).not.toContain(MARKER);
    }
    expect(h.events(["bead.transitioned"])).toEqual([]);
    expect(h.events(["operator.action"])).toHaveLength(printed.length);
  });
});

describe("a call with no exit status", () => {
  // Review round 1 of the implementation, measured with a real bd: bd prints
  // warnings on stderr, and a warning can hold any word. Only the runtime's own
  // message for a program that is not there means the call never started.
  const killed = (stderr: string): BdResult => ({
    status: null,
    stdout: "",
    stderr,
  });

  test("is an unknown outcome whenever its stderr is bd's own, whatever words that holds", async () => {
    const h = await start();
    const ownOutput = [
      '⚠ Creating test issue in production database\n  Title: "Test ENOENT sweep 12" appears to be test data\n',
      'warning: hook: Executable not found in $PATH: "git-lfs"\n',
      'Executable not found in $PATH: "bd"\nand then something else',
      "spawn bd ENOENT (printed by a hook, not by the runtime)",
      "Error: ENOENT: no such file or directory, open '.beads/metadata.json'\n",
    ];
    for (const stderr of ownOutput) {
      h.bd.answer = () => killed(stderr);
      for (const attempt of ATTEMPTS) {
        const answer = await post(h, attempt.path, attempt.body);
        const where = `${attempt.verb}: ${stderr.slice(0, 30)}`;
        expect({ where, status: answer.status }).toEqual({
          where,
          status: 504,
        });
        expect(answer.body.error).toContain("may still have been made");
        expect(answer.body.error).not.toContain("Nothing was changed");
      }
    }
    expect(h.events(["bead.transitioned"])).toEqual([]);
  });

  test("is 'bd could not be started' only for the runtime's own message that there is no such program, and nothing else", async () => {
    const h = await start();
    for (const stderr of [
      'Executable not found in $PATH: "bd"',
      "spawn bd ENOENT",
      "spawn bd ENOENT\n",
    ]) {
      h.bd.answer = () => killed(stderr);
      const answer = await post(h, "/beads", { title: "A bead" });
      expect({ stderr, status: answer.status }).toEqual({
        stderr,
        status: 502,
      });
      expect(answer.body.error).toContain("could not be started");
      expect(answer.body.error).toContain("Nothing was changed");
    }
    // A program that printed something had started.
    h.bd.answer = () => ({
      status: null,
      stdout: "{",
      stderr: 'Executable not found in $PATH: "bd"',
    });
    expect((await post(h, "/beads", { title: "A bead" })).status).toBe(504);
  });

  test("that the runtime could not spawn for another reason is still an unknown outcome, and the answer says it may never have started instead of that it ran out of time", async () => {
    const h = await start();
    // Measured under Bun 1.3.10 with the runner's options: a working directory
    // that is gone ends the call with no exit status, nothing on stdout, and
    // this, whole, as what the runner hands back on stderr.
    h.bd.answer = () =>
      killed("ENOENT: no such file or directory, uv_spawn 'bd'");
    for (const attempt of ATTEMPTS) {
      const answer = await post(h, attempt.path, attempt.body);
      const where = attempt.verb;
      expect({ where, status: answer.status }).toEqual({ where, status: 504 });
      expect({ where, error: answer.body.error }).toEqual({
        where,
        error: expect.stringContaining("or it never started"),
      });
      expect(answer.body.error).not.toContain("time limit");
      expect(answer.body.error).toContain("may still have been made");
      expect(answer.body.error).toContain(attempt.check);
    }
    expect(h.events(["bead.transitioned"])).toEqual([]);
  });
});

describe("what a refusal says", () => {
  test("is bd's error line, not everything bd printed: a warning that repeats the title is not passed on", async () => {
    const h = await start();
    h.bd.answer = () => ({
      status: 1,
      stdout: "",
      stderr: `⚠ Creating test issue in production database\n  Title: "Test ${MARKER}" appears to be test data\n  Recommendation: Use isolated test database with --db\n    bd --db /tmp/test-beads create "Test ${MARKER}"\nError: parent issue demo-nope not found\n`,
    });
    const answer = await post(h, "/beads", {
      title: `Test ${MARKER}`,
      parent: "demo-nope",
    });
    expect(answer.status).toBe(502);
    expect(answer.body.error).toBe(
      "bd create failed: parent issue demo-nope not found",
    );
  });

  test("with no line that begins Error:, is the last line bd printed", async () => {
    const h = await start();
    h.bd.answer = () => ({
      status: 1,
      stdout: "",
      stderr: `a first line holding ${MARKER}\n\nissue not claimable: status closed\n\n`,
    });
    const answer = await post(h, "/beads/demo-task/claim", {});
    expect(answer.body.error).toBe(
      "bd update --claim failed: issue not claimable: status closed",
    );
  });

  // bd 1.1.0 was not seen to print anything after its error line (seven
  // refusals measured). The rule is kept so that a line it might print after
  // one cannot carry the title into the answer.
  test("when a line begins Error, that line is the refusal, whatever is printed after it", async () => {
    const h = await start();
    h.bd.answer = () => ({
      status: 1,
      stdout: "",
      stderr: `Error: parent issue demo-nope not found\n  while creating "Test ${MARKER}"\n`,
    });
    const answer = await post(h, "/beads", {
      title: `Test ${MARKER}`,
      parent: "demo-nope",
    });
    expect(answer.body.error).toBe(
      "bd create failed: parent issue demo-nope not found",
    );
    // An error line bd prints without the colon is passed on as it is.
    h.bd.answer = () => ({
      status: 1,
      stdout: "",
      stderr:
        'Error resolving demo-nope: no issue found matching "demo-nope"\n',
    });
    expect((await post(h, "/beads/demo-nope/claim", {})).body.error).toBe(
      'bd update --claim failed: Error resolving demo-nope: no issue found matching "demo-nope"',
    );
  });

  test("with two lines that begin Error, is the last of them", async () => {
    const h = await start();
    h.bd.answer = () => ({
      status: 1,
      stdout: "",
      stderr:
        "Error: a first error line\nError: parent issue demo-nope not found\n",
    });
    const answer = await post(h, "/beads", {
      title: "A child",
      parent: "demo-nope",
    });
    expect(answer.status).toBe(502);
    expect(answer.body.error).toBe(
      "bd create failed: parent issue demo-nope not found",
    );
  });

  test("is made safe: a secret in bd's error is redacted and a long one is cut", async () => {
    const h = await start();
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    h.bd.answer = () => bdAnswers.refusedOnStderr(`remote said ${secret}`);
    const refused = await post(h, "/beads/demo-task/claim", {});
    expect(refused.status).toBe(502);
    expect(refused.body.error).not.toContain(secret);
    expect(refused.body.error).toContain("remote said");

    h.bd.answer = () => bdAnswers.refusedOnStderr("x".repeat(5000));
    const long = await post(h, "/beads/demo-task/claim", {});
    expect(long.body.error?.length).toBeLessThanOrEqual(500);
  });

  test("the reason the ledger gave for not recording is made safe too", async () => {
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    let ledger = "";
    const h = await start({
      api: {
        appendEvent: (event) =>
          event.kind === "bead.transitioned"
            ? { ok: false, error: `refused for ${secret}` }
            : appendEvent(event, { path: ledger }),
      },
    });
    ledger = h.ledger;
    const answer = await post(h, "/beads/demo-task/claim", {});
    expect(answer.status).toBe(200);
    expect(answer.body.data?.recorded).toBe(false);
    expect(answer.body.data?.recordError).toContain("refused for");
    expect(answer.body.data?.recordError).not.toContain(secret);
  });
});

describe("what a confirmed write answers", () => {
  test("the labels bd printed, for a create and for a claim: a child inherits its parent's", async () => {
    const h = await start();
    h.bd.answer = (args) =>
      args[0] === "create"
        ? bdAnswers.created(
            anIssue({ id: "demo-epic.1", labels: ["area", "queue:approved"] }),
          )
        : bdAnswers.claimed(
            anIssue({
              id: "demo-epic.1",
              status: "in_progress",
              assignee: "operator",
              labels: ["area", "queue:approved"],
            }),
          );
    const created = await post(h, "/beads", {
      title: "A child",
      parent: "demo-epic",
    });
    expect(created.body.data?.labels).toEqual(["area", "queue:approved"]);
    const claimed = await post(h, "/beads/demo-epic.1/claim", {});
    expect(claimed.body.data?.labels).toEqual(["area", "queue:approved"]);
    // The answer shows them; the ledger does not take them.
    expect(JSON.stringify(h.events())).not.toContain("queue:approved");
  });

  test("the length on the outcome event counts the text as the limits do, in UTF-16 units", async () => {
    const h = await start();
    const text = `caf${String.fromCodePoint(0xe9)} ${THREE_BYTES}${THREE_BYTES} ${String.fromCodePoint(0x1f600)}`;
    expect(text.length).not.toBe(Buffer.byteLength(text));
    await post(h, "/beads/demo-task/comment", { text });
    expect(h.events(["bead.transitioned"]).at(-1)?.payload).toEqual({
      action: "comment",
      hash: hashText(text),
      length: text.length,
    });
  });
});

describe("a close, timed", () => {
  const reason = "Verified today";

  test("with no closing time printed is taken on its reason alone", async () => {
    const h = await start();
    h.bd.answer = () =>
      bdAnswers.closed(anIssue({ status: "closed", close_reason: reason }));
    const answer = await post(h, "/beads/demo-task/close", { reason });
    expect(answer.status).toBe(200);
    expect(h.events(["bead.transitioned"])).toHaveLength(1);
  });

  test("is timed against when the call began, not when bd answered: a slow bd does not turn a close into 'already closed'", async () => {
    const h = await start();
    h.bd.answer = async () => {
      const closedAt = bdTime();
      await new Promise((done) => setTimeout(done, 3100));
      return bdAnswers.closed(
        anIssue({
          status: "closed",
          close_reason: reason,
          closed_at: closedAt,
        }),
      );
    };
    const answer = await post(h, "/beads/demo-task/close", { reason });
    expect(answer.status).toBe(200);
    expect(h.events(["bead.transitioned"])).toHaveLength(1);
  }, 10_000);
});

describe("a claim of a bead that was already claimed", () => {
  // bd's claim is idempotent for the same actor: it exits 0 and prints the
  // issue as it was, with the time of its last change.
  test("is told by a last change from before the call began: 409, and no claim is recorded", async () => {
    const h = await start();
    h.bd.answer = () =>
      bdAnswers.claimed(
        anIssue({
          status: "in_progress",
          assignee: "operator",
          updated_at: bdTime(new Date(Date.now() - 10_000)),
        }),
      );
    const answer = await post(h, "/beads/demo-task/claim", {});
    expect(answer.status).toBe(409);
    expect(answer.body.error).toContain("already claimed");
    expect(h.events(["bead.transitioned"])).toEqual([]);
    expect(h.events(["operator.action"])).toHaveLength(1);
    expect(h.bd.calls.length).toBe(1);
  });

  test("is told by a last change bd printed three seconds back, just outside the two seconds allowed: 409, nothing recorded", async () => {
    const h = await start();
    // bdTime drops the milliseconds: the time printed is three to four seconds
    // before bd answered. A slack of four seconds or more would take it for
    // this call's claim.
    h.bd.answer = () =>
      bdAnswers.claimed(
        anIssue({
          status: "in_progress",
          assignee: "operator",
          updated_at: bdTime(new Date(Date.now() - 3000)),
        }),
      );
    const answer = await post(h, "/beads/demo-task/claim", {});
    expect(answer.status).toBe(409);
    expect(answer.body.error).toContain("already claimed");
    expect(h.events(["bead.transitioned"])).toEqual([]);
  });

  test("is timed against when the call began, not when bd answered: a slow bd does not turn a claim into 'already claimed'", async () => {
    const h = await start();
    // bd changes the issue as the call reaches it and answers 3.1 s later.
    // Timed against that answer, the change would be more than the two
    // seconds allowed before it, and the claim would be taken for an old one.
    h.bd.answer = async () => {
      const updatedAt = bdTime();
      await new Promise((done) => setTimeout(done, 3100));
      return bdAnswers.claimed(
        anIssue({
          status: "in_progress",
          assignee: "operator",
          updated_at: updatedAt,
        }),
      );
    };
    const answer = await post(h, "/beads/demo-task/claim", {});
    expect(answer.status).toBe(200);
    expect(answer.body.data?.status).toBe("in_progress");
    expect(h.events(["bead.transitioned"])).toHaveLength(1);
  }, 10_000);

  test("a claim bd timed within the second it rounds to, or did not time, is this call's", async () => {
    const h = await start();
    for (const updated of [bdTime(new Date(Date.now() - 999)), undefined]) {
      const { updated_at: _dropped, ...untimed } = anIssue({
        status: "in_progress",
        assignee: "operator",
      });
      h.bd.answer = () =>
        updated === undefined
          ? { status: 0, stdout: JSON.stringify([untimed]), stderr: "" }
          : bdAnswers.claimed({
              ...untimed,
              updated_at: bdTime(new Date(Date.now() - 999)),
            });
      expect((await post(h, "/beads/demo-task/claim", {})).status).toBe(200);
    }
    expect(h.events(["bead.transitioned"])).toHaveLength(2);
  });

  test("is not told by started_at: a claim printed with a started_at from before the call and an updated_at inside its two seconds is answered 200 and recorded", async () => {
    // bd 1.1.0 writes started_at on a claim only while it is empty, so a bead
    // that was released and is claimed again prints the time of its first
    // claim. On 2026-10-12 this project's tracker held an open issue that still
    // carried the started_at of an earlier claim.
    const h = await start();
    h.bd.answer = () =>
      bdAnswers.claimed(
        anIssue({
          status: "in_progress",
          assignee: "operator",
          started_at: bdTime(new Date(Date.now() - 10 * 86_400_000)),
          updated_at: bdTime(),
        }),
      );
    const answer = await post(h, "/beads/demo-task/claim", {});
    expect(answer.status).toBe(200);
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

describe("a text must say something", () => {
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
  const WORD_JOINER = String.fromCodePoint(0x2060);
  const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
  /**
   * Characters that draw nothing and are neither whitespace nor a format
   * character: the braille blank, three Hangul fillers, a variation selector
   * and the combining grapheme joiner.
   */
  const BLANK_LOOKING = [0x2800, 0x3164, 0xffa0, 0x115f, 0xfe0f, 0x034f].map(
    (code) => String.fromCodePoint(code),
  );
  const VARIATION_SELECTOR = String.fromCodePoint(0xfe0f);
  const nothing = [
    ZERO_WIDTH_SPACE,
    `${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}`,
    ` ${ZERO_WIDTH_SPACE}\n${WORD_JOINER}\t`,
    NO_BREAK_SPACE,
    ...BLANK_LOOKING,
    ` ${BLANK_LOOKING.join(ZERO_WIDTH_SPACE)} `,
  ];

  test("a reason, a comment or a title made only of spaces and characters nobody can see is refused", async () => {
    const h = await start();
    await refusedBeforeAnything(
      h,
      nothing.flatMap((text): Refusal[] => [
        ["a close reason", "/beads/demo-task/close", { reason: text }],
        ["a comment", "/beads/demo-task/comment", { text }],
        ["a title", "/beads", { title: text }],
      ]),
    );
  });

  test("a description or an acceptance text made only of those is left out, as a blank one is", async () => {
    const h = await start();
    for (const text of nothing) {
      const answer = await post(h, "/beads", {
        title: "A bead",
        description: text,
        acceptance: text,
      });
      expect(answer.status).toBe(201);
      expect(h.bd.calls.at(-1)).toEqual([
        "create",
        "--title=A bead",
        "--type=task",
        "--priority=2",
        "--json",
      ]);
    }
  });

  test("a text that holds something to read is passed on with what surrounds it", async () => {
    const h = await start();
    const text = `${ZERO_WIDTH_SPACE}done${ZERO_WIDTH_SPACE}`;
    expect(
      (await post(h, "/beads/demo-task/close", { reason: text })).status,
    ).toBe(200);
    expect(h.bd.calls.at(-1)?.[1]).toBe(`--reason=${text}`);
    // A variation selector says nothing alone; with the mark it styles, the mark is read.
    const mark = `${String.fromCodePoint(0x2714)}${VARIATION_SELECTOR}`;
    expect(
      (await post(h, "/beads/demo-task/comment", { text: mark })).status,
    ).toBe(201);
    expect(h.bd.calls.at(-1)?.at(-1)).toBe(mark);
  });
});

describe("the title limit is bd's as well", () => {
  test("a title of 200 characters that is more than 500 bytes is refused here, as bd would refuse it", async () => {
    const h = await start();
    const tooManyBytes = THREE_BYTES.repeat(167);
    expect(tooManyBytes.length).toBeLessThan(200);
    expect(Buffer.byteLength(tooManyBytes)).toBe(501);
    await refusedBeforeAnything(h, [
      ["501 bytes in 167 characters", "/beads", { title: tooManyBytes }],
    ]);
    const fits = THREE_BYTES.repeat(166);
    expect((await post(h, "/beads", { title: fits })).status).toBe(201);
    expect(h.bd.calls.at(-1)?.[1]).toBe(`--title=${fits}`);
  });
});
