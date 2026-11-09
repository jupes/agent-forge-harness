import type { JSX } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import type { ProjectBudgets } from "../../../scripts/projects/project-budgets-protocol";
import type { ProjectNotifications } from "../../../scripts/projects/project-notifications-protocol";
import type {
  ProjectRepositoryMember,
  ProjectWorktreeFact,
} from "../../../scripts/projects/project-repositories-protocol";
import { PROJECT_COLOR_IDS, type ProjectRecord } from "../../../types/projects";
import type { KeeperClient } from "./keeper-client";
import type { NotificationControl } from "./notification-delivery";
import { ProjectBudgetsSettings } from "./ProjectBudgetsSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { ProjectKeeperSettings } from "./ProjectKeeperSettings";
import { ProjectNotificationsSettings } from "./ProjectNotificationsSettings";
import { ProjectScopeSettings } from "./ProjectScopeSettings";
import type {
  GeneralCatalog,
  GeneralDraft,
  GeneralSettingsSnapshot,
  ProjectGeneralSettingsOwner,
} from "./project-general-settings-client";
import type { ProjectRepositoriesSnapshot } from "./project-repositories-client";
import type { useProjectDefaults } from "./use-project-defaults";
import type { useProjectKeeperSettings } from "./use-project-keeper-settings";
import type { useProjectValueSettings } from "./use-project-value-settings";
import type { useProjectWorktreeCleanup } from "./use-project-worktree-cleanup";
import type { SmithsController } from "./use-smiths";
import "./project-settings.css";

type CleanupReviewActions = Pick<
  ReturnType<typeof useProjectWorktreeCleanup>,
  "canReview" | "reviewCandidate"
>;

interface RepositoriesProps {
  projectId: string;
  state: ProjectRepositoriesSnapshot;
  onRefresh(): void;
  onReconcile(): void;
  cleanup?: CleanupReviewActions | undefined;
}

function repositoryAccessLabel(member: ProjectRepositoryMember): string {
  if (member.access === "served") return "Served checkout";
  if (member.access === "approved") return "Approved checkout";
  return "Unregistered repository path";
}

function cleanupWorktreeReview(
  projectId: string,
  member: ProjectRepositoryMember,
  worktree: ProjectWorktreeFact,
  cleanup: CleanupReviewActions | undefined,
) {
  const scope = {
    projectId,
    repository: member.path,
    worktreeId: worktree.id ?? "",
  };
  let unavailable = "";
  if (member.access !== "served")
    unavailable = "Cleanup review requires the served checkout.";
  else if (worktree.kind !== "trees")
    unavailable = "Only managed trees worktrees support cleanup review.";
  else if (worktree.missing)
    unavailable =
      "Cleanup review is unavailable for a reported missing worktree.";
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope.worktreeId))
    unavailable =
      "This legacy or incomplete row has no valid managed worktree ID.";
  else if (worktree.branch === null || worktree.createdAt === undefined)
    unavailable = "Cleanup review requires complete branch and creation facts.";
  else if (!cleanup?.canReview(scope))
    unavailable =
      "Cleanup review requires current repository facts and a verified connection to this exact repository.";
  return (
    <>
      <Button
        disabled={Boolean(unavailable)}
        onClick={() => {
          if (!unavailable && cleanup?.canReview(scope))
            void cleanup.reviewCandidate(scope);
        }}
      >
        Review cleanup
      </Button>
      {unavailable && <p role="status">{unavailable}</p>}
    </>
  );
}

