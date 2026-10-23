import { expect, test } from "bun:test";
import {
  QUEUE_STATES,
  type QueueState,
  type SmithsView,
} from "../../types/hearth";
import {
  type BdExportRow,
  issuesAndDepsFromExportRows,
} from "../beads-dashboard";
import { queueEntries } from "../hearth/routes/operator-reads";
import type { Eligibility } from "../scheduler/eligibility";
import type { ProjectSources } from "./summary";
import { projectFixture } from "./testing";
import { projectWorkbench } from "./workbench";

const workspace = "/fixture/workspace";
const smiths: SmithsView = {
  smiths: [
    {
      name: "fixture-smith",
      provider: "claude",
      model: "fixture-model",
      effort: "",
      enabled: true,
      tags: [],
    },
    {
      name: "fixture-master",
      provider: "claude",
      model: "fixture-master-model",
      effort: "",
      enabled: true,
      tags: [],
    },
    {
      name: "fixture-disabled",
      provider: "claude",
      model: "fixture-disabled-model",
      effort: "",
      enabled: false,
      tags: [],
    },
  ],
  benches: {
    low: [{ smith: "fixture-smith", weight: 100 }],
    medium: [{ smith: "fixture-smith", weight: 100 }],
    high: [{ smith: "fixture-master", weight: 100 }],
  },
  defaultSmith: "fixture-smith",
};
const host = { busy: false, cpu: 0.1, memory: 0.3, threshold: 0.85 };
type WorkbenchRow = BdExportRow & { metadata?: Record<string, string> };
function row(
  id: string,
  state?: QueueState,
  overrides: Partial<WorkbenchRow> = {},
): WorkbenchRow {
  return {
    id,
    title: id,
    issue_type: id === "alpha-epic" ? "epic" : "task",
    status: "open",
    priority: 4,
    labels: [
      "project:alpha",
      ...(state ? [`queue:${state}`] : []),
      "complexity:low",
    ],
    metadata: state
      ? {
          queue_state: state,
          ...(state === "paused" ? { queue_resume: "running" } : {}),
        }
      : {},
    dependencies:
      id === "alpha-epic"
        ? []
        : [{ issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" }],
    ...overrides,
  };
}
function source(rows: BdExportRow[]): ProjectSources {
  const normalized = issuesAndDepsFromExportRows(rows);
  const queue = queueEntries(JSON.stringify(rows));
  if (!queue.ok) throw Error(queue.error);
  return {
    workspace,
    asOf: "2026-10-23T00:00:00Z",
    issues: normalized.issues,
    dependencies: normalized.deps,
    beadRows: rows,
    queue: queue.entries,
    sessions: [],
    sessionsComplete: true,
    problems: [],
  };
}
const empty: Eligibility = { eligible: [], waiting: [], stale: [] };

test("Workbench shows all eight authoritative queue states, preserves P4, and never grants inherited or duplicate labels approval", () => {
  const rows = [
    row("alpha-epic"),
    ...QUEUE_STATES.map((state) => row(`alpha-${state}`, state)),
    row("alpha-inherited", "approved", { metadata: {} }),
    row("alpha-duplicate", "approved", {
      labels: ["project:alpha", "queue:approved", "queue:queued"],
    }),
    row("alpha-unknown-label", "queued", {
      labels: ["project:alpha", "queue:queued", "queue:teleported"],
    }),
    row("foreign", "queued", {
      labels: ["project:beta", "queue:queued"],
      title: "FOREIGN-TITLE",
    }),
  ];
  const page = projectWorkbench(projectFixture(workspace), source(rows), {
    eligibility: empty,
    smiths,
    host,
  });
  expect(new Set(page.cards.map((card) => card.entry.state))).toEqual(
    new Set(QUEUE_STATES),
  );
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-proposed")?.moves,
  ).toEqual(["approve", "pause", "reassign"]);
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-running")?.moves,
  ).toEqual(["pause"]);
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-paused")?.moves,
  ).toEqual(["resume", "reassign"]);
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-done")?.moves,
  ).toEqual([]);
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-inherited")?.moves,
  ).toEqual(["propose"]);
  expect(
    page.cards
      .filter((card) => card.entry.beadId === "alpha-duplicate")
      .every((card) => card.moves.length === 0),
  ).toBe(true);
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-proposed")?.entry
      .priority,
  ).toBe(4);
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-proposed")
      ?.complexity,
  ).toBe("low");
  expect(JSON.stringify(page)).not.toContain("FOREIGN");
  const unknown = page.cards.find(
    (card) => card.entry.beadId === "alpha-unknown-label",
  );
  expect(unknown?.moves).toEqual([]);
  expect(unknown?.note).toContain("conflicting");
  expect(unknown?.eligibility?.may).toBe(false);
});

