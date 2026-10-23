import { expect, test } from "bun:test";
import {
  newProjectShiftDraft,
  reviewedProjectShift,
} from "../../apps/desktop/src/project-shift-composer";
import type { ProjectShiftOptions } from "../../types/project-shifts";

const options: ProjectShiftOptions = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: "/workspace",
  catalogRevision: 7,
  asOf: "2026-10-23T18:00:00.000Z",
  defaults: {
    for: { value: "90m", source: "/workspace/agent-forge.toml" },
    concurrency: { value: 3, source: "builtin" },
    maxBeads: { value: 8, source: "builtin" },
    maxUsd: { value: 12, source: "builtin" },
    repairs: { value: 2, source: "builtin" },
    base: { value: "master", source: "shift CLI" },
    runTimeout: { value: null, source: "remaining shift time" },
  },
  limits: {
    durationMs: [1, 86400000],
    concurrency: [1, 8],
    maxBeads: [1, 100],
    maxUsd: 1000,
    repairs: [0, 10],
  },
  epics: [{ id: "alpha-epic", title: "Scoped epic" }],
  smiths: { names: ["claude-journeyman"], defaultSmith: "claude-journeyman" },
  availability: { start: true, reason: null },
};
test("the shift form uses actual defaults without an invented per-run timeout or smith override", () => {
  const draft = newProjectShiftDraft(options),
    review = reviewedProjectShift(options, draft);
  expect(draft).toMatchObject({
    for: "90m",
    concurrency: "3",
    maxBeads: "8",
    maxUsd: "12",
    repairs: "2",
    base: "master",
    runTimeout: "",
    smith: "",
  });
  expect(review).toEqual({
    ok: true,
    input: {
      expectedCatalogRevision: 7,
      options: {
        for: "90m",
        concurrency: 3,
        maxBeads: 8,
        maxUsd: 12,
        repairs: 2,
        base: "master",
      },
    },
  });
  expect(options.defaults.for.source).toBe("/workspace/agent-forge.toml");
});
test("all edited bounds survive review exactly, while stale choices or invalid canonical values refuse", () => {
  const draft = {
    ...newProjectShiftDraft(options),
    for: "2h",
    concurrency: "8",
    maxBeads: "100",
    maxUsd: "1000",
    repairs: "10",
    epic: "alpha-epic",
    smith: "claude-journeyman",
    base: "feature/base",
    runTimeout: "20m",
  };
  expect(reviewedProjectShift(options, draft)).toMatchObject({
    ok: true,
    input: {
      options: {
        for: "2h",
        concurrency: 8,
        maxBeads: 100,
        maxUsd: 1000,
        repairs: 10,
        epic: "alpha-epic",
        smith: "claude-journeyman",
        base: "feature/base",
        runTimeout: "20m",
      },
    },
  });
  for (const patch of [
    { expectedCatalogRevision: 6 },
    { for: "25h" },
    { concurrency: "9" },
    { repairs: "11" },
    { repairs: "" },
    { maxUsd: "0" },
    { base: "HEAD" },
    { epic: "foreign" },
    { smith: "disabled" },
    { runTimeout: "soon" },
  ])
    expect(reviewedProjectShift(options, { ...draft, ...patch }).ok).toBe(
      false,
    );
});
