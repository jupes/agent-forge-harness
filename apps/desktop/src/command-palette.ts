import type { CommandEntry } from "../../../scripts/dashboard/commands-catalog";

export interface PaletteProjectInput {
  id: string;
  name: string;
}

export interface PaletteBeadInput {
  id: string;
  projectId: string;
  title: string;
}

export type PaletteRow =
  | {
      kind: "project";
      id: string;
      projectId: string;
      label: string;
    }
  | {
      kind: "bead";
      id: string;
      projectId: string;
      label: string;
    }
  | {
      kind: "slash-command";
      name: string;
      description: string;
      argumentHint: string;
    };

export type PaletteIntent = {
  kind: "slash-command";
  name: string;
  argumentHint: string;
};

export function buildPaletteRows(input: {
  projects: readonly PaletteProjectInput[];
  beads: readonly PaletteBeadInput[];
  commands: readonly CommandEntry[];
}): PaletteRow[] {
  void input;
  return [];
}

export function paletteIntent(row: PaletteRow): PaletteIntent | null {
  if (row.kind !== "slash-command") return null;
  return {
    kind: "slash-command",
    name: row.name,
    argumentHint: row.argumentHint,
  };
}
