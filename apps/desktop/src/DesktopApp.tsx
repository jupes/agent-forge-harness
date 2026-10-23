import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { ConnectionBanner, useDesktopRecovery } from "./ConnectionBanner";
import type { FrameSession } from "./DesktopFrame";
import { DesktopFrame } from "./DesktopFrame";
import { KeeperConversation, KeeperScope } from "./KeeperConversation";
import {
  desktopHref,
  desktopRoute,
  GLOBAL_DESTINATIONS,
  navigateGlobal,
  PROJECT_DESTINATIONS,
} from "./navigation";
import { OwnedSessions } from "./OwnedSessions";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectSessions, SessionInspector } from "./ProjectSessions";
import { ProjectsHome } from "./ProjectsHome";
import { SessionComposer } from "./SessionComposer";
import { SessionConversation } from "./SessionConversation";
import { sessionRows } from "./sessions-model";
import { useKeeper } from "./use-keeper";
import { useKeeperProposals } from "./use-keeper-proposals";
import { useProjects } from "./use-projects";
import { useSessions } from "./use-sessions";

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
  const writesAllowed = recovery?.connection.writesAllowed ?? false;
  const selectedOwnedSession =
    route.destination === "sessions" &&
    route.selection?.kind === "session" &&
    /^session-[0-9a-f-]{36}$/.test(route.selection.id)
      ? route.selection.id
      : null;
  const sessions = useSessions(
    project?.id ?? null,
    selectedOwnedSession,
    writesAllowed,
  );
  const [composerOpen, setComposerOpen] = useState(false);
  const composerOpener = useRef<HTMLElement>(null);
  const openSession = (beadId?: string) => {
    if (!project || project.archived) return;
    composerOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (beadId) sessions.editComposer(project.id, { beadId });
    setComposerOpen(true);
  };
  const keeper = useKeeper(project?.id ?? null, writesAllowed);
  const proposals = useKeeperProposals(
    project?.id ?? null,
    writesAllowed,
    keeper,
  );
  const [keeperOpen, setKeeperOpen] = useState(false);
  const keeperOpener = useRef<HTMLElement>(null);
  const openKeeper = () => {
    if (!project) return;
    keeperOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (route.selection) void keeper.attach(project.id, route.selection);
    setKeeperOpen(true);
  };
  // A selection may commit before effects replace an event listener. Keep the
  // listener stable and read the current render's context for every shortcut.
  const keeperShortcut = useRef<(() => void) | null>(null);
  keeperShortcut.current = project && !keeperOpen ? openKeeper : null;
  const frameSessions: FrameSession[] = summary
    ? sessionRows(summary.sessions, {}, summary.asOf).map((row) => ({
        id: row.session.sessionId,
        title: row.session.beadId ?? row.session.sessionId,
        provider: row.session.executor?.provider ?? "Provider not reported",
        status: row.group,
        depth: row.depth,
      }))
    : [];
  if (project)
    for (const record of sessions.project(project.id).records)
      if (!frameSessions.some((item) => item.id === record.id))
        frameSessions.push({
          id: record.id,
          title: `${record.mode === "chat" ? "Chat" : "Task"} · ${record.beadId ?? record.requestedModel}`,
          provider: record.provider,
          status: "unverified",
        });
  const previousProject = useRef(route.projectId);
  useEffect(() => {
    if (previousProject.current !== route.projectId)
      document.getElementById("af-main")?.focus();
    if (previousProject.current !== route.projectId) setKeeperOpen(false);
    if (previousProject.current !== route.projectId) setComposerOpen(false);
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
    const shortcut = (event: KeyboardEvent) => {
      if (
        !keeperShortcut.current ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "j"
      )
        return;
      // Respect any other modal already using the browser's top layer.
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      keeperShortcut.current();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
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
    <>
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
              onAskKeeper={openKeeper}
            />
          ) : route.destination === "keeper" && project ? (
            <KeeperScope project={project} page={keeper.get(project.id).page} />
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
        onNewSession={
          project && !project.archived ? () => openSession() : undefined
        }
      >
        <ConnectionBanner />
        {project && route.selection?.kind === "bead" && (
          <Button
            disabled={!writesAllowed || project.archived}
            onClick={() => openSession(route.selection?.id)}
          >
            Start session for bead {route.selection.id}
          </Button>
        )}
        {project && route.destination !== "keeper" && (
          <div class="af-keeper-launcher">
            <button
              type="button"
              class="af-btn af-btn-secondary"
              onClick={openKeeper}
              aria-haspopup="dialog"
              aria-keyshortcuts="Control+j Meta+j"
            >
              Ask Keeper
            </button>
          </div>
        )}
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
            keeper={keeper}
            home={projects.data}
            error={projects.error}
            loading={projects.loading}
            stale={recovery?.connection.phase !== "connected"}
            held={projects.held}
            writesAllowed={recovery?.connection.writesAllowed ?? false}
            reload={projects.reload}
            change={projects.change}
          />
        ) : route.destination === "keeper" && project ? (
          <KeeperConversation
            key={project.id}
            project={project}
            client={keeper}
            proposals={proposals}
            writesAllowed={writesAllowed}
            onScope={() => setInspectorOpen(true)}
            active={!keeperOpen}
          />
        ) : route.destination === "overview" && project ? (
          <ProjectOverview
            key={project.id}
            projectId={project.id}
            keeper={keeper}
          />
        ) : route.destination === "sessions" &&
          project &&
          selectedOwnedSession ? (
          <SessionConversation
            key={`${project.id}:${selectedOwnedSession}`}
            projectId={project.id}
            sessionId={selectedOwnedSession}
            client={sessions}
            writesAllowed={writesAllowed}
          />
        ) : route.destination === "sessions" && project ? (
          <>
            <OwnedSessions
              projectId={project.id}
              client={sessions}
              onNew={() => openSession()}
            />
            <ProjectSessions
              keeper={keeper}
              writesAllowed={writesAllowed}
              key={project.id}
              projectId={project.id}
              selectedId={
                route.selection?.kind === "session" ? route.selection.id : null
              }
            />
          </>
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
      <Dialog
        open={composerOpen && Boolean(project)}
        title={`New session · ${project?.name ?? ""}`}
        titleId="af-session-composer-title"
        onClose={() => setComposerOpen(false)}
        returnFocusRef={composerOpener}
        class="af-session-dialog"
        initialFocus="content"
      >
        {project && composerOpen && (
          <SessionComposer
            key={project.id}
            project={project}
            client={sessions}
            keeper={keeper}
            writesAllowed={writesAllowed}
            onCancel={() => setComposerOpen(false)}
            onStarted={(id) => {
              setComposerOpen(false);
              window.location.hash = desktopHref({
                projectId: project.id,
                destination: "sessions",
                selection: { kind: "session", id },
              }).slice(1);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={keeperOpen && Boolean(project)}
        title={`Forge Keeper · ${project?.name ?? ""}`}
        titleId="af-keeper-drawer-title"
        onClose={() => setKeeperOpen(false)}
        returnFocusRef={keeperOpener}
        class="af-keeper-drawer"
        initialFocus="content"
      >
        {project && (
          <>
            <div class="af-keeper-drawer-link">
              <a
                href={desktopHref({
                  destination: "keeper",
                  projectId: project.id,
                  selection: null,
                })}
                onClick={() => setKeeperOpen(false)}
              >
                Open full conversation
              </a>
            </div>
            <KeeperConversation
              key={project.id}
              project={project}
              client={keeper}
              proposals={proposals}
              writesAllowed={writesAllowed}
              compact
              active={keeperOpen}
              onNavigate={() => setKeeperOpen(false)}
            />
          </>
        )}
      </Dialog>
    </>
  );
}
