import {
  type ProjectRepositoriesData,
  projectRepositoriesDataSchema,
} from "../../../scripts/projects/project-repositories-protocol";
import type { ProjectsHome } from "../../../types/project-summary";

export type ProjectRepositoriesPhase =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "catalog-mismatch"
  | "reconciling-catalog";

export interface ProjectRepositoriesSnapshot {
  key: string | null;
  projectId: string | null;
  requestedRevision: number | null;
  phase: ProjectRepositoriesPhase;
  data: ProjectRepositoriesData | null;
  error: string | null;
  responseRevision: number | null;
}

const emptySnapshot: ProjectRepositoriesSnapshot = {
  key: null,
  projectId: null,
  requestedRevision: null,
  phase: "idle",
  data: null,
  error: null,
  responseRevision: null,
};

export function projectRepositoriesKey(
  projectId: string | null,
  revision: number | null,
): string | null {
  return projectId !== null &&
    projectId.length > 0 &&
    revision !== null &&
    Number.isSafeInteger(revision) &&
    revision >= 0
    ? JSON.stringify([projectId, revision])
    : null;
}

export function projectRepositoriesForSelection(
  snapshot: ProjectRepositoriesSnapshot,
  projectId: string | null,
  revision: number | null,
): ProjectRepositoriesSnapshot {
  const key = projectRepositoriesKey(projectId, revision);
  if (snapshot.key === key) return snapshot;
  return key
    ? {
        key,
        projectId,
        requestedRevision: revision,
        phase: "loading",
        data: null,
        error: null,
        responseRevision: null,
      }
    : emptySnapshot;
}

export function validatedProjectRepositories(
  value: unknown,
  projectId: string,
): ProjectRepositoriesData {
  const checked = projectRepositoriesDataSchema.safeParse(value);
  if (!checked.success) throw Error("The repository response was malformed.");
  if (checked.data.projectId !== projectId)
    throw Error("The repository response belongs to another project.");
  return checked.data;
}

interface Dependencies {
  read(projectId: string): Promise<unknown>;
}
type CurrentView = () => boolean;

type CurrentSelection = () => {
  projectId: string | null;
  revision: number | null;
};

interface ReconciliationBarrier {
  state: "pending" | "complete" | "failed";
  revision: number;
  projects: unknown[];
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectCatalogFacts(value: unknown): {
  revision: number;
  projects: unknown[];
} {
  const home = isRecord(value) ? value : null;
  const catalog = isRecord(home?.["catalog"]) ? home["catalog"] : null;
  const revision = catalog?.["revision"];
  const projects = catalog?.["projects"];
  if (
    !home ||
    !Array.isArray(home["summaries"]) ||
    typeof home["asOf"] !== "string" ||
    catalog?.["version"] !== 1 ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Array.isArray(projects)
  )
    throw Error("The refreshed project catalog was malformed.");
  return { revision, projects };
}

export class ProjectRepositoriesOwner {
  private value = emptySnapshot;
  private listeners = new Set<
    (snapshot: ProjectRepositoriesSnapshot) => void
  >();
  private key: string | null = null;
  private epoch = 0;
  private pendingReconciliation: ReconciliationBarrier | null = null;
  private highestResponseRevision: number | null = null;
  private currentSelection: CurrentSelection = () => ({
    projectId: null,
    revision: null,
  });

  constructor(private readonly dependencies: Dependencies) {}

  snapshot = (): ProjectRepositoriesSnapshot => this.value;

