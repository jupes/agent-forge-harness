import { readHearth } from "../../../docs/js/hearth-read";
import { operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import {
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../../scripts/projects/run-protocol";
import { projectSessionObservationsSchema } from "../../../scripts/projects/session-observations-protocol";
import { projectCouncilHistorySchema } from "../../../types/project-council";
import type { ProjectsHome } from "../../../types/project-summary";
import type { PaletteSourceRow } from "./command-palette";
import { createProjectCouncilTransport } from "./project-council-transport";
import { deriveProjectRunCheckpoints } from "./project-run-checkpoints";
import { createProjectRunsClient } from "./project-runs-client";
import { createProjectRunsReads } from "./project-runs-read";
import { readSessionObservationResponse } from "./session-observation-response";
import { sessionObservationRows } from "./session-observations";

export type PaletteCoverage =
  | "loading"
  | "available"
  | "partial"
  | "unavailable";
export interface PaletteSourceStatus {
  coverage: PaletteCoverage;
  checkedAt: number;
  error: string;
}
export interface PaletteIndexScope {
  catalogRevision: number;
  routeGeneration: number;
  projectId: string | null;
  workspace: string | null;
  writesAllowed: boolean;
  nativeAvailable: boolean;
}
export interface PaletteIndexSnapshot {
  scope: PaletteIndexScope;
  generation: number;
  asOf: number;
  rows: PaletteSourceRow[];
  sources: Record<string, PaletteSourceStatus>;
}
export interface PaletteProject {
  id: string;
  name: string;
  slug: string;
  description?: string;
  archived: boolean;
  workspaces: { root: string }[];
}
export interface PaletteIndexDependencies {
  readBeads(projectId: string, signal: AbortSignal): Promise<unknown>;
  readSessions(projectId: string, signal: AbortSignal): Promise<unknown>;
  readRuns(
    projectId: string,
    workspace: string,
    signal: AbortSignal,
    selectedRun?: { projectId: string; slug: string } | null,
  ): Promise<unknown>;
  readCouncil(projectId: string, signal: AbortSignal): Promise<unknown>;
}
const status = (
  coverage: PaletteCoverage,
  error = "",
): PaletteSourceStatus => ({
  coverage,
  checkedAt: Date.now(),
  error: error.replace(/[\p{Cc}\p{Cs}]/gu, " ").slice(0, 200),
});
const sessionPath = (id: string) =>
  `/__agent-forge/projects/${encodeURIComponent(id)}/session-observations`;

/** Current cross-project metadata only. Each source fails independently and rows remain project/workspace bound. */
export function createCommandPaletteIndex(
  deps: PaletteIndexDependencies = {
    readBeads: (id, signal) =>
      readOperatorRoute(`/projects/${encodeURIComponent(id)}/beads`, {
        ...pageReads(),
        fetch: (url, init) =>
          operatorRead(url, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([signal, init.signal])
              : signal,
          }),
      }),
    readSessions: (id, signal) =>
      readHearth(
        sessionPath(id),
        (response) => readSessionObservationResponse(response, "index"),
        {
          ...pageReads(),
          fetch: (url, init) =>
            operatorRead(url, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal,
            }),
        },
      ),
    readRuns: async (id, workspace, signal, selectedRun) => {
      const reads = createProjectRunsReads(id, {
        options: { ...pageReads(), fetch: operatorRead },
      });
      const client = createProjectRunsClient({
        projectId: id,
        workspace,
        ...reads,
      });
      const cancel = () => client.dispose();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await client.refresh();
        const page = client.get().page;
        if (client.get().error || !page)
          throw Error(client.get().error || "Run metadata unavailable.");
        const slug = selectedRun?.projectId === id ? selectedRun.slug : null;
        if (slug && page.runs.some((run) => run.slug === slug)) {
          client.select(slug);
          await new Promise<void>((resolve, reject) => {
            let stop = () => {};
            const abort = () => {
              stop();
              reject(Error("Run detail read aborted."));
            };
            stop = client.subscribe(() => {
              const view = client.get();
              if (signal.aborted) abort();
              else if (!view.detailLoading && view.selectedSlug === slug) {
                stop();
                signal.removeEventListener("abort", abort);
                resolve();
              }
            });
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
        }
        return { page, detail: slug ? client.get().detail : null };
      } finally {
        signal.removeEventListener("abort", cancel);
        client.dispose();
      }
    },
    readCouncil: (id, signal) =>
      createProjectCouncilTransport().history(id, signal),
  },
) {
  return {
    async refresh(input: {
      generation: number;
      scope: PaletteIndexScope;
      home: ProjectsHome;
      signal: AbortSignal;
      isCurrent(): boolean;
      selectedRun?: { projectId: string; slug: string } | null;
      onSnapshot?(snapshot: PaletteIndexSnapshot): void;
    }): Promise<PaletteIndexSnapshot> {
      const { generation, scope, home, signal, isCurrent } = input;
      const asOf = Date.now();
      const rows: PaletteSourceRow[] = [];
      const sources: Record<string, PaletteSourceStatus> = {};
      const projects = home.catalog.projects as unknown as PaletteProject[];
      for (const project of projects) {
        rows.push({
          kind: "project",
          id: project.id,
          label: project.name,
          ...(project.description !== undefined
            ? { detail: project.description }
            : {}),
          keywords: project.slug,
          projectId: project.id,
          intent: {
            kind: "navigate",
            route: {
              destination: "overview",
              projectId: project.id,
              selection: null,
            },
          },
        });
      }
      const candidates = projects.filter((project) => !project.archived);
      for (const project of candidates)
        for (const source of ["beads", "sessions", "runs", "council"])
          sources[`${source}:${project.id}`] = status("loading");
      const publish = () => {
        if (!signal.aborted && isCurrent())
          input.onSnapshot?.({
            scope,
            generation,
            asOf,
            rows: [...rows],
            sources: { ...sources },
          });
      };
      publish();
      const settled = async (
        read: () => Promise<unknown>,
      ): Promise<PromiseSettledResult<unknown>> => {
        try {
          return { status: "fulfilled", value: await read() };
        } catch (reason) {
          return { status: "rejected", reason };
        }
      };
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(3, candidates.length) },
        async () => {
          while (!signal.aborted && isCurrent()) {
            const project = candidates[cursor++];
            if (!project) return;
            const summary = home.summaries.find(
              (item) => item.projectId === project.id,
            );
            const workspace = summary?.workspace;
            const canonical =
              !!workspace &&
              project.workspaces.some((entry) => entry.root === workspace);
            const beadsResult = await settled(() =>
              deps.readBeads(project.id, signal),
            );
            if (signal.aborted || !isCurrent()) return;
            const beadPage =
              beadsResult.status === "fulfilled"
                ? projectBeadsPageSchema.safeParse(beadsResult.value)
                : null;
            if (
              beadPage?.success &&
              beadPage.data.projectId === project.id &&
              canonical &&
              beadPage.data.workspace === workspace
            ) {
              const complete =
                beadPage.data.complete && !beadPage.data.problems.length;
              sources[`beads:${project.id}`] = status(
                complete ? "available" : "partial",
                complete ? "" : "The Beads page is incomplete.",
              );
              for (const bead of beadPage.data.beads) {
                const route = {
                  destination: "beads" as const,
                  projectId: project.id,
                  selection: { kind: "bead" as const, id: bead.id },
                };
                rows.push({
                  kind: "bead",
                  id: bead.id,
                  projectId: project.id,
                  label: bead.title,
                  detail: `${bead.type} · ${bead.status}`,
                  keywords: `${bead.id} ${bead.assignee ?? ""} ${bead.labels.join(" ")}`,
                  intent: { kind: "navigate", route },
                  updatedAt: bead.updatedAt,
                });
                if (complete)
                  rows.push({
                    kind: "review",
                    id: `bead:${bead.id}`,
                    projectId: project.id,
                    label: `Review ${bead.title}`,
                    detail: `${bead.type} · ${bead.status}`,
                    keywords: `${bead.id} ${bead.assignee ?? ""}`,
                    intent: {
                      kind: "review",
                      target: {
                        kind: "bead",
                        projectId: project.id,
                        beadId: bead.id,
                      },
                    },
                    updatedAt: bead.updatedAt,
                  });
              }
            } else
              sources[`beads:${project.id}`] = status(
                "unavailable",
                "Current Beads metadata could not be verified.",
              );
            publish();
            if (signal.aborted || !isCurrent()) return;
            const sessionsResult = await settled(() =>
              deps.readSessions(project.id, signal),
            );
            if (signal.aborted || !isCurrent()) return;
            const sessionPage =
              sessionsResult.status === "fulfilled"
                ? projectSessionObservationsSchema.safeParse(
                    sessionsResult.value,
                  )
                : null;
            if (
              sessionPage?.success &&
              sessionPage.data.projectId === project.id &&
              canonical &&
              sessionPage.data.workspace === workspace
            ) {
              const data = sessionPage.data;
              const coverage =
                data.observationsComplete &&
                data.ownership.available &&
                !data.problems.length
                  ? "available"
                  : "partial";
              sources[`sessions:${project.id}`] = status(
                coverage,
                coverage === "available"
                  ? ""
                  : "Session observations or ownership are incomplete.",
              );
              for (const row of sessionObservationRows(data)) {
                const lastEventAt = row.observation?.lastEventAt;
                rows.push({
                  kind: "session",
                  id: row.id,
                  projectId: project.id,
                  label: row.title,
                  detail:
                    row.ownership === "owned"
                      ? "Verified app-owned metadata"
                      : "Observed metadata only",
                  keywords: `${row.provider} ${row.id} ${row.observation?.beadId ?? ""}`,
                  intent: {
                    kind: "navigate",
                    route: {
                      destination: "sessions",
                      projectId: project.id,
                      selection: { kind: "session", id: row.id },
                    },
                  },
                  ...(lastEventAt !== undefined
                    ? { updatedAt: lastEventAt }
                    : {}),
                });
              }
            } else
              sources[`sessions:${project.id}`] = status(
                "unavailable",
                "Session metadata could not be verified.",
              );
            publish();
            if (signal.aborted || !isCurrent()) return;
            const runsResult = await settled(() =>
              canonical
                ? deps.readRuns(
                    project.id,
                    workspace!,
                    signal,
                    input.selectedRun,
                  )
                : Promise.reject(
                    Error("Workspace is not current for this project."),
                  ),
            );
            if (signal.aborted || !isCurrent()) return;
            const runValue =
              runsResult.status === "fulfilled"
                ? (runsResult.value as { page?: unknown; detail?: unknown })
                : null;
            const runPage = runValue
              ? projectRunsPageSchema.safeParse(runValue.page)
              : null;
            if (
              runPage?.success &&
              runPage.data.projectId === project.id &&
              canonical &&
              runPage.data.workspace === workspace &&
              runPage.data.coverage === "served-checkout-only"
            ) {
              const incompleteRun = runPage.data.runs.some(
                (run) => !run.complete,
              );
              const runsPartial =
                runPage.data.problems.length > 0 || incompleteRun;
              sources[`runs:${project.id}`] = status(
                runsPartial ? "partial" : "available",
                runsPartial ? "Run metadata is incomplete." : "",
              );
              for (const run of runPage.data.runs)
                rows.push({
                  kind: "run",
                  id: run.slug,
                  projectId: project.id,
                  label: run.feature ?? run.slug,
                  detail: `Run · ${run.status.kind}`,
                  keywords: `${run.slug} ${run.epic ?? ""} ${project.name}`,
                  intent: {
                    kind: "navigate",
                    route: {
                      destination: "runs",
                      projectId: project.id,
                      selection: { kind: "run", id: run.slug },
                    },
                  },
                  ...(run.updatedAt !== null
                    ? { updatedAt: run.updatedAt }
                    : {}),
                });
              const beads =
                beadPage?.success &&
                beadPage.data.projectId === project.id &&
                beadPage.data.workspace === workspace
                  ? beadPage.data
                  : null;
              const rawDetail = runValue?.detail;
              const detailCore =
                typeof rawDetail === "object" &&
                rawDetail !== null &&
                !Array.isArray(rawDetail)
                  ? Object.fromEntries(
                      Object.entries(rawDetail).filter(
                        ([key]) => key !== "sessionHistory",
                      ),
                    )
                  : rawDetail;
              const detailResult = projectRunDetailSchema.safeParse(detailCore);
              const detail = detailResult.success ? detailResult.data : null;
              if (
                input.selectedRun?.projectId === project.id &&
                input.selectedRun.slug &&
                detail &&
                beads &&
                runPage.data.runs.some(
                  (run) => run.slug === input.selectedRun?.slug,
                )
              ) {
                const listed = runPage.data.runs.find(
                  (run) => run.slug === input.selectedRun?.slug,
                )!;
                const result = deriveProjectRunCheckpoints({
                  projectId: project.id,
                  workspace,
                  runs: {
                    page: runPage.data,
                    loading: false,
                    error: "",
                    selectedSlug: listed.slug,
                    detail,
                    detailLoading: false,
                    detailError: "",
                    detailStale: false,
                  },
                  beads: { page: beads, loading: false, error: null },
                });
                if (
                  result.kind === "ready" &&
                  listed.complete &&
                  !detail.problems.length &&
                  listed.updatedAt !== null &&
                  detail.run.updatedAt !== null &&
                  detail.run.updatedAt === listed.updatedAt
                )
                  for (const checkpointId of result.summary.inProgressIds)
                    rows.push({
                      kind: "review",
                      id: `${listed.slug}:${checkpointId}`,
                      projectId: project.id,
                      label: `Review checkpoint ${checkpointId}`,
                      detail: listed.feature ?? listed.slug,
                      keywords: `${checkpointId} ${listed.slug} checkpoint`,
                      ...(!scope.writesAllowed
                        ? { unavailable: "Writes are currently unavailable." }
                        : {}),
                      intent: {
                        kind: "review",
                        target: {
                          kind: "checkpoint",
                          projectId: project.id,
                          runSlug: listed.slug,
                          checkpointId,
                          runUpdatedAt: listed.updatedAt,
                        },
                      },
                      updatedAt: listed.updatedAt,
                    });
              }
            } else
              sources[`runs:${project.id}`] = status(
                "unavailable",
                "Full current Runs metadata could not be verified.",
              );
            publish();
            if (signal.aborted || !isCurrent()) return;
            const councilResult = await settled(() =>
              deps.readCouncil(project.id, signal),
            );
            if (signal.aborted || !isCurrent()) return;
            const history =
              councilResult.status === "fulfilled"
                ? projectCouncilHistorySchema.safeParse(councilResult.value)
                : null;
            if (
              history?.success &&
              history.data.projectId === project.id &&
              canonical &&
              history.data.workspace === workspace
            ) {
              sources[`council:${project.id}`] = status(
                history.data.omitted ? "partial" : "available",
                history.data.omitted
                  ? "Some saved Council results were omitted."
                  : "",
              );
              for (const item of history.data.items)
                rows.push({
                  kind: "review",
                  id: `council:${item.requestId}`,
                  projectId: project.id,
                  label: item.sourceName,
                  detail: `Council · ${item.state} · ${item.profileTitle}`,
                  keywords: `${item.requestId} ${item.state}`,
                  intent: {
                    kind: "navigate",
                    route: {
                      destination: "reviews",
                      projectId: project.id,
                      selection: { kind: "event", id: item.requestId },
                    },
                  },
                  updatedAt: item.createdAt,
                });
            } else
              sources[`council:${project.id}`] = status(
                "unavailable",
                "Council history could not be verified.",
              );
            publish();
          }
        },
      );
      await Promise.all(workers);
      if (signal.aborted || !isCurrent())
        throw Error("Palette index refresh was superseded.");
      return { scope, generation, asOf, rows, sources };
    },
    watchInvalidation(callback: () => void) {
      return appStream().watch(
        [
          "operator.action",
          "bead.transitioned",
          "session.started",
          "session.ended",
          "prompt.submitted",
          "tool.called",
          "run.phase.entered",
          "run.phase.completed",
          "review.recorded",
          "gate.ran",
        ],
        callback,
      );
    },
  };
}
