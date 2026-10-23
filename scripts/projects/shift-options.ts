import type { ProjectShiftOptions } from "../../types/project-shifts";
import type { ProjectRecord } from "../../types/projects";
import { SHIFT_LIMITS, SHIFT_MAX_USD } from "../config/defaults";
import type { LoadedConfig } from "../config/load";
import { ConversationError } from "../conversations/error";
import { SHIFT_DEFAULTS } from "../scheduler/shift";
import {
  ATTENDED_SHIFT_UNAVAILABLE,
  projectShiftOptionsSchema,
} from "../shifts/protocol";
import { selectProjectBeads, workspaceKey } from "./scope";
import type { ProjectSources } from "./summary";

/** Preserve a configured duration exactly as an accepted whole CLI duration. */
function duration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

export function projectShiftOptions(
  project: ProjectRecord,
  source: ProjectSources,
  loaded: LoadedConfig,
  catalogRevision: number,
): ProjectShiftOptions {
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(source.workspace),
  );
  if (!scope)
    throw new ConversationError(
      409,
      "This hearth does not serve this project's workspace.",
    );
  if (source.issues === null)
    throw new ConversationError(
      503,
      "The current project bead scope is unavailable. Refresh before starting a shift.",
    );
  const members = selectProjectBeads(project, source.workspace, source.issues);
  if (
    scope.epicIds.some(
      (epic) =>
        !members.some((member) => member.id === epic && member.type === "epic"),
    )
  )
    throw new ConversationError(
      409,
      "A selected project epic is absent from the current scope. Refresh before starting a shift.",
    );
  const config = loaded.config.shift;
  const origin = (key: string) =>
    loaded.provenance[`shift.${key}`]?.source ?? "builtin";
  const names = Object.values(loaded.config.smiths)
    .filter((smith) => smith.enabled)
    .map((smith) => smith.name);
  const result: ProjectShiftOptions = {
    projectId: project.id,
    workspace: source.workspace,
    catalogRevision,
    asOf: source.asOf,
    defaults: {
      for: { value: duration(config.forMs), source: origin("for") },
      concurrency: { value: config.concurrency, source: origin("concurrency") },
      maxBeads: { value: config.maxBeads, source: origin("max_beads") },
      maxUsd: { value: config.maxUsd, source: origin("max_usd") },
      repairs: { value: config.repairs, source: origin("repairs") },
      base: { value: SHIFT_DEFAULTS.base, source: "shift CLI" },
      runTimeout: { value: null, source: "remaining shift time" },
    },
    limits: {
      durationMs: [...SHIFT_LIMITS.forMs],
      concurrency: [...SHIFT_LIMITS.concurrency],
      maxBeads: [...SHIFT_LIMITS.maxBeads],
      maxUsd: SHIFT_MAX_USD,
      repairs: [...SHIFT_LIMITS.repairs],
    },
    epics: members
      .filter((member) => member.type === "epic")
      .map(({ id, title }) => ({ id, title })),
    smiths: {
      names,
      defaultSmith: names.includes(loaded.config.workflow.defaultCrew)
        ? loaded.config.workflow.defaultCrew
        : null,
    },
    availability: {
      start: false,
      reason: project.archived
        ? "This project is archived. Unarchive it before starting a shift."
        : ATTENDED_SHIFT_UNAVAILABLE,
    },
  };
  const checked = projectShiftOptionsSchema.safeParse(result);
  if (
    !checked.success ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > 1_048_576
  )
    throw new ConversationError(
      503,
      "The shift options exceed their verified read limits. Refresh a smaller project scope.",
    );
  return checked.data;
}
