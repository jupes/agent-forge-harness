import type {
  ProjectRunGate,
  ProjectRunRow,
} from "../../../types/project-runs";
import { desktopHref } from "./navigation";

export interface RunFilters {
  search: string;
  health: ProjectRunRow["health"] | null;
  mode: ProjectRunRow["mode"] | null;
}
export const emptyRunFilters = (): RunFilters => ({
  search: "",
  health: null,
  mode: null,
});
export function parseRunFilters(hash: string): {
  filters: RunFilters | null;
  error: string;
} {
  try {
    const query = new URL(hash.replace(/^#/, ""), "http://127.0.0.1")
      .searchParams;
    const allowed = [
      "selectionKind",
      "selectionId",
      "runSearch",
      "runHealth",
      "runMode",
    ];
    if (
      [...query.keys()].some(
        (key) => !allowed.includes(key) || query.getAll(key).length !== 1,
      )
    )
      throw Error("Unexpected filter");
    const search = query.get("runSearch") ?? "",
      health = query.get("runHealth"),
      mode = query.get("runMode");
    if (search.length > 200 || /[\p{Cc}\p{Cs}]/u.test(search))
      throw Error("Invalid search");
    if (
      health !== null &&
      health !== "running" &&
      health !== "attention" &&
      health !== "shipped"
    )
      throw Error("Invalid health");
    if (mode !== null && mode !== "gated" && mode !== "auto")
      throw Error("Invalid mode");
    return { filters: { search, health, mode }, error: "" };
  } catch {
    return {
      filters: null,
      error:
        "These run filters are invalid. Clear the filters to inspect this project's recorded runs.",
    };
  }
}
export function runsHref(
  projectId: string,
  slug: string | null,
  filters = emptyRunFilters(),
): string {
  const base = desktopHref({
    projectId,
    destination: "runs",
    selection: slug === null ? null : { kind: "run", id: slug },
  });
  const query = new URLSearchParams();
  if (filters.search) query.set("runSearch", filters.search);
  if (filters.health) query.set("runHealth", filters.health);
  if (filters.mode) query.set("runMode", filters.mode);
  return query.size ? `${base}${base.includes("?") ? "&" : "?"}${query}` : base;
}
export function filterRuns(
  rows: readonly ProjectRunRow[],
  filters: RunFilters,
): ProjectRunRow[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (!filters.health || row.health === filters.health) &&
      (!filters.mode || row.mode === filters.mode) &&
      (!query ||
        [row.slug, row.feature, row.epic]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)),
  );
}
export const phaseName = (phase: string) =>
  phase.charAt(0).toUpperCase() + phase.slice(1);
export function runStatus(run: ProjectRunRow): string {
  const status = run.status;
  switch (status.kind) {
    case "halted":
      return `Halted at ${phaseName(status.phase)}: ${status.reason}`;
    case "revising":
      return `Revising ${phaseName(status.phase)}`;
    case "awaiting-review":
      return `Awaiting ${phaseName(status.phase)} review`;
    case "shipped":
      return "Shipped";
    case "phase":
      return phaseName(status.phase);
  }
}
const CHECKS = ["typecheck", "lint", "tests", "clean-tree", "eval-verdict"];
export function gateCheckRows(gate: ProjectRunGate | null) {
  const checks = gate?.checks ?? [];
  const ordered = [
    ...CHECKS.flatMap((name) => {
      const found = checks.filter((check) => check.name === name);
      return found.length
        ? found
        : [{ name, detail: null, passed: false, skipped: false, absent: true }];
    }),
    ...checks.filter((check) => !CHECKS.includes(check.name)),
  ];
  return ordered.map((check) => ({
    name: check.name,
    detail: check.detail,
    state:
      "absent" in check
        ? "Not run"
        : check.skipped
          ? "Skipped"
          : check.passed
            ? "Pass"
            : "Fail",
  }));
}
