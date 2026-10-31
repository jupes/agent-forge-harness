import { expect, test } from "bun:test";
import { COMMANDS } from "../../../docs/js/generated/commands";
import {
  buildPaletteRows,
  createPaletteIndex,
  type GeneratedSlashRow,
  movePaletteActive,
  paletteIndexCurrent,
  paletteIntent,
  readPaletteRecents,
  recentPaletteRows,
  searchPalette,
  writePaletteRecent,
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
  const row: GeneratedSlashRow = {
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

test("search ranks fuzzy matches deterministically and fences project-scoped rows", () => {
  const index = createPaletteIndex({
    generation: 4,
    now: 100,
    commands: [],
    sourceRows: [
      {
        kind: "project",
        id: "p1",
        label: "Alpha Forge",
        intent: {
          kind: "navigate",
          route: { destination: "projects", projectId: null, selection: null },
        },
      },
      {
        kind: "bead",
        id: "b1",
        projectId: "p1",
        label: "Fix palette focus",
        intent: {
          kind: "navigate",
          route: {
            destination: "beads",
            projectId: "p1",
            selection: { kind: "bead", id: "b1" },
          },
        },
      },
      {
        kind: "bead",
        id: "b2",
        projectId: "p2",
        label: "Fix palette focus",
        intent: {
          kind: "navigate",
          route: {
            destination: "beads",
            projectId: "p2",
            selection: { kind: "bead", id: "b2" },
          },
        },
      },
    ],
  });
  expect(
    searchPalette(index, "pal foc", "p1").map((row) => [row.id, row.projectId]),
  ).toEqual([
    ["b1", "p1"],
    ["b2", "p2"],
  ]);
  expect(searchPalette(index, "forge", "p1").map((row) => row.id)).toEqual([
    "p1",
  ]);
  expect(paletteIndexCurrent(index, 30_100)).toBe(false);
});

test("recents retain only validated row identities and resolve against the fresh index", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  };
  store.set(
    "af.palette.recents.v1",
    JSON.stringify([
      "project:p1:p1",
      { prompt: "secret" },
      "../bad",
      "project:p2:p2",
    ]),
  );
  expect(readPaletteRecents(storage)).toEqual([
    "project:p1:p1",
    "project:p2:p2",
  ]);
  const row = {
    kind: "project" as const,
    id: "p1",
    label: "Alpha",
    detail: "",
    keywords: "",
    projectId: "p1",
    intent: {
      kind: "navigate" as const,
      route: {
        destination: "projects" as const,
        projectId: null,
        selection: null,
      },
    },
  };
  writePaletteRecent(storage, row);
  expect(JSON.parse(store.get("af.palette.recents.v1") ?? "[]")).toEqual([
    "project:p1:p1",
    "project:p2:p2",
  ]);
  const index = createPaletteIndex({
    generation: 5,
    now: 200,
    sourceRows: [row],
    commands: [],
  });
  expect(recentPaletteRows(index, readPaletteRecents(storage))).toEqual([row]);
});

test("palette drops untrusted source extras and bounds keyboard movement", () => {
  const source = {
    kind: "bead" as const,
    id: "bead-1",
    projectId: "project-1",
    label: "Review source",
    detail: "Open bead",
    intent: {
      kind: "navigate" as const,
      route: {
        destination: "beads" as const,
        projectId: "project-1",
        selection: { kind: "bead" as const, id: "bead-1" },
      },
    },
    pid: 321,
    path: "C:/private/checkout",
    commandBody: "provider-specific body",
  };
  const index = createPaletteIndex({
    generation: 7,
    now: 300,
    sourceRows: [source],
    commands: [],
  });
  expect(index.rows).toHaveLength(1);
  expect(JSON.stringify(index)).not.toMatch(
    /321|private\/checkout|provider-specific body|commandBody/,
  );
  expect(movePaletteActive(0, "ArrowUp", 3)).toBe(0);
  expect(movePaletteActive(2, "ArrowDown", 3)).toBe(2);
  expect(movePaletteActive(0, "ArrowDown", 0)).toBe(0);
});