  subscribe = (listener: (snapshot: ProjectRepositoriesSnapshot) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(snapshot: ProjectRepositoriesSnapshot) {
    this.value = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  deactivate() {
    this.epoch++;
    this.key = null;
  }

  activate(
    projectId: string | null,
    revision: number | null,
    getCurrentSelection?: CurrentSelection,
  ) {
    this.currentSelection =
      getCurrentSelection ?? (() => ({ projectId, revision }));
    const selected = this.currentSelection();
    if (selected.projectId !== projectId || selected.revision !== revision)
      return;
    const key = projectRepositoriesKey(projectId, revision);
    if (key === this.key) {
      if (this.pendingReconciliation?.state === "complete")
        this.finishReconciliation();
      return;
    }
    this.key = key;
    const epoch = ++this.epoch;
    if (key === null || projectId === null || revision === null) {
      this.publish(emptySnapshot);
      return;
    }
    if (this.pendingReconciliation) {
      const pending = this.pendingReconciliation;
      if (pending.state === "complete") this.finishReconciliation();
      else
        this.publish({
          ...this.value,
          key,
          projectId,
          requestedRevision: revision,
          phase:
            pending.state === "pending"
              ? "reconciling-catalog"
              : "catalog-mismatch",
          data: null,
          error: pending.error,
          responseRevision: this.highestResponseRevision,
        });
      return;
    }
    if (
      this.highestResponseRevision !== null &&
      revision < this.highestResponseRevision
    ) {
      this.publish({
        key,
        projectId,
        requestedRevision: revision,
        phase: "catalog-mismatch",
        data: null,
        error:
          "The selected project catalog revision is older than a repository response already received.",
        responseRevision: this.highestResponseRevision,
      });
      return;
    }
    this.publish({
      key,
      projectId,
      requestedRevision: revision,
      phase: "loading",
      data: null,
      error: null,
      responseRevision: null,
    });
    void this.load(projectId, revision, epoch);
  }

  async refresh(
    projectId: string | null,
    revision: number | null,
    isCurrent: CurrentView,
  ): Promise<void> {
    const key = projectRepositoriesKey(projectId, revision);
    if (
      projectId === null ||
      revision === null ||
      key === null ||
      key !== this.key ||
      this.pendingReconciliation !== null ||
      !isCurrent() ||
      this.value.phase === "loading" ||
      this.value.phase === "catalog-mismatch" ||
      this.value.phase === "reconciling-catalog"
    )
      return;
    const epoch = this.epoch;
    this.publish({
      ...this.value,
      phase: "loading",
      data: null,
      error: null,
      responseRevision: null,
    });
    await this.load(projectId, revision, epoch);
  }

  async reconcile(
    refreshProjectHome: () => Promise<ProjectsHome>,
    isCurrent: CurrentView,
  ): Promise<void> {
    const current = this.value;
    if (
      current.key === null ||
      current.projectId === null ||
      current.requestedRevision === null ||
      current.phase !== "catalog-mismatch" ||
      current.key !== this.key ||
      !isCurrent() ||
      this.pendingReconciliation?.state === "pending"
    )
      return;
    const barrier: ReconciliationBarrier = {
      state: "pending",
      revision: 0,
      projects: [],
      error: null,
    };
    this.pendingReconciliation = barrier;
    this.epoch++;
    this.publish({
      ...current,
      phase: "reconciling-catalog",
      data: null,
      error: null,
    });
    try {
      const home = await refreshProjectHome();
      const facts = projectCatalogFacts(home);
      if (this.pendingReconciliation !== barrier) return;
      barrier.revision = facts.revision;
      barrier.projects = facts.projects;
      barrier.state = "complete";
      this.finishReconciliation();
    } catch (error) {
      if (this.pendingReconciliation !== barrier) return;
      barrier.state = "failed";
      barrier.error =
        "Could not refresh the project catalog: " + errorMessage(error);
      const selection = this.currentSelection();
      if (
        this.key !== null &&
        projectRepositoriesKey(selection.projectId, selection.revision) ===
          this.key
      )
        this.publish({
          ...this.value,
          phase: "catalog-mismatch",
          data: null,
          error: barrier.error,
        });
    }
  }

  private finishReconciliation() {
    const pending = this.pendingReconciliation;
    const selection = this.currentSelection();
    const { projectId, revision } = selection;
    const key = projectRepositoriesKey(projectId, revision);
    if (
      !pending ||
      pending.state !== "complete" ||
      key === null ||
      key !== this.key ||
      projectId === null ||
      revision === null
    )
      return;
    const floor = this.highestResponseRevision ?? pending.revision;
    if (
      pending.projects.filter(
        (item) => isRecord(item) && item["id"] === projectId,
      ).length !== 1 ||
      pending.revision !== revision ||
      pending.revision < floor
    ) {
      this.publish({
        ...this.value,
        key,
        projectId,
        requestedRevision: revision,
        phase: "catalog-mismatch",
        data: null,
        error:
          "The refreshed catalog does not match the selected project or repository revision.",
        responseRevision: this.highestResponseRevision,
      });
      return;
    }
    this.pendingReconciliation = null;
    this.key = null;
    this.activate(projectId, revision, this.currentSelection);
  }

  private recordResponseRevision(revision: number) {
    if (
      this.highestResponseRevision !== null &&
      revision <= this.highestResponseRevision
    )
      return;
    this.highestResponseRevision = revision;
    const selection = this.currentSelection();
    if (
      projectRepositoriesKey(selection.projectId, selection.revision) ===
        this.key &&
      selection.revision !== null &&
      selection.revision < revision &&
      this.pendingReconciliation?.state !== "pending"
    ) {
      this.epoch++;
      this.publish({
        ...this.value,
        phase: "catalog-mismatch",
        data: null,
        error:
          "A repository response reports a newer catalog revision. Refresh the project catalog.",
        responseRevision: revision,
      });
    }
  }

  private currentSelectionMatches(
    projectId: string,
    revision: number,
  ): boolean {
    const selection = this.currentSelection();
    return selection.projectId === projectId && selection.revision === revision;
  }

  private async load(
    projectId: string,
    revision: number,
    epoch: number,
  ): Promise<void> {
    const key = projectRepositoriesKey(projectId, revision);
    try {
      const data = validatedProjectRepositories(
        await this.dependencies.read(projectId),
        projectId,
      );
      this.recordResponseRevision(data.catalogRevision);
      if (
        epoch !== this.epoch ||
        key !== this.key ||
        !this.currentSelectionMatches(projectId, revision)
      )
        return;
      if (data.catalogRevision !== revision) {
        this.publish({
          key,
          projectId,
          requestedRevision: revision,
          phase: "catalog-mismatch",
          data: null,
          error: null,
          responseRevision: data.catalogRevision,
        });
        return;
      }
      this.publish({
        key,
        projectId,
        requestedRevision: revision,
        phase: "ready",
        data,
        error: null,
        responseRevision: data.catalogRevision,
      });
    } catch (error) {
      if (
        epoch !== this.epoch ||
        key !== this.key ||
        !this.currentSelectionMatches(projectId, revision)
      )
        return;
      this.publish({
        key,
        projectId,
        requestedRevision: revision,
        phase: "error",
        data: null,
        error: errorMessage(error),
        responseRevision: null,
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The repository request failed.";
}
