import { BENCH_NAMES, type SmithsView } from "../../types/hearth";
import type {
  ProjectWorkbenchCard,
  ProjectWorkbenchHost,
  ProjectWorkbenchPage,
} from "../../types/project-workbench";
import type { ProjectRecord } from "../../types/projects";
import { ConversationError } from "../conversations/error";
import type { Eligibility, Waiting } from "../scheduler/eligibility";
import { queueStateOf, smithFor } from "../scheduler/queue";
import { operatorMoves } from "../scheduler/queue-table";
import { selectProjectBeads, workspaceKey } from "./scope";
import type { ProjectSources } from "./summary";
import {
  projectWorkbenchPageSchema,
  workbenchHostSchema,
} from "./workbench-protocol";

/** Free-form scheduler explanations can contain foreign identities and file maps. */
function waitingReason(wait: Waiting, ids: ReadonlySet<string>) {
  if (wait.waitsOn)
    return ids.has(wait.waitsOn)
      ? `Its declared file scope overlaps work reserved or claimed by ${wait.waitsOn}.`
      : "Waits for work or a file reservation outside this project's visible scope.";
  if (wait.waitsOnShift)
    return "An earlier run still holds this bead's shift reservation. Check its shift before admitting another run.";
  if (wait.why.startsWith("its reservation overlaps"))
    return "This bead's active reservation overlaps another reservation. One must be released.";
  if (wait.why.startsWith("its file map changed"))
    return "The declared file map changed since this bead was reserved. Review its Files and reservation before proceeding.";
  if (wait.why.startsWith("an epic is worked"))
    return "An epic is worked through its child beads.";
  if (wait.why.startsWith("it is blocked"))
    return "An open prerequisite still blocks this bead.";
  if (wait.why === "it is in progress")
    return "This bead is already in progress.";
  return "The scheduler reports a wait. Refresh or inspect the bead before proceeding.";
}

