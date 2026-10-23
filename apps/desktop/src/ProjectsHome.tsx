import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import type { ProjectsHome as Home } from "../../../types/project-summary";
import type { ProjectPreferences } from "../../../types/projects";
import { type FrameProvider, ProviderMonogram } from "./DesktopFrame";
import { desktopHref } from "./navigation";
import { openProject, projectCards } from "./projects-model";
import "./projects.css";
import { ProjectKeeperLine } from "./KeeperBrief";
import type { KeeperClient } from "./keeper-client";

export interface ProjectsHomeProps {
  home: Home | null;
  error: string | null;
  loading: boolean;
  stale: boolean;
  held: boolean;
  writesAllowed: boolean;
  keeper?: KeeperClient;
  reload(): void;
  change(id: string, patch: ProjectPreferences): Promise<void>;
}

export function ProjectsHome(props: ProjectsHomeProps): JSX.Element {
  const [filter, setFilter] = useState<"active" | "archived" | "all">("active");
  const [search, setSearch] = useState("");
  return (
    <ProjectsHomeView
      {...props}
      filter={filter}
      search={search}
      onFilter={setFilter}
      onSearch={setSearch}
    />
  );
}

export function ProjectsHomeView({
  home,
  error,
  loading,
  stale,
  held,
  writesAllowed,
  keeper,
  reload,
  change,
  filter,
  search,
  onFilter,
  onSearch,
}: ProjectsHomeProps & {
  filter: "active" | "archived" | "all";
  search: string;
  onFilter(value: "active" | "archived" | "all"): void;
  onSearch(value: string): void;
}): JSX.Element {
  if (!home)
    return (
      <EmptyState
        title={error ? "Projects could not be loaded" : "Loading projects…"}
        hint={error ?? "Reading the hearth's project catalog."}
      >
        <Button onClick={reload} disabled={loading}>
          Refresh projects
        </Button>
      </EmptyState>
    );
  const cards = projectCards(home, filter, search);
  const needs = cards.flatMap(({ project, summary }) =>
    (summary?.needsYou ?? []).map((item) => ({ ...item, project })),
  );
  const partial = cards.some(({ summary }) => !summary?.complete);
  return (
    <div class="af-projects-home" data-last-known={stale || Boolean(error)}>
      <div class="af-projects-toolbar">
        <label>
          Find projects
          <input
            type="search"
            value={search}
            onInput={(event) => onSearch(event.currentTarget.value)}
          />
        </label>
        <label>
          Show
          <select
            id="af-projects-filter"
            value={filter}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "active" || value === "archived" || value === "all")
                onFilter(value);
            }}
          >
            <option value="active">Active projects</option>
            <option value="archived">Archived projects</option>
            <option value="all">All projects</option>
          </select>
        </label>
        <Button onClick={reload}>Refresh projects</Button>
      </div>
      <p class="af-projects-muted">
        Pinned first, then needs you, then last activity.{" "}
        {stale || error ? "Last-known data" : "Read from the hearth"} ·{" "}
        <time dateTime={home.asOf}>{new Date(home.asOf).toLocaleString()}</time>
      </p>
      {error && (
        <p role="status">
          Refresh failed: {error}. Showing the last-known projects.
        </p>
      )}
      <section aria-label="Needs you" class="af-projects-needs">
        {needs.length ? (
          needs.map((item) => (
            <a
              key={`${item.project.id}-${item.beadId}-${item.state}`}
              href={desktopHref({
                destination: "workbench",
                projectId: item.project.id,
                selection: { kind: "bead", id: item.beadId },
              })}
            >
              <strong>
                {item.state} · {item.beadId}
              </strong>
              <span>
                {item.project.name} · {item.title}
              </span>
            </a>
          ))
        ) : (
          <p>
            {partial
              ? "Needs-you items unavailable for some projects."
              : "No queue items need you."}{" "}
            Permission requests and run checkpoints are not yet reported here.
          </p>
        )}
      </section>
      {!home.catalog.projects.length ? (
        <EmptyState
          title="Welcome to Agent Forge"
          hint="Your projects will appear here. Project creation is not available in this build."
        />
      ) : cards.length === 0 ? (
        <EmptyState
          title="No matching projects"
          hint="Try another search or show archived projects."
        />
      ) : null}
      <section class="af-projects-grid" aria-label="Project cards">
        {cards.map(({ project, summary }) => (
          <article
            key={project.id}
            class="af-project-card"
            aria-labelledby={`project-${project.id}`}
          >
            <header>
              <span class="af-project-tile" aria-hidden="true">
                {project.icon}
              </span>
              <div>
                <h2 id={`project-${project.id}`}>
                  <a href={openProject(project.id)}>{project.name}</a>
                </h2>
                <p>{project.description}</p>
                <small>
                  {
                    new Set(
                      project.workspaces.flatMap((item) => item.repositories),
                    ).size
                  }{" "}
                  repositories{project.pinned ? " · Pinned" : ""}
                  {project.archived ? " · Archived" : ""}
                </small>
              </div>
            </header>
            <p>
              Sessions observed: {summary?.sessions.length ?? "—"}
              {summary?.sessionsComplete ? "" : " · partial or unavailable"}.
              Running status — not reported.
            </p>
            <div class="af-project-providers">
              {[
                ...new Set(
                  (summary?.sessions ?? []).map(
                    (session) =>
                      session.executor?.provider ?? "Unknown provider",
                  ),
                ),
              ].map((provider) => (
                <span key={provider}>
                  {isFrameProvider(provider) ? (
                    <ProviderMonogram provider={provider} />
                  ) : (
                    provider
                  )}{" "}
                  {
                    summary?.sessions.filter(
                      (session) =>
                        (session.executor?.provider ?? "Unknown provider") ===
                        provider,
                    ).length
                  }{" "}
                  observed
                </span>
              ))}
            </div>
            <div class="af-project-queue">
              {(["proposed", "running", "review", "halted"] as const).map(
                (state) => (
                  <span key={state} data-state={state}>
                    {state[0]?.toUpperCase()}
                    {state.slice(1)}{" "}
                    <strong>{summary?.queue?.[state] ?? "—"}</strong>
                  </span>
                ),
              )}
            </div>
            {(summary?.runs ?? [])
              .filter((run) => !run.complete)
              .map((run) => (
                <div class="af-project-run" key={run.slug}>
                  <a
                    href={desktopHref({
                      destination: "runs",
                      projectId: project.id,
                      selection: { kind: "run", id: run.slug },
                    })}
                  >
                    {run.slug}
                  </a>
                  <p>
                    {["research", "plan", "implement", "ship"].map((phase) => (
                      <span
                        key={phase}
                        aria-current={run.phase === phase ? "step" : undefined}
                      >
                        {phase}
                        {run.completed.includes(phase as typeof run.phase)
                          ? " ✓"
                          : run.phase === phase
                            ? " · current"
                            : ""}{" "}
                      </span>
                    ))}
                  </p>
                  {run.halted && <p>Halted: {run.halted.reason}</p>}
                </div>
              ))}
            <p class="af-projects-muted">
              Run observations from this checkout only; other worktrees are not
              reported.
            </p>
            {keeper ? (
              <ProjectKeeperLine projectId={project.id} client={keeper} />
            ) : (
              <p class="af-project-keeper">
                Keeper — no project brief available.
              </p>
            )}
            <p class="af-projects-muted">
              Last activity{" "}
              {summary?.lastActivity ? (
                <time dateTime={summary.lastActivity}>
                  {new Date(summary.lastActivity).toLocaleString()}
                </time>
              ) : (
                "— not reported"
              )}
              <br />
              Spend today — not reported · Unread — not reported
            </p>
            {summary?.problems.map((problem) => (
              <p key={problem} class="af-projects-problem">
                {problem}
              </p>
            ))}
            <footer>
              <Button href={openProject(project.id)}>
                Open {project.name}
              </Button>
              <Button href={openProject(project.id, "keeper")}>
                Ask the Keeper
              </Button>
              <Button href={openProject(project.id, "project-settings")}>
                Settings
              </Button>
              <Button
                disabled
                title="Session creation is not available in this build"
              >
                New session
              </Button>
              <Button
                onClick={() => {
                  void change(project.id, { pinned: !project.pinned });
                }}
                disabled={!writesAllowed || held}
              >
                {project.pinned ? "Unpin" : "Pin"} {project.name}
              </Button>
              <Button
                onClick={() => {
                  void change(project.id, { archived: !project.archived }).then(
                    () =>
                      document
                        .querySelector<HTMLSelectElement>("#af-projects-filter")
                        ?.focus(),
                  );
                }}
                disabled={!writesAllowed || held}
              >
                {project.archived ? "Unarchive" : "Archive"} {project.name}
              </Button>
            </footer>
          </article>
        ))}
        <div class="af-project-new">
          <Button
            disabled
            title="Project creation is not available in this build"
          >
            New project
          </Button>
        </div>
      </section>
      <section aria-label="Subscriptions" class="af-projects-subscriptions">
        {["Claude", "Codex", "Gemini", "Grok", "OpenRouter"].map((provider) => (
          <p key={provider}>
            <strong>{provider}</strong>
            <br />
            Usage — not reported
          </p>
        ))}
      </section>
    </div>
  );
}

function isFrameProvider(value: string): value is FrameProvider {
  return ["claude", "codex", "gemini", "grok", "openrouter", "keeper"].includes(
    value,
  );
}
