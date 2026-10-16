import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Reservation } from "../../types/hearth";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { resolveCheckout } from "../ledger/workspace";
import {
  type EligibilityInput,
  eligibility,
  type QueuedBead,
  readEligibility,
  type ShiftWorktree,
} from "./eligibility";
import { QUEUED_EXACT_ARGS } from "./queue";
import { type ShiftStanding, writeShiftRecord } from "./shift-store";

const files = (...globs: string[]) => `## Files\n${globs.join("\n")}\n`;

function bead(id: string, more: Partial<QueuedBead> = {}): QueuedBead {
  return {
    id,
    title: id,
    issue_type: "task",
    status: "open",
    priority: 2,
    description: files(`src/${id}.ts`),
    ...more,
  };
}

function input(
  candidates: QueuedBead[],
  more: Partial<EligibilityInput> = {},
): EligibilityInput {
  return {
    candidates,
    readyIds: new Set(
      candidates.filter((c) => c.status === "open").map((c) => c.id),
    ),
    active: [],
    staleIds: new Map(),
    host: { busy: false },
    ...more,
  };
}

const ids = (list: Array<{ id: string }>) => list.map((entry) => entry.id);

function reservation(beadId: string, globs: string[]): Reservation {
  return {
    beadId,
    worktree: `c:/repo/trees/${beadId}`,
    workspace: "c:/repo",
    globs,
    acquiredAt: "2026-10-12T00:00:00.000Z",
  };
}

describe("eligibility: overlapping beads are never eligible together", () => {
  test("of two queued, ready beads whose globs overlap, only the first in bundle order is eligible; the other waits on it", () => {
    const answer = eligibility(
      input([
        bead("t-b", { description: files("src/**") }),
        bead("t-a", { description: files("src/a.ts") }),
      ]),
    );
    expect(ids(answer.eligible)).toEqual(["t-a"]);
    expect(answer.waiting).toEqual([
      expect.objectContaining({ id: "t-b", waitsOn: "t-a" }),
    ]);
  });

  test("beads whose globs do not overlap are eligible together", () => {
    const answer = eligibility(input([bead("t-a"), bead("t-b"), bead("t-c")]));
    expect(ids(answer.eligible)).toEqual(["t-a", "t-b", "t-c"]);
    expect(answer.waiting).toEqual([]);
  });

  test("across every order of three beads that pairwise overlap, exactly one is eligible", () => {
    const three = [
      bead("t-1", { description: files("a/**") }),
      bead("t-2", { description: files("a/b.ts") }),
      bead("t-3", { description: files("**/b.ts") }),
    ];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
    ]) {
      const answer = eligibility(
        input(order.map((i) => three[i] as QueuedBead)),
      );
      expect(answer.eligible.length).toBe(1);
      expect(answer.waiting.length).toBe(2);
    }
  });
});

describe("eligibility: serialized in bundle order", () => {
  test("a bead's blocker comes first; within a layer by priority, then by natural id", () => {
    const blocked = bead("t-1", {
      status: "open",
      dependencies: [
        { issue_id: "t-1", depends_on_id: "t-9", type: "blocks" },
        // Not an ordering edge.
        { issue_id: "t-1", depends_on_id: "epic-0", type: "parent-child" },
      ],
    });
    const answer = eligibility(
      input([
        blocked,
        bead("t-9"),
        bead("x.10", { priority: 1 }),
        bead("x.2", { priority: 1 }),
        bead("t-0", { priority: 3 }),
      ]),
    );
    // t-1 is in the second layer, after its blocker t-9; it is also ready here
    // only because the test says so (a real bd would not call it ready).
    expect(ids([...answer.eligible, ...answer.waiting])).toEqual([
      "x.2",
      "x.10",
      "t-9",
      "t-0",
      "t-1",
    ]);
  });

  test("a waiting bead keeps its place: a later bead that overlaps only it waits too", () => {
    const answer = eligibility(
      input(
        [
          bead("t-1", { description: files("a/**", "b/**") }),
          bead("t-2", { description: files("b/x.ts") }),
        ],
        { active: [reservation("t-0", ["a/one.ts"])] },
      ),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting).toEqual([
      expect.objectContaining({ id: "t-1", waitsOn: "t-0" }),
      expect.objectContaining({ id: "t-2", waitsOn: "t-1" }),
    ]);
  });

  test("once the first bead's reservation is released, the second becomes eligible", () => {
    const second = bead("t-2", { description: files("src/a.ts") });
    // t-1 started: it is no longer queued, and holds its reservation.
    const running = eligibility(
      input([second], { active: [reservation("t-1", ["src/**"])] }),
    );
    expect(running.waiting).toEqual([
      expect.objectContaining({ id: "t-2", waitsOn: "t-1" }),
    ]);
    const released = eligibility(input([second], { active: [] }));
    expect(ids(released.eligible)).toEqual(["t-2"]);
  });
});

