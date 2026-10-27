import type {
  ProjectCreateOptions,
  ProjectScopePreview,
} from "../../../scripts/projects/create-options-protocol";
import {
  type ProjectCreateDiscovery,
  type ProjectCreateIdentity,
  type ProjectCreateOriginal,
  projectCreateOriginalSchema,
  projectCreateReserveSchema,
} from "../../../scripts/projects/create-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import type { SmithsView } from "../../../types/hearth";
import type { ProjectCreateWriteResult } from "./project-create-api";
import type { ProjectCreateLocalIdentity } from "./project-create-identities";
import { canonicalProjectCreateJson } from "./project-create-identities";

export interface ProjectCreateEntry {
  identity: ProjectCreateIdentity | null;
  local: ProjectCreateLocalIdentity | null;
  original: ProjectCreateOriginal;
  phase: "pending" | "not-sent" | "unknown" | "reserved";
}

export interface ProjectCreateState {
  phase: "loading" | "ready" | "unavailable";
  options: ProjectCreateOptions | null;
  smiths: SmithsView | null;
  catalogRevision: number | null;
  entries: ProjectCreateEntry[];
  busy: boolean;
  error: string;
  notice: string;
}

const emptyState = (): ProjectCreateState => ({
  phase: "loading",
  options: null,
  smiths: null,
  catalogRevision: null,
  entries: [],
  busy: false,
  error: "",
  notice: "",
});

type Catalog = {
  revision: number;
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    description: string;
    icon: string;
    keeperSmith?: string | undefined;
    color?: string | undefined;
    workspaces: Array<{ root: string }>;
  }>;
};
type ProjectCreateDiscoveryRow = ProjectCreateDiscovery["operations"][number];
type ClientIdentityStore = {
  list(): ProjectCreateLocalIdentity[];
  reserve(
    original: ProjectCreateOriginal,
    revision: number,
    mint: () => string,
  ): Promise<{ identity: ProjectCreateLocalIdentity; created: boolean }>;
  update(
    requestId: string,
    requestHash: string,
    state: ProjectCreateLocalIdentity["state"],
  ): Promise<ProjectCreateLocalIdentity>;
  observe(identity: ProjectCreateIdentity): Promise<ProjectCreateLocalIdentity>;
};
type Api = {
  options(): Promise<ProjectCreateOptions>;
  smiths(): Promise<SmithsView>;
  discovery(): Promise<ProjectCreateDiscovery>;
  original(requestId: string): Promise<ProjectCreateIdentity>;
  catalog(): Promise<Catalog>;
  preview(
    slug: string,
    epicIds: readonly string[],
  ): Promise<ProjectScopePreview>;
  reserve(
    request: {
      requestId: string;
      expectedCatalogRevision: number;
      original: ProjectCreateOriginal;
    },
    requestHash: string,
  ): Promise<ProjectCreateWriteResult<ProjectCreateIdentity>>;
  commit(
    requestId: string,
    requestHash: string,
    reviewedScopeHash: string,
  ): Promise<ProjectCreateWriteResult<ProjectCreateIdentity>>;
  retire(
    requestId: string,
    requestHash: string,
  ): Promise<ProjectCreateWriteResult<ProjectCreateIdentity>>;
};

const exactOriginal = (left: unknown, right: unknown) =>
  canonicalProjectCreateJson(left) === canonicalProjectCreateJson(right);
const rowMatchesIdentity = (
  row: ProjectCreateDiscoveryRow,
  identity: ProjectCreateIdentity,
) =>
  row.requestId === identity.requestId &&
  row.requestHash === identity.requestHash &&
  row.state === identity.state &&
  row.scopeCount === identity.scopeCount &&
  row.projectId === identity.projectId;

const isActive = (entry: ProjectCreateEntry) =>
  entry.phase === "pending" ||
  entry.phase === "not-sent" ||
  entry.phase === "unknown" ||
  entry.phase === "reserved";

