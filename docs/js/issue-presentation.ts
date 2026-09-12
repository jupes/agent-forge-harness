/**
 * How issue metadata reads in the interface.
 *
 * One copy, shared by every view. Status colour, type glyphs and priority
 * emphasis used to be defined twice (once in `app.mjs` for the legacy Epics
 * renderer, once in `IssuesViewsIsland.tsx`) with a third palette in
 * `insights.mjs`; they drifted apart silently because nothing tied them.
 */

import type { IssuePriority, IssueStatus, IssueType } from "../../types/beads";
import type { IconName } from "./ds/Icon";
import type { TagTone } from "./ds/Tag";

/** Tag tone for a status pill. */
export function statusTone(status: IssueStatus | string | undefined): TagTone {
  switch (status) {
    case "in_progress":
      return "accent";
    case "blocked":
      return "outline";
    case "closed":
      return "muted";
    default:
      return "neutral";
  }
}

/** Human label for a status. */
export function statusLabel(status: IssueStatus | string | undefined): string {
  return status === "in_progress" ? "in progress" : String(status ?? "");
}

const TYPE_ICONS: Record<string, IconName> = {
  epic: "stack",
  feature: "sparkle",
  task: "check-square",
  bug: "bug",
  chore: "broom",
};

/** Glyph for an issue type — replaces the old emoji set. */
export function typeIcon(type: IssueType | string | undefined): IconName {
  return TYPE_ICONS[String(type ?? "")] ?? "circle";
}

/**
 * Priority emphasis. P0/critical earns the accent; the rest stay quiet so a
 * screen of issues does not read as uniformly urgent.
 */
export function priorityTone(
  priority: IssuePriority | string | undefined,
): TagTone {
  switch (priority) {
    case "critical":
      return "outline";
    case "high":
      return "accent";
    case "low":
      return "muted";
    default:
      return "neutral";
  }
}