/** Pairs of beads that each wait on the other. */
function circles(waiting: Array<{ id: string; waitsOn?: string }>): string[] {
  const on = new Map(waiting.map((w) => [w.id, w.waitsOn]));
  return waiting
    .filter((w) => w.waitsOn !== undefined && on.get(w.waitsOn) === w.id)
    .map((w) => `${w.id} <-> ${w.waitsOn}`);
}

describe("eligibility: what holds a bead back", () => {
  test("two queued beads holding overlapping reservations are both held back, and neither is named as waited on", () => {
    const answer = eligibility(
      input(
        [
          bead("t-1", { description: files("src/**") }),
          bead("t-2", { description: files("src/a.ts") }),
          bead("t-3", { description: files("docs/x.md") }),
        ],
        {
          active: [
            reservation("t-1", ["src/**"]),
            reservation("t-2", ["src/a.ts"]),
          ],
        },
      ),
    );
    expect(ids(answer.eligible)).toEqual(["t-3"]);
    expect(answer.waiting.map((w) => [w.id, w.waitsOn ?? null])).toEqual([
      ["t-1", null],
      ["t-2", null],
    ]);
    expect(answer.waiting[0]?.why).toContain("release one");
  });

  test("a holder whose map changed since it reserved waits to reserve again, and no two holders wait on each other", () => {
    const answer = eligibility(
      input(
        [
          bead("t-1", { description: files("src/**") }),
          bead("t-2", { description: files("lib/x.ts", "src/a.ts") }),
        ],
        {
          active: [
            reservation("t-1", ["docs/**"]),
            reservation("t-2", ["lib/x.ts", "src/a.ts"]),
          ],
        },
      ),
    );
    expect(ids(answer.eligible)).toEqual(["t-2"]);
    expect(answer.waiting[0]).toMatchObject({ id: "t-1" });
    expect(answer.waiting[0]?.why).toContain("changed since it was reserved");
    expect(circles(answer.waiting)).toEqual([]);
  });

  test("an in-progress bead with no reservation holds back an overlapping bead that holds one", () => {
    const answer = eligibility(
      input(
        [
          bead("t-1", { status: "in_progress", description: files("src/**") }),
          bead("t-2", { description: files("src/a.ts") }),
        ],
        {
          readyIds: new Set(["t-2"]),
          active: [reservation("t-2", ["src/a.ts"])],
        },
      ),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting.map((w) => [w.id, w.waitsOn ?? null])).toEqual([
      ["t-1", null],
      ["t-2", "t-1"],
    ]);
  });

  test("a why names a glob in at most 120 characters", () => {
    const long = `src/${"x".repeat(200)}`;
    const answer = eligibility(
      input([
        bead("t-1", { description: files(`${long}/**`) }),
        bead("t-2", { description: files("src/**") }),
      ]),
    );
    expect(answer.waiting[0]?.why.length).toBeLessThan(400);
    expect(answer.waiting[0]?.why).toContain("…");
    // The cut falls between characters, never inside one.
    const astral = eligibility(
      input([
        bead("t-1", {
          description: files(`src/${"x".repeat(114)}\u{1F600}x/**`),
        }),
        bead("t-2", { description: files("src/**") }),
      ]),
    );
    // A lone surrogate is a one-unit character in the surrogate range.
    const lone = Array.from(astral.waiting[0]?.why ?? "").filter(
      (c) =>
        c.length === 1 &&
        c.charCodeAt(0) >= 0xd800 &&
        c.charCodeAt(0) <= 0xdfff,
    );
    expect(lone).toEqual([]);
  });

  test("an in-progress bead holds back an overlapping bead whichever comes first in the order", () => {
    for (const [running, other] of [
      ["probe-7vh", "probe-4kl"],
      ["probe-4kl", "probe-7vh"],
    ] as const) {
      const answer = eligibility(
        input(
          [
            bead(running, {
              status: "in_progress",
              description: files("docs/**"),
            }),
            bead(other, { description: files("docs/x.md") }),
          ],
          { readyIds: new Set([other]) },
        ),
      );
      expect({ running, eligible: ids(answer.eligible) }).toEqual({
        running,
        eligible: [],
      });
      expect(answer.waiting.find((w) => w.id === other)).toMatchObject({
        waitsOn: running,
      });
    }
  });

  test("a queued bead that already holds its reservation goes first: a bead ordered before it that overlaps waits on it, and nothing waits in a circle", () => {
    // probe-ve9 comes before probe-y0c in id order; y0c already holds src/**.
    const answer = eligibility(
      input(
        [
          bead("probe-y0c", { description: files("src/**") }),
          bead("probe-ve9", { description: files("src/a.ts") }),
        ],
        { active: [reservation("probe-y0c", ["src/**"])] },
      ),
    );
    expect(ids(answer.eligible)).toEqual(["probe-y0c"]);
    expect(answer.waiting).toEqual([
      expect.objectContaining({ id: "probe-ve9", waitsOn: "probe-y0c" }),
    ]);
  });

  test("its own reservation does not; another bead's does, naming it and the globs", () => {
    const own = eligibility(
      input([bead("t-1", { description: files("src/**") })], {
        active: [reservation("t-1", ["src/**"])],
      }),
    );
    expect(ids(own.eligible)).toEqual(["t-1"]);
    const other = eligibility(
      input([bead("t-1", { description: files("src/**") })], {
        active: [reservation("t-7", ["src/x/y.ts"])],
      }),
    );
    expect(other.waiting[0]).toMatchObject({ id: "t-1", waitsOn: "t-7" });
    expect(other.waiting[0]?.why).toContain("src/x/y.ts");
  });

  test("a reservation whose bead is closed or gone is stale: ignored, and reported", () => {
    const answer = eligibility(
      input([bead("t-1", { description: files("src/**") })], {
        active: [
          reservation("t-old", ["src/**"]),
          reservation("t-del", ["**"]),
        ],
        staleIds: new Map([
          ["t-old", "closed"],
          ["t-del", "gone"],
        ]),
      }),
    );
    expect(ids(answer.eligible)).toEqual(["t-1"]);
    expect(
      answer.stale.map((entry) => [entry.reservation.beadId, entry.why]),
    ).toEqual([
      ["t-old", "closed"],
      ["t-del", "gone"],
    ]);
  });

  test("a blocked bead waits and claims nothing, so it never holds back its own blocker", () => {
    const blocked = bead("t-1", {
      priority: 0,
      description: files("src/**"),
      dependencies: [{ issue_id: "t-1", depends_on_id: "t-2", type: "blocks" }],
    });
    const blocker = bead("t-2", {
      priority: 4,
      description: files("src/a.ts"),
    });
    for (const withDeps of [true, false]) {
      const candidates = withDeps
        ? [blocked, blocker]
        : [{ ...blocked, dependencies: [] }, blocker];
      const answer = eligibility(
        input(candidates, { readyIds: new Set(["t-2"]) }),
      );
      expect({ withDeps, eligible: ids(answer.eligible) }).toEqual({
        withDeps,
        eligible: ["t-2"],
      });
      expect(answer.waiting[0]).toMatchObject({ id: "t-1" });
      expect(answer.waiting[0]?.why).toContain("blocked");
    }
  });

  test("an in-progress queued bead waits and keeps its claim", () => {
    const answer = eligibility(
      input(
        [
          bead("t-1", { status: "in_progress", description: files("src/**") }),
          bead("t-2", { description: files("src/a.ts") }),
        ],
        { readyIds: new Set(["t-2"]) },
      ),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting).toEqual([
      expect.objectContaining({ id: "t-1" }),
      expect.objectContaining({ id: "t-2", waitsOn: "t-1" }),
    ]);
    expect(answer.waiting[0]?.why).toContain("in progress");
  });

  test("a busy host keeps every bead waiting, with its reason, and claims nothing", () => {
    const answer = eligibility(
      input([bead("t-1"), bead("t-2")], {
        host: { busy: true, reason: "CPU at 93%" },
      }),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting.map((w) => w.why)).toEqual([
      "the host is busy: CPU at 93%",
      "the host is busy: CPU at 93%",
    ]);
  });

  test("a queued epic is never a candidate and claims nothing", () => {
    const answer = eligibility(
      input([
        bead("e-1", { issue_type: "epic", description: "no map" }),
        bead("t-1"),
      ]),
    );
    expect(ids(answer.eligible)).toEqual(["t-1"]);
    expect(answer.waiting[0]).toMatchObject({ id: "e-1" });
    expect(answer.waiting[0]?.why).toContain("epic");
  });

  test("a bead with a missing or malformed map reserves everything, holds back every bead after it, and says why", () => {
    const answer = eligibility(
      input([
        bead("t-1", { description: "no map" }),
        bead("t-2", { description: files("../out") }),
        bead("t-3"),
      ]),
    );
    expect(ids(answer.eligible)).toEqual(["t-1"]);
    expect(answer.eligible[0]).toMatchObject({
      globs: ["**"],
      conservative: true,
    });
    expect(answer.waiting.map((w) => [w.id, w.waitsOn])).toEqual([
      ["t-2", "t-1"],
      ["t-3", "t-1"],
    ]);
    expect(answer.waiting[0]?.conservative).toBe(true);
  });
});

