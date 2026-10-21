import type { ComponentChildren, JSX } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { Icon, type IconName } from "../../../docs/js/ds/Icon";
import { Tag } from "../../../docs/js/ds/Tag";
import {
  type DesktopRoute,
  desktopHref,
  GLOBAL_DESTINATIONS,
  navigateGlobal,
  navigateProject,
  PROJECT_DESTINATIONS,
} from "./navigation";
import "./frame.css";

const PROVIDERS = {
  claude: { name: "Claude", monogram: "Cl" },
  codex: { name: "Codex", monogram: "Cx" },
  gemini: { name: "Gemini", monogram: "Ge" },
  grok: { name: "Grok", monogram: "Gk" },
  openrouter: { name: "OpenRouter", monogram: "OR" },
  keeper: { name: "Forge Keeper", monogram: "FK" },
} as const;

export type FrameProvider = keyof typeof PROVIDERS;
export type FrameSessionStatus = "needs-you" | "running" | "idle" | "observed";
export interface FrameSession {
  id: string;
  title: string;
  provider: FrameProvider;
  status: FrameSessionStatus;
}
/** A future project producer supplies only rows it has actually scoped to this stable id. */
export interface FrameProject {
  id: string;
  name: string;
  sessions: readonly FrameSession[];
}

export function ProviderMonogram({
  provider,
}: {
  provider: FrameProvider;
}): JSX.Element {
  return (
    <span
      class={`af-desktop-monogram af-provider-${provider}`}
      role="img"
      aria-label={PROVIDERS[provider].name}
      title={PROVIDERS[provider].name}
    >
      {PROVIDERS[provider].monogram}
    </span>
  );
}

const GROUPS: readonly {
  status: FrameSessionStatus;
  label: string;
  icon: IconName;
}[] = [
  { status: "needs-you", label: "Needs you", icon: "warning-circle" },
  { status: "running", label: "Running", icon: "circle-half" },
  { status: "idle", label: "Idle", icon: "circle" },
  { status: "observed", label: "Observed", icon: "circle" },
];

export interface DesktopFrameProps {
  route: DesktopRoute;
  project: FrameProject | null;
  connectionLabel: string;
  inspectorOpen: boolean;
  onInspectorToggle(): void;
  children: ComponentChildren;
  inspector?: ComponentChildren;
}