/** Project membership precedes card metadata and every reservation/eligibility explanation. */
export function projectWorkbench(
  project: ProjectRecord,
  source: ProjectSources,
  observations: {
    eligibility: Eligibility | null;
    smiths: SmithsView | null;
    host: ProjectWorkbenchHost | null;
  },
): ProjectWorkbenchPage {
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(source.workspace),
  );
  if (!scope)
    throw new ConversationError(
      409,
      "This hearth does not serve the selected project workspace.",
    );
  if (!source.issues || !source.queue || !source.beadRows)
    throw new ConversationError(
      503,
      "The live tracker read is unavailable. Refresh before using the Workbench.",
    );
  const members = selectProjectBeads(project, source.workspace, source.issues);
  const ids = new Set(members.map((item) => item.id));
  const queue = source.queue.filter((entry) => ids.has(entry.beadId));
  const labels = new Map<string, number>();
  for (const entry of queue)
    labels.set(entry.beadId, (labels.get(entry.beadId) ?? 0) + 1);
  const rows = new Map(
    source.beadRows
      .filter((row) => ids.has(row.id))
      .map((row) => [row.id, row]),
  );
  const problems = [...source.problems];
  const broken = [...rows.values()].filter(
    (row) => queueStateOf(row).kind === "broken",
  );
  if (broken.length)
    problems.push(
      `Unrecognized or conflicting queue labels on ${broken
        .slice(0, 5)
        .map((row) => row.id)
        .join(
          ", ",
        )}${broken.length > 5 ? " and other scoped beads" : ""}. Inspect the labels before moving these beads.`,
    );
  if (
    scope.epicIds.some(
      (id) => !members.some((item) => item.id === id && item.type === "epic"),
    )
  )
    problems.push(
      "One or more selected epics are absent from the current scoped tracker read.",
    );
  if (project.workspaces.length > 1)
    problems.push("Other project workspaces are unavailable from this hearth.");
  const hostRead = workbenchHostSchema.safeParse(observations.host);
  const host = hostRead.success ? hostRead.data : null;
  if (!host || host.cpu === null)
    problems.push(
      "Current host CPU observation is unavailable. May start cannot be confirmed.",
    );
  if (!observations.eligibility)
    problems.push(
      "Current scheduler eligibility is unavailable. May start cannot be confirmed.",
    );
  if (!observations.smiths)
    problems.push(
      "Configured smith choices are unavailable. Reassignment cannot be offered.",
    );
  const names =
    observations.smiths?.smiths
      .filter((smith) => smith.enabled)
      .map((smith) => smith.name) ?? [];
  const configured = observations.smiths
    ? {
        names,
        defaultSmith: names.includes(observations.smiths.defaultSmith)
          ? observations.smiths.defaultSmith
          : null,
      }
    : null;
  const eligible = new Map(
    observations.eligibility?.eligible.map((item) => [item.id, item]) ?? [],
  );
  const waiting = new Map(
    observations.eligibility?.waiting.map((item) => [item.id, item]) ?? [],
  );
  const cards: ProjectWorkbenchCard[] = queue.map((entry) => {
    const member = members.find((item) => item.id === entry.beadId);
    const row = rows.get(entry.beadId);
    const selection = observations.smiths
      ? smithFor(
          {
            smiths: Object.fromEntries(
              observations.smiths.smiths.map((smith) => [smith.name, smith]),
            ),
            benches: observations.smiths.benches,
            workflow: { defaultCrew: observations.smiths.defaultSmith },
          },
          {
            id: entry.beadId,
            labels: member?.labels ?? [],
            metadata: row && "metadata" in row ? row.metadata : undefined,
          },
        )
      : null;
    const smith: ProjectWorkbenchCard["smith"] =
      selection?.ok && selection.via !== "explicit"
        ? { name: selection.smith.name, via: selection.via, reason: null }
        : {
            name: null,
            via: null,
            reason:
              selection && !selection.ok
                ? selection.error
                : "Configured smith selection is unavailable.",
          };
    const twoLabels =
      (labels.get(entry.beadId) ?? 0) > 1 ||
      queueStateOf(rows.get(entry.beadId) ?? {}).kind === "broken";
    const moves =
      entry.status === "closed" ? [] : operatorMoves(entry, { twoLabels });
    const note = twoLabels
      ? "This bead carries conflicting queue labels. Review its queue state before moving it."
      : entry.backed !== true
        ? "This inherited or manually added label grants no approval. Propose enters the actual approval queue."
        : entry.state === "paused" && !entry.resume
          ? "The saved paused state is incomplete. Its original queue state must be recovered before Resume."
          : null;
    let admission: ProjectWorkbenchCard["eligibility"] = null;
    if (entry.state === "queued") {
      const wait = waiting.get(entry.beadId);
      admission =
        !entry.backed || twoLabels || entry.status === "closed"
          ? {
              may: false,
              reason: "The current queue state does not permit admission.",
              waitsOn: null,
            }
          : !observations.eligibility
            ? {
                may: null,
                reason:
                  "Scheduler eligibility is unavailable. Refresh to check again.",
                waitsOn: null,
              }
            : wait
              ? {
                  may: false,
                  reason: waitingReason(wait, ids),
                  waitsOn:
                    wait.waitsOn && ids.has(wait.waitsOn) ? wait.waitsOn : null,
                }
              : !eligible.has(entry.beadId)
                ? {
                    may: null,
                    reason:
                      "This bead is absent from the current eligibility observation. Refresh to check again.",
                    waitsOn: null,
                  }
                : !host || host.cpu === null
                  ? {
                      may: null,
                      reason:
                        "Current host load could not be checked. Refresh before admitting work.",
                      waitsOn: null,
                    }
                  : !smith.name
                    ? {
                        may: false,
                        reason: `Smith selection is unavailable: ${smith.reason}`,
                        waitsOn: null,
                      }
                    : host.busy
                      ? {
                          may: false,
                          reason: `The host is busy${host.reason ? `: ${host.reason}` : "."}`,
                          waitsOn: null,
                        }
                      : {
                          may: true,
                          reason: eligible.get(entry.beadId)?.conservative
                            ? "Current checks permit admission with conservative file scope; a shift will reserve the whole checkout."
                            : "Current tracker, file reservation and host checks permit admission. A shift applies its final limits.",
                          waitsOn: null,
                        };
    }
    const session = source.sessions
      .filter(
        (item) =>
          item.beadId === entry.beadId &&
          workspaceKey(item.workspace) === workspaceKey(source.workspace),
      )
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt))[0];
    return {
      entry: { ...entry },
      moves,
      smith,
      complexity:
        BENCH_NAMES.find((bench) =>
          members
            .find((item) => item.id === entry.beadId)
            ?.labels?.includes(`complexity:${bench}`),
        ) ?? null,
      updatedAt: typeof row?.updated_at === "string" ? row.updated_at : "",
      note,
      eligibility: admission,
      session: session
        ? {
            id: session.sessionId,
            provider: session.executor?.provider ?? null,
            worktree: session.worktree ?? null,
            startedAt: session.startedAt ?? null,
          }
        : null,
    };
  });
  const value = {
    projectId: project.id,
    workspace: source.workspace,
    asOf: source.asOf,
    complete:
      project.workspaces.length === 1 &&
      scope.epicIds.every((id) => ids.has(id)) &&
      problems.length === 0,
    problems,
    cards,
    smiths: configured,
    host,
  };
  const checked = projectWorkbenchPageSchema.safeParse(value);
  if (
    !checked.success ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_048_576
  )
    throw new ConversationError(
      503,
      "The project Workbench exceeds its verified read limits. Refresh to check a smaller scope.",
    );
  return checked.data;
}
