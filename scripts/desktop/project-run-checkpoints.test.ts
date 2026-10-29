import { expect, test } from "bun:test";
import { deriveProjectRunCheckpoints } from "../../apps/desktop/src/project-run-checkpoints";
import type { ProjectBead, ProjectBeadsPage } from "../../types/project-beads";
import type {
  ProjectRunDetail,
  ProjectRunRow,
  ProjectRunsPage,
} from "../../types/project-runs";

const projectId = "project-alpha",
  workspace = "C:/checkout",
  checkout = "C:/checkout",
  slug = "alpha-run";
const row: ProjectRunRow = {
  slug,
  feature: "Alpha run",
  epic: "alpha-epic",
  mode: "gated",
  health: "running",
  phases: [],
  status: { kind: "phase", phase: "implement" },
  completedCount: 2,
  totalPhases: 4,
  gatePassed: null,
  reviewRounds: 0,
  latestVerdict: null,
  updatedAt: null,
  complete: false,
};
function bead(
  id: string,
  type: ProjectBead["type"],
  status: string,
  parent: string | null,
): ProjectBead {
  return {
    id,
    title: id,
    type,
    status,
    priority: 2,
    parent,
    assignee: null,
    owner: null,
    labels: [],
    createdAt: "2026-10-29T00:00:00Z",
    updatedAt: "2026-10-29T00:00:00Z",
    due: null,
    description: "",
    acceptanceCriteria: "",
    estimate: null,
    spent: null,
    ready: false,
    blocked: false,
    blockers: [],
    unavailableBlockers: 0,
    queue: null,
    smith: null,
    comments: [],
    commentsComplete: false,
    detailsLoaded: false,
    fileMap: null,
    fileMapReason: null,
    reservations: null,
    activity: null,
    activityComplete: false,
  };
}
function input() {
  const run = { ...row };
  const page: ProjectRunsPage = {
    version: 1,
    projectId,
    workspace,
    checkout,
    asOf: "2026-10-29T00:00:00Z",
    coverage: "served-checkout-only",
    problems: [],
    runs: [run],
  };
  const detail: ProjectRunDetail = {
    version: 1,
    projectId,
    workspace,
    checkout,
    asOf: page.asOf,
    coverage: page.coverage,
    problems: [],
    run: { ...run },
    reviews: [],
    gateHistory: [],
    gateHistoryDays: 30,
    earlierGateLimit: 10,
  };
  const beads: ProjectBeadsPage = {
    projectId,
    workspace,
    asOf: page.asOf,
    complete: true,
    problems: [],
    beads: [
      bead("alpha-epic", "epic", "open", null),
      bead("alpha-feature", "feature", "open", "alpha-epic"),
      bead("alpha-active", "task", "in_progress", "alpha-feature"),
      bead("alpha-second", "task", "in_progress", "alpha-feature"),
      bead("alpha-next", "task", "open", "alpha-feature"),
    ],
    dependencies: [{ from: "alpha-next", to: "alpha-active", type: "blocks" }],
  };
  return {
    projectId,
    workspace,
    runs: {
      page,
      loading: false,
      error: "",
      selectedSlug: slug,
      detail,
      detailLoading: false,
      detailError: "",
      detailStale: false,
    },
    beads: { page: beads, loading: false, error: null },
  };
}

test("only the current complete scoped run graph becomes checkpoint facts", () => {
  const result = deriveProjectRunCheckpoints(input());
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.epicId).toBe("alpha-epic");
  expect(
    result.summary.checkpoints.map(({ id, status }) => [id, status]),
  ).toEqual([
    ["alpha-active", "in_progress"],
    ["alpha-next", "open"],
    ["alpha-second", "in_progress"],
  ]);
  expect(
    result.summary.checkpoints.find(({ id }) => id === "alpha-next")?.blockedBy,
  ).toEqual(["alpha-active"]);
  expect(result.summary.inProgressIds).toEqual([
    "alpha-active",
    "alpha-second",
  ]);
});

test("loading, stale, mismatched, incomplete and unknown graph data stay distinct from empty", () => {
  const base = input();
  expect(
    deriveProjectRunCheckpoints({
      ...base,
      beads: { ...base.beads, loading: true },
    }).kind,
  ).toBe("loading");
  const changedRun = input();
  changedRun.runs.selectedSlug = "other-run";
  expect(deriveProjectRunCheckpoints(changedRun).kind).toBe("unavailable");
  expect(
    deriveProjectRunCheckpoints({
      ...base,
      runs: { ...base.runs, detailStale: true },
    }).kind,
  ).toBe("unavailable");
  expect(
    deriveProjectRunCheckpoints({
      ...base,
      beads: { ...base.beads, error: "Current bead graph is unavailable" },
    }).kind,
  ).toBe("unavailable");
  expect(
    deriveProjectRunCheckpoints({
      ...base,
      beads: {
        ...base.beads,
        page: { ...base.beads.page!, projectId: "project-other" },
      },
    }).kind,
  ).toBe("unavailable");
  expect(
    deriveProjectRunCheckpoints({
      ...base,
      beads: { ...base.beads, page: { ...base.beads.page!, complete: false } },
    }).kind,
  ).toBe("unavailable");
  const unknown = input();
  unknown.beads.page!.beads[2]!.status = "new-status";
  expect(deriveProjectRunCheckpoints(unknown).kind).toBe("unavailable");
});

test("missing and wrong-type epics are unavailable while a recorded null epic is explicit", () => {
  const missing = input();
  missing.beads.page!.beads = missing.beads.page!.beads.filter(
    ({ id }) => id !== "alpha-epic",
  );
  expect(deriveProjectRunCheckpoints(missing).kind).toBe("unavailable");
  const wrong = input();
  wrong.beads.page!.beads[0]!.type = "task";
  expect(deriveProjectRunCheckpoints(wrong).kind).toBe("unavailable");
  const none = input();
  none.runs.page!.runs[0]!.epic = null;
  none.runs.detail!.run.epic = null;
  expect(deriveProjectRunCheckpoints(none).kind).toBe("no-epic");
});

test("a present epic with no children is a verified empty checkpoint list", () => {
  const empty = input();
  empty.beads.page!.beads = [empty.beads.page!.beads[0]!];
  empty.beads.page!.dependencies = [];
  const result = deriveProjectRunCheckpoints(empty);
  expect(result.kind).toBe("ready");
  if (result.kind === "ready") expect(result.summary.state).toBe("empty");
});