test("foreign reservations remain conservative waits without leaking ids or globs; missing host or eligibility never says May start", () => {
  const input = source([
    row("alpha-epic"),
    row("alpha-ready", "queued"),
    row("alpha-waits", "queued"),
  ]);
  const eligibility: Eligibility = {
    eligible: [{ id: "alpha-ready", globs: ["apps/**"], conservative: false }],
    waiting: [
      {
        id: "alpha-waits",
        why: "overlaps FOREIGN-ID in secret/path/**",
        waitsOn: "FOREIGN-ID",
        globs: ["secret/path/**"],
      },
    ],
    stale: [],
  };
  const page = projectWorkbench(projectFixture(workspace), input, {
    eligibility,
    smiths,
    host,
  });
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-ready")?.eligibility
      ?.may,
  ).toBe(true);
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-waits")?.eligibility,
  ).toMatchObject({ may: false, waitsOn: null });
  expect(JSON.stringify(page)).not.toContain("FOREIGN-ID");
  expect(JSON.stringify(page)).not.toContain("secret/path");
  for (const observations of [
    { eligibility: null, smiths, host },
    { eligibility, smiths, host: null },
  ]) {
    const unknown = projectWorkbench(
      projectFixture(workspace),
      input,
      observations,
    );
    expect(unknown.cards.some((card) => card.eligibility?.may === true)).toBe(
      false,
    );
    expect(unknown.problems.length).toBeGreaterThan(0);
  }
  const busy = projectWorkbench(projectFixture(workspace), input, {
    eligibility,
    smiths,
    host: { ...host, busy: true, reason: "CPU 93%" },
  });
  expect(
    busy.cards.find((card) => card.entry.beadId === "alpha-ready")?.eligibility,
  ).toMatchObject({ may: false, reason: "The host is busy: CPU 93%" });
});

test("Workbench refuses an unavailable tracker or foreign workspace rather than reporting a confirmed empty board", () => {
  const input = source([row("alpha-epic")]);
  expect(() =>
    projectWorkbench(
      projectFixture(workspace),
      { ...input, issues: null },
      { eligibility: empty, smiths, host },
    ),
  ).toThrow("tracker");
  expect(() =>
    projectWorkbench(
      projectFixture(workspace),
      { ...input, workspace: "/another" },
      { eligibility: empty, smiths, host },
    ),
  ).toThrow("workspace");
});

test("smith observation follows bead, deterministic complexity bench and default precedence; disabled selection never says May start", () => {
  const input = source([
    row("alpha-epic"),
    row("alpha-high", "queued", {
      labels: ["project:alpha", "queue:queued", "complexity:high"],
    }),
    row("alpha-default", "approved", {
      labels: ["project:alpha", "queue:approved"],
    }),
    row("alpha-assigned", "approved", {
      metadata: { queue_state: "approved", smith: "fixture-master" },
    }),
    row("alpha-disabled", "queued", {
      metadata: { queue_state: "queued", smith: "fixture-disabled" },
    }),
  ]);
  const page = projectWorkbench(projectFixture(workspace), input, {
    eligibility: {
      eligible: [
        { id: "alpha-high", globs: ["apps/high/**"], conservative: false },
        {
          id: "alpha-disabled",
          globs: ["apps/disabled/**"],
          conservative: false,
        },
      ],
      waiting: [],
      stale: [],
    },
    smiths,
    host,
  });
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-high")?.smith,
  ).toMatchObject({ name: "fixture-master", via: "bench" });
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-default")?.smith,
  ).toMatchObject({ name: "fixture-smith", via: "default" });
  expect(
    page.cards.find((card) => card.entry.beadId === "alpha-assigned")?.smith,
  ).toMatchObject({ name: "fixture-master", via: "bead" });
  const disabled = page.cards.find(
    (card) => card.entry.beadId === "alpha-disabled",
  );
  expect(disabled?.smith.name).toBeNull();
  expect(disabled?.smith.reason).toContain("disabled");
  expect(disabled?.eligibility?.may).toBe(false);
});
