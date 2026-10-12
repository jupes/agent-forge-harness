import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LedgerEventInput,
  QUEUE_ACTIONS,
  QUEUE_ACTORS,
  QUEUE_STATES,
  type QueueAction,
  type QueueActor,
  type QueueEntry,
  type QueueState,
} from "../../types/hearth";
import { loadConfig } from "../config/load";
import { bdAnswers } from "../hearth/bd-answers";
import { type AppendResult, appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import {
  actionFor,
  checkSmith,
  complexityOf,
  createQueue,
  decide,
  legalMoves,
  pickable,
  QUEUE_TABLE,
  QUEUED_EXACT_ARGS,
  type Queue,
  queueStateOf,
  smithFor,
} from "./queue";
import {
  type QueueTracker,
  queueTracker,
  type TrackedBead,
} from "./queue-fixture";

const OPERATOR: QueueActor[] = ["operator"];
const BOTH: QueueActor[] = ["operator", "scheduler"];

/**
 * The table as the bead's `design:` comment has it, written out again here on
 * the test's side: from, then to, then the action and who may take it. A pair
 * that is not here is illegal. Leaving `paused` is not here either: it depends
 * on where the bead was paused from, and is walked separately.
 */
const EXPECTED: Record<
  string,
  Partial<Record<QueueState, [QueueAction, QueueActor[]]>>
> = {
  none: { proposed: ["propose", BOTH] },
  proposed: { approved: ["approve", OPERATOR], paused: ["pause", OPERATOR] },
  approved: {
    queued: ["queue", OPERATOR],
    running: ["start", OPERATOR],
    paused: ["pause", OPERATOR],
    halted: ["halt", BOTH],
  },
  queued: {
    running: ["start", BOTH],
    paused: ["pause", OPERATOR],
    halted: ["halt", BOTH],
  },
  running: {
    review: ["submit", BOTH],
    queued: ["release", BOTH],
    paused: ["pause", OPERATOR],
    halted: ["halt", BOTH],
  },
  review: {
    done: ["complete", BOTH],
    queued: ["rework", BOTH],
    paused: ["pause", OPERATOR],
    halted: ["halt", BOTH],
  },
  done: {},
  paused: {},
  halted: { queued: ["queue", OPERATOR] },
};

/** The states a bead can be paused from, and so resumed to. */
const PAUSABLE: QueueState[] = [
  "proposed",
  "approved",
  "queued",
  "running",
  "review",
];

const FROMS: Array<QueueState | null> = [null, ...QUEUE_STATES];
const name = (state: QueueState | null): string => state ?? "none";

/** What the table says about a pair, for a bead paused from `resume` when it is paused. */
function expected(
  from: QueueState | null,
  to: QueueState,
  resume?: QueueState,
): [QueueAction, QueueActor[]] | undefined {
  if (from === "paused")
    return to === resume ? ["resume", OPERATOR] : undefined;
  return EXPECTED[name(from)]?.[to];
}

const home = mkdtempSync(join(tmpdir(), "af-queue-test-"));
const ledger = join(home, "ledger.db");
const workspace = join(home, "workspace");
mkdirSync(workspace);

afterAll(() => {
  closeLedger(ledger);
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

let serial = 0;

/** A bead in a state the queue wrote, with an id no other case uses. */
function beadIn(
  state: QueueState | null,
  resume?: QueueState,
  more: Partial<TrackedBead> = {},
): TrackedBead {
  serial++;
  return {
    id: `probe-${serial}`,
    ...(state !== null
      ? {
          labels: [`queue:${state}`, "command-center"],
          metadata: {
            queue_state: state,
            ...(resume !== undefined ? { queue_resume: resume } : {}),
          },
        }
      : { labels: ["command-center"] }),
    ...more,
  };
}

interface Rig {
  tracker: QueueTracker;
  queue: Queue;
  /** The `bead.transitioned` events stored for a bead, as kind-free payloads. */
  events(id: string): unknown[];
}

function rig(
  beads: TrackedBead[],
  append?: (event: LedgerEventInput) => AppendResult,
): Rig {
  const tracker = queueTracker(beads);
  const queue = createQueue({
    workspace,
    runBd: tracker.run,
    appendEvent: append ?? ((event) => appendEvent(event, { path: ledger })),
    lockFile: join(home, "queue-lock.db"),
  });
  return {
    tracker,
    queue,
    events: (id) =>
      queryEvents(
        {
          workspace,
          beadId: id,
          beadExact: true,
          kinds: ["bead.transitioned"],
        },
        { path: ledger },
      ).map((event) => event.payload),
  };
}

const show = (id: string): string[] => [
  "show",
  "--readonly",
  "--json",
  "--",
  id,
];

function queueLabels(tracker: QueueTracker, id: string): string[] {
  return (tracker.beads.get(id)?.labels ?? []).filter((label) =>
    label.startsWith("queue:"),
  );
}

describe("the table", () => {
  test("names every legal pair with one action and its actors, and no other pair", () => {
    for (const from of FROMS)
      for (const to of QUEUE_STATES) {
        if (from === "paused") continue;
        const want = expected(from, to);
        expect({ from, to, action: actionFor(from, to) }).toEqual({
          from,
          to,
          action: want?.[0] ?? null,
        });
        const rows = QUEUE_TABLE.filter(
          (row) => row.from === from && row.to === to,
        );
        expect(rows.map((row) => [row.action, [...row.by]])).toEqual(
          want ? [want] : [],
        );
      }
    // Leaving paused: one resume row per state a bead can be paused from.
    expect(
      QUEUE_TABLE.filter((row) => row.from === "paused").map((row) => [
        row.action,
        row.to,
        [...row.by],
      ]),
    ).toEqual(PAUSABLE.map((to) => ["resume", to, OPERATOR]));
  });

  test("decide allows exactly the table's rows, for every state, action and actor", () => {
    for (const from of FROMS)
      for (const resume of from === "paused" ? PAUSABLE : [undefined])
        for (const action of QUEUE_ACTIONS)
          for (const by of QUEUE_ACTORS) {
            const targets = QUEUE_STATES.filter((to) => {
              const want = expected(from, to, resume);
              return want?.[0] === action && want[1].includes(by);
            });
            const decided = decide({ state: from, resume }, action, by);
            expect({
              from,
              resume,
              action,
              by,
              to: decided.ok ? decided.to : null,
            }).toEqual({ from, resume, action, by, to: targets[0] ?? null });
            expect(targets.length).toBeLessThanOrEqual(1);
          }
  });

  test("decision 5: nothing but an operator's approve leads from proposed towards running, and the scheduler starts only what is queued", () => {
    // Every state reachable from proposed without the approve row...
    const reach = (allowed: (row: (typeof QUEUE_TABLE)[number]) => boolean) => {
      const seen = new Set<QueueState>(["proposed"]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const row of QUEUE_TABLE)
          if (
            row.from !== null &&
            seen.has(row.from) &&
            !seen.has(row.to) &&
            allowed(row) &&
            // A paused bead returns only to where it came from.
            (row.action !== "resume" || seen.has(row.to))
          ) {
            seen.add(row.to);
            grew = true;
          }
      }
      return [...seen].sort();
    };
    expect(reach((row) => row.action !== "approve")).toEqual([
      "paused",
      "proposed",
    ]);
    // ...and with no operator at all.
    expect(reach((row) => row.by.includes("scheduler"))).toEqual(["proposed"]);
    expect(
      QUEUE_TABLE.filter(
        (row) => row.to === "running" && row.by.includes("scheduler"),
      ).map((row) => row.from),
    ).toEqual(["queued"]);
    // The one other row into running is the resume of a bead that was paused while running.
    expect(
      QUEUE_TABLE.filter((row) => row.to === "running").map((row) => [
        row.action,
        row.from,
      ]),
    ).toEqual([
      ["start", "approved"],
      ["start", "queued"],
      ["resume", "paused"],
    ]);
  });

  test("a refusal names the current state and every move allowed from it, with who may make it", () => {
    const wrongMove = decide({ state: "proposed" }, "start", "operator");
    expect(wrongMove).toEqual({
      ok: false,
      error:
        'is queue:proposed: "start" is not a move from there. From proposed: approve (operator), pause (operator).',
    });
    const wrongActor = decide({ state: "proposed" }, "approve", "scheduler");
    expect(wrongActor).toEqual({
      ok: false,
      error:
        'is queue:proposed: only operator may "approve" it. From proposed: approve (operator), pause (operator).',
    });
    expect(decide({ state: null }, "approve", "operator")).toEqual({
      ok: false,
      error:
        'is not in the queue: "approve" is not a move from there. From outside the queue: propose (operator, scheduler).',
    });
    expect(decide({ state: "done" }, "queue", "operator")).toEqual({
      ok: false,
      error:
        'is queue:done: "queue" is not a move from there. From done: nothing, it is final.',
    });
    expect(
      decide({ state: "paused", resume: "queued" }, "start", "operator"),
    ).toEqual({
      ok: false,
      error:
        'is queue:paused: "start" is not a move from there. From paused: resume to queued (operator).',
    });
    expect(legalMoves("queued").map((row) => row.action)).toEqual([
      "start",
      "pause",
      "halt",
    ]);
  });
});

describe("queueStateOf", () => {
  const cases: Array<[string, unknown, unknown, unknown]> = [
    ["no labels at all", undefined, undefined, { kind: "none" }],
    ["no queue label", ["command-center"], {}, { kind: "none" }],
    [
      "one label the queue wrote",
      ["queue:queued", "x"],
      { queue_state: "queued" },
      { kind: "state", state: "queued" },
    ],
    [
      "a paused bead with where it came from",
      ["queue:paused"],
      { queue_state: "paused", queue_resume: "review" },
      { kind: "state", state: "paused", resume: "review" },
    ],
    [
      "a paused bead whose resume is not a state it can return to",
      ["queue:paused"],
      { queue_state: "paused", queue_resume: "done" },
      { kind: "state", state: "paused" },
    ],
    [
      "a label with no metadata behind it (inherited)",
      ["queue:queued"],
      undefined,
      { kind: "unbacked", label: "queued" },
    ],
    [
      "a label whose metadata names another state",
      ["queue:queued"],
      { queue_state: "approved" },
      { kind: "unbacked", label: "queued" },
    ],
    [
      "a label whose metadata is not text",
      ["queue:queued"],
      { queue_state: ["queued"] },
      { kind: "unbacked", label: "queued" },
    ],
    [
      "metadata that is not an object",
      ["queue:queued"],
      "queue_state=queued",
      { kind: "unbacked", label: "queued" },
    ],
    [
      "two queue labels",
      ["queue:queued", "queue:paused"],
      { queue_state: "queued" },
      { kind: "broken", labels: ["queue:paused", "queue:queued"] },
    ],
    [
      "a queue label that is not a state",
      ["queue:teleported"],
      { queue_state: "teleported" },
      { kind: "broken", labels: ["queue:teleported"] },
    ],
    ["the bare prefix", ["queue:"], {}, { kind: "broken", labels: ["queue:"] }],
    [
      "labels that are not text are not labels",
      [7, null, { queue: "queued" }],
      {},
      { kind: "none" },
    ],
    ["labels that are not a list", "queue:queued", {}, { kind: "none" }],
  ];
  for (const [title, labels, metadata, want] of cases)
    test(title, () => {
      expect(queueStateOf({ labels, metadata })).toEqual(want as never);
    });
});

describe("moving a bead: every pair of states", () => {
  for (const from of FROMS)
    for (const to of QUEUE_STATES)
      for (const resume of from === "paused" ? PAUSABLE : [undefined]) {
        const want = expected(from, to, resume);
        const where =
          from === "paused" ? `paused (from ${resume})` : name(from);
        if (want) {
          const [action, actors] = want;
          for (const by of QUEUE_ACTORS) {
            const allowed = actors.includes(by);
            test(`${where} -> ${to}: ${action} by ${by} is ${allowed ? "made, with one event" : "refused"}`, async () => {
              const bead = beadIn(from, resume);
              const { tracker, queue, events } = rig([bead]);
              const result = await queue.move(bead.id, action, by);
              if (!allowed) {
                expect(result.ok ? "" : result.kind).toBe("refused");
                expect(tracker.updates()).toEqual([]);
                expect(queueLabels(tracker, bead.id)).toEqual(
                  from === null ? [] : [`queue:${from}`],
                );
                expect(events(bead.id)).toEqual([]);
                return;
              }
              expect(result).toEqual({
                ok: true,
                value: { id: bead.id, action, from, to, recorded: true },
              });
              // One read, one write, each an argument array with the id after `--`.
              expect(tracker.calls).toEqual([
                show(bead.id),
                [
                  "update",
                  ...(from !== null ? [`--remove-label=queue:${from}`] : []),
                  `--add-label=queue:${to}`,
                  `--set-metadata=queue_state=${to}`,
                  ...(action === "pause"
                    ? [`--set-metadata=queue_resume=${from}`]
                    : []),
                  ...(action === "resume"
                    ? ["--unset-metadata=queue_resume"]
                    : []),
                  "--json",
                  "--",
                  bead.id,
                ],
              ]);
              expect(queueLabels(tracker, bead.id)).toEqual([`queue:${to}`]);
              expect(tracker.beads.get(bead.id)?.metadata).toEqual({
                queue_state: to,
                ...(action === "pause" ? { queue_resume: from } : {}),
              });
              // Every other label the bead carried is still there.
              expect(tracker.beads.get(bead.id)?.labels).toContain(
                "command-center",
              );
              expect(events(bead.id)).toEqual([
                { from, to, reason: `${action}:${by}` },
              ]);
            });
          }
        } else {
          test(`${where} -> ${to}: illegal; no action by anyone lands there, and a refusal writes nothing and records nothing`, async () => {
            for (const action of QUEUE_ACTIONS)
              for (const by of QUEUE_ACTORS) {
                const bead = beadIn(from, resume);
                const { tracker, queue, events } = rig([bead]);
                const result = await queue.move(bead.id, action, by);
                if (result.ok) {
                  // A legal move from this state: it went somewhere else.
                  expect({ action, by, to: result.value.to }).not.toEqual({
                    action,
                    by,
                    to,
                  });
                  expect(queueLabels(tracker, bead.id)).not.toEqual([
                    `queue:${to}`,
                  ]);
                  continue;
                }
                expect({ action, by, kind: result.kind }).toEqual({
                  action,
                  by,
                  kind: "refused",
                });
                expect(result.error).toContain(bead.id);
                expect(tracker.updates()).toEqual([]);
                expect(queueLabels(tracker, bead.id)).toEqual(
                  from === null ? [] : [`queue:${from}`],
                );
                expect(events(bead.id)).toEqual([]);
              }
          });
        }
      }

  test("pause and resume return a bead to the state it was paused from, for each such state", async () => {
    for (const state of PAUSABLE) {
      const bead = beadIn(state);
      const { tracker, queue, events } = rig([bead]);
      expect((await queue.move(bead.id, "pause", "operator")).ok).toBe(true);
      expect(queueLabels(tracker, bead.id)).toEqual(["queue:paused"]);
      const resumed = await queue.move(bead.id, "resume", "operator");
      expect(resumed.ok && resumed.value.to).toBe(state);
      expect(queueLabels(tracker, bead.id)).toEqual([`queue:${state}`]);
      expect(tracker.beads.get(bead.id)?.metadata).toEqual({
        queue_state: state,
      });
      expect(events(bead.id)).toEqual([
        { from: state, to: "paused", reason: "pause:operator" },
        { from: "paused", to: state, reason: "resume:operator" },
      ]);
    }
  });

  test("a paused bead with no usable state to return to is refused, with how to repair it", async () => {
    for (const resume of [
      undefined,
      "paused",
      "done",
      "halted",
      "nowhere",
      7,
    ]) {
      const bead = beadIn("paused");
      bead.metadata = {
        queue_state: "paused",
        ...(resume !== undefined ? { queue_resume: resume } : {}),
      };
      const { tracker, queue, events } = rig([bead]);
      const result = await queue.move(bead.id, "resume", "operator");
      expect(result.ok ? "" : result.kind).toBe("refused");
      expect(result.ok ? "" : result.error).toContain("queue_resume");
      expect(result.ok ? "" : result.error).toContain("--unset-metadata");
      expect(tracker.updates()).toEqual([]);
      expect(events(bead.id)).toEqual([]);
    }
  });

  test("the whole happy path leaves one event per move, in order", async () => {
    const bead = beadIn(null);
    const { queue, events } = rig([bead]);
    const path: Array<[QueueAction, QueueActor]> = [
      ["propose", "scheduler"],
      ["approve", "operator"],
      ["queue", "operator"],
      ["start", "scheduler"],
      ["submit", "scheduler"],
      ["complete", "operator"],
    ];
    for (const [action, by] of path)
      expect((await queue.move(bead.id, action, by)).ok).toBe(true);
    expect(events(bead.id)).toEqual([
      { from: null, to: "proposed", reason: "propose:scheduler" },
      { from: "proposed", to: "approved", reason: "approve:operator" },
      { from: "approved", to: "queued", reason: "queue:operator" },
      { from: "queued", to: "running", reason: "start:scheduler" },
      { from: "running", to: "review", reason: "submit:scheduler" },
      { from: "review", to: "done", reason: "complete:operator" },
    ]);
  });
});

describe("a label the queue did not write", () => {
  test("a child that inherited queue:queued can only be proposed; then only an approval leads on", async () => {
    for (const action of QUEUE_ACTIONS)
      for (const by of QUEUE_ACTORS) {
        if (action === "propose") continue;
        // As bd prints a child: the label, no metadata of its own, the parent's under dependencies.
        const child: TrackedBead = {
          id: `probe-child-${++serial}`,
          labels: ["queue:queued"],
          parent: { id: "probe-parent", metadata: { queue_state: "queued" } },
        };
        const { tracker, queue, events } = rig([child]);
        const result = await queue.move(child.id, action, by);
        expect({ action, by, kind: result.ok ? "ok" : result.kind }).toEqual({
          action,
          by,
          kind: "refused",
        });
        expect(result.ok ? "" : result.error).toContain("propose");
        expect(result.ok ? "" : result.error).toContain(
          "the queue did not write it",
        );
        expect(tracker.updates()).toEqual([]);
        expect(events(child.id)).toEqual([]);
      }

    const child: TrackedBead = {
      id: `probe-child-${++serial}`,
      labels: ["queue:queued"],
      parent: { id: "probe-parent", metadata: { queue_state: "queued" } },
    };
    const { tracker, queue, events } = rig([child]);
    const proposed = await queue.move(child.id, "propose", "scheduler");
    expect(proposed).toEqual({
      ok: true,
      value: {
        id: child.id,
        action: "propose",
        from: null,
        to: "proposed",
        recorded: true,
      },
    });
    expect(tracker.updates()).toEqual([
      [
        "update",
        "--remove-label=queue:queued",
        "--add-label=queue:proposed",
        "--set-metadata=queue_state=proposed",
        "--json",
        "--",
        child.id,
      ],
    ]);
    expect(queueLabels(tracker, child.id)).toEqual(["queue:proposed"]);
    expect(events(child.id)).toEqual([
      { from: null, to: "proposed", reason: "propose:scheduler" },
    ]);
    expect((await queue.move(child.id, "start", "scheduler")).ok).toBe(false);
    expect((await queue.move(child.id, "queue", "operator")).ok).toBe(false);
    expect((await queue.move(child.id, "approve", "operator")).ok).toBe(true);
  });

  test("an inherited queue:proposed is proposed without removing the label it adds (bd adds before it removes)", async () => {
    const child: TrackedBead = {
      id: `probe-child-${++serial}`,
      labels: ["queue:proposed"],
    };
    const { tracker, queue, events } = rig([child]);
    const result = await queue.move(child.id, "propose", "operator");
    expect(result.ok).toBe(true);
    expect(tracker.updates()).toEqual([
      [
        "update",
        "--add-label=queue:proposed",
        "--set-metadata=queue_state=proposed",
        "--json",
        "--",
        child.id,
      ],
    ]);
    expect(queueLabels(tracker, child.id)).toEqual(["queue:proposed"]);
    expect(events(child.id)).toEqual([
      { from: null, to: "proposed", reason: "propose:operator" },
    ]);
  });

  test("a bead with two queue labels, or one that is not a state, is in no state: every action is refused and nothing is written", async () => {
    const broken: Array<[string[], Record<string, unknown>]> = [
      [["queue:queued", "queue:paused"], { queue_state: "queued" }],
      [["queue:queued", "queue:running"], { queue_state: "running" }],
      [["queue:teleported"], { queue_state: "teleported" }],
      [["queue:queued", "queue:"], { queue_state: "queued" }],
    ];
    for (const [labels, metadata] of broken)
      for (const action of QUEUE_ACTIONS)
        for (const by of QUEUE_ACTORS) {
          const bead: TrackedBead = {
            id: `probe-broken-${++serial}`,
            labels,
            metadata,
          };
          const { tracker, queue, events } = rig([bead]);
          const result = await queue.move(bead.id, action, by);
          expect({ action, by, kind: result.ok ? "ok" : result.kind }).toEqual({
            action,
            by,
            kind: "refused",
          });
          for (const label of labels)
            expect(result.ok ? "" : result.error).toContain(label);
          expect(result.ok ? "" : result.error).toContain(
            "--unset-metadata=queue_state",
          );
          expect(tracker.updates()).toEqual([]);
          expect(events(bead.id)).toEqual([]);
        }
  });

  test("start is refused for a closed bead, and its status is never written", async () => {
    const bead = beadIn("queued", undefined, { status: "closed" });
    const { tracker, queue, events } = rig([bead]);
    const result = await queue.move(bead.id, "start", "scheduler");
    expect(result.ok ? "" : result.kind).toBe("refused");
    expect(result.ok ? "" : result.error).toContain("closed");
    expect(tracker.updates()).toEqual([]);
    expect(events(bead.id)).toEqual([]);
    // The refusal names the state the bead is in, not the one the scheduler starts from.
    const approved = beadIn("approved", undefined, { status: "closed" });
    const byHand = rig([approved]);
    const refused = await byHand.queue.move(approved.id, "start", "operator");
    expect(refused.ok ? "" : refused.error).toContain(
      `${approved.id} is queue:approved and its Beads status is closed`,
    );
    expect(byHand.tracker.updates()).toEqual([]);
    // No call the queue makes names a status.
    const walked = beadIn(null);
    const all = rig([walked]);
    for (const action of [
      "propose",
      "approve",
      "queue",
      "pause",
      "resume",
    ] as const)
      await all.queue.move(walked.id, action, "operator");
    expect(
      all.tracker.calls
        .flat()
        .filter((arg) => /status|claim|assignee/.test(arg)),
    ).toEqual([]);
  });
});

describe("ids that are not a bead's", () => {
  const hostile = [
    "",
    " ",
    "--help",
    "-rf",
    "probe 1",
    "probe-1,probe-2",
    "../probe-1",
    "probe-1\u0000",
    "probe-1\n--add-label=queue:queued",
    "--add-label=queue:queued",
    "=x",
    " probe-1",
    "probe-1 ",
    `probe-${"x".repeat(200)}`,
    "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ];
  test("bd is never called for one, by move or by reassign", async () => {
    const config = loadConfig({ harnessRoot: workspace, env: {}, home }).config;
    for (const id of hostile) {
      const { tracker, queue } = rig([beadIn("proposed")]);
      const moved = await queue.move(id, "approve", "operator");
      expect({ id, kind: moved.ok ? "ok" : moved.kind }).toEqual({
        id,
        kind: "invalid",
      });
      const reassigned = await queue.reassign(id, "claude-master", config);
      expect(reassigned.ok ? "ok" : reassigned.kind).toBe("invalid");
      expect(tracker.calls).toEqual([]);
    }
    for (const id of [7, null, undefined, ["probe-1"], { id: "probe-1" }]) {
      const { tracker, queue } = rig([beadIn("proposed")]);
      // justification: what a caller without types could pass.
      const moved = await queue.move(
        id as unknown as string,
        "approve",
        "operator",
      );
      expect(moved.ok ? "ok" : moved.kind).toBe("invalid");
      expect(tracker.calls).toEqual([]);
    }
  });

  test("an action or an actor that is not one is invalid, and bd is not called", async () => {
    const bead = beadIn("proposed");
    const { tracker, queue } = rig([bead]);
    for (const [action, by] of [
      ["teleport", "operator"],
      ["approve", "root"],
      ["__proto__", "operator"],
      ["approve", "constructor"],
    ]) {
      const result = await queue.move(
        bead.id,
        action as QueueAction,
        by as QueueActor,
      );
      expect(result.ok ? "ok" : result.kind).toBe("invalid");
    }
    expect(tracker.calls).toEqual([]);
  });

  test("an id no bead has is not found; a part of an id that bd resolves to another bead is not found either", async () => {
    const real = beadIn("proposed");
    const { tracker, queue, events } = rig([real]);
    const missing = await queue.move("probe-nothere", "approve", "operator");
    expect(missing.ok ? "" : missing.kind).toBe("not-found");

    // bd resolves part of an id to the issue and prints the whole id.
    tracker.intercept = (args) =>
      args[0] === "show" && args[4] === "partial"
        ? bdAnswers.shown({
            id: real.id,
            title: "",
            issue_type: "task",
            priority: 2,
            status: "open",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            labels: ["queue:proposed"],
            metadata: { queue_state: "proposed" },
          })
        : undefined;
    const partial = await queue.move("partial", "approve", "operator");
    expect(partial.ok ? "" : partial.kind).toBe("not-found");
    expect(partial.ok ? "" : partial.error).toContain(real.id);
    expect(tracker.updates()).toEqual([]);
    expect(events(real.id)).toEqual([]);
  });
});

describe("a write that does not happen, or cannot be confirmed", () => {
  const failures: Array<
    [
      string,
      (args: string[], id: string) => ReturnType<typeof bdAnswers.help>,
      string,
    ]
  > = [
    [
      "bd refuses (exit 1)",
      () => bdAnswers.refusedOnStderr("the tracker is read-only"),
      "failed",
    ],
    [
      "the call is killed at its limit",
      (args) => bdAnswers.notFinished(args),
      "unknown",
    ],
    [
      "bd is not installed",
      () => ({
        status: null,
        stdout: "",
        stderr: 'Executable not found in $PATH: "bd"',
      }),
      "failed",
    ],
    ["exit 0 with help text", () => bdAnswers.help(), "unknown"],
    [
      "exit 0 with nothing",
      () => ({ status: 0, stdout: "", stderr: "" }),
      "unknown",
    ],
    [
      "exit 0 naming another bead",
      () =>
        bdAnswers.updated({
          id: "probe-other",
          title: "",
          issue_type: "task",
          priority: 2,
          status: "open",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          labels: ["queue:approved"],
          metadata: { queue_state: "approved" },
        }),
      "unknown",
    ],
    [
      "exit 0 without the label it was to add",
      (_args, id) =>
        bdAnswers.updated({
          id,
          title: "",
          issue_type: "task",
          priority: 2,
          status: "open",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          labels: ["queue:proposed"],
          metadata: { queue_state: "proposed" },
        }),
      "unknown",
    ],
    [
      "exit 0 with the label and not the metadata",
      (_args, id) =>
        bdAnswers.updated({
          id,
          title: "",
          issue_type: "task",
          priority: 2,
          status: "open",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          labels: ["queue:approved"],
        }),
      "unknown",
    ],
    [
      "exit 0 with two issues",
      (_args, id) => ({
        status: 0,
        stdout: JSON.stringify([
          {
            id,
            labels: ["queue:approved"],
            metadata: { queue_state: "approved" },
          },
          {
            id,
            labels: ["queue:approved"],
            metadata: { queue_state: "approved" },
          },
        ]),
        stderr: "",
      }),
      "unknown",
    ],
  ];
  for (const [title, answer, kind] of failures)
    test(`${title}: ${kind}, and no event`, async () => {
      const bead = beadIn("proposed");
      const { tracker, queue, events } = rig([bead]);
      tracker.intercept = (args) =>
        args[0] === "update" ? answer(args, bead.id) : undefined;
      const result = await queue.move(bead.id, "approve", "operator");
      expect(result.ok ? "ok" : result.kind).toBe(kind);
      expect(events(bead.id)).toEqual([]);
      // One attempt: a write is never repeated.
      expect(tracker.updates().length).toBe(1);
      // What the runner said, which repeats every argument, is not passed on.
      expect(result.ok ? "" : result.error).not.toContain("Command failed");
      if (kind === "unknown")
        expect(result.ok ? "" : result.error).toContain(`bd show ${bead.id}`);
    });

  test("a runner that rejects is an unknown outcome on the write, and a failure on the read; neither leaves an event", async () => {
    const bead = beadIn("proposed");
    const tracker = queueTracker([bead]);
    let reject: "show" | "update" = "update";
    const queue = createQueue({
      workspace,
      runBd: async (args) => {
        if (args[0] === reject)
          throw new Error(`spawn failed for ${args.join(" ")}`);
        return tracker.run(args);
      },
      appendEvent: (event) => appendEvent(event, { path: ledger }),
      lockFile: join(home, "queue-lock.db"),
    });
    const written = await queue.move(bead.id, "approve", "operator");
    expect(written.ok ? "ok" : written.kind).toBe("unknown");
    expect(written.ok ? "" : written.error).not.toContain("spawn failed");
    reject = "show";
    const read = await queue.move(bead.id, "approve", "operator");
    expect(read.ok ? "ok" : read.kind).toBe("failed");
    expect(
      queryEvents(
        { workspace, beadId: bead.id, beadExact: true },
        { path: ledger },
      ),
    ).toEqual([]);
  });

  test("a read that fails changes nothing: refused by bd, killed, not installed, not JSON", async () => {
    const answers: Array<[() => ReturnType<typeof bdAnswers.help>, string]> = [
      [() => bdAnswers.refusedOnStderr("database is locked"), "failed"],
      [() => bdAnswers.notFinished(["show"]), "failed"],
      [
        () => ({
          status: null,
          stdout: "",
          stderr: 'Executable not found in $PATH: "bd"',
        }),
        "failed",
      ],
      [() => bdAnswers.help(), "not-found"],
      [() => ({ status: 0, stdout: "[]", stderr: "" }), "not-found"],
    ];
    for (const [answer, kind] of answers) {
      const bead = beadIn("proposed");
      const { tracker, queue, events } = rig([bead]);
      tracker.intercept = (args) => (args[0] === "show" ? answer() : undefined);
      const result = await queue.move(bead.id, "approve", "operator");
      expect(result.ok ? "ok" : result.kind).toBe(kind);
      expect(tracker.updates()).toEqual([]);
      expect(events(bead.id)).toEqual([]);
    }
  });

  test("bd's text in an answer is made safe: a secret is redacted and a long one is cut, on the read and on the write", async () => {
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    for (const call of ["show", "update"]) {
      for (const [said, check] of [
        [
          `remote said ${secret}`,
          (error: string) => {
            expect(error).not.toContain(secret);
            expect(error).toContain("remote said");
          },
        ],
        [
          "x".repeat(5000),
          (error: string) => expect(error.length).toBeLessThanOrEqual(500),
        ],
      ] as const) {
        const bead = beadIn("proposed");
        const { tracker, queue } = rig([bead]);
        tracker.intercept = (args) =>
          args[0] === call ? bdAnswers.refusedOnStderr(said) : undefined;
        const result = await queue.move(bead.id, "approve", "operator");
        expect({ call, kind: result.ok ? "ok" : result.kind }).toEqual({
          call,
          kind: "failed",
        });
        check(result.ok ? "" : result.error);
      }
    }
  });

  test("the label is written and the ledger will not store the event: the answer says so, and the move stands", async () => {
    const outcomes: Array<[() => AppendResult, string]> = [
      [() => ({ ok: false, error: "the disk is full" }), "the disk is full"],
      [
        () => {
          throw new Error("the ledger threw");
        },
        "the ledger threw",
      ],
      [() => ({ ok: true, duplicate: true, ulid: "x" }), "stored no row"],
    ];
    for (const [append, why] of outcomes) {
      const bead = beadIn("proposed");
      const { tracker, queue } = rig([bead], append);
      const result = await queue.move(bead.id, "approve", "operator");
      expect(result.ok && result.value.recorded).toBe(false);
      expect(result.ok ? result.value.recordError : "").toContain(why);
      expect(queueLabels(tracker, bead.id)).toEqual(["queue:approved"]);
    }
  });

  test("a busy ledger is tried again, and the event is stored once", async () => {
    const bead = beadIn("proposed");
    let attempts = 0;
    const { queue, events } = rig([bead], (event) => {
      attempts++;
      return attempts < 3
        ? { ok: false, error: "database is locked" }
        : appendEvent(event, { path: ledger });
    });
    const result = await queue.move(bead.id, "approve", "operator");
    expect(result.ok && result.value.recorded).toBe(true);
    expect(attempts).toBe(3);
    expect(events(bead.id).length).toBe(1);
  });
});

describe("two callers at once", () => {
  test("the same move twice: one is made, the other reads the new state and is refused; one event", async () => {
    const bead = beadIn("proposed");
    const { tracker, queue, events } = rig([bead]);
    const results = await Promise.all([
      queue.move(bead.id, "approve", "operator"),
      queue.move(bead.id, "approve", "operator"),
    ]);
    expect(results.map((result) => (result.ok ? "ok" : result.kind))).toEqual([
      "ok",
      "refused",
    ]);
    expect(results[1]?.ok ? "" : results[1]?.error).toContain("queue:approved");
    expect(tracker.updates().length).toBe(1);
    expect(events(bead.id)).toEqual([
      { from: "proposed", to: "approved", reason: "approve:operator" },
    ]);
  });

  test("two different moves from one state: the second is judged against what the first left", async () => {
    const bead = beadIn("queued");
    const { tracker, queue, events } = rig([bead]);
    const [started, paused] = await Promise.all([
      queue.move(bead.id, "start", "scheduler"),
      queue.move(bead.id, "pause", "operator"),
    ]);
    // Started first; a running bead can be paused, and it is paused from running.
    expect(started.ok && started.value.to).toBe("running");
    expect(paused.ok && paused.value.from).toBe("running");
    expect(queueLabels(tracker, bead.id)).toEqual(["queue:paused"]);
    expect(tracker.beads.get(bead.id)?.metadata).toEqual({
      queue_state: "paused",
      queue_resume: "running",
    });
    expect(events(bead.id)).toEqual([
      { from: "queued", to: "running", reason: "start:scheduler" },
      { from: "running", to: "paused", reason: "pause:operator" },
    ]);
  });

  test("two queues over one tracker and one lock file, as two processes would be: a second start is refused", async () => {
    const bead = beadIn("queued");
    const { tracker, queue, events } = rig([bead]);
    const other = createQueue({
      workspace,
      runBd: tracker.run,
      appendEvent: (event) => appendEvent(event, { path: ledger }),
      lockFile: join(home, "queue-lock.db"),
    });
    const results = await Promise.all([
      queue.move(bead.id, "start", "scheduler"),
      other.move(bead.id, "start", "scheduler"),
    ]);
    expect(
      results.map((result) => (result.ok ? "ok" : result.kind)).sort(),
    ).toEqual(["ok", "refused"]);
    expect(tracker.updates().length).toBe(1);
    expect(events(bead.id).length).toBe(1);
  });

  test("a writer outside the queue gets in between the read and the write: a conflict that names both labels, no event, no further write", async () => {
    const bead = beadIn("queued");
    const { tracker, queue, events } = rig([bead]);
    tracker.beforeUpdate = (stored) => {
      // Someone ran bd by hand: the label this call read is gone, another is there.
      stored.labels = ["queue:halted"];
    };
    const result = await queue.move(bead.id, "start", "scheduler");
    expect(result.ok ? "ok" : result.kind).toBe("conflict");
    for (const text of [
      "queue:halted",
      "queue:running",
      "--unset-metadata=queue_state",
    ])
      expect(result.ok ? "" : result.error).toContain(text);
    expect(tracker.updates().length).toBe(1);
    expect(events(bead.id)).toEqual([]);
    // The bead now has two labels, and is refused until it is repaired.
    tracker.beforeUpdate = null;
    const next = await queue.move(bead.id, "pause", "operator");
    expect(next.ok ? "ok" : next.kind).toBe("refused");
  });

  test("a lock that cannot be had is busy, a lock file that cannot be one is a failure; bd is not called for either", async () => {
    const bead = beadIn("proposed");
    const tracker = queueTracker([bead]);
    const lockFile = join(home, "held-lock.db");
    const { Database } = await import("bun:sqlite");
    const holder = new Database(lockFile, { create: true });
    holder.exec("BEGIN EXCLUSIVE");
    const queue = createQueue({
      workspace,
      runBd: tracker.run,
      appendEvent: (event) => appendEvent(event, { path: ledger }),
      lockFile,
      lockWaitMs: 150,
    });
    const busy = await queue.move(bead.id, "approve", "operator");
    holder.exec("COMMIT");
    holder.close();
    expect(busy.ok ? "ok" : busy.kind).toBe("busy");

    const broken = createQueue({
      workspace,
      runBd: tracker.run,
      appendEvent: (event) => appendEvent(event, { path: ledger }),
      // A directory is not a file a lock can live in.
      lockFile: home,
    });
    const failed = await broken.move(bead.id, "approve", "operator");
    expect(failed.ok ? "ok" : failed.kind).toBe("failed");
    expect(tracker.calls).toEqual([]);
  });
});

describe("reassign", () => {
  const config = loadConfig({ harnessRoot: workspace, env: {}, home }).config;

  test("records the smith as the bead's smith metadata, in the states where the work has not started", async () => {
    for (const state of QUEUE_STATES) {
      const bead = beadIn(state, state === "paused" ? "queued" : undefined);
      const { tracker, queue, events } = rig([bead]);
      const result = await queue.reassign(bead.id, "claude-master", config);
      const allowed = ["proposed", "approved", "queued", "paused", "halted"];
      if (!allowed.includes(state)) {
        expect({ state, kind: result.ok ? "ok" : result.kind }).toEqual({
          state,
          kind: "refused",
        });
        expect(result.ok ? "" : result.error).toContain(`queue:${state}`);
        expect(tracker.updates()).toEqual([]);
        continue;
      }
      expect(result).toEqual({
        ok: true,
        value: { id: bead.id, state, smith: "claude-master" },
      });
      expect(tracker.calls).toEqual([
        show(bead.id),
        [
          "update",
          "--set-metadata=smith=claude-master",
          "--json",
          "--",
          bead.id,
        ],
      ]);
      expect(tracker.beads.get(bead.id)?.metadata?.["smith"]).toBe(
        "claude-master",
      );
      // The state did not move, so no transition is recorded.
      expect(queueLabels(tracker, bead.id)).toEqual([`queue:${state}`]);
      expect(events(bead.id)).toEqual([]);
    }
  });

  test("a bead outside the queue, with an inherited label, or with two labels is refused", async () => {
    const beads: TrackedBead[] = [
      beadIn(null),
      { id: `probe-${++serial}`, labels: ["queue:queued"] },
      {
        id: `probe-${++serial}`,
        labels: ["queue:queued", "queue:paused"],
        metadata: { queue_state: "queued" },
      },
    ];
    for (const bead of beads) {
      const { tracker, queue } = rig([bead]);
      const result = await queue.reassign(bead.id, "claude-master", config);
      expect(result.ok ? "ok" : result.kind).toBe("refused");
      expect(tracker.updates()).toEqual([]);
    }
  });

  test("a smith that is not configured, is disabled, or is not a name is invalid, and bd is not called", async () => {
    const disabled = structuredClone(config);
    const journeyman = disabled.smiths["claude-journeyman"];
    if (!journeyman) throw new Error("the built-in smith is missing");
    journeyman.enabled = false;
    const odd = structuredClone(config);
    odd.smiths["a=b"] = { ...journeyman, name: "a=b", enabled: true };
    const cases: Array<[typeof config, unknown, string]> = [
      [config, "nobody", "unknown smith"],
      [config, "", "smith"],
      [config, "--help", "smith"],
      [config, "toString", "unknown smith"],
      [config, "__proto__", "smith"],
      [config, "constructor", "unknown smith"],
      [config, 7, "smith"],
      [disabled, "claude-journeyman", "disabled"],
      [odd, "a=b", "smith"],
    ];
    for (const [given, smith, why] of cases) {
      const bead = beadIn("queued");
      const { tracker, queue } = rig([bead]);
      // justification: what a caller without types could pass.
      const result = await queue.reassign(bead.id, smith as string, given);
      expect({ smith, kind: result.ok ? "ok" : result.kind }).toEqual({
        smith,
        kind: "invalid",
      });
      expect(result.ok ? "" : result.error).toContain(why);
      expect(tracker.calls).toEqual([]);
    }
    expect(checkSmith(config, "claude-master")).toEqual({
      ok: true,
      smith: "claude-master",
    });
  });

  test("a write bd does not confirm is an unknown outcome", async () => {
    const bead = beadIn("queued");
    const { tracker, queue } = rig([bead]);
    tracker.intercept = (args) =>
      args[0] === "update" ? bdAnswers.help() : undefined;
    const result = await queue.reassign(bead.id, "claude-master", config);
    expect(result.ok ? "ok" : result.kind).toBe("unknown");

    // bd printed the bead, and the smith is not on it.
    tracker.intercept = (args) =>
      args[0] === "update"
        ? bdAnswers.updated({
            id: bead.id,
            title: "",
            issue_type: "task",
            priority: 2,
            status: "open",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            labels: ["queue:queued"],
            metadata: { queue_state: "queued", smith: "someone-else" },
          })
        : undefined;
    const unconfirmed = await queue.reassign(bead.id, "claude-master", config);
    expect(unconfirmed.ok ? "ok" : unconfirmed.kind).toBe("unknown");
    expect(unconfirmed.ok ? "" : unconfirmed.error).toContain(
      `bd show ${bead.id}`,
    );
  });
});

describe("the in-memory tracker, where it must behave as bd was measured to", () => {
  test("a label is added before it is removed: removing the label being added leaves none", async () => {
    const tracker = queueTracker([
      { id: "probe-1", labels: ["queue:proposed"] },
    ]);
    await tracker.run([
      "update",
      "--remove-label=queue:proposed",
      "--add-label=queue:proposed",
      "--json",
      "--",
      "probe-1",
    ]);
    expect(tracker.beads.get("probe-1")?.labels).toEqual([]);
  });

  test("removing a label that is not there is silent, and the add still happens", async () => {
    const tracker = queueTracker([
      { id: "probe-1", labels: ["queue:running"] },
    ]);
    const result = await tracker.run([
      "update",
      "--remove-label=queue:queued",
      "--add-label=queue:paused",
      "--json",
      "--",
      "probe-1",
    ]);
    expect(result.status).toBe(0);
    expect(tracker.beads.get("probe-1")?.labels?.sort()).toEqual([
      "queue:paused",
      "queue:running",
    ]);
  });

  test("it answers only the queue's two calls", () => {
    const tracker = queueTracker([{ id: "probe-1" }]);
    expect(tracker.answer(["show", "probe-1", "--json"])).toBeUndefined();
    expect(
      tracker.answer(["update", "--claim", "--json", "--", "probe-1"]),
    ).toBeUndefined();
    expect(tracker.answer(["list", "--json"])).toBeUndefined();
    expect(tracker.calls).toEqual([]);
  });
});

describe("bench selection", () => {
  const config = loadConfig({ harnessRoot: workspace, env: {}, home }).config;

  test("complexityOf reads the one complexity label", () => {
    expect(complexityOf(["x", "complexity:high"])).toEqual({
      ok: true,
      complexity: "high",
    });
    expect(complexityOf(["queue:queued"])).toEqual({ ok: true });
    expect(complexityOf([])).toEqual({ ok: true });
    expect(complexityOf(["complexity:low", "complexity:high"]).ok).toBe(false);
    expect(complexityOf(["complexity:huge"]).ok).toBe(false);
    expect(complexityOf(["complexity:"]).ok).toBe(false);
  });

  test("smithFor: the bead's smith, else the bench of its complexity, else the config's default", () => {
    const high = smithFor(config, {
      id: "probe-1",
      labels: ["complexity:high"],
    });
    expect(high.ok && [high.smith.name, high.via]).toEqual([
      "claude-master",
      "bench",
    ]);
    const low = smithFor(config, { id: "probe-1", labels: ["complexity:low"] });
    expect(low.ok && low.via).toBe("bench");
    expect(low.ok && config.benches.low.map((entry) => entry.smith)).toContain(
      low.ok ? low.smith.name : "",
    );
    // The same bead gets the same smith every time.
    expect(
      smithFor(config, { id: "probe-1", labels: ["complexity:low"] }),
    ).toEqual(low);
    const none = smithFor(config, { id: "probe-1", labels: ["queue:queued"] });
    expect(none.ok && [none.smith.name, none.via]).toEqual([
      config.workflow.defaultCrew,
      "default",
    ]);
    const preferred = smithFor(config, {
      id: "probe-1",
      labels: ["complexity:low"],
      metadata: { smith: "claude-master" },
    });
    expect(preferred.ok && [preferred.smith.name, preferred.via]).toEqual([
      "claude-master",
      "bead",
    ]);
    expect(
      smithFor(config, {
        id: "probe-1",
        labels: [],
        metadata: { smith: "nobody" },
      }).ok,
    ).toBe(false);
    expect(
      smithFor(config, {
        id: "probe-1",
        labels: ["complexity:low", "complexity:high"],
      }).ok,
    ).toBe(false);
    // Metadata that is not a name is no preference.
    const odd = smithFor(config, {
      id: "probe-1",
      labels: [],
      metadata: { smith: 7 },
    });
    expect(odd.ok && odd.via).toBe("default");
  });
});

describe("what a shift may pick", () => {
  const entry = (more: Partial<QueueEntry>): QueueEntry => ({
    beadId: "probe-1",
    title: "",
    state: "queued",
    status: "open",
    backed: true,
    ...more,
  });

  test("pickable: queued, written by the queue, not closed, and in no other state", () => {
    // An entry from a reader that does not say: not known to be the queue's.
    const { backed: _, ...unknownBacking } = entry({
      beadId: "probe-unknown-backing",
    });
    const entries: QueueEntry[] = [
      entry({ beadId: "probe-ok" }),
      entry({ beadId: "probe-progress", status: "in_progress" }),
      entry({ beadId: "probe-closed", status: "closed" }),
      entry({ beadId: "probe-inherited", backed: false }),
      unknownBacking,
      entry({ beadId: "probe-two" }),
      entry({ beadId: "probe-two", state: "paused" }),
      entry({ beadId: "probe-approved", state: "approved" }),
    ];
    expect(pickable(entries).map((picked) => picked.beadId)).toEqual([
      "probe-ok",
      "probe-progress",
    ]);
  });

  test("the bd arguments that print exactly that set", () => {
    expect([...QUEUED_EXACT_ARGS]).toEqual([
      "list",
      "--readonly",
      "--flat",
      "--json",
      "--limit",
      "0",
      "--label",
      "queue:queued",
      "--metadata-field",
      "queue_state=queued",
      "--exclude-label",
      "queue:proposed,queue:approved,queue:running,queue:review,queue:done,queue:paused,queue:halted",
    ]);
  });
});
