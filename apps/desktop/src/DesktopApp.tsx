import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { BeadWriteNotices, NewBeadForm } from "./BeadWrites";
import { ConnectionBanner, useDesktopRecovery } from "./ConnectionBanner";
import type { FrameSession } from "./DesktopFrame";
import { DesktopFrame } from "./DesktopFrame";
import { KeeperConversation, KeeperScope } from "./KeeperConversation";
import {
  desktopHref,
  desktopRoute,
  GLOBAL_DESTINATIONS,
  navigateGlobal,
  observeDesktopRoute,
  PROJECT_DESTINATIONS,
} from "./navigation";
import { ObservedSessionDetail } from "./ObservedSessionDetail";
import { OwnedSessions } from "./OwnedSessions";
import {
  ProjectActivityFeed,
  ProjectActivityInspector,
} from "./ProjectActivity";
import { BeadPanel, beadHref, ProjectBeads } from "./ProjectBeads";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectSessions, SessionInspector } from "./ProjectSessions";
import { ProjectShifts } from "./ProjectShifts";
import { ProjectsHome } from "./ProjectsHome";
import { ProjectWorkbench } from "./ProjectWorkbench";
import { Providers } from "./Providers";
import {
  activityHref,
  emptyActivityFilters,
  parseActivityFilters,
} from "./project-activity-model";
import { SessionComposer } from "./SessionComposer";
import { SessionConversation } from "./SessionConversation";
import { Smiths } from "./Smiths";
import { useBeadWrites } from "./use-bead-writes";
import { useBeads } from "./use-beads";
import { useKeeper } from "./use-keeper";
import { useKeeperProposals } from "./use-keeper-proposals";
import { useProjectActivity } from "./use-project-activity";
import { useProjectShifts } from "./use-project-shifts";
import { useProjects } from "./use-projects";
import { useProviders } from "./use-providers";
import { useSessionLibrary } from "./use-session-library";
import { useSessionObservations } from "./use-session-observations";
import { useSessions } from "./use-sessions";
import { useSmiths } from "./use-smiths";
import { useWorkbench } from "./use-workbench";

