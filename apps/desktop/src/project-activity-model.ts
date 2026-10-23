import { projectActivityFiltersSchema } from "../../../scripts/projects/activity-protocol";
import {
  LEDGER_EVENT_KINDS,
  type LedgerEventKind,
} from "../../../types/hearth";
import type { ProjectActivityFilters } from "../../../types/project-activity";
import { desktopHref } from "./navigation";

export const emptyActivityFilters = (): ProjectActivityFilters => ({
  kinds: [],
  provider: null,
  beadId: null,
  sessionId: null,
  runId: null,
  shiftId: null,
  since: null,
  until: null,
});
const fields = [
  ["provider", "provider"],
  ["bead", "beadId"],
  ["session", "sessionId"],
  ["run", "runId"],
  ["shift", "shiftId"],
  ["since", "since"],
  ["until", "until"],
] as const;
function parameters(filters: ProjectActivityFilters): URLSearchParams {
  const checked = projectActivityFiltersSchema.parse(filters),
    result = new URLSearchParams();
  if (checked.kinds.length) result.set("kind", checked.kinds.join(","));
  for (const [wire, field] of fields)
    if (checked[field] !== null) result.set(wire, checked[field]);
  return result;
}
export function activityHref(
  projectId: string,
  filters = emptyActivityFilters(),
  eventId: number | null = null,
): string {
  const href = desktopHref({
    projectId,
    destination: "activity",
    selection: eventId === null ? null : { kind: "event", id: String(eventId) },
  });
  const query = parameters(filters).toString();
  return query ? `${href}${href.includes("?") ? "&" : "?"}${query}` : href;
}
export function activityPagePath(
  projectId: string,
  filters: ProjectActivityFilters,
  after: number,
): string {
  const query = parameters(filters);
  query.set("after", String(after));
  query.set("limit", "200");
  return `/__agent-forge/projects/${encodeURIComponent(projectId)}/activity?${query}`;
}
export function parseActivityFilters(hash: string): {
  filters: ProjectActivityFilters | null;
  error: string;
} {
  try {
    const url = new URL(hash.replace(/^#/, ""), "http://127.0.0.1"),
      query = url.searchParams;
    const allowed = [
      "selectionKind",
      "selectionId",
      "kind",
      ...fields.map(([wire]) => wire),
    ];
    if (
      [...query.keys()].some(
        (key) => !allowed.includes(key) || query.getAll(key).length !== 1,
      )
    )
      throw Error("Unknown or repeated filter");
    const filters = projectActivityFiltersSchema.safeParse({
      kinds: query.has("kind") ? query.get("kind")?.split(",") : [],
      ...Object.fromEntries(
        fields.map(([wire, field]) => [field, query.get(wire)]),
      ),
    });
    if (!filters.success) throw Error("Invalid filters");
    return { filters: filters.data, error: "" };
  } catch {
    return {
      filters: null,
      error:
        "These Activity filters or their time range are invalid. Clear the filters to read this project's metadata.",
    };
  }
}

const kinds = (prefix: string): LedgerEventKind[] =>
  LEDGER_EVENT_KINDS.filter((kind) => kind.startsWith(prefix));
export const ACTIVITY_GROUPS = [
  { id: "all", label: "All kinds", kinds: [] },
  { id: "sessions", label: "Sessions", kinds: kinds("session.") },
  { id: "tools", label: "Tool calls", kinds: kinds("tool.") },
  { id: "prompts", label: "Prompts", kinds: kinds("prompt.") },
  { id: "phases", label: "Phases", kinds: kinds("run.phase.") },
  { id: "reviews", label: "Reviews", kinds: kinds("review.") },
  { id: "gates", label: "Gates", kinds: kinds("gate.") },
  { id: "verdicts", label: "Verdicts", kinds: kinds("verdict.") },
  { id: "beads", label: "Bead changes", kinds: kinds("bead.") },
  { id: "reservations", label: "Reservations", kinds: kinds("reservation.") },
  { id: "shifts", label: "Shifts", kinds: kinds("shift.") },
  { id: "council", label: "Council", kinds: kinds("council.") },
  { id: "operator", label: "Operator actions", kinds: kinds("operator.") },
  { id: "friction", label: "Friction", kinds: kinds("friction.") },
] satisfies { id: string; label: string; kinds: LedgerEventKind[] }[];
