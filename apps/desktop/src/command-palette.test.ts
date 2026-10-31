import { expect, test } from "bun:test";
import { COMMANDS } from "../../../docs/js/generated/commands";
import {
  buildPaletteRows,
  paletteIntent,
  type PaletteRow,
} from "./command-palette";

test("palette model keeps two projects and their beads scoped with generated command hints", () => {
  const forgePlan = COMMANDS.find((command) => command.name === "/forge-plan");
  if (!forgePlan) throw Error("The generated /forge-plan command is missing.");
  const rows = buildPaletteRows({
    projects: [
      { id: "project-alpha", name: "Alpha" },
      { id: "project-beta", name: "Beta" },
    ],
    beads: [
      { id: "alpha-bead", projectId: "project-alpha", title: "Alpha bead" },
      { id: "beta-bead", projectId: "project-beta", title: "Beta bead" },
    ],
    commands: [forgePlan],
  });

  expect(rows).toEqual([
    {
      kind: "project",
      id: "project-alpha",
      projectId: "project-alpha",
      label: "Alpha",
    },
    {
      kind: "project",
      id: "project-beta",
      projectId: "project-beta",
      label: "Beta",
    },
    {
      kind: "bead",
      id: "alpha-bead",
      projectId: "project-alpha",
      label: "Alpha bead",
    },
    {
      kind: "bead",
      id: "beta-bead",
      projectId: "project-beta",
      label: "Beta bead",
    },
    {
      kind: "slash-command",
      name: "/forge-plan",
      description: forgePlan.description,
      argumentHint: forgePlan.argumentHint,
    },
  ]);
});

test("selecting a generated slash row yields only reviewed draft metadata", () => {
  const forgePlan = COMMANDS.find((command) => command.name === "/forge-plan");
  if (!forgePlan) throw Error("The generated /forge-plan command is missing.");
  const row: PaletteRow = {
    kind: "slash-command",
    name: forgePlan.name,
    description: forgePlan.description,
    argumentHint: forgePlan.argumentHint,
  };

  const intent = paletteIntent(row);
  expect(intent).toEqual({
    kind: "slash-command",
    name: "/forge-plan",
    argumentHint: "<slug> [--smith <name>]",
  });
  expect(JSON.stringify(intent)).not.toMatch(/execute|commandBody|scriptBody/i);
});