/** Desktop routing stays separate from the ordinary dashboard's legacy URLs and snapshot mode. */
export function DesktopApp(): JSX.Element {
  const [route, setRoute] = useState(() => desktopRoute(window.location.hash));
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.matchMedia("(min-width: 1201px)").matches,
  );
  const recovery = useDesktopRecovery();
  const projects = useProjects();
  const providers = useProviders();
  const smiths = useSmiths(
    route.destination === "smiths",
    providers.data?.workspace ?? null,
  );
  const project = projects.data?.catalog.projects.find(
    (item) => item.id === route.projectId,
  );
  const summary = projects.data?.summaries.find(
    (item) => item.projectId === project?.id,
  );
  const activityFilters =
    route.destination === "activity"
      ? parseActivityFilters(window.location.hash)
      : { filters: null, error: "" };
  const activitySelection =
    route.destination === "activity" && route.selection?.kind === "event"
      ? route.selection.id
      : null;
  const selectedActivityId =
    activitySelection !== null &&
    /^[1-9]\d*$/.test(activitySelection) &&
    Number.isSafeInteger(Number(activitySelection))
      ? Number(activitySelection)
      : null;
  const activity = useProjectActivity(
    route.destination === "activity" ? (project?.id ?? null) : null,
    summary?.workspace ?? null,
    activityFilters.filters,
    selectedActivityId,
  );
  const writesAllowed = recovery?.connection.writesAllowed ?? false;
  const beads = useBeads(
    route.destination === "beads" ||
      (route.destination === "workbench" && route.selection?.kind === "bead")
      ? (project?.id ?? null)
      : null,
    (route.destination === "beads" || route.destination === "workbench") &&
      route.selection?.kind === "bead"
      ? route.selection.id
      : null,
  );
  const workbench = useWorkbench(
    route.destination === "workbench" ? (project?.id ?? null) : null,
  );
  const shifts = useProjectShifts(
    route.destination === "workbench" ? (project?.id ?? null) : null,
    workbench.data?.projectId === project?.id
      ? (workbench.data?.workspace ?? null)
      : null,
    writesAllowed,
  );
  const fullBead =
    route.destination === "beads" &&
    route.selection?.kind === "bead" &&
    new URL(window.location.hash.slice(1), "http://127.0.0.1").searchParams.get(
      "view",
    ) === "full";
  const beadWrites = useBeadWrites(writesAllowed && !project?.archived, () => {
    beads.reload();
    workbench.reload();
    projects.reload();
  });
  const [newBeadOpen, setNewBeadOpen] = useState(false);
  const beadOpener = useRef<HTMLElement>(null);
  const openNewBead = () => {
    if (!project || !beads.data || project.archived || !writesAllowed) return;
    beadOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setNewBeadOpen(true);
  };
  const selectedSession =
    route.selection?.kind === "session" ? route.selection.id : null;
  const observations = useSessionObservations(
    project?.id ?? null,
    selectedSession,
    summary?.workspace ?? null,
  );
  const sessions = useSessions(project?.id ?? null, null, writesAllowed);
  const observationRows = project
    ? observations.rows(project.id, sessions.project(project.id).records)
    : [];
  const selectedOwner =
    project && selectedSession
      ? observationRows.find((row) => row.id === selectedSession)?.owner
      : null;
  // Historical registration proves the address belongs to this project. Its
  // spelling, ledger kind, worktree and process availability grant no authority.
  const selectedOwnedSession =
    route.destination === "sessions" && selectedOwner && !selectedOwner.origin
      ? selectedOwner.record.id
      : null;
  useEffect(() => {
    sessions.activate(project?.id ?? null, selectedOwnedSession);
  }, [sessions, project?.id, selectedOwnedSession]);
  const sessionLibrary = useSessionLibrary(
    project?.id ?? null,
    project && selectedOwnedSession
      ? (sessions
          .project(project.id)
          .records.find((record) => record.id === selectedOwnedSession) ?? null)
      : null,
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
  const frameSessions: FrameSession[] = observationRows.map((row) => ({
    id: row.id,
    title: row.title,
    provider: row.provider,
    status: row.status,
    depth: row.depth,
  }));
  const previousProject = useRef(route.projectId);
  useEffect(() => {
    if (previousProject.current !== route.projectId)
      document.getElementById("af-main")?.focus();
    if (previousProject.current !== route.projectId) setKeeperOpen(false);
    if (previousProject.current !== route.projectId) setComposerOpen(false);
    if (previousProject.current !== route.projectId) setNewBeadOpen(false);
    previousProject.current = route.projectId;
  }, [route.projectId]);
  useEffect(() => {
    if (route.selection?.kind === "session") setInspectorOpen(true);
  }, [route.projectId, route.selection?.kind, route.selection?.id]);
  useEffect(() => {
    return observeDesktopRoute(
      {
        hash: () => window.location.hash,
        listen: (changed) => {
          window.addEventListener("hashchange", changed);
          return () => window.removeEventListener("hashchange", changed);
        },
      },
      setRoute,
    );
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
  useEffect(() => {
    if (selectedActivityId !== null) setInspectorOpen(true);
  }, [route.projectId, selectedActivityId]);
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
        providers={providers.data}
        providerStale={providers.stale}
        route={route}
        project={
          project
            ? {
                id: project.id,
                name: project.name,
                sessions: frameSessions,
                sessionsComplete:
                  !!observations.project(project.id).data
                    ?.observationsComplete &&
                  !!observations.project(project.id).data?.ownership
                    .available &&
                  !observations.project(project.id).error,
              }
            : null
        }
        connectionLabel={
          recovery?.busy
            ? "Restarting"
            : (recovery?.connection.label ?? "Connecting")
        }
        inspectorOpen={fullBead ? false : inspectorOpen}
        inspector={
          route.destination === "activity" && project ? (
            activitySelection !== null && selectedActivityId === null ? (
              <p role="alert">
                This event address is invalid. Choose an event from Activity.
              </p>
            ) : (
              <ProjectActivityInspector
                projectId={project.id}
                controller={activity}
              />
            )
          ) : (route.destination === "beads" ||
              route.destination === "workbench") &&
            !fullBead &&
            route.selection?.kind === "bead" &&
            project ? (
            <BeadPanel
              key={`${project.id}:${route.selection.id}`}
              projectId={project.id}
              id={route.selection.id}
              error={beads.error}
              loading={beads.loading}
              reload={() => {
                beads.reload();
                projects.reload();
              }}
              page={beads.data}
              sessions={summary?.sessions ?? []}
              sessionsComplete={summary?.sessionsComplete ?? false}
              onAskKeeper={openKeeper}
              writes={beadWrites}
              onStart={
                writesAllowed && !project.archived ? openSession : undefined
              }
            />
          ) : route.selection?.kind === "session" && project ? (
            <SessionInspector
              projectId={project.id}
              row={observationRows.find((row) => row.id === selectedSession)}
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
        {project &&
          route.destination !== "beads" &&
          route.selection?.kind === "bead" && (
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
        {project && route.destination === "sessions" && selectedSession && (
          <Button
            href={activityHref(project.id, {
              ...emptyActivityFilters(),
              sessionId: selectedSession,
            })}
          >
            View session Activity
          </Button>
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
        {project && route.destination === "beads" && beads.data && (
          <BeadWriteNotices
            writes={beadWrites}
            scope={{ projectId: project.id, workspace: beads.data.workspace }}
          />
        )}
        {route.destination === "projects" ? (
          <ProjectsHome
            providers={providers.data}
            providerStale={providers.stale}
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
        ) : route.destination === "providers" ? (
          <Providers
            data={providers.data}
            error={providers.error}
            loading={providers.loading}
            stale={providers.stale}
            reload={providers.reload}
            doctor={providers.doctor}
            checking={providers.checking}
            logins={providers.logins}
            writesAllowed={writesAllowed}
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
        ) : route.destination === "beads" && project ? (
          fullBead && route.selection?.kind === "bead" ? (
            <>
              <Button
                href={desktopHref({
                  projectId: project.id,
                  destination: "beads",
                  selection: null,
                })}
              >
                Back to Beads
              </Button>
              <BeadPanel
                key={`full:${project.id}:${route.selection.id}`}
                projectId={project.id}
                id={route.selection.id}
                error={beads.error}
                loading={beads.loading}
                reload={() => {
                  beads.reload();
                  projects.reload();
                }}
                page={beads.data}
                sessions={summary?.sessions ?? []}
                sessionsComplete={summary?.sessionsComplete ?? false}
                onAskKeeper={openKeeper}
                writes={beadWrites}
                onStart={
                  writesAllowed && !project.archived ? openSession : undefined
                }
              />
            </>
          ) : (
            <ProjectBeads
              key={project.id}
              projectId={project.id}
              page={beads.data}
              error={beads.error}
              loading={beads.loading}
              reload={() => {
                beads.reload();
                projects.reload();
              }}
              selectedId={
                route.selection?.kind === "bead" ? route.selection.id : null
              }
              onNew={
                writesAllowed && !project.archived ? openNewBead : undefined
              }
              onSelect={(id) => {
                setInspectorOpen(true);
                window.location.hash = beadHref(project.id, id).slice(1);
              }}
              onOpen={(id) => {
                window.location.hash = beadHref(project.id, id, true).slice(1);
              }}
            />
          )
        ) : route.destination === "workbench" && project ? (
          <ProjectWorkbench
            key={project.id}
            projectId={project.id}
            page={workbench.data}
            error={workbench.error}
            loading={workbench.loading}
            reload={workbench.reload}
            writes={beadWrites}
            shifts={
              shifts.scope && (
                <ProjectShifts
                  key={project.id}
                  client={shifts.client}
                  scope={shifts.scope}
                  writesAllowed={writesAllowed}
                  archived={project.archived}
                />
              )
            }
            selectedId={
              route.selection?.kind === "bead" ? route.selection.id : null
            }
            onSelect={(id) => {
              setInspectorOpen(true);
              window.location.hash = desktopHref({
                projectId: project.id,
                destination: "workbench",
                selection: { kind: "bead", id },
              }).slice(1);
            }}
          />
        ) : route.destination === "activity" && project ? (
          <ProjectActivityFeed
            controller={activity}
            filters={activityFilters.filters}
            filterError={activityFilters.error}
            onApply={(filters) => {
              window.location.hash = activityHref(
                project.id,
                filters,
                selectedActivityId,
              ).slice(1);
            }}
            onInspect={(id) => {
              if (!activityFilters.filters) return;
              setInspectorOpen(true);
              window.location.hash = activityHref(
                project.id,
                activityFilters.filters,
                id,
              ).slice(1);
            }}
          />
        ) : route.destination === "overview" && project ? (
          <ProjectOverview
            providers={providers.data}
            providerStale={providers.stale}
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
            keeper={keeper}
            writesAllowed={writesAllowed}
            archived={project.archived}
            library={sessionLibrary}
          />
        ) : route.destination === "sessions" && project && selectedSession ? (
          <ObservedSessionDetail
            key={`${project.id}:${selectedSession}`}
            projectId={project.id}
            sessionId={selectedSession}
            client={observations}
            row={observationRows.find((row) => row.id === selectedSession)}
          />
        ) : route.destination === "sessions" && project ? (
          <>
            <OwnedSessions
              projectId={project.id}
              client={sessions}
              onNew={() => openSession()}
              library={sessionLibrary}
            />
            <ProjectSessions
              client={observations}
              representedIds={sessions
                .project(project.id)
                .records.map((record) => record.id)}
              keeper={keeper}
              writesAllowed={writesAllowed}
              key={project.id}
              projectId={project.id}
              selectedId={
                route.selection?.kind === "session" ? route.selection.id : null
              }
            />
          </>
        ) : route.destination === "smiths" ? (
          <Smiths
            controller={smiths}
            workspace={providers.data?.workspace ?? null}
          />
        ) : route.destination === "inbox" ? (
          <BeadWriteNotices writes={beadWrites} inbox />
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
        open={newBeadOpen && !!project && !!beads.data}
        title={`New bead · ${project?.name ?? ""}`}
        titleId="af-new-bead-title"
        onClose={() => setNewBeadOpen(false)}
        returnFocusRef={beadOpener}
        class="af-bead-dialog"
        initialFocus="content"
      >
        {newBeadOpen && beads.data && (
          <NewBeadForm
            key={project?.id}
            writes={beadWrites}
            page={beads.data}
            onCancel={() => setNewBeadOpen(false)}
          />
        )}
      </Dialog>
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
            providers={providers.data}
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
