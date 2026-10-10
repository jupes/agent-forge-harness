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
import {
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "../testing";
import { validateOperatorEnvelope } from "../validate";
import { BEAD_PRIORITIES, BEAD_TYPES, DEFAULT_BEAD_PRIORITY } from "./beads";

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