export function RepositoriesAndWorktrees({
  projectId,
  state,
  onRefresh,
  onReconcile,
  cleanup,
}: RepositoriesProps): JSX.Element {
  return (
    <section
      class="af-project-repositories"
      aria-labelledby="af-project-repositories-title"
    >
      <header class="af-project-repositories-heading">
        <h3 id="af-project-repositories-title">Repositories and worktrees</h3>
        <p>
          Reported repository membership and worktree facts for project{" "}
          <code>{projectId}</code> at catalog revision{" "}
          {state.requestedRevision ?? "unavailable"}.
        </p>
      </header>
      {state.phase !== "ready" && (
        <p role="status">Cleanup review waits for current repository facts.</p>
      )}
      {state.phase === "idle" && (
        <p role="status">
          Select a current project to inspect its repositories.
        </p>
      )}
      {state.phase === "loading" && (
        <p role="status">Loading repositories and worktrees…</p>
      )}
      {state.phase === "reconciling-catalog" && (
        <p role="status">
          Refreshing the project catalog before loading repository details…
        </p>
      )}
      {state.phase === "error" && (
        <div>
          <p role="alert">
            Repository details could not be loaded: {state.error}
          </p>
          <Button onClick={onRefresh}>Retry repository refresh</Button>
        </div>
      )}
      {state.phase === "catalog-mismatch" && (
        <div>
          {state.responseRevision !== null && (
            <p role="alert">
              The repository response is at catalog revision{" "}
              {state.responseRevision}; the selected project view is at revision{" "}
              {state.requestedRevision}.
            </p>
          )}
          {state.error && <p role="alert">{state.error}</p>}
          <Button onClick={onReconcile}>Refresh project catalog</Button>
        </div>
      )}
      {state.phase === "ready" && state.data && (
        <>
          <p class="af-project-repositories-provenance" role="status">
            Repository facts read for project {state.data.projectId} at catalog
            revision {state.data.catalogRevision}.
          </p>
          {state.data.repositories.length === 0 ? (
            <p role="status">No workspaces are reported for this project.</p>
          ) : (
            <div class="af-project-repositories-workspaces">
              {state.data.repositories.map((workspace, workspaceIndex) => (
                <section
                  class="af-project-repositories-workspace"
                  key={workspace.workspaceRoot + ":" + workspaceIndex}
                  aria-label={"Workspace " + workspace.workspaceRoot}
                >
                  <h4>Workspace</h4>
                  <p>
                    Root: <code>{workspace.workspaceRoot}</code>
                  </p>
                  {workspace.repositories.length === 0 ? (
                    <p role="status">
                      No repository paths are reported for this workspace.
                    </p>
                  ) : (
                    <ul class="af-project-repositories-members">
                      {workspace.repositories.map((member) => (
                        <li
                          class="af-project-repositories-member"
                          key={member.path + ":" + member.access}
                        >
                          <h5>
                            {member.access === "unregistered"
                              ? "Unregistered repository path"
                              : member.name}
                          </h5>
                          <p>{repositoryAccessLabel(member)}</p>
                          <p>
                            Path: <code>{member.path}</code>
                          </p>
                          {member.access === "unregistered" ? (
                            <p role="status">
                              No worktree facts are reported for this path.
                              Cleanup review is unavailable for unregistered
                              repository paths.
                            </p>
                          ) : member.worktrees.length === 0 ? (
                            <p role="status">
                              No worktrees are reported for this repository.
                            </p>
                          ) : (
                            <ul class="af-project-repositories-worktrees">
                              {member.worktrees.map((worktree) => (
                                <li
                                  key={
                                    worktree.path +
                                    ":" +
                                    (worktree.id ?? worktree.kind)
                                  }
                                >
                                  <dl>
                                    <div>
                                      <dt>Worktree path</dt>
                                      <dd>
                                        <code>{worktree.path}</code>
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>Kind</dt>
                                      <dd>{worktree.kind}</dd>
                                    </div>
                                    <div>
                                      <dt>Reported status</dt>
                                      <dd>
                                        {worktree.missing
                                          ? "Reported missing"
                                          : "Reported present"}
                                      </dd>
                                    </div>
                                    {worktree.branch !== null && (
                                      <div>
                                        <dt>Branch</dt>
                                        <dd>
                                          <code>{worktree.branch}</code>
                                        </dd>
                                      </div>
                                    )}
                                    {worktree.id !== undefined && (
                                      <div>
                                        <dt>Worktree id</dt>
                                        <dd>
                                          <code>{worktree.id}</code>
                                        </dd>
                                      </div>
                                    )}
                                    {worktree.createdAt !== undefined && (
                                      <div>
                                        <dt>Reported creation time</dt>
                                        <dd>
                                          <time dateTime={worktree.createdAt}>
                                            {worktree.createdAt}
                                          </time>
                                        </dd>
                                      </div>
                                    )}
                                  </dl>
                                  {cleanupWorktreeReview(
                                    projectId,
                                    member,
                                    worktree,
                                    cleanup,
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
          <Button onClick={onRefresh}>Refresh repository facts</Button>
        </>
      )}
    </section>
  );
}
interface Props {
  projectId: string | null;
  project: ProjectRecord | null;
  catalog: GeneralCatalog | null;
  initialRevision: number | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  writesAllowed: boolean;
  owner: ProjectGeneralSettingsOwner;
  state: GeneralSettingsSnapshot;
  keeperSettings: ReturnType<typeof useProjectKeeperSettings>;
  keeper?: KeeperClient | undefined;
  defaultsSettings: ReturnType<typeof useProjectDefaults>;
  budgetsSettings: ReturnType<typeof useProjectValueSettings<ProjectBudgets>>;
  notificationDelivery?: NotificationControl | undefined;
  notificationsSettings: ReturnType<
    typeof useProjectValueSettings<ProjectNotifications>
  >;
  smiths: SmithsController;
  onRefresh(): void;
  repositories: ProjectRepositoriesSnapshot;
  onRefreshRepositories(): void;
  onReconcileRepositories(): void;
  cleanup?: CleanupReviewActions | undefined;
}

export function ProjectSettings({
  projectId,
  project,
  catalog,
  initialRevision,
  loading,
  error,
  stale,
  writesAllowed,
  owner,
  state,
  onRefresh,
  keeperSettings,
  keeper,
  defaultsSettings,
  budgetsSettings,
  notificationsSettings,
  notificationDelivery,
  smiths,
  repositories,
  onRefreshRepositories,
  onReconcileRepositories,
  cleanup,
}: Props): JSX.Element {
  const refreshCurrent = () => {
    if (projectId) void owner.review(projectId).finally(onRefresh);
    else onRefresh();
  };
  if (!project && !catalog && loading)
    return <p role="status">Loading project settings…</p>;
  if (error && !project)
    return (
      <section
        class="af-project-settings"
        aria-labelledby="project-settings-title"
      >
        <h2 id="project-settings-title">Project settings</h2>
        <p role="alert">{error}</p>
        {projectId && state.notices[projectId] && (
          <p role="status">{state.notices[projectId]}</p>
        )}
        <Button
          onClick={refreshCurrent}
          disabled={Boolean(state.sendingProjectId || state.checkingProjectId)}
        >
          Refresh current settings
        </Button>
      </section>
    );
  if (!project)
    return (
      <section
        class="af-project-settings"
        aria-labelledby="project-settings-title"
      >
        <h2 id="project-settings-title">Project settings</h2>
        <p role="status">This project is not in the current catalog.</p>
        {projectId && state.notices[projectId] && (
          <p role="status">{state.notices[projectId]}</p>
        )}
        <Button
          onClick={refreshCurrent}
          disabled={Boolean(state.sendingProjectId || state.checkingProjectId)}
        >
          Refresh current settings
        </Button>
      </section>
    );

  const currentCatalog = catalog;
  const current =
    currentCatalog?.project.id === project.id ? currentCatalog.project : null;
  if (!current || !currentCatalog)
    return (
      <section
        class="af-project-settings"
        aria-labelledby="project-settings-title"
      >
        <h2 id="project-settings-title">Project settings</h2>
        {state.projectionErrors[project.id] ? (
          <p role="alert">
            The General settings projection was rejected:{" "}
            {state.projectionErrors[project.id]}
          </p>
        ) : (
          <p role="status">
            Loading the validated General settings projection.
          </p>
        )}
        {(state.priorNotices[project.id] ?? []).map((prior, index) => (
          <p role="status" key={`${project.id}:${index}`}>
            {prior}
          </p>
        ))}
        {state.notices[project.id] && (
          <p role="status">{state.notices[project.id]}</p>
        )}
        <Button
          onClick={() => void owner.review(project.id)}
          disabled={Boolean(state.sendingProjectId || state.checkingProjectId)}
        >
          Refresh current settings
        </Button>
      </section>
    );
  const original = current.general;
  const draft: GeneralDraft = owner.draft(project.id, original);
  const message = state.notices[project.id] ?? "";
  const currentUnresolved = state.unresolved.filter(
    (intent) => intent.projectId === project.id,
  );
  const otherProjectId =
    state.unresolved.find((intent) => intent.projectId !== project.id)
      ?.projectId ??
    (state.sendingProjectId && state.sendingProjectId !== project.id
      ? state.sendingProjectId
      : null);
  const needsReview =
    state.reviewedProjectId !== project.id &&
    (state.reviewRequired[project.id] === true || currentUnresolved.length > 0);
  const busy = Boolean(state.sendingProjectId || state.checkingProjectId);
  const editable =
    writesAllowed && !project.archived && !otherProjectId && !busy;
  const set = (patch: Partial<GeneralDraft>) =>
    owner.setDraft(project.id, { ...draft, ...patch });

  return (
    <section
      class="af-project-settings"
      aria-labelledby="project-settings-title"
    >
      <header class="af-project-settings-heading">
        <div>
          <h2 id="project-settings-title">Project settings</h2>
          <p>General details for {current.general.name}.</p>
        </div>
      </header>
      <section aria-labelledby="project-general-heading">
        <h3 id="project-general-heading">General</h3>
        <p class="af-project-settings-provenance">
          Source:{" "}
          {currentCatalog.freshRead
            ? "current hearth project catalog read"
            : "last-known hearth project catalog"}{" "}
          · revision{" "}
          {currentCatalog.revision ?? initialRevision ?? "unavailable"} · record
          updated <time dateTime={current.updatedAt}>{current.updatedAt}</time>
        </p>
        {state.projectionErrors[project.id] && (
          <p role="alert">
            The latest project summary could not be projected:{" "}
            {state.projectionErrors[project.id]}. These values are last-known;
            refresh the General catalog before saving.
          </p>
        )}
        <Button
          onClick={() => void owner.review(project.id, currentCatalog.revision)}
          disabled={busy}
        >
          Refresh current settings
        </Button>
        <dl
          class="af-project-settings-current"
          aria-label="Current catalog values"
        >
          <div>
            <dt>Name</dt>
            <dd>{current.general.name}</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>{current.general.description || "No description"}</dd>
          </div>
          <div>
            <dt>Icon</dt>
            <dd>{current.general.icon}</dd>
          </div>
          <div>
            <dt>Color</dt>
            <dd>{current.general.color ?? "No color"}</dd>
          </div>
        </dl>
        {project.archived && (
          <p role="status">
            This archived project is available for inspection; editing is
            disabled.
          </p>
        )}
        {!writesAllowed && !project.archived && (
          <p role="status">
            Reconnect to the hearth before changing project settings.
          </p>
        )}
        {stale && project && (
          <p role="status">
            Showing last-known catalog values. Refresh and compare before making
            changes.
          </p>
        )}
        {otherProjectId && (
          <p role="status">
            A General update for project {otherProjectId} is in progress or
            unresolved. Return to that project to check or review it before
            editing another project.
          </p>
        )}
        {(state.priorNotices[project.id] ?? []).map((prior, index) => (
          <p
            class="af-project-settings-notice"
            role="status"
            key={`${project.id}:${index}`}
          >
            {prior}
          </p>
        ))}
        {message && (
          <p
            class="af-project-settings-notice"
            role="status"
            aria-live="polite"
          >
            {message}
          </p>
        )}
        {needsReview && editable && (
          <div class="af-project-settings-review">
            <p>
              Compare the current catalog values above with your draft below. A
              check reads the catalog only; it does not resend an earlier
              request.
            </p>
            {state.checkedProjectId === project.id ? (
              <Button
                onClick={() => owner.confirmReview(project.id)}
                disabled={busy}
              >
                I reviewed the current values
              </Button>
            ) : (
              <Button
                onClick={() =>
                  void owner.review(project.id, currentCatalog.revision)
                }
                disabled={busy}
              >
                {currentUnresolved.length
                  ? "Check current settings"
                  : "Refresh current settings"}
              </Button>
            )}
          </div>
        )}
        <form
          class="af-project-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void owner.save(
              project.id,
              currentCatalog.revision,
              original,
              draft,
            );
          }}
        >
          <label>
            Project name
            <input
              aria-label="Project name"
              maxLength={120}
              required
              value={draft.name}
              disabled={!editable}
              onInput={(event) => set({ name: event.currentTarget.value })}
            />
          </label>
          <label>
            Project description
            <textarea
              aria-label="Project description"
              maxLength={500}
              value={draft.description}
              disabled={!editable}
              onInput={(event) =>
                set({ description: event.currentTarget.value })
              }
            />
          </label>
          <label>
            Project icon
            <input
              aria-label="Project icon"
              maxLength={16}
              required
              value={draft.icon}
              disabled={!editable}
              onInput={(event) => set({ icon: event.currentTarget.value })}
            />
          </label>
          <label>
            Project color
            <select
              aria-label="Project color"
              value={draft.color ?? ""}
              disabled={!editable}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "") set({ color: undefined });
                else {
                  const color = PROJECT_COLOR_IDS.find(
                    (item) => item === value,
                  );
                  if (color) set({ color });
                }
              }}
            >
              <option value="">No color</option>
              {PROJECT_COLOR_IDS.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </label>
          <button
            class="af-btn af-btn-primary"
            type="submit"
            disabled={!editable || needsReview}
          >
            {state.sendingProjectId === project.id
              ? "Saving…"
              : "Save General settings"}
          </button>
        </form>
      </section>
      <ProjectKeeperSettings
        projectId={project.id}
        archived={project.archived}
        writesAllowed={writesAllowed}
        settings={keeperSettings}
        keeper={keeper}
        smiths={smiths}
      />
      <ProjectDefaultsSettings
        projectId={project.id}
        archived={project.archived}
        writesAllowed={writesAllowed}
        settings={defaultsSettings}
        smiths={smiths}
      />
      <ProjectScopeSettings
        key={project.id}
        projectId={project.id}
        revision={initialRevision}
        writesAllowed={writesAllowed}
        archived={project.archived}
        onRefresh={onRefresh}
      />
      <RepositoriesAndWorktrees
        projectId={project.id}
        state={repositories}
        onRefresh={() => void onRefreshRepositories()}
        onReconcile={() => void onReconcileRepositories()}
        cleanup={cleanup}
      />
      <ProjectNotificationsSettings
        projectId={project.id}
        archived={project.archived}
        writesAllowed={writesAllowed}
        settings={notificationsSettings}
        delivery={notificationDelivery}
      />
      <ProjectBudgetsSettings
        projectId={project.id}
        archived={project.archived}
        writesAllowed={writesAllowed}
        settings={budgetsSettings}
      />
    </section>
  );
}
