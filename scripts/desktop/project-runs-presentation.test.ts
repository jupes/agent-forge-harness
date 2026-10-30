import { expect, test } from "bun:test";
import { type ComponentChildren, isValidElement } from "preact";
import {
  RunDetail,
  RunGateChecks,
  RunReadStatus,
} from "../../apps/desktop/src/ProjectRuns";
import type { ProjectRunsView } from "../../apps/desktop/src/project-runs-client";
import type { ProjectRunDetail } from "../../types/project-runs";

function text(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (isValidElement(value)) return text(value.props.children);
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}
function props(value: ComponentChildren): {
  children?: ComponentChildren;
  role?: string;
  "aria-live"?: string;
  "aria-hidden"?: boolean;
}[] {
  if (Array.isArray(value)) return value.flatMap(props);
  if (!isValidElement(value)) return [];
  return [value.props, ...props(value.props.children)];
}
const empty: ProjectRunsView = {
  page: null,
  loading: false,
  error: "",
  selectedSlug: null,
  detail: null,
  detailLoading: false,
  detailError: "",
  detailStale: false,
  sessionHistoryLoading: false,
  sessionHistoryError: "",
  sessionHistoryStale: false,
  sessionHistoryCapped: false,
};

test("initial unavailable metadata is announced as loading or failed, never as an empty run history", () => {
  const loading = RunReadStatus({ view: null });
  expect(text(loading)).toContain("Loading project runs");
  expect(props(loading)).toContainEqual(
    expect.objectContaining({ role: "status", "aria-live": "polite" }),
  );
  expect(props(loading).some((node) => node["aria-hidden"])).toBe(true);
  const failed = RunReadStatus({
    view: { ...empty, error: "Current membership is unavailable" },
  });
  expect(text(failed)).not.toContain("Loading");
  expect(text(failed)).not.toContain("No forge runs");
  expect(props(failed)).toContainEqual(
    expect.objectContaining({ role: "alert" }),
  );
});

test("phase and gate detail keep recorded failure separate from unavailable route/start and non-calendar history coverage", () => {
  const detail: ProjectRunDetail = {
    version: 1,
    projectId: "project-alpha",
    workspace: "/workspace",
    checkout: "/checkout",
    coverage: "served-checkout-only",
    asOf: "2026-10-23T12:00:00.000Z",
    problems: [],
    run: {
      slug: "alpha-run",
      feature: "Scoped forge",
      epic: "alpha-epic",
      mode: "auto",
      health: "attention",
      status: { kind: "phase", phase: "implement" },
      phases: [
        {
          id: "research",
          state: "complete",
          artifact: "plans/research/alpha-run.md",
          artifactMissing: false,
        },
        {
          id: "plan",
          state: "complete",
          artifact: null,
          artifactMissing: false,
        },
        {
          id: "implement",
          state: "active",
          artifact: null,
          artifactMissing: false,
        },
        { id: "ship", state: "locked", artifact: null, artifactMissing: false },
      ],
      completedCount: 2,
      totalPhases: 4,
      gatePassed: false,
      reviewRounds: 0,
      latestVerdict: null,
      updatedAt: null,
      complete: false,
    },
    reviews: [],
    gateHistory: [],
    gateHistoryDays: 30,
    earlierGateLimit: 10,
  };
  const copy = text(RunDetail({ projectId: "project-alpha", detail }));
  for (const required of [
    "Unattended (historical)",
    "Full or Mini is not recorded",
    "Start time is not recorded",
    "Complete",
    "Active",
    "Locked",
    "Gate failed",
    "30 retained log-date folders",
    "10 earlier entries",
    "contents are unavailable",
    "No matching gate",
    "No review rounds",
  ])
    expect(copy).toContain(required);
  expect(copy).not.toContain("last 30 days");
  expect(text(RunGateChecks({ gate: null })).match(/Not run/g)).toHaveLength(5);
});