/** One content outlet; changing destinations never owns or recreates the page stream. */
export function DesktopFrame({
  route,
  project: supplied,
  connectionLabel,
  inspectorOpen,
  onInspectorToggle,
  children,
  inspector,
}: DesktopFrameProps): JSX.Element {
  const project = supplied?.id === route.projectId ? supplied : null;
  const projectName =
    project?.name ??
    (route.projectId ? "Project unavailable" : "No project selected");
  const global = GLOBAL_DESTINATIONS.find(
    (entry) => entry.id === route.destination,
  );
  const title =
    global?.label ??
    PROJECT_DESTINATIONS.find((entry) => entry.id === route.destination)
      ?.label ??
    "Projects";
  return (
    <div class="af-desktop-frame" data-inspector-open={inspectorOpen}>
      <button
        class="af-skip-link"
        type="button"
        onClick={() => document.getElementById("af-main")?.focus()}
      >
        Skip to content
      </button>
      <header class="af-desktop-titlebar">
        <a
          class="af-desktop-brand"
          href={desktopHref(navigateGlobal(route, "projects"))}
        >
          <Icon name="hammer" />
          <span>Agent Forge</span>
        </a>
        <a
          class="af-desktop-project-name"
          href={desktopHref(navigateGlobal(route, "projects"))}
          title={projectName}
          aria-label={`Choose project: ${projectName}`}
        >
          <span>{projectName}</span>
          <Icon name="caret-down" size={13} />
        </a>
        <div class="af-desktop-title-actions">
          <Button
            variant="ghost"
            icon="magnifying-glass"
            disabled
            title="Search is not available yet"
          >
            Search unavailable
          </Button>
          <Tag tone="outline">Hearth {connectionLabel}</Tag>
          <a
            class="af-desktop-chip"
            href={desktopHref(navigateGlobal(route, "providers"))}
            title="Provider usage has not been reported"
            aria-label="Providers and usage: reporting unavailable"
          >
            <Icon name="gauge" />
            Usage —
          </a>
          <a
            class="af-desktop-chip"
            href={desktopHref(navigateGlobal(route, "inbox"))}
            title="Inbox; waiting count unavailable"
          >
            <Icon name="tray" />
            <span class="af-desktop-compact-label">Inbox</span>
          </a>
        </div>
      </header>
      <div class="af-desktop-layout">
        <nav class="af-desktop-rail" aria-label="Global">
          {GLOBAL_DESTINATIONS.map((entry) => (
            <a
              key={entry.id}
              class={`af-desktop-rail-link${route.destination === entry.id ? " is-current" : ""}`}
              href={desktopHref(navigateGlobal(route, entry.id))}
              aria-label={entry.label}
              title={entry.label}
              aria-current={route.destination === entry.id ? "page" : undefined}
            >
              <Icon name={entry.icon} size={20} />
            </a>
          ))}
        </nav>
        <aside class="af-desktop-sidebar" aria-label="Project">
          <p class="af-desktop-sidebar-heading" title={projectName}>
            {projectName}
          </p>
          <a
            class={`af-desktop-project-link${route.destination === "keeper" ? " is-current" : ""}`}
            href={
              route.projectId
                ? desktopHref(navigateProject(route, "keeper"))
                : undefined
            }
            aria-disabled={!route.projectId}
            aria-label="Forge Keeper"
            title={
              route.projectId
                ? "Forge Keeper"
                : "Choose a project to open Forge Keeper"
            }
            aria-current={route.destination === "keeper" ? "page" : undefined}
          >
            <ProviderMonogram provider="keeper" />
            <span class="af-desktop-sidebar-label">Forge Keeper</span>
          </a>
          <p class="af-desktop-sidebar-heading">Sessions</p>
          {project?.sessions.length ? (
            GROUPS.map((group) => {
              const rows = project.sessions.filter(
                (row) => row.status === group.status,
              );
              return rows.length ? (
                <div key={group.status}>
                  <p class="af-desktop-session-group">{group.label}</p>
                  {rows.map((row) => (
                    <a
                      key={row.id}
                      class="af-desktop-project-link"
                      href={desktopHref({
                        ...navigateProject(route, "sessions"),
                        selection: { kind: "session", id: row.id },
                      })}
                      title={`${row.title} · ${group.label}`}
                      aria-label={`${PROVIDERS[row.provider].name}: ${row.title}, ${group.label}`}
                    >
                      <ProviderMonogram provider={row.provider} />
                      <span class="af-desktop-sidebar-label">{row.title}</span>
                      <Icon name={group.icon} label={group.label} size={13} />
                    </a>
                  ))}
                </div>
              ) : null;
            })
          ) : (
            <p class="af-desktop-session-group">
              {project ? "No sessions" : "Sessions unavailable"}
            </p>
          )}
          <Button
            variant="ghost"
            icon="plus-circle"
            disabled
            title={
              project
                ? "Starting a session is not available yet"
                : "Choose a project before starting a session"
            }
            aria-label="New session unavailable"
          >
            <span class="af-desktop-sidebar-label">
              New session unavailable
            </span>
          </Button>
          <nav class="af-desktop-project-nav" aria-label="Project destinations">
            {PROJECT_DESTINATIONS.filter((entry) => entry.id !== "keeper").map(
              (entry) => (
                <a
                  key={entry.id}
                  class={`af-desktop-project-link${route.destination === entry.id ? " is-current" : ""}`}
                  href={
                    route.projectId
                      ? desktopHref(navigateProject(route, entry.id))
                      : undefined
                  }
                  aria-disabled={!route.projectId}
                  aria-label={
                    entry.id === "project-settings"
                      ? "Project settings"
                      : entry.label
                  }
                  title={
                    route.projectId
                      ? entry.label
                      : `Choose a project to open ${entry.label}`
                  }
                  aria-current={
                    route.destination === entry.id ? "page" : undefined
                  }
                >
                  <Icon name={entry.icon} />
                  <span class="af-desktop-sidebar-label">{entry.label}</span>
                </a>
              ),
            )}
          </nav>
        </aside>
        <main id="af-main" class="af-desktop-main" tabIndex={-1}>
          <header class="af-desktop-content-header">
            <div>
              <p class="af-desktop-breadcrumb">
                {global ? "Agent Forge" : projectName}
              </p>
              <h1>{title}</h1>
            </div>
            <Button
              variant="ghost"
              icon="file-text"
              onClick={onInspectorToggle}
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
            >
              {inspectorOpen ? "Hide inspector" : "Show inspector"}
            </Button>
          </header>
          <div class="af-desktop-content">{children}</div>
        </main>
        <aside
          class="af-desktop-inspector"
          aria-label="Inspector"
          hidden={!inspectorOpen}
          onKeyDown={(event) => {
            if (event.key === "Escape" && inspectorOpen) {
              event.preventDefault();
              onInspectorToggle();
            }
          }}
        >
          <header>
            <h2>Inspector</h2>
            <Button
              variant="ghost"
              icon="x"
              onClick={onInspectorToggle}
              aria-label="Close inspector"
            />
          </header>
          {inspector ??
            (route.selection ? (
              <EmptyState
                title="Details unavailable"
                hint={
                  <>
                    The requested {route.selection.kind} has not been loaded.
                    Return to its project to check its details.
                    <code>{route.selection.id}</code>
                  </>
                }
              />
            ) : (
              <EmptyState
                title="No selection"
                hint="Select a bead, session, run or event to see its details here."
              />
            ))}
        </aside>
      </div>
    </div>
  );
}