describe("eligibility: a queued bead whose reservation a shift's worktree still holds (x1gs.5.4.13)", () => {
  const SHIFT = "shift-20261015-120000-0a0b";
  const TREE = `c:/repo/trees/${SHIFT}-1`;
  const inShift = (beadId: string, globs: string[]): Reservation => ({
    ...reservation(beadId, globs),
    worktree: TREE,
  });
  const standing = (state: ShiftStanding): ReadonlyMap<string, ShiftWorktree> =>
    new Map([[TREE, { shiftId: SHIFT, standing: state }]]);

  test("in a live shift's worktree it waits for that run, naming the worktree and the shift, and is eligible once the reservation is released", () => {
    const one = bead("t-1", { description: files("src/**") });
    const answer = eligibility(
      input([one], {
        active: [inShift("t-1", ["src/**"])],
        shiftWorktrees: standing("live"),
      }),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting).toEqual([
      {
        id: "t-1",
        why: `its earlier run in ${TREE} (shift ${SHIFT}) has not ended: it starts again once that run releases its reservation (if that shift is gone and its pid names another program now, bun run forge:reservations release t-1 ${TREE} frees it)`,
        waitsOnShift: SHIFT,
        globs: ["src/**"],
        conservative: false,
      },
    ]);
    const released = eligibility(
      input([one], { active: [], shiftWorktrees: standing("live") }),
    );
    expect(ids(released.eligible)).toEqual(["t-1"]);
  });

  test("in a dead shift's worktree it waits too, and the reason says forge:shift recover frees it", () => {
    const answer = eligibility(
      input([bead("t-1", { description: files("src/**") })], {
        active: [inShift("t-1", ["src/**"])],
        shiftWorktrees: standing("dead"),
      }),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting[0]).toMatchObject({ id: "t-1", waitsOnShift: SHIFT });
    expect(answer.waiting[0]?.why).toContain("process has ended");
    expect(answer.waiting[0]?.why).toContain(
      `bun run forge:shift recover ${SHIFT} frees it`,
    );
  });

  test("in the worktree of a shift whose record was not read it waits, and says how the reservation is freed", () => {
    const answer = eligibility(
      input([bead("t-1", { description: files("src/**") })], {
        active: [inShift("t-1", ["src/**"])],
        shiftWorktrees: standing("unknown"),
      }),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting[0]).toMatchObject({ id: "t-1", waitsOnShift: SHIFT });
    expect(answer.waiting[0]?.why).toContain("whose record was not read here");
    expect(answer.waiting[0]?.why).toContain("forge:reservations release");
  });

  test("a reservation in a stopped shift's worktree, or in one made outside any shift (by hand), holds its bead back no more than before: it is eligible", () => {
    const one = bead("t-1", { description: files("src/**") });
    for (const [active, shiftWorktrees] of [
      [[inShift("t-1", ["src/**"])], standing("stopped")],
      [[reservation("t-1", ["src/**"])], standing("live")],
      [[reservation("t-1", ["src/**"])], undefined],
    ] as const) {
      const answer = eligibility(
        input([one], {
          active,
          ...(shiftWorktrees !== undefined ? { shiftWorktrees } : {}),
        }),
      );
      expect(ids(answer.eligible)).toEqual(["t-1"]);
      expect(answer.waiting).toEqual([]);
    }
  });

  test("it keeps its place while it waits: what it holds still claims, so an overlapping bead waits on it and one that does not overlap is eligible", () => {
    const answer = eligibility(
      input(
        [
          bead("t-1", { description: files("src/**") }),
          bead("t-2", { description: files("src/a.ts") }),
          bead("t-3", { description: files("docs/x.md") }),
        ],
        {
          active: [inShift("t-1", ["src/**"])],
          shiftWorktrees: standing("live"),
        },
      ),
    );
    expect(ids(answer.eligible)).toEqual(["t-3"]);
    expect(
      answer.waiting.map((w) => [w.id, w.waitsOn ?? null, w.waitsOnShift]),
    ).toEqual([
      ["t-1", null, SHIFT],
      ["t-2", "t-1", undefined],
    ]);
  });

  test("an in-progress queued bead that waits for its earlier run still claims its current map, beside what it holds", () => {
    const answer = eligibility(
      input(
        [
          bead("t-1", { status: "in_progress", description: files("lib/**") }),
          bead("t-2", { description: files("lib/c.ts") }),
        ],
        {
          readyIds: new Set(["t-2"]),
          active: [inShift("t-1", ["src/**"])],
          shiftWorktrees: standing("live"),
        },
      ),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting).toEqual([
      expect.objectContaining({
        id: "t-1",
        waitsOnShift: SHIFT,
        globs: ["lib/**"],
      }),
      expect.objectContaining({ id: "t-2", waitsOn: "t-1" }),
    ]);
  });

  test("a running bead's reservation in a live shift's worktree (that shift's own run, not queued) is a claim as before: an overlapping queued bead waits on it, naming no shift", () => {
    const answer = eligibility(
      input([bead("t-2", { description: files("src/a.ts") })], {
        active: [inShift("t-1", ["src/**"])],
        shiftWorktrees: standing("live"),
      }),
    );
    expect(answer.eligible).toEqual([]);
    expect(answer.waiting).toEqual([
      expect.objectContaining({ id: "t-2", waitsOn: "t-1" }),
    ]);
    expect(answer.waiting[0]?.waitsOnShift).toBeUndefined();
  });
});

