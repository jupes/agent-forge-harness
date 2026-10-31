import type { CommandEntry } from "../../../scripts/dashboard/commands-catalog";
import type { DesktopRoute } from "./navigation";

export type PaletteSourceKind =
  | "project"
  | "bead"
  | "session"
  | "run"
  | "review"
  | "smith"
  | "setting"
  | "action";
export type PaletteReviewTarget =
  | { kind: "bead"; projectId: string; beadId: string }
  | {
      kind: "checkpoint";
      projectId: string;
      runSlug: string;
      checkpointId: string;
      runUpdatedAt: string;
    }
  | {
      kind: "keeper";
      projectId: string;
      requestId: string;
      revision: number;
    };
export type PaletteIntent =
  | { kind: "navigate"; route: DesktopRoute }
  | { kind: "new-session"; projectId: string; beadId?: string }
  | { kind: "new-bead"; projectId: string }
  | { kind: "ask-keeper"; projectId: string }
  | { kind: "review"; target: PaletteReviewTarget }
  | { kind: "start-shift"; projectId: string }
  | {
      kind: "send-to-council";
      projectId: string;
      workspace: string;
      sourceType: "bead" | "run";
      sourceId: string;
    }
  | { kind: "slash-command"; name: string; argumentHint: string };
export interface PaletteRow {
  kind: PaletteSourceKind | "slash-command" | "action";
  id: string;
  label: string;
  detail: string;
  keywords: string;
  projectId: string | null;
  intent: PaletteIntent | null;
  unavailable?: string;
}
export interface PaletteSourceRow {
  kind: PaletteSourceKind;
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
  projectId?: string | null;
  intent: PaletteIntent;
  updatedAt?: string;
  unavailable?: string;
}
export interface PaletteProjectInput {
  id: string;
  name: string;
}
export interface PaletteBeadInput {
  id: string;
  projectId: string;
  title: string;
}
export interface PaletteIndex {
  generation: number;
  asOf: number;
  rows: readonly PaletteRow[];
  errors: readonly string[];
  statuses: readonly string[];
  scopeKey?: string;
}

const MAX_AGE_MS = 30_000;
const safeText = (value: string | undefined) =>
  (value ?? "").replace(/[\p{Cc}\p{Cs}]/gu, " ").slice(0, 240);
function safeIntent(intent: PaletteIntent): PaletteIntent {
  switch (intent.kind) {
    case "navigate":
      return {
        kind: "navigate",
        route: {
          destination: intent.route.destination,
          projectId: intent.route.projectId,
          selection: intent.route.selection
            ? {
                kind: intent.route.selection.kind,
                id: intent.route.selection.id,
              }
            : null,
        },
      };
    case "new-session":
      return {
        kind: "new-session",
        projectId: intent.projectId,
        ...(intent.beadId ? { beadId: intent.beadId } : {}),
      };
    case "new-bead":
      return { kind: "new-bead", projectId: intent.projectId };
    case "ask-keeper":
      return { kind: "ask-keeper", projectId: intent.projectId };
    case "start-shift":
      return { kind: "start-shift", projectId: intent.projectId };
    case "review":
      return intent.target.kind === "bead"
        ? {
            kind: "review",
            target: {
              kind: "bead",
              projectId: intent.target.projectId,
              beadId: intent.target.beadId,
            },
          }
        : intent.target.kind === "checkpoint"
          ? {
              kind: "review",
              target: {
                kind: "checkpoint",
                projectId: intent.target.projectId,
                runSlug: intent.target.runSlug,
                checkpointId: intent.target.checkpointId,
                runUpdatedAt: intent.target.runUpdatedAt,
              },
            }
          : {
              kind: "review",
              target: {
                kind: "keeper",
                projectId: intent.target.projectId,
                requestId: intent.target.requestId,
                revision: intent.target.revision,
              },
            };
    case "send-to-council":
      return {
        kind: "send-to-council",
        projectId: intent.projectId,
        workspace: intent.workspace,
        sourceType: intent.sourceType,
        sourceId: intent.sourceId,
      };
    case "slash-command":
      return {
        kind: "slash-command",
        name: safeText(intent.name),
        argumentHint: safeText(intent.argumentHint),
      };
  }
}
const key = (row: Pick<PaletteRow, "kind" | "id" | "projectId">) =>
  `${row.kind}:${row.projectId ?? ""}:${row.id}`;
