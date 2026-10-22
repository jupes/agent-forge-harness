import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { ConnectionBanner, useDesktopRecovery } from "./ConnectionBanner";
import { DesktopFrame } from "./DesktopFrame";
import {
  desktopHref,
  desktopRoute,
  GLOBAL_DESTINATIONS,
  navigateGlobal,
  PROJECT_DESTINATIONS,
} from "./navigation";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectSessions, SessionInspector } from "./ProjectSessions";
import { ProjectsHome } from "./ProjectsHome";
import { sessionRows } from "./sessions-model";
import { useProjects } from "./use-projects";

/** Desktop routing stays separate from the ordinary dashboard's legacy URLs and snapshot mode. */
export function DesktopApp(): JSX.Element {
  const [route, setRoute] = useState(() => desktopRoute(window.location.hash));
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.matchMedia("(min-width: 1201px)").matches,
  );
  const recovery = useDesktopRecovery();
  const projects = useProjects();
  const project = projects.data?.catalog.projects.find(
    (item) => item.id === route.projectId,
  );
  const summary = projects.data?.summaries.find(
    (item) => item.projectId === project?.id,
  );
  const frameSessions = summary
    ? sessionRows(summary.sessions, {}, summary.asOf).map((row) => ({
        id: row.session.sessionId,
        title: row.session.beadId ?? row.session.sessionId,
        provider: row.session.executor?.provider ?? "Provider not reported",
        status: row.group,
        depth: row.depth,
      }))
    : [];
  const previousProject = useRef(route.projectId);
  useEffect(() => {
    if (previousProject.current !== route.projectId)
      document.getElementById("af-main")?.focus();
    previousProject.current = route.projectId;
  }, [route.projectId]);
  useEffect(() => {
    if (route.selection?.kind === "session") setInspectorOpen(true);
  }, [route.projectId, route.selection?.kind, route.selection?.id]);
  useEffect(() => {
    const changed = () => setRoute(desktopRoute(window.location.hash));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const compact = window.matchMedia("(max-width: 1200px)");
    const collapse = () => {
      if (compact.matches) {
        const focused = document.activeElement?.closest(
          ".af-desktop-inspector",
        );
        setInspectorOpen(false);
        if (focused)
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(
                'main button[aria-label="Show inspector"]',
              )
              ?.focus(),
          );
      }
    };
    compact.addEventListener("change", collapse);
    collapse();
    return () => compact.removeEventListener("change", collapse);
  }, []);
  const global = GLOBAL_DESTINATIONS.find(
    (entry) => entry.id === route.destination,
  );
  const name =
    global?.label ??
    PROJECT_DESTINATIONS.find((entry) => entry.id === route.destination)
      ?.label ??
    "Projects";
  return (
    <DesktopFrame
      route={route}
      project={
        project
          ? {
              id: project.id,
              name: project.name,
              sessions: frameSessions,
              sessionsComplete: summary?.sessionsComplete ?? false,
            }
          : null
      }
      connectionLabel={
        recovery?.busy
          ? "Restarting"
          : (recovery?.connection.label ?? "Connecting")
      }
      inspectorOpen={inspectorOpen}
      inspector={
        route.selection?.kind === "session" && project ? (
          <SessionInspector
            projectId={project.id}
            session={summary?.sessions.find(
              (session) => session.sessionId === route.selection?.id,
            )}
          />
        ) : undefined
      }
      onInspectorToggle={() => {
        setInspectorOpen(!inspectorOpen);
        if (inspectorOpen)
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(
                'main button[aria-label="Show inspector"]',
              )
              ?.focus(),
          );
      }}
    >
      <ConnectionBanner />
      {project?.archived && (
        <p role="status">
          This project is archived. Its saved scope remains available for
          inspection.
        </p>
      )}
      {projects.notice && (
        <div role="status" class="af-notice">
          {projects.notice}
          {projects.needsCheck && (
            <Button
              onClick={() => {
                void projects.check();
              }}
            >
              Check project preferences
            </Button>
          )}
        </div>
      )}
      {route.destination === "projects" ? (
        <ProjectsHome
          home={projects.data}
          error={projects.error}
          loading={projects.loading}
          stale={recovery?.connection.phase !== "connected"}
          held={projects.held}
          writesAllowed={recovery?.connection.writesAllowed ?? false}
          reload={projects.reload}
          change={projects.change}
        />
      ) : route.destination === "overview" && project ? (
        <ProjectOverview key={project.id} projectId={project.id} />
      ) : route.destination === "sessions" && project ? (
        <ProjectSessions
          key={project.id}
          projectId={project.id}
          selectedId={
            route.selection?.kind === "session" ? route.selection.id : null
          }
        />
      ) : global ? (
        <EmptyState
          title={`${name} unavailable`}
          hint={`${name} is not available in this build.`}
        />
      ) : (
        <EmptyState
          title={project ? `${name} unavailable` : "Project unavailable"}
          hint={
            project
              ? `${name} for ${project.name} is not available in this build.`
              : "This project could not be loaded. Choose a project to continue."
          }
        >
          <Button href={desktopHref(navigateGlobal(route, "projects"))}>
            Choose project
          </Button>
        </EmptyState>
      )}
    </DesktopFrame>
  );
}
