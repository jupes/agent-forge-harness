import { expect, test } from "bun:test";
import type { BeadsIssue } from "../../types/beads";
import type { ProjectShiftStartRequest } from "../../types/project-shifts";
import { BUILTIN_BENCHES, BUILTIN_SMITHS } from "../config/defaults";
import { BUILTIN_SHIFT_CONFIG, type LoadedConfig } from "../config/load";
import type { ProjectSources } from "../projects/summary";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { createProjectShiftScopeValidator } from "./scope";

const workspace = "/fixture/workspace";
const issue = (
  id: string,
  type: "epic" | "task",
  parent?: string,
): BeadsIssue => ({
  id,
  type,
  title: id,
  status: "open",
  labels: ["project:alpha"],
  createdAt: "",
  updatedAt: "",
  ...(parent ? { parent } : {}),
});
const loaded: LoadedConfig = {
  config: {
    workflow: { defaultCrew: "claude-journeyman" },
    smiths: structuredClone(BUILTIN_SMITHS),
    benches: structuredClone(BUILTIN_BENCHES),
    execution: { envPass: [] },
    shift: BUILTIN_SHIFT_CONFIG,
  },
  files: [],
  provenance: {},
};
const request: ProjectShiftStartRequest = {
  requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
  expectedCatalogRevision: 1,
  options: {
    for: "2h",
    concurrency: 2,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 3,
    base: "master",
    epic: "nested-epic",
    smith: "claude-journeyman",
  },
};
function fixture() {
  const catalog = projectCatalogFixture(workspace),
    source: ProjectSources = {
      workspace,
      asOf: "2026-10-23T06:00:00.000Z",
      issues: [
        issue("alpha-epic", "epic"),
        issue("nested-epic", "epic", "alpha-epic"),
        issue("valid-task", "task", "nested-epic"),
        issue("sibling", "task", "alpha-epic"),
        issue("nested-epic.fake-prefix", "task"),
      ],
      queue: [],
      sessions: [],
      sessionsComplete: true,
      problems: [],
    };
  const config = structuredClone(loaded);
  const validator = createProjectShiftScopeValidator({
    workspace,
    load: async () => ({ catalog, source }),
    loadConfig: () => config,
  });
  return { catalog, source, config, validator };
}
test("every admission freshly requires current catalog, archive, selected epic ancestry AND label, never id-prefix inference", async () => {
  const f = fixture();
  const guard = f.validator.beforeStart(FIXTURE_PROJECT_ID, request);
  expect(await guard("valid-task", { labels: ["project:alpha"] })).toBe(true);
  expect(await guard("sibling", { labels: ["project:alpha"] })).toBe(false);
  expect(
    await guard("nested-epic.fake-prefix", { labels: ["project:alpha"] }),
  ).toBe(false);
  expect(await guard("valid-task", { labels: ["project:beta"] })).toBe(false);
  const task = f.source.issues?.find((row) => row.id === "valid-task");
  if (!task) throw Error("Missing scope fixture");
  task.labels = ["project:beta"];
  expect(await guard("valid-task", { labels: ["project:alpha"] })).toBe(false);
  task.labels = ["project:alpha"];
  f.catalog.revision++;
  expect(await guard("valid-task", { labels: ["project:alpha"] })).toBe(false);
  f.catalog.revision--;
  const project = f.catalog.projects[0];
  if (!project) throw Error("Missing project");
  project.archived = true;
  expect(await guard("valid-task", { labels: ["project:alpha"] })).toBe(false);
});
test("fresh preparation refuses removed selected epics, disabled smiths, unknown source or foreign workspace without replacing reviewed bounds", async () => {
  const f = fixture();
  await expect(
    f.validator.validateStart(FIXTURE_PROJECT_ID, request),
  ).resolves.toBeUndefined();
  const smith = f.config.config.smiths["claude-journeyman"];
  if (!smith) throw Error("Missing smith fixture");
  smith.enabled = false;
  await expect(
    f.validator.validateStart(FIXTURE_PROJECT_ID, request),
  ).rejects.toMatchObject({ status: 409 });
  smith.enabled = true;
  f.source.issues =
    f.source.issues?.filter((row) => row.id !== "alpha-epic") ?? null;
  await expect(
    f.validator.validateStart(FIXTURE_PROJECT_ID, request),
  ).rejects.toMatchObject({ status: 409 });
  f.source.issues = null;
  await expect(
    f.validator.validateStart(FIXTURE_PROJECT_ID, request),
  ).rejects.toMatchObject({ status: 503 });
  f.source.workspace = "/foreign";
  await expect(
    f.validator.validateStart(FIXTURE_PROJECT_ID, request),
  ).rejects.toMatchObject({ status: 409 });
  expect(request.options.for).toBe("2h");
});