function score(query: string, candidate: string): number | null {
  const q = query.toLocaleLowerCase(),
    c = candidate.toLocaleLowerCase();
  if (!q) return 0;
  if (c.includes(q)) return c.indexOf(q) + (c === q ? -100 : 0);
  let qi = 0,
    start = -1,
    previous = -2,
    gaps = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] !== q[qi]) continue;
    if (start < 0) start = i;
    if (previous >= 0) gaps += i - previous - 1;
    previous = i;
    qi++;
  }
  return qi === q.length ? 100 + start + gaps * 3 : null;
}
export function createPaletteIndex(input: {
  generation: number;
  now?: number;
  scopeKey?: string;
  slashUnavailable?: string;
  sourceRows: readonly PaletteSourceRow[];
  commands: readonly CommandEntry[];
  errors?: readonly string[];
  statuses?: readonly string[];
}): PaletteIndex {
  const rows: PaletteRow[] = input.sourceRows.map((source) => {
    const unavailable = safeText(source.unavailable);
    return {
      kind: source.kind,
      id: source.id,
      label: safeText(source.label),
      detail: safeText(source.detail),
      keywords: safeText(source.keywords),
      projectId: source.projectId ?? null,
      intent: safeIntent(source.intent),
      ...(unavailable ? { unavailable } : {}),
    };
  });
  for (const command of input.commands) {
    if (!/^\/[a-z0-9][a-z0-9-]*$/i.test(command.name)) continue;
    rows.push({
      kind: "slash-command",
      id: command.name,
      label: command.name,
      detail: safeText(command.description),
      keywords: safeText(command.description),
      projectId: null,
      intent: {
        kind: "slash-command",
        name: command.name,
        argumentHint: safeText(command.argumentHint),
      },
      ...(input.slashUnavailable
        ? { unavailable: input.slashUnavailable }
        : {}),
    });
  }
  const unique = new Map(rows.map((row) => [key(row), row]));
  return {
    generation: input.generation,
    asOf: input.now ?? Date.now(),
    rows: [...unique.values()],
    errors: [...(input.errors ?? [])].map((error) => safeText(error)),
    statuses: [...(input.statuses ?? [])].map((value) => safeText(value)),
    ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
  };
}
export function appendPaletteRows(
  index: PaletteIndex,
  additions: readonly PaletteSourceRow[],
): PaletteIndex {
  const rows = new Map(index.rows.map((row) => [key(row), row]));
  for (const source of additions) {
    const unavailable = safeText(source.unavailable);
    const row: PaletteRow = {
      kind: source.kind,
      id: safeText(source.id),
      label: safeText(source.label),
      detail: safeText(source.detail),
      keywords: safeText(source.keywords),
      projectId: source.projectId ?? null,
      intent: safeIntent(source.intent),
      ...(unavailable ? { unavailable } : {}),
    };
    rows.set(key(row), row);
  }
  return { ...index, rows: [...rows.values()] };
}
export function replacePaletteRows(
  index: PaletteIndex,
  matches: (row: PaletteRow) => boolean,
  additions: readonly PaletteSourceRow[],
): PaletteIndex {
  const base = { ...index, rows: index.rows.filter((row) => !matches(row)) };
  return appendPaletteRows(base, additions);
}
export function paletteIndexCurrent(
  index: PaletteIndex | null,
  now = Date.now(),
): index is PaletteIndex {
  return !!index && now >= index.asOf && now - index.asOf < MAX_AGE_MS;
}
export function searchPalette(
  index: PaletteIndex,
  query: string,
  projectId: string | null,
): PaletteRow[] {
  const normalized = query.trim();
  return index.rows
    .map((row) => ({
      row,
      score: score(normalized, `${row.label} ${row.detail} ${row.keywords}`),
    }))
    .filter(
      (item): item is { row: PaletteRow; score: number } => item.score !== null,
    )
    .sort(
      (a, b) =>
        a.score -
          (a.row.projectId === projectId ? 5 : 0) -
          (b.score - (b.row.projectId === projectId ? 5 : 0)) ||
        a.row.label.localeCompare(b.row.label) ||
        key(a.row).localeCompare(key(b.row)),
    )
    .map(({ row }) => row);
}
export function movePaletteActive(
  current: number,
  key: "ArrowDown" | "ArrowUp",
  count: number,
): number {
  if (count <= 0) return 0;
  return key === "ArrowDown"
    ? Math.min(count - 1, Math.max(0, current) + 1)
    : Math.max(0, Math.min(count - 1, current) - 1);
}
export type GeneratedSlashRow = {
  kind: "slash-command";
  name: string;
  description: string;
  argumentHint: string;
};
export function paletteIntent(
  row: PaletteRow | GeneratedSlashRow,
): PaletteIntent | null {
  if ("intent" in row) return row.intent;
  return row.kind === "slash-command"
    ? { kind: "slash-command", name: row.name, argumentHint: row.argumentHint }
    : null;
}
export function buildPaletteRows(input: {
  projects: readonly PaletteProjectInput[];
  beads: readonly PaletteBeadInput[];
  commands: readonly CommandEntry[];
}): (
  | { kind: "project" | "bead"; id: string; projectId: string; label: string }
  | GeneratedSlashRow
)[] {
  return [
    ...input.projects.map((project) => ({
      kind: "project" as const,
      id: project.id,
      projectId: project.id,
      label: project.name,
    })),
    ...input.beads.map((bead) => ({
      kind: "bead" as const,
      id: bead.id,
      projectId: bead.projectId,
      label: bead.title,
    })),
    ...input.commands.map((command) => ({
      kind: "slash-command" as const,
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
    })),
  ];
}
export function readPaletteRecents(
  storage: Pick<Storage, "getItem"> | null,
): string[] {
  if (!storage) return [];
  try {
    const raw: unknown = JSON.parse(
      storage.getItem("af.palette.recents.v1") ?? "null",
    );
    if (!Array.isArray(raw)) return [];
    return [
      ...new Set(
        raw.filter(
          (item): item is string =>
            typeof item === "string" &&
            item.length <= 600 &&
            /^[a-z-]+:/.test(item) &&
            item.slice(item.indexOf(":") + 1).length <= 560 &&
            [...item].every((character) => character.charCodeAt(0) >= 0x20),
        ),
      ),
    ].slice(0, 8);
  } catch {
    return [];
  }
}
export function writePaletteRecent(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  row: PaletteRow,
): void {
  if (!storage) return;
  try {
    const next = [
      key(row),
      ...readPaletteRecents(storage).filter((item) => item !== key(row)),
    ].slice(0, 8);
    storage.setItem("af.palette.recents.v1", JSON.stringify(next));
  } catch {
    // The palette remains usable when the per-origin browser store is unavailable.
  }
}
export function recentPaletteRows(
  index: PaletteIndex,
  recents: readonly string[],
): PaletteRow[] {
  const rows = new Map(index.rows.map((row) => [key(row), row]));
  return recents.flatMap((identity) => {
    const row = rows.get(identity);
    return row ? [row] : [];
  });
}