/** App-root owner of the immutable project original and its explicit actions. */
export function createProjectCreateOwner(deps: {
  workspace: string | null;
  currentWorkspace(): string | null;
  canWrite(): boolean;
  identities: ClientIdentityStore;
  api: Api;
  mint(): string;
  changed(): void;
}) {
  const state = emptyState();
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  const scope = deps.workspace ? workspaceKey(deps.workspace) : null;
  const currentScopeMatches = () =>
    Boolean(scope && workspaceKey(deps.currentWorkspace() ?? "") === scope);
  const emit = () => {
    if (disposed) return;
    deps.changed();
    for (const listener of listeners) listener();
  };
  const unavailable = (message: string, current: number) => {
    if (disposed || current !== generation) return;
    state.phase = "unavailable";
    state.options = null;
    state.smiths = null;
    state.catalogRevision = null;
    state.error = message;
    // Keep unresolved originals visible and blocking even when reads fail.
    emit();
  };
  const replaceEntry = (entry: ProjectCreateEntry) => {
    const index = state.entries.findIndex(
      (item) =>
        (item.identity?.requestId ?? item.local?.request.requestId) ===
        (entry.identity?.requestId ?? entry.local?.request.requestId),
    );
    state.entries =
      index < 0
        ? [...state.entries, entry]
        : state.entries.map((item, position) =>
            position === index ? entry : item,
          );
  };
  const activeFor = (requestId: string) =>
    state.entries.find(
      (entry) =>
        isActive(entry) &&
        (entry.identity?.requestId ?? entry.local?.request.requestId) ===
          requestId,
    );
  const scopeAllowed = (original: ProjectCreateOriginal) => {
    if (!state.options || !state.smiths || !currentScopeMatches()) return false;
    return choicesAllowed(original, state.options, state.smiths);
  };
  const choicesAllowed = (
    original: ProjectCreateOriginal,
    options: ProjectCreateOptions,
    smiths: SmithsView,
  ) => {
    const currentScope = scope;
    if (!currentScope) return false;
    const project = projectCreateOriginalSchema.safeParse(original);
    if (!project.success) return false;
    const work = project.data.workspaces[0];
    if (
      !work ||
      workspaceKey(work.root) !== currentScope ||
      options.workspace.key !== currentScope ||
      workspaceKey(options.workspace.path) !== currentScope
    )
      return false;
    const repositoryPaths = new Set(
      options.repositories.map((row) => row.path),
    );
    const epicIds = new Set(options.epics.map((row) => row.id));
    if (
      !work.repositories.every((path) => repositoryPaths.has(path)) ||
      !work.epicIds.every((id) => epicIds.has(id))
    )
      return false;
    const keeper = smiths.smiths.find(
      (smith) => smith.name === project.data.keeperSmith,
    );
    return keeper?.enabled === true;
  };

  const recover = async () => {
    if (disposed || state.busy) return;
    const current = ++generation;
    state.phase = "loading";
    state.error = "";
    emit();
    if (!scope) {
      unavailable("The trusted project workspace is unavailable.", current);
      return;
    }
    try {
      const [options, smiths, catalog, page, localRows] = await Promise.all([
        deps.api.options(),
        deps.api.smiths(),
        deps.api.catalog(),
        deps.api.discovery(),
        Promise.resolve(deps.identities.list()),
      ]);
      if (disposed || current !== generation) return;
      if (!currentScopeMatches()) {
        unavailable(
          "The trusted project workspace changed during recovery.",
          current,
        );
        return;
      }
      if (
        !page.complete ||
        options.workspace.key !== scope ||
        workspaceKey(options.workspace.path) !== scope ||
        !currentScopeMatches()
      )
        throw Error("The current trusted workspace could not be verified.");
      state.options = options;
      state.smiths = smiths;
      state.catalogRevision = catalog.revision;

      const locals = new Map(
        localRows.map((entry) => [entry.request.requestId, entry]),
      );
      const seen = new Set<string>();
      const entries: ProjectCreateEntry[] = [];
      for (const row of page.operations) {
        const local = locals.get(row.requestId) ?? null;
        if (row.state !== "reserved" && !local) continue;
        try {
          const identity = await deps.api.original(row.requestId);
          if (disposed || current !== generation) return;
          if (
            !rowMatchesIdentity(row, identity) ||
            workspaceKey(identity.original.workspaces[0]!.root) !== scope ||
            (local &&
              (local.requestHash !== identity.requestHash ||
                !exactOriginal(local.request.original, identity.original)))
          )
            throw Error("The protected project original did not match.");
          const saved = await deps.identities.observe(identity);
          if (disposed || current !== generation) return;
          seen.add(identity.requestId);
          if (identity.state === "reserved")
            entries.push({
              identity,
              local: saved,
              original: identity.original,
              phase: "reserved",
            });
        } catch {
          if (
            row.state === "reserved" ||
            (local &&
              isActive({
                identity: null,
                local,
                original: local.request.original,
                phase:
                  local.state === "reserved"
                    ? "reserved"
                    : local.state === "not-sent"
                      ? "not-sent"
                      : "unknown",
              }))
          ) {
            const original = local?.request.original;
            if (!original)
              throw Error("A reserved project original is unverified.");
            entries.push({
              identity: null,
              local,
              original,
              phase: "unknown",
            });
          }
        }
      }
      for (const local of localRows) {
        if (
          !seen.has(local.request.requestId) &&
          local.state !== "created" &&
          local.state !== "retired"
        )
          entries.push({
            identity: null,
            local,
            original: local.request.original,
            phase: local.state === "not-sent" ? "not-sent" : "unknown",
          });
      }
      if (disposed || current !== generation) return;
      if (!currentScopeMatches()) {
        unavailable(
          "The trusted project workspace changed during recovery.",
          current,
        );
        return;
      }
      state.entries = entries;
      state.phase = "ready";
      state.error = "";
      emit();
    } catch {
      unavailable(
        "Saved project creation could not be verified. Existing originals remain held; no further action was taken.",
        current,
      );
    }
  };

  const freshPreview = async (
    original: ProjectCreateOriginal,
  ): Promise<ProjectScopePreview> => {
    const preview = await deps.api.preview(
      original.slug,
      original.workspaces[0]!.epicIds,
    );
    if (
      !scope ||
      preview.workspaceKey !== scope ||
      !currentScopeMatches() ||
      preview.slug !== original.slug ||
      preview.epicIds.length !== original.workspaces[0]!.epicIds.length ||
      !preview.epicIds.every(
        (id, index) =>
          id === [...original.workspaces[0]!.epicIds].sort()[index],
      )
    )
      throw Error("The reviewed project scope changed. Review it again.");
    return preview;
  };

  const verifiedCreated = async (
    expected: ProjectCreateIdentity,
    current: number,
  ) => {
    const [identity, catalog] = await Promise.all([
      deps.api.original(expected.requestId),
      deps.api.catalog(),
    ]);
    if (disposed || current !== generation) return null;
    if (!currentScopeMatches()) return null;
    const project = catalog.projects.find(
      (item) => item.id === expected.projectId,
    );
    const catalogOriginal = project
      ? {
          slug: project.slug,
          name: project.name,
          description: project.description,
          icon: project.icon,
          ...(project.keeperSmith === undefined
            ? {}
            : { keeperSmith: project.keeperSmith }),
          ...(project.color === undefined ? {} : { color: project.color }),
          workspaces: project.workspaces,
        }
      : null;
    if (
      identity.state !== "created" ||
      identity.requestId !== expected.requestId ||
      identity.requestHash !== expected.requestHash ||
      !exactOriginal(identity.original, expected.original) ||
      !project ||
      !catalogOriginal ||
      !exactOriginal(catalogOriginal, expected.original) ||
      catalog.revision < identity.createdRevision!
    )
      return null;
    await deps.identities.observe(identity);
    if (disposed || current !== generation) return null;
    return identity;
  };

  const reserveWithIdentity = async (
    local: ProjectCreateLocalIdentity,
    preview: ProjectScopePreview,
    current: number,
  ) => {
    // Once a POST may begin, persist uncertainty before entering transport.
    // Only a typed NotSent result can restore an explicit retry proof.
    await deps.identities.update(
      local.request.requestId,
      local.requestHash,
      "unknown",
    );
    if (
      disposed ||
      current !== generation ||
      !currentScopeMatches() ||
      !deps.canWrite()
    )
      return false;
    const outcome = await deps.api.reserve(local.request, local.requestHash);
    if (disposed || current !== generation || !currentScopeMatches())
      return false;
    if (outcome.state === "confirmed") {
      const identity = outcome.value;
      if (
        identity.requestId !== local.request.requestId ||
        identity.requestHash !== local.requestHash ||
        identity.baseRevision !== local.request.expectedCatalogRevision ||
        identity.scopeHash !== preview.scopeHash ||
        identity.scopeCount !== preview.scopeCount ||
        !exactOriginal(identity.original, local.request.original)
      ) {
        await deps.identities.update(
          local.request.requestId,
          local.requestHash,
          "unknown",
        );
        state.notice =
          "The reservation reply did not match the saved original. It remains held for review.";
        return false;
      }
      await deps.identities.observe(identity);
      state.notice = "The exact project original is reserved for review.";
      return true;
    }
    await deps.identities.update(
      local.request.requestId,
      local.requestHash,
      outcome.state === "not-sent" ? "not-sent" : "unknown",
    );
    state.notice =
      outcome.state === "not-sent"
        ? "The reservation was refused before sending. The exact original remains saved; retry that same request explicitly."
        : "The reservation outcome is unknown. The exact original remains saved; no replacement was created.";
    return false;
  };

  return {
    get: () => structuredClone(state),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover,
    async preview(originalInput: ProjectCreateOriginal) {
      if (disposed || state.busy || state.phase !== "ready") return null;
      const original = projectCreateOriginalSchema.parse(
        structuredClone(originalInput),
      );
      if (!scopeAllowed(original)) {
        state.error = "Choose only current trusted project and Keeper options.";
        emit();
        return null;
      }
      state.busy = true;
      state.error = "";
      state.notice = "Checking the complete trusted project scope…";
      const current = ++generation;
      emit();
      try {
        const [options, smiths, catalog, preview] = await Promise.all([
          deps.api.options(),
          deps.api.smiths(),
          deps.api.catalog(),
          freshPreview(original),
        ]);
        if (disposed || current !== generation) return null;
        if (!choicesAllowed(original, options, smiths))
          throw Error(
            "Trusted project choices changed. Refresh and review again.",
          );
        if (catalog.revision !== state.catalogRevision) {
          state.catalogRevision = catalog.revision;
          state.options = options;
          state.smiths = smiths;
          throw Error(
            "Projects changed. Review the project again before reserving.",
          );
        }
        state.options = options;
        state.smiths = smiths;
        state.notice =
          "The complete project scope is ready for explicit review.";
        return preview;
      } catch {
        state.error =
          "The complete project scope could not be verified. No reservation was sent.";
        return null;
      } finally {
        if (!disposed && current === generation) {
          state.busy = false;
          emit();
        }
      }
    },
    async reserve(
      originalInput: ProjectCreateOriginal,
      reviewed: ProjectScopePreview,
    ) {
      if (
        disposed ||
        state.busy ||
        state.phase !== "ready" ||
        !deps.canWrite() ||
        state.entries.some(isActive)
      )
        return false;
      const original = projectCreateOriginalSchema.parse(
        structuredClone(originalInput),
      );
      if (!scopeAllowed(original)) {
        state.error = "Choose only current trusted project and Keeper options.";
        emit();
        return false;
      }
      state.busy = true;
      state.error = "";
      state.notice = "Saving the exact project original before reservation…";
      const current = ++generation;
      emit();
      try {
        const [options, catalog, smiths, preview] = await Promise.all([
          deps.api.options(),
          deps.api.catalog(),
          deps.api.smiths(),
          freshPreview(original),
        ]);
        if (disposed || current !== generation) return false;
        if (
          !deps.canWrite() ||
          !currentScopeMatches() ||
          options.workspace.key !== scope ||
          workspaceKey(options.workspace.path) !== scope ||
          !choicesAllowed(original, options, smiths) ||
          catalog.revision !== state.catalogRevision ||
          reviewed.workspaceKey !== scope ||
          reviewed.scopeHash !== preview.scopeHash ||
          reviewed.scopeCount !== preview.scopeCount ||
          !smiths.smiths.some(
            (smith) => smith.name === original.keeperSmith && smith.enabled,
          )
        )
          throw Error(
            "Choices changed. Refresh the trusted scope and review again.",
          );
        const local = await deps.identities.reserve(
          original,
          catalog.revision,
          deps.mint,
        );
        if (disposed || current !== generation) return false;
        if (!currentScopeMatches() || !deps.canWrite()) {
          if (local.created)
            await deps.identities.update(
              local.identity.request.requestId,
              local.identity.requestHash,
              "not-sent",
            );
          return false;
        }
        if (!local.created) {
          replaceEntry({
            identity: null,
            local: local.identity,
            original: local.identity.request.original,
            phase: "unknown",
          });
          state.notice =
            "An unresolved project original already exists. Review or check that exact request first.";
          return false;
        }
        replaceEntry({
          identity: null,
          local: local.identity,
          original,
          phase: "pending",
        });
        emit();
        return await reserveWithIdentity(local.identity, preview, current);
      } catch {
        state.error =
          "The reservation could not be confirmed. Check saved originals before starting another review.";
        return false;
      } finally {
        if (!disposed && current === generation) {
          state.busy = false;
          emit();
          void recover();
        }
      }
    },
    async retryReservation(requestId: string) {
      const entry = activeFor(requestId);
      if (
        !entry?.local ||
        entry.identity ||
        entry.local.state !== "not-sent" ||
        state.busy ||
        !deps.canWrite() ||
        !scopeAllowed(entry.original)
      )
        return false;
      state.busy = true;
      state.error = "";
      state.notice = "Retrying only the exact saved project reservation…";
      const current = ++generation;
      emit();
      try {
        const [options, smiths, preview, page] = await Promise.all([
          deps.api.options(),
          deps.api.smiths(),
          freshPreview(entry.original),
          deps.api.discovery(),
        ]);
        if (disposed || current !== generation) return false;
        if (
          !deps.canWrite() ||
          !currentScopeMatches() ||
          !page.complete ||
          options.workspace.key !== scope ||
          workspaceKey(options.workspace.path) !== scope ||
          !choicesAllowed(entry.original, options, smiths)
        )
          throw Error(
            "Trusted project choices changed. Check the saved original.",
          );
        const existing = page.operations.find(
          (row) => row.requestId === entry.local!.request.requestId,
        );
        if (existing) {
          const identity = await deps.api.original(existing.requestId);
          if (disposed || current !== generation || !currentScopeMatches())
            return false;
          if (
            !rowMatchesIdentity(existing, identity) ||
            identity.requestHash !== entry.local.requestHash ||
            !exactOriginal(identity.original, entry.original) ||
            workspaceKey(identity.original.workspaces[0]!.root) !== scope
          )
            throw Error(
              "The protected original did not match the saved request.",
            );
          await deps.identities.observe(identity);
          state.notice =
            identity.state === "reserved"
              ? "The same original is already reserved. No new reservation was sent."
              : "The saved original already has a server record. No new reservation was sent.";
          return false;
        }
        return await reserveWithIdentity(entry.local, preview, current);
      } catch {
        state.error =
          "The saved project reservation could not be retried safely. The original remains held.";
        return false;
      } finally {
        if (!disposed && current === generation) {
          state.busy = false;
          emit();
          void recover();
        }
      }
    },
    async checkOriginal(requestId: string) {
      const entry = activeFor(requestId);
      if (!entry || state.busy) return null;
      state.busy = true;
      state.error = "";
      state.notice = "Checking the exact saved project original…";
      const current = ++generation;
      emit();
      try {
        const identity = await deps.api.original(requestId);
        if (disposed || current !== generation) return null;
        if (!currentScopeMatches()) return null;
        if (
          identity.requestId !== requestId ||
          identity.requestHash !==
            (entry.identity?.requestHash ?? entry.local?.requestHash) ||
          !exactOriginal(identity.original, entry.original) ||
          workspaceKey(identity.original.workspaces[0]!.root) !== scope
        )
          throw Error("The protected original did not match.");
        await deps.identities.observe(identity);
        state.notice =
          identity.state === "reserved"
            ? "The same original remains reserved. No project was created."
            : identity.state === "created"
              ? "The exact project creation is recorded; verify its project before opening it."
              : "The exact original is retired. A new project requires a separate review.";
        return identity;
      } catch {
        state.notice =
          "The exact original could not be verified. It remains held; a missing record does not authorize a replacement.";
        return null;
      } finally {
        if (!disposed && current === generation) {
          state.busy = false;
          emit();
          void recover();
        }
      }
    },
    async commit(requestId: string): Promise<string | null> {
      const entry = activeFor(requestId);
      const identity = entry?.identity;
      if (
        !entry ||
        !identity ||
        identity.state !== "reserved" ||
        state.busy ||
        !deps.canWrite() ||
        !scopeAllowed(entry.original)
      )
        return null;
      state.busy = true;
      state.error = "";
      state.notice = "Checking the reviewed project scope before create…";
      const current = ++generation;
      emit();
      try {
        const uncertain = await deps.identities.update(
          identity.requestId,
          identity.requestHash,
          "unknown",
        );
        if (disposed || current !== generation) return null;
        replaceEntry({
          identity: null,
          local: uncertain,
          original: entry.original,
          phase: "unknown",
        });
        emit();
        const [options, catalog, smiths, preview] = await Promise.all([
          deps.api.options(),
          deps.api.catalog(),
          deps.api.smiths(),
          freshPreview(entry.original),
        ]);
        if (disposed || current !== generation) return null;
        if (
          !deps.canWrite() ||
          !currentScopeMatches() ||
          options.workspace.key !== scope ||
          workspaceKey(options.workspace.path) !== scope ||
          !choicesAllowed(entry.original, options, smiths) ||
          preview.scopeHash !== identity.scopeHash ||
          preview.scopeCount !== identity.scopeCount ||
          !smiths.smiths.some(
            (smith) =>
              smith.name === entry.original.keeperSmith && smith.enabled,
          )
        )
          throw Error(
            "The trusted project scope changed. Create was not sent.",
          );
        const result = await deps.api.commit(
          identity.requestId,
          identity.requestHash,
          preview.scopeHash,
        );
        if (disposed || current !== generation) return null;
        const expected =
          result.state === "confirmed"
            ? result.value
            : await deps.api.original(identity.requestId).catch(() => null);
        if (!expected || expected.requestHash !== identity.requestHash)
          throw Error("The create outcome is not verified.");
        const verified = await verifiedCreated(expected, current);
        if (!verified?.projectId)
          throw Error("The project receipt is not verified.");
        state.entries = state.entries.filter(
          (item) =>
            (item.identity?.requestId ?? item.local?.request.requestId) !==
            identity.requestId,
        );
        state.notice = "Project creation was read back from the hearth.";
        return verified.projectId;
      } catch {
        state.notice =
          "The create outcome could not be verified. Check this same original; no replacement is available.";
        return null;
      } finally {
        if (!disposed && current === generation) {
          state.busy = false;
          emit();
          void recover();
        }
      }
    },
    async retire(requestId: string): Promise<boolean> {
      const entry = activeFor(requestId);
      const identity = entry?.identity;
      if (
        !entry ||
        !identity ||
        identity.state !== "reserved" ||
        state.phase !== "ready" ||
        state.busy ||
        !deps.canWrite() ||
        !currentScopeMatches() ||
        workspaceKey(entry.original.workspaces[0]!.root) !== scope
      )
        return false;
      state.busy = true;
      state.error = "";
      state.notice = "Retiring only the reviewed reserved original…";
      const current = ++generation;
      try {
        const uncertain = await deps.identities.update(
          identity.requestId,
          identity.requestHash,
          "unknown",
        );
        if (
          disposed ||
          current !== generation ||
          !currentScopeMatches() ||
          !deps.canWrite()
        )
          return false;
        replaceEntry({
          identity: null,
          local: uncertain,
          original: entry.original,
          phase: "unknown",
        });
        emit();
        const result = await deps.api.retire(
          identity.requestId,
          identity.requestHash,
        );
        if (disposed || current !== generation || !currentScopeMatches())
          return false;
        const observed = await deps.api
          .original(identity.requestId)
          .catch(() => null);
        if (
          disposed ||
          current !== generation ||
          !currentScopeMatches() ||
          !observed ||
          observed.requestId !== identity.requestId ||
          observed.state !== "retired-before-create" ||
          observed.requestHash !== identity.requestHash ||
          !exactOriginal(observed.original, identity.original) ||
          (result.state === "confirmed" &&
            (result.value.requestId !== observed.requestId ||
              result.value.requestHash !== observed.requestHash ||
              result.value.state !== observed.state ||
              !exactOriginal(result.value.original, observed.original)))
        )
          throw Error("The retirement readback did not match.");
        await deps.identities.observe(observed);
        state.entries = state.entries.filter(
          (item) =>
            (item.identity?.requestId ?? item.local?.request.requestId) !==
            identity.requestId,
        );
        state.notice = "The saved original is retired. No project was created.";
        return true;
      } catch {
        state.notice =
          "Retirement could not be verified. The original remains held; no new project was created.";
        return false;
      } finally {
        if (!disposed && current === generation) {
          state.busy = false;
          emit();
          void recover();
        }
      }
    },
    dispose() {
      disposed = true;
      generation++;
      listeners.clear();
    },
  };
}