describe("readEligibility: from bd and the ledger", () => {
  const home = mkdtempSync(join(tmpdir(), "af-eligibility-"));
  const root = join(home, "checkout");
  mkdirSync(join(root, ".git"), { recursive: true });
  const ledger = join(home, "ledger.db");
  const workspace = resolveCheckout(root).workspace;
  afterAll(() => {
    closeLedger(ledger);
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const ok = (value: unknown): BdResult => ({
    status: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  });

  function stubBd(answers: {
    queued: QueuedBead[];
    ready: string[];
    shown?: (ids: string[]) => BdResult;
  }): { run: BdRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: BdRunner = (args) => {
      calls.push(args);
      if (args[0] === "list" && args.includes("--ready"))
        return ok(answers.queued.filter((b) => answers.ready.includes(b.id)));
      if (args[0] === "list") return ok(answers.queued);
      if (args[0] === "show")
        return answers.shown?.(args.slice(args.indexOf("--") + 1)) ?? ok([]);
      return { status: 1, stdout: "", stderr: "not asked" };
    };
    return { run, calls };
  }

  test("joins the exact queued set, the ready ids, the ledger's reservations and the reserved beads that are closed or gone", async () => {
    for (const [beadId, globs] of [
      ["t-held", ["src/**"]],
      ["t-closed", ["docs/**"]],
      ["t-gone", ["**"]],
    ] as const)
      appendEvent(
        {
          kind: "reservation.acquired",
          workspace,
          beadId,
          payload: {
            worktree: `${workspace}/trees/${beadId}`,
            globs: [...globs],
          },
        },
        { path: ledger },
      );
    const bd = stubBd({
      queued: [
        bead("t-1", { description: files("src/a.ts") }),
        bead("t-2", { description: files("docs/x.md") }),
        bead("t-3", { status: "in_progress" }),
      ],
      ready: ["t-1", "t-2"],
      // A partial id resolved to another bead is not that bead.
      shown: () =>
        ok([
          { id: "t-held", status: "in_progress" },
          { id: "t-closed", status: "closed" },
          { id: "t-gone-but-longer", status: "open" },
        ]),
    });
    const answer = await readEligibility({
      root,
      runBd: bd.run,
      ledgerPath: ledger,
      host: { busy: false },
    });
    if (!answer.ok) throw new Error(answer.error);
    expect(ids(answer.value.eligible)).toEqual(["t-2"]);
    // The bead in progress is walked before the others.
    expect(answer.value.waiting.map((w) => [w.id, w.waitsOn ?? null])).toEqual([
      ["t-3", null],
      ["t-1", "t-held"],
    ]);
    expect(
      answer.value.stale.map((s) => [s.reservation.beadId, s.why]),
    ).toEqual([
      ["t-closed", "closed"],
      ["t-gone", "gone"],
    ]);
    expect(bd.calls[0]).toEqual([...QUEUED_EXACT_ARGS]);
    expect(bd.calls[1]).toEqual([...QUEUED_EXACT_ARGS, "--ready"]);
    expect(bd.calls[2]?.slice(0, 4)).toEqual([
      "show",
      "--readonly",
      "--json",
      "--",
    ]);
  });

  test("bd answering that none of the reserved beads exists makes them all gone, not an error", async () => {
    const other = join(home, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    const otherWorkspace = resolveCheckout(other).workspace;
    appendEvent(
      {
        kind: "reservation.acquired",
        workspace: otherWorkspace,
        beadId: "t-x",
        payload: { worktree: `${otherWorkspace}/trees/x`, globs: ["**"] },
      },
      { path: ledger },
    );
    const bd = stubBd({
      queued: [bead("t-1")],
      ready: ["t-1"],
      shown: () => ({
        status: 1,
        stdout: JSON.stringify({
          error: "no issues found matching the provided IDs",
          schema_version: 1,
        }),
        stderr: "",
      }),
    });
    const answer = await readEligibility({
      root: other,
      runBd: bd.run,
      ledgerPath: ledger,
      host: { busy: false },
    });
    if (!answer.ok) throw new Error(answer.error);
    expect(ids(answer.value.eligible)).toEqual(["t-1"]);
    expect(answer.value.stale.map((s) => s.why)).toEqual(["gone"]);
  });

  test("a listed bead that also carries a queue label that is not a state is no candidate: neither eligible nor waiting, since start would refuse it", async () => {
    const other = join(home, "teleported");
    mkdirSync(join(other, ".git"), { recursive: true });
    const queued = { queue_state: "queued" };
    const bd = stubBd({
      queued: [
        bead("t-1", { labels: ["queue:queued"], metadata: queued }),
        bead("t-2", {
          labels: ["queue:queued", "queue:teleported"],
          metadata: queued,
        }),
        bead("t-3", {
          labels: ["queue:queued", "queue:teleported"],
          metadata: queued,
          status: "in_progress",
        }),
      ],
      ready: ["t-1", "t-2"],
    });
    const answer = await readEligibility({
      root: other,
      runBd: bd.run,
      ledgerPath: ledger,
      host: { busy: false },
    });
    if (!answer.ok) throw new Error(answer.error);
    expect(ids(answer.value.eligible)).toEqual(["t-1"]);
    expect(answer.value.waiting).toEqual([]);
  });

  test("a queued bead's reservation in a shift's worktree is read against that shift's record: a live, a dead or an unrecorded shift's worktree holds its bead back, a stopped shift's and a by-hand one do not; without the records every shift's worktree does", async () => {
    const checkout = join(home, "shifts checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    const space = resolveCheckout(checkout).workspace;
    const shiftsDir = join(home, "shifts");
    const shiftIds = {
      live: "shift-20261015-120000-0001",
      dead: "shift-20261015-120000-0002",
      stopped: "shift-20261015-120000-0003",
      none: "shift-20261015-120000-0004",
    } as const;
    const record = (shiftId: string, pid: number, stopped = false) =>
      writeShiftRecord(shiftsDir, {
        shiftId,
        pid,
        workspace: space,
        startedAt: "2026-10-15T12:00:00.000Z",
        deadline: "2026-10-15T14:00:00.000Z",
        state: stopped ? "stopped" : "running",
        options: {
          concurrency: 2,
          forMs: 7_200_000,
          maxBeads: 4,
          maxUsd: 10,
          repairs: 0,
        },
        spentUsd: 0,
        unpriced: 0,
        beads: [],
      });
    record(shiftIds.live, process.pid);
    // No process has this id (shift-recover.test.ts uses it as dead too).
    record(shiftIds.dead, 2_000_000_000);
    record(shiftIds.stopped, process.pid, true);
    const held: Array<[string, string]> = [
      ["t-live", `${space}/trees/${shiftIds.live}-1`],
      ["t-dead", `${space}/trees/${shiftIds.dead}-2`],
      ["t-stopped", `${space}/trees/${shiftIds.stopped}-1`],
      ["t-none", `${space}/trees/${shiftIds.none}-1`],
      // Made by hand: not a shift's name, and not under trees/ either.
      ["t-hand", `${space}/trees/t-hand`],
      ["t-odd", `${space}/elsewhere/${shiftIds.live}-1`],
    ];
    for (const [beadId, worktree] of held)
      appendEvent(
        {
          kind: "reservation.acquired",
          workspace: space,
          beadId,
          payload: { worktree, globs: [`src/${beadId}/**`] },
        },
        { path: ledger },
      );
    const queued = held.map(([id]) =>
      bead(id, { description: files(`src/${id}/**`) }),
    );
    const bd = stubBd({ queued, ready: queued.map((b) => b.id) });

    const read = await readEligibility({
      root: checkout,
      runBd: bd.run,
      ledgerPath: ledger,
      host: { busy: false },
      shiftsDir,
    });
    if (!read.ok) throw new Error(read.error);
    expect(ids(read.value.eligible).sort()).toEqual([
      "t-hand",
      "t-odd",
      "t-stopped",
    ]);
    const waits = new Map(read.value.waiting.map((w) => [w.id, w]));
    expect(waits.get("t-live")).toMatchObject({ waitsOnShift: shiftIds.live });
    expect(waits.get("t-live")?.why).toContain("has not ended");
    expect(waits.get("t-dead")).toMatchObject({ waitsOnShift: shiftIds.dead });
    expect(waits.get("t-dead")?.why).toContain(
      `forge:shift recover ${shiftIds.dead}`,
    );
    expect(waits.get("t-none")).toMatchObject({ waitsOnShift: shiftIds.none });
    expect(waits.get("t-none")?.why).toContain("record was not read here");

    // Without the records, nothing tells a stopped shift from a live one.
    const blind = await readEligibility({
      root: checkout,
      runBd: bd.run,
      ledgerPath: ledger,
      host: { busy: false },
    });
    if (!blind.ok) throw new Error(blind.error);
    expect(ids(blind.value.eligible).sort()).toEqual(["t-hand", "t-odd"]);
    expect(
      blind.value.waiting.map((w) => [w.id, w.waitsOnShift]).sort(),
    ).toEqual([
      ["t-dead", shiftIds.dead],
      ["t-live", shiftIds.live],
      ["t-none", shiftIds.none],
      ["t-stopped", shiftIds.stopped],
    ]);
    for (const wait of blind.value.waiting)
      expect(wait.why).toContain("record was not read here");
  });

  test("any other bd failure is an error, not an empty queue", async () => {
    const refused: BdRunner = () => ({
      status: 1,
      stdout: "",
      stderr: "Error: database is locked",
    });
    const answer = await readEligibility({
      root,
      runBd: refused,
      ledgerPath: ledger,
      host: { busy: false },
    });
    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.error).toContain("database is locked");
  });
});
