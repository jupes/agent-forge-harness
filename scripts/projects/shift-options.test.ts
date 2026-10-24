import { expect, test } from "bun:test";
import type { BeadsIssue } from "../../types/beads";
import { BUILTIN_BENCHES, BUILTIN_SMITHS } from "../config/defaults";
import { BUILTIN_SHIFT_CONFIG, type LoadedConfig } from "../config/load";
import { projectShiftOptions } from "./shift-options";
import type { ProjectSources } from "./summary";
import { projectFixture } from "./testing";

const workspace = "/fixture/workspace";
const issue = (id: string, extra: Partial<BeadsIssue> = {}): BeadsIssue => ({
  id,
  type: "epic",
  title: id,
  status: "open",
  labels: ["project:alpha"],
  createdAt: "",
  updatedAt: "",
  ...extra,
});
const source: ProjectSources = {
  workspace,
  asOf: "2026-10-23T06:00:00.000Z",
  issues: [
    issue("alpha-epic"),
    issue("alpha-nested", { parent: "alpha-epic" }),
    issue("outside-epic"),
    issue("FOREIGN-PRIVATE", {
      parent: "alpha-epic",
      labels: ["project:beta"],
    }),
  ],
  queue: [],
  sessions: [],
  sessionsComplete: true,
  problems: [],
};
const loaded: LoadedConfig = {
  config: {
    workflow: { defaultCrew: "claude-journeyman" },
    smiths: structuredClone(BUILTIN_SMITHS),
    benches: structuredClone(BUILTIN_BENCHES),
    execution: { envPass: [] },
    shift: { ...BUILTIN_SHIFT_CONFIG, forMs: 3_600_000, maxBeads: 7 },
  },
  files: ["/fixture/workspace/agent-forge.toml"],
  provenance: {
    "shift.for": {
      value: "1h",
      source: "/fixture/workspace/agent-forge.toml",
    },
    "shift.max_beads": {
      value: 7,
      source: "/fixture/workspace/agent-forge.toml",
    },
  },
};

test("shift options retain exact configured bounds and provenance within current epic AND label scope, with attended Start refused", () => {
  const page = projectShiftOptions(
    projectFixture(workspace),
    source,
    loaded,
    8,
  );
  expect(page.projectId).toBe(projectFixture(workspace).id);
  expect(page.catalogRevision).toBe(8);
  expect(page.workspace).toBe(workspace);
  expect(page.defaults.for).toEqual({
    value: "1h",
    source: "/fixture/workspace/agent-forge.toml",
  });
  expect(page.defaults.maxBeads.value).toBe(7);
  expect(page.defaults.concurrency).toEqual({ value: 2, source: "builtin" });
  expect(page.defaults.maxUsd.value).toBe(10);
  expect(page.defaults.repairs.value).toBe(3);
  expect(page.defaults.base).toEqual({ value: "master", source: "shift CLI" });
  expect(page.defaults.runTimeout).toEqual({
    value: null,
    source: "remaining shift time",
  });
  expect(page.epics.map((epic) => epic.id)).toEqual([
    "alpha-epic",
    "alpha-nested",
  ]);
  expect(page.availability.start).toBe(false);
  expect(page.availability.reason).toContain("attended");
  expect(JSON.stringify(page)).not.toContain("FOREIGN-PRIVATE");
});
