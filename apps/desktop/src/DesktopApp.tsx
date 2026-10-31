import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import type { KeeperProposal } from "../../../types/keeper-proposal";
import { BeadWriteNotices, NewBeadForm } from "./BeadWrites";
import { ConnectionBanner, useDesktopRecovery } from "./ConnectionBanner";
import { useChatDecisionOwners } from "./chat-decision-owners";
import type { FrameSession } from "./DesktopFrame";
import { DesktopFrame } from "./DesktopFrame";
import {
  captureForgeRunDraft,
  type ForgeRunDraftSnapshot,
  type ForgeRunPrefill,
  forgeRunComposerPatch,
  forgeRunDraftIsPristine,
  forgeRunDraftMatches,
  forgeRunPreparationHold,
} from "./forge-run-prefill";
import { KeeperConversation, KeeperScope } from "./KeeperConversation";
import { KeeperShiftReviewDialog } from "./KeeperShiftReviewDialog";
import type { KeeperSessionReview } from "./keeper-session-review";
import type { KeeperShiftReviewEntry } from "./keeper-shift-review-owner";
import { ManagedShiftSession } from "./ManagedShiftSession";
import {
  managedShiftHref,
  managedShiftSelection,
} from "./managed-shift-navigation";
import { NewForgeRun } from "./NewForgeRun";
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
import { ProjectReviews } from "./ProjectReviews";
import { ProjectRunInspector, ProjectRuns } from "./ProjectRuns";
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
import {
  createProjectCheckpointReviewOwner,
  type ProjectCheckpointReviewOwner,
  type ProjectCheckpointReviewTarget,
} from "./project-checkpoint-review-client";
import {
  createProjectCouncilDraftCache,
  type PendingProjectCouncilSourceReplacement,
  type ProjectCouncilDraftScope,
  type ProjectCouncilSourcePrefill,
} from "./project-council-draft";
import {
  createProjectCouncilReturnMemory,
  type ProjectCouncilReturnFocus,
  type ProjectCouncilReturnOrigin,
  type ProjectCouncilSourceIntent,
} from "./project-council-return";
import type { VerifiedProjectCreate } from "./project-create-owner";
import { parseRunFilters, runsHref } from "./project-runs-model";
import { ClaudeSessionComposer, SessionComposer } from "./SessionComposer";
import { SessionConversation } from "./SessionConversation";
import { Smiths } from "./Smiths";
import {
  canContinueClaudeRateLimit,
  validContinuationSummary,
} from "./session-continuation";
import type { VerifiedSessionIdentityScope } from "./session-start-identity-server";
import { useBeadWrites } from "./use-bead-writes";
import { useBeads } from "./use-beads";
import { useKeeper } from "./use-keeper";
import { useKeeperProposals } from "./use-keeper-proposals";
import { useKeeperSessionReviews } from "./use-keeper-session-reviews";
import { useKeeperShiftReviews } from "./use-keeper-shift-reviews";
import { useProjectActivity } from "./use-project-activity";
import { useProjectCreate } from "./use-project-create";
import { useProjectRuns } from "./use-project-runs";
import { useProjectShifts } from "./use-project-shifts";
import { useProjects } from "./use-projects";
import { useProviders } from "./use-providers";
import { useSessionLibrary } from "./use-session-library";
import { useSessionObservations } from "./use-session-observations";
import { useSessions } from "./use-sessions";
import { useSmithCreate } from "./use-smith-create";
import { useSmithEdit } from "./use-smith-edit";
import { useSmithRoutingEdit } from "./use-smith-routing-edit";
import { useSmiths } from "./use-smiths";
import { useWorkbench } from "./use-workbench";

function sameDesktopRoute(
  left: ReturnType<typeof desktopRoute>,
  right: ReturnType<typeof desktopRoute>,
): boolean {
  return (
    left.destination === right.destination &&
    left.projectId === right.projectId &&
    left.selection?.kind === right.selection?.kind &&
    left.selection?.id === right.selection?.id
  );
}

function sameForgeRunIdentityScope(
  left: VerifiedSessionIdentityScope | null,
  right: VerifiedSessionIdentityScope | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.projectId === right.projectId &&
    left.workspace === right.workspace &&
    left.generation === right.generation
  );
}

/** Desktop routing stays separate from the ordinary dashboard's legacy URLs and snapshot mode. */
export function DesktopApp(): JSX.Element {
  const [route, setRoute] = useState(() => desktopRoute(window.location.hash));
  const forgeRouteGeneration = useRef(0);
  useEffect(() => {
    const changed = (event: HashChangeEvent) => {
      if (event.oldURL !== event.newURL) forgeRouteGeneration.current++;
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const [finishBrief, setFinishBrief] = useState<VerifiedProjectCreate | null>(
    null,
  );
  const councilDraftCache = useRef<ReturnType<
    typeof createProjectCouncilDraftCache
  > | null>(null);
  if (!councilDraftCache.current)
    councilDraftCache.current = createProjectCouncilDraftCache();
  const councilReturnMemory = useRef(createProjectCouncilReturnMemory());
  const [councilReturnFocus, setCouncilReturnFocus] =
    useState<ProjectCouncilReturnFocus | null>(null);
  const councilReturnFocusRef = useRef<ProjectCouncilReturnFocus | null>(null);
  const [councilReturnNotice, setCouncilReturnNotice] = useState("");
  const [, setCouncilReturnRevision] = useState(0);
  const checkpointReviewOwners = useRef(
    new Map<string, ProjectCheckpointReviewOwner>(),
  );
  useEffect(
    () => () => {
      for (const owner of checkpointReviewOwners.current.values())
        owner.dispose();
      checkpointReviewOwners.current.clear();
    },
    [],
  );
  const [councilSourceReplacement, setCouncilSourceReplacement] = useState<{
    scope: ProjectCouncilDraftScope;
    pending: PendingProjectCouncilSourceReplacement;
    intent: ProjectCouncilSourceIntent;
    focusSource: boolean;
    error: string;
  } | null>(null);
  const [councilDraftGeneration, setCouncilDraftGeneration] = useState(0);
  const [focusCouncilSource, setFocusCouncilSource] = useState(false);
  const [councilDraftNotice, setCouncilDraftNotice] = useState("");
  const managedSelection = managedShiftSelection(window.location.hash);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.matchMedia("(min-width: 1201px)").matches,
  );
  const recovery = useDesktopRecovery();
  const projects = useProjects();
  const providers = useProviders();
  const projectCreate = useProjectCreate(
    providers.data?.workspace ?? null,
    recovery?.connection.writesAllowed ?? false,
    projects.refreshProjectHome,
  );
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
  const currentCouncilScope: ProjectCouncilDraftScope | null =
    project?.id && summary?.workspace
      ? { projectId: project.id, workspace: summary.workspace }
      : null;
  const clearCouncilReturnPath = useCallback(() => {
    councilReturnMemory.current.clear();
    setCouncilReturnRevision((revision) => revision + 1);
    setCouncilSourceReplacement(null);
    councilReturnFocusRef.current = null;
    setCouncilReturnFocus(null);
    setCouncilReturnNotice("");
  }, []);
  const lastCouncilScope = useRef<ProjectCouncilDraftScope | null>(null);
  useEffect(() => {
    const previous = lastCouncilScope.current;
    const next = currentCouncilScope;
    if (
      previous &&
      (!next ||
        previous.projectId !== next.projectId ||
        previous.workspace !== next.workspace)
    ) {
      clearCouncilReturnPath();
      setCouncilReturnNotice(
        "The project workspace changed. The previous Run return path was cleared.",
      );
    }
    lastCouncilScope.current = next;
  }, [
    clearCouncilReturnPath,
    currentCouncilScope?.projectId,
    currentCouncilScope?.workspace,
  ]);
  const lastRouteKey = useRef(
    JSON.stringify([
      route.destination,
      route.projectId,
      route.selection?.kind ?? null,
      route.selection?.id ?? null,
    ]),
  );
  const currentRouteKey = JSON.stringify([
    route.destination,
    route.projectId,
    route.selection?.kind ?? null,
    route.selection?.id ?? null,
  ]);
  useEffect(() => {
    const previousKey = lastRouteKey.current;
    if (previousKey !== currentRouteKey && route.destination !== "reviews") {
      const focus = councilReturnFocusRef.current;
      const isIntendedRun =
        route.destination === "runs" &&
        route.projectId === focus?.origin.projectId &&
        route.selection?.kind === "run" &&
        route.selection.id === focus.origin.runSlug;
      const isSameScopeRunBrowse =
        route.destination === "runs" &&
        !!currentCouncilScope &&
        route.projectId === currentCouncilScope.projectId &&
        councilReturnMemory.current.get(currentCouncilScope) !== null;
      if (!isIntendedRun && !isSameScopeRunBrowse) {
        clearCouncilReturnPath();
      }
    }
    const focus = councilReturnFocusRef.current;
    if (
      focus &&
      route.destination !== "reviews" &&
      !(
        route.destination === "runs" &&
        route.projectId === focus.origin.projectId &&
        route.selection?.kind === "run" &&
        route.selection.id === focus.origin.runSlug
      )
    ) {
      clearCouncilReturnPath();
    }
    lastRouteKey.current = currentRouteKey;
  }, [
    clearCouncilReturnPath,
    currentCouncilScope?.projectId,
    currentCouncilScope?.workspace,
    currentRouteKey,
    route.destination,
    route.projectId,
    route.selection,
  ]);
  useEffect(() => {
    if (
      councilSourceReplacement &&
      (councilSourceReplacement.scope.projectId !== project?.id ||
        councilSourceReplacement.scope.workspace !== summary?.workspace)
    ) {
      setCouncilSourceReplacement(null);
      setCouncilDraftNotice(
        "The project workspace changed. The existing Council draft was kept; choose its source again from the current workspace.",
      );
    }
  }, [councilSourceReplacement, project?.id, summary?.workspace]);
  const openCouncilSource = (
    source: ProjectCouncilSourcePrefill,
    sourceWorkspace: string,
    focusSource = false,
    returnOrigin: ProjectCouncilReturnOrigin | null = null,
  ) => {
    if (
      !project ||
      !summary?.workspace ||
      sourceWorkspace !== summary.workspace
    ) {
      setCouncilDraftNotice(
        "This source is not from the current served project workspace. The existing Council draft was kept.",
      );
      return;
    }
    const scope = { projectId: project.id, workspace: summary.workspace };
    const matchingOrigin =
      returnOrigin &&
      source.sourceType === "bead" &&
      source.source === returnOrigin.checkpointId
        ? returnOrigin
        : null;
    const intent = councilReturnMemory.current.begin(scope, matchingOrigin);
    const result = councilDraftCache.current?.prefill(scope, source);
    if (result?.kind === "confirmation-required") {
      setCouncilSourceReplacement({
        scope,
        pending: result.pending,
        intent,
        focusSource,
        error: "",
      });
      return;
    }
    if (result?.kind !== "applied") {
      councilReturnMemory.current.reject(intent, scope);
      setCouncilDraftNotice(
        result?.reason === "capacity"
          ? "The 32-draft limit is reached. Existing Council drafts were kept."
          : result?.reason === "source-too-large"
            ? "This source is too large for the private Council draft cache. The existing draft was kept."
            : "A current served project workspace is required. The existing draft was kept.",
      );
      return;
    }
    if (!councilReturnMemory.current.apply(intent, scope)) {
      setCouncilDraftNotice(
        "This source request is no longer current. The existing Council draft and Run return path were kept.",
      );
      return;
    }
    setCouncilDraftNotice("");
    setCouncilDraftGeneration((current) => current + 1);
    setFocusCouncilSource(focusSource);
    window.location.hash = desktopHref({
      projectId: project.id,
      destination: "reviews",
      selection: null,
    }).slice(1);
  };
  const keepCouncilDraft = () => {
    if (!councilSourceReplacement) return;
    if (
      project?.id !== councilSourceReplacement.scope.projectId ||
      summary?.workspace !== councilSourceReplacement.scope.workspace
    ) {
      setCouncilSourceReplacement(null);
      setCouncilDraftNotice(
        "The project workspace changed. The existing Council draft was kept.",
      );
      return;
    }
    if (
      !councilReturnMemory.current.keep(
        councilSourceReplacement.intent,
        councilSourceReplacement.scope,
      )
    ) {
      setCouncilSourceReplacement(null);
      setCouncilDraftNotice(
        "This source request is no longer current. The existing Council draft and Run return path were kept.",
      );
      return;
    }
    setCouncilSourceReplacement(null);
    setCouncilDraftGeneration((current) => current + 1);
    setFocusCouncilSource(false);
    window.location.hash = desktopHref({
      projectId: councilSourceReplacement.scope.projectId,
      destination: "reviews",
      selection: null,
    }).slice(1);
  };
  const replaceCouncilDraftSource = () => {
    if (!councilSourceReplacement) return;
    if (
      project?.id !== councilSourceReplacement.scope.projectId ||
      summary?.workspace !== councilSourceReplacement.scope.workspace
    ) {
      setCouncilSourceReplacement(null);
      setCouncilDraftNotice(
        "The project workspace changed. The existing Council draft was kept.",
      );
      return;
    }
    if (
      !councilReturnMemory.current.isCurrent(
        councilSourceReplacement.intent,
        councilSourceReplacement.scope,
      )
    ) {
      setCouncilSourceReplacement((current) =>
        current
          ? {
              ...current,
              error:
                "The source request is no longer current. Keep the existing draft and choose the source again.",
            }
          : current,
      );
      return;
    }
    const result = councilDraftCache.current?.confirm(
      councilSourceReplacement.scope,
      councilSourceReplacement.pending,
    );
    if (result?.kind === "stale") {
      setCouncilSourceReplacement((current) =>
        current
          ? {
              ...current,
              error:
                "The draft changed while this confirmation was open. Keep the current draft and review it again.",
            }
          : current,
      );
      return;
    }
    if (result?.kind !== "applied") {
      councilReturnMemory.current.reject(
        councilSourceReplacement.intent,
        councilSourceReplacement.scope,
      );
      setCouncilDraftNotice(
        result?.reason === "capacity"
          ? "The 32-draft limit is reached. Existing Council drafts were kept."
          : result?.reason === "source-too-large"
            ? "This source is too large for the private Council draft cache. The existing draft was kept."
            : "A current served project workspace is required. The existing draft was kept.",
      );
      setCouncilSourceReplacement(null);
      return;
    }
    if (
      !councilReturnMemory.current.apply(
        councilSourceReplacement.intent,
        councilSourceReplacement.scope,
      )
    ) {
      setCouncilSourceReplacement((current) =>
        current
          ? {
              ...current,
              error:
                "The source request changed before it could be applied. Keep the existing draft and choose the source again.",
            }
          : current,
      );
      return;
    }
    setCouncilDraftNotice("");
    const projectId = councilSourceReplacement.scope.projectId;
    setCouncilSourceReplacement(null);
    setCouncilDraftGeneration((current) => current + 1);
    setFocusCouncilSource(councilSourceReplacement.focusSource);
    window.location.hash = desktopHref({
      projectId,
      destination: "reviews",
      selection: null,
    }).slice(1);
  };
  const returnToCouncilSourceRun = (
    expectedOrigin: ProjectCouncilReturnOrigin,
  ) => {
    if (!currentCouncilScope) {
      setCouncilReturnNotice(
        "A verified project workspace is required to return to this Run.",
      );
      return;
    }
    const focus = councilReturnMemory.current.take(
      currentCouncilScope,
      expectedOrigin,
    );
    if (!focus) {
      councilReturnMemory.current.clear();
      setCouncilReturnNotice(
        "The saved Run return path is no longer current. Select the Run again to inspect its checkpoint.",
      );
      return;
    }
    councilReturnFocusRef.current = focus;
    setCouncilReturnFocus(focus);
    setCouncilReturnNotice("");
    window.location.hash = runsHref(
      focus.origin.projectId,
      focus.origin.runSlug,
    ).slice(1);
  };
  const handleCouncilReturnFocus = (
    focus: ProjectCouncilReturnFocus,
    result: "focused" | "unavailable",
  ) => {
    if (councilReturnFocusRef.current?.generation !== focus.generation) return;
    councilReturnFocusRef.current = null;
    setCouncilReturnFocus(null);
    setCouncilReturnNotice(
      result === "focused"
        ? "Returned to the exact Run checkpoint."
        : "The Run checkpoint could not be freshly verified as in progress. Focus was not restored.",
    );
  };
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
  const checkpointReviewOwner = (target: ProjectCheckpointReviewTarget) => {
    const key = JSON.stringify([
      target.projectId,
      target.workspacePath,
      target.runSlug,
      target.beadId,
    ]);
    let owner = checkpointReviewOwners.current.get(key);
    if (!owner) {
      owner = createProjectCheckpointReviewOwner(target);
      checkpointReviewOwners.current.set(key, owner);
    }
    return owner;
  };
  const smithCreates = useSmithCreate(
    writesAllowed,
    providers.data?.workspace ?? null,
  );
  const smithEdits = useSmithEdit(
    writesAllowed,
    providers.data?.workspace ?? null,
  );
  const smithRoutingEdits = useSmithRoutingEdit(
    writesAllowed,
    providers.data?.workspace ?? null,
  );
  const runFilters =
    route.destination === "runs"
      ? parseRunFilters(window.location.hash)
      : { filters: null, error: "" };
  const runs = useProjectRuns(
    route.destination === "runs" ? (project?.id ?? null) : null,
    summary?.workspace ?? null,
    route.destination === "runs" && route.selection?.kind === "run"
      ? route.selection.id
      : null,
  );
  const beads = useBeads(
    route.destination === "beads" ||
      route.destination === "runs" ||
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
      : (summary?.workspace ?? null),
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
  const sessions = useSessions(
    project?.id ?? null,
    null,
    writesAllowed,
    providers.data,
  );
  const actualRoute = desktopRoute(window.location.hash);
  const renderedRouteMatchesActual = sameDesktopRoute(route, actualRoute);
  const selectedRunSlug =
    route.selection?.kind === "run" ? route.selection.id : null;
  const currentRunPage = runs.view?.page;
  const forgeRunCanOpen = Boolean(
    renderedRouteMatchesActual &&
      actualRoute.destination === "runs" &&
      actualRoute.projectId === project?.id &&
      project &&
      !project.archived &&
      writesAllowed &&
      summary?.workspace &&
      providers.data?.workspace === summary.workspace &&
      project.workspaces.some((scope) => scope.root === summary.workspace) &&
      runs.view &&
      !runs.view.loading &&
      !runs.view.error &&
      runs.view.selectedSlug === selectedRunSlug &&
      currentRunPage &&
      currentRunPage.projectId === project.id &&
      currentRunPage.workspace === summary.workspace &&
      currentRunPage.coverage === "served-checkout-only" &&
      currentRunPage.problems.length === 0,
  );
  const forgeRunCurrent = useRef<{
    canOpen: boolean;
    projectId: string | null;
    workspace: string | null;
    routeHash: string;
    navigationGeneration: number;
    renderedRoute: typeof route;
    actualRoute: typeof actualRoute;
    identityScope: VerifiedSessionIdentityScope | null;
    beadsPage: typeof beads.data;
    beadsLoading: boolean;
    beadsError: string | null;
    sessions: typeof sessions;
  } | null>(null);
  forgeRunCurrent.current = {
    canOpen: forgeRunCanOpen,
    projectId: project?.id ?? null,
    workspace: summary?.workspace ?? null,
    routeHash: window.location.hash,
    navigationGeneration: forgeRouteGeneration.current,
    renderedRoute: route,
    actualRoute,
    identityScope: sessions.currentIdentityScope(),
    beadsPage: beads.data,
    beadsLoading: beads.loading,
    beadsError: beads.error,
    sessions,
  };
  const observationRows = project
    ? observations.rows(project.id, sessions.project(project.id).records)
    : [];
  const selectedOwner =
    project && selectedSession
      ? observationRows.find((row) => row.id === selectedSession)?.owner
      : null;
  const managedSession =
    !!selectedOwner?.origin ||
    (managedSelection.selection?.sessionId !== undefined &&
      managedSelection.selection.sessionId !== null) ||
    !!managedSelection.error;
  // Historical registration proves the address belongs to this project. Its
  // spelling, ledger kind, worktree and process availability grant no authority.
  const selectedOwnedSession =
    route.destination === "sessions" &&
    selectedOwner &&
    !selectedOwner.origin &&
    !managedSession
      ? selectedOwner.record.id
      : null;
  const chatDecisionOwners = useChatDecisionOwners({
    canWrite: (address) => {
      const target = projects.data?.catalog.projects.find(
        (item) => item.id === address.projectId,
      );
      return writesAllowed && !!target && !target.archived;
    },
    isCurrent: (address) => {
      const currentProject = projects.data?.catalog.projects.find(
          (item) => item.id === address.projectId,
        ),
        currentSummary = projects.data?.summaries.find(
          (item) => item.projectId === address.projectId,
        ),
        currentRecord = sessions
          .project(address.projectId)
          .records.find((item) => item.id === address.sessionId),
        currentSession = sessions.session(address.projectId, address.sessionId),
        currentTurn = currentSession.page?.turns.at(-1),
        actualRoute = desktopRoute(window.location.hash),
        routeCurrent =
          sameDesktopRoute(route, actualRoute) &&
          ((actualRoute.destination === "sessions" &&
            actualRoute.projectId === address.projectId &&
            actualRoute.selection?.kind === "session" &&
            actualRoute.selection.id === address.sessionId) ||
            actualRoute.destination === "inbox");
      const projectScopeCurrent = Boolean(
        routeCurrent &&
          currentProject &&
          currentSummary?.workspace === address.workspace &&
          currentProject.workspaces.some(
            (scope) => scope.root === address.workspace,
          ),
      );
      // Inbox activations are independently bound by the exact project-scoped
      // approvals read and offer ID; SessionsClient only keeps the selected
      // conversation live and cannot be the cross-project authority here.
      if (actualRoute.destination === "inbox")
        return Boolean(
          projectScopeCurrent && address.requestId && address.acceptedTurnId,
        );
      return Boolean(
        projectScopeCurrent &&
          currentRecord?.projectId === address.projectId &&
          currentRecord?.mode === "chat" &&
          (currentRecord?.provider === "codex" ||
            currentRecord?.provider === "gemini") &&
          currentSession.loaded &&
          currentSession.live &&
          !currentSession.readError &&
          !currentSession.feedInterrupted &&
          !currentSession.stopping &&
          !currentSession.stopPosting &&
          !currentSession.stopUnknown &&
          currentTurn?.requestId === address.acceptedTurnId &&
          (currentTurn?.phase === "accepted" ||
            currentTurn?.phase === "running"),
      );
    },
  });
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
  const [forgeRunReview, setForgeRunReview] = useState<{
    projectId: string;
    workspace: string;
    routeHash: string;
    navigationGeneration: number;
    identityScope: VerifiedSessionIdentityScope | null;
    draft: ForgeRunDraftSnapshot;
  } | null>(null);
  const forgeRunOpener = useRef<HTMLElement>(null);
  const reviews = useKeeperSessionReviews(writesAllowed, sessions);
  const shiftReviews = useKeeperShiftReviews(writesAllowed);
  const [sessionReview, setSessionReview] =
    useState<KeeperSessionReview | null>(null);
  const reviewOpener = useRef<HTMLElement>(null);
  const [shiftReview, setShiftReview] = useState<KeeperShiftReviewEntry | null>(
    null,
  );
  const shiftReviewRef = useRef<KeeperShiftReviewEntry | null>(null);
  shiftReviewRef.current = shiftReview;
  const shiftReviewOpener = useRef<HTMLElement>(null);
  const openSessionReview = (
    source: KeeperProposal,
    revision: number,
    requestId?: string,
  ) => {
    if (!project || source.projectId !== project.id) return;
    reviewOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const review = reviews.get(source, revision, requestId);
    setSessionReview(review);
    void reviews.open(review);
  };
  const openShiftReview = (
    source: KeeperProposal,
    revision: number,
    originalOnly = false,
    requestId?: string,
  ) => {
    if (!project || source.projectId !== project.id) return;
    shiftReviewOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const entry = shiftReviews.get(source, revision, originalOnly, requestId);
    setShiftReview(entry);
    void shiftReviews.owner.open(entry);
  };
  const closeShiftReview = () => {
    const entry = shiftReviewRef.current;
    if (entry) shiftReviews.owner.close(entry);
    setShiftReview(null);
  };
  const composerOpener = useRef<HTMLElement>(null);
  const openNewForgeRun = () => {
    const current = forgeRunCurrent.current;
    const liveIdentityScope = current?.sessions.currentIdentityScope() ?? null;
    const currentIdentityView = current?.projectId
      ? current.sessions.project(current.projectId)
      : null;
    if (
      !current?.canOpen ||
      !current.projectId ||
      !current.workspace ||
      !sameForgeRunIdentityScope(current.identityScope, liveIdentityScope) ||
      !currentIdentityView ||
      current.routeHash !== window.location.hash ||
      current.navigationGeneration !== forgeRouteGeneration.current ||
      !sameDesktopRoute(
        current.renderedRoute,
        desktopRoute(window.location.hash),
      ) ||
      current.actualRoute.destination !== "runs" ||
      current.actualRoute.projectId !== current.projectId
    )
      return;
    forgeRunOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setForgeRunReview({
      projectId: current.projectId,
      workspace: current.workspace,
      routeHash: current.routeHash,
      navigationGeneration: current.navigationGeneration,
      identityScope: liveIdentityScope,
      draft: captureForgeRunDraft(currentIdentityView),
    });
  };
  const validateForgeRunReview = (
    expected: NonNullable<typeof forgeRunReview>,
  ): { view: ReturnType<typeof sessions.project>; error: string | null } => {
    const current = forgeRunCurrent.current;
    const liveIdentityScope = current?.sessions.currentIdentityScope() ?? null;
    if (
      !current?.canOpen ||
      current.projectId !== expected.projectId ||
      current.workspace !== expected.workspace ||
      current.routeHash !== expected.routeHash ||
      window.location.hash !== expected.routeHash ||
      current.navigationGeneration !== expected.navigationGeneration ||
      current.navigationGeneration !== forgeRouteGeneration.current ||
      !sameForgeRunIdentityScope(current.identityScope, liveIdentityScope) ||
      !sameForgeRunIdentityScope(liveIdentityScope, expected.identityScope) ||
      !sameDesktopRoute(
        current.renderedRoute,
        desktopRoute(window.location.hash),
      ) ||
      current.actualRoute.destination !== "runs" ||
      current.actualRoute.projectId !== expected.projectId
    )
      return {
        view: sessions.project(expected.projectId),
        error:
          "The project, workspace, or Runs view changed. Close this preparation and review it again from the current Runs page.",
      };
    const view = current.sessions.project(expected.projectId);
    const hold = forgeRunPreparationHold(view, liveIdentityScope);
    if (hold) return { view, error: hold };
    if (!forgeRunDraftMatches(expected.draft, view))
      return {
        view,
        error:
          "A composer draft or session identity changed while you reviewed this prompt. Reopen preparation to review the current state.",
      };
    return { view, error: null };
  };
  const validateForgeRunBead = (
    current: NonNullable<typeof forgeRunCurrent.current>,
    prefill: ForgeRunPrefill,
    expected: NonNullable<typeof forgeRunReview>,
  ): string | null => {
    if (!prefill.beadId) return null;
    const page = current.beadsPage;
    if (
      !page ||
      current.beadsLoading ||
      current.beadsError ||
      page.projectId !== expected.projectId ||
      page.workspace !== expected.workspace ||
      !page.complete ||
      page.problems.length > 0 ||
      !page.beads.some(
        (bead) =>
          bead.id === prefill.beadId &&
          (bead.type === "feature" || bead.type === "epic"),
      )
    )
      return "That feature or epic is no longer verified in this project workspace. Review the scoped bead list again.";
    return null;
  };
  const applyForgeRunPrefill = (prefill: ForgeRunPrefill) => {
    if (!forgeRunReview)
      return "This forge-run review is no longer current. Reopen preparation from the Runs page.";
    const checked = validateForgeRunReview(forgeRunReview);
    if (checked.error) return checked.error;
    const current = forgeRunCurrent.current;
    if (!current)
      return "The current Runs scope is unavailable. Reopen preparation.";
    const beadError = validateForgeRunBead(current, prefill, forgeRunReview);
    if (beadError) return beadError;
    current.sessions.chooseComposerProvider(forgeRunReview.projectId, "claude");
    current.sessions.editComposer(
      forgeRunReview.projectId,
      forgeRunComposerPatch(prefill),
    );
    composerOpener.current = forgeRunOpener.current;
    setForgeRunReview(null);
    setComposerOpen(true);
    return null;
  };
  const continueForgeRunToComposer = (prefill: ForgeRunPrefill) => {
    if (!forgeRunReview)
      return "Reopen preparation from the current Runs page.";
    const checked = validateForgeRunReview(forgeRunReview);
    if (checked.error) return checked.error;
    const current = forgeRunCurrent.current;
    if (!current)
      return "The current Runs scope is unavailable. Reopen preparation.";
    const beadError = validateForgeRunBead(current, prefill, forgeRunReview);
    if (beadError) return beadError;
    return forgeRunDraftIsPristine(forgeRunReview.draft)
      ? (applyForgeRunPrefill(prefill) ?? "applied")
      : "confirm";
  };
  const keepForgeRunDraft = () => {
    if (!forgeRunReview)
      return "Reopen preparation from the current Runs page.";
    const checked = validateForgeRunReview(forgeRunReview);
    if (checked.error) return checked.error;
    composerOpener.current = forgeRunOpener.current;
    setForgeRunReview(null);
    setComposerOpen(true);
    return null;
  };
  const openSession = (beadId?: string) => {
    if (!project || project.archived) return;
    composerOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (beadId) sessions.editComposer(project.id, { beadId });
    setComposerOpen(true);
  };
  const continueToChat = (
    handoffSummary: string,
    sourceSessionId: string,
    target: "codex" | "gemini",
  ) => {
    if (
      !project ||
      project.archived ||
      !writesAllowed ||
      selectedOwnedSession !== sourceSessionId ||
      !validContinuationSummary(handoffSummary)
    )
      return false;
    const currentProject = sessions.project(project.id),
      currentView = sessions.session(project.id, sourceSessionId);
    if (
      !canContinueClaudeRateLimit({
        projectId: project.id,
        workspace: summary?.workspace ?? null,
        writable: writesAllowed,
        archived: project.archived,
        record:
          currentProject.records.find(
            (record) => record.id === sourceSessionId,
          ) ?? null,
        page: currentView.page,
        loaded: currentView.loaded,
        live: currentView.live,
        feedInterrupted: currentView.feedInterrupted,
        readError: currentView.readError,
        stopping: !!currentView.stopping,
        stopPosting: currentView.stopPosting,
        stopUnknown: currentView.stopUnknown,
        pending: !!currentView.pending,
        posting: currentView.posting,
        identity: {
          page: currentProject.identityPage,
          loading: currentProject.identityLoading,
          generation: currentProject.identityGeneration,
          startIdentity: currentProject.startIdentity,
          pendingStart: !!currentProject.pendingStart,
          starting: currentProject.starting,
          startIdentityError: currentProject.startIdentityError,
          legacyIdentityError: currentProject.legacyIdentityError,
          legacyIdentityUnavailable: currentProject.legacyIdentityUnavailable,
          inspection: currentProject.identityInspection,
        },
      })
    )
      return false;
    sessions.chooseComposerProvider(project.id, target);
    if (target === "gemini") sessions.chooseGeminiMode(project.id, "chat");
    else sessions.chooseCodexMode(project.id, "chat");
    sessions.editComposer(project.id, {
      prompt: handoffSummary.trim(),
      attachments: [],
      about: [{ kind: "session", id: sourceSessionId }],
    });
    composerOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setComposerOpen(true);
    return true;
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
    if (previousProject.current !== route.projectId) setSessionReview(null);
    if (previousProject.current !== route.projectId) {
      const entry = shiftReviewRef.current;
      if (entry) shiftReviews.owner.close(entry);
      setShiftReview(null);
    }
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
      <Dialog
        open={!!councilSourceReplacement}
        title="Replace Council draft source?"
        titleId="af-council-source-replacement-title"
        onClose={() => setCouncilSourceReplacement(null)}
        class="af-session-dialog"
      >
        {councilSourceReplacement && (
          <>
            <p>
              This project and workspace already have a Council draft with a
              source. Keep the current draft or replace only its source?
            </p>
            <p>Profile and review options stay with the draft.</p>
            {councilSourceReplacement.error && (
              <p role="alert">{councilSourceReplacement.error}</p>
            )}
            <div class="af-button-row">
              <Button onClick={keepCouncilDraft}>Keep draft</Button>
              <Button variant="primary" onClick={replaceCouncilDraftSource}>
                Replace source
              </Button>
            </div>
          </>
        )}
      </Dialog>
      {councilDraftNotice && <p role="alert">{councilDraftNotice}</p>}
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
              onCouncilPrefill={(id) =>
                beads.data?.workspace &&
                openCouncilSource(
                  { sourceType: "bead", source: id },
                  beads.data.workspace,
                )
              }
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
              onCouncilSummary={() =>
                summary?.workspace &&
                openCouncilSource(
                  { sourceType: "text", source: "" },
                  summary.workspace,
                  true,
                )
              }
              onAskKeeper={openKeeper}
            />
          ) : route.selection?.kind === "run" && project ? (
            <ProjectRunInspector
              projectId={project.id}
              workspace={summary?.workspace ?? null}
              slug={route.selection.id}
              view={runs.view}
              routeCurrent={
                renderedRouteMatchesActual &&
                actualRoute.destination === "runs" &&
                actualRoute.projectId === project.id &&
                actualRoute.selection?.kind === "run" &&
                actualRoute.selection.id === route.selection.id
              }
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
            projectCreate={projectCreate.state}
            projectCreateOwner={projectCreate.client}
            canCreateProject={recovery?.connection.writesAllowed ?? false}
            home={projects.data}
            error={projects.error}
            loading={projects.loading}
            stale={recovery?.connection.phase !== "connected"}
            held={projects.held}
            writesAllowed={recovery?.connection.writesAllowed ?? false}
            reload={projects.reload}
            change={projects.change}
            onCreated={(created) => {
              setFinishBrief(created);
              window.location.hash = desktopHref({
                projectId: created.projectId,
                destination: "overview",
                selection: null,
              });
            }}
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
            onReviewSession={openSessionReview}
            onReviewShift={openShiftReview}
            onCouncilSummary={() => {
              setKeeperOpen(false);
              if (summary?.workspace)
                openCouncilSource(
                  { sourceType: "text", source: "" },
                  summary.workspace,
                  true,
                );
            }}
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
                onCouncilPrefill={(id) =>
                  beads.data?.workspace &&
                  openCouncilSource(
                    { sourceType: "bead", source: id },
                    beads.data.workspace,
                  )
                }
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
                  originalRequestId={
                    managedSelection.selection?.requestId ?? null
                  }
                  selectionError={managedSelection.error}
                  onOriginalSelect={(requestId) => {
                    window.location.hash = (
                      requestId
                        ? managedShiftHref({
                            projectId: project.id,
                            requestId,
                            sessionId: null,
                          })
                        : desktopHref({
                            projectId: project.id,
                            destination: "workbench",
                            selection: null,
                          })
                    ).slice(1);
                  }}
                />
              )
            }
            selectedId={
              route.selection?.kind === "bead" ? route.selection.id : null
            }
            onCouncilPrefill={(id, workspace) =>
              openCouncilSource({ sourceType: "bead", source: id }, workspace)
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
        ) : route.destination === "reviews" && project ? (
          <ProjectReviews
            key={`${project.id}:${summary?.workspace ?? ""}`}
            projectId={project.id}
            workspace={summary?.workspace ?? null}
            archived={project.archived}
            writesAllowed={writesAllowed}
            draftCache={councilDraftCache.current}
            draftGeneration={councilDraftGeneration}
            focusSource={focusCouncilSource}
            returnOrigin={
              currentCouncilScope
                ? councilReturnMemory.current.get(currentCouncilScope)
                : null
            }
            onReturnToRun={returnToCouncilSourceRun}
            onSourceIdentityChanged={clearCouncilReturnPath}
          />
        ) : route.destination === "runs" && project ? (
          <ProjectRuns
            key={project.id}
            projectId={project.id}
            workspace={summary?.workspace ?? null}
            controller={runs}
            beads={{
              page: beads.data,
              loading: beads.loading,
              error: beads.error,
            }}
            onCouncilArtifactPrefill={openCouncilSource}
            onCouncilBeadPrefill={(source, sourceWorkspace, origin) =>
              openCouncilSource(source, sourceWorkspace, false, origin)
            }
            {...(forgeRunCanOpen ? { onNewForgeRun: openNewForgeRun } : {})}
            returnFocus={
              councilReturnFocus &&
              councilReturnFocusRef.current?.generation ===
                councilReturnFocus.generation &&
              route.destination === "runs" &&
              route.projectId === councilReturnFocus.origin.projectId &&
              route.selection?.kind === "run" &&
              route.selection.id === councilReturnFocus.origin.runSlug &&
              currentCouncilScope &&
              currentCouncilScope.projectId ===
                councilReturnFocus.origin.projectId &&
              currentCouncilScope.workspace ===
                councilReturnFocus.origin.workspace
                ? councilReturnFocus
                : null
            }
            returnFocusNotice={councilReturnNotice}
            onReturnFocusHandled={handleCouncilReturnFocus}
            checkpointReviewOwner={checkpointReviewOwner}
            checkpointReviewsWritable={writesAllowed && !project.archived}
            filters={runFilters.filters}
            filterError={runFilters.error}
            onFilter={(filters) => {
              window.location.hash = runsHref(project.id, null, filters).slice(
                1,
              );
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
            onboardingRequestId={
              finishBrief?.projectId === project.id
                ? finishBrief.requestId
                : undefined
            }
            onFinishFirstBrief={(requestId) =>
              setFinishBrief((current) =>
                current?.requestId === requestId ? null : current,
              )
            }
          />
        ) : route.destination === "sessions" &&
          project &&
          selectedSession &&
          managedSession ? (
          <ManagedShiftSession
            key={`${project.id}:${summary?.workspace}:${selectedSession}`}
            projectId={project.id}
            workspace={summary?.workspace ?? ""}
            sessionId={selectedSession}
            owner={managedSelection.error ? null : selectedOwner}
            {...(observations.project(project.id).data
              ? { metadataAsOf: observations.project(project.id).data!.asOf }
              : {})}
            {...(managedSelection.selection
              ? { expectedRequestId: managedSelection.selection.requestId }
              : {})}
            parent={
              observations.detail(project.id, selectedSession).data?.parent
            }
          />
        ) : route.destination === "sessions" &&
          project &&
          selectedOwnedSession ? (
          <SessionConversation
            key={`${project.id}:${selectedOwnedSession}`}
            projectId={project.id}
            sessionId={selectedOwnedSession}
            client={sessions}
            decisionOwners={chatDecisionOwners}
            forkClient={sessions.fork}
            keeper={keeper}
            writesAllowed={writesAllowed}
            archived={project.archived}
            library={sessionLibrary}
            workspace={summary?.workspace ?? null}
            onContinueToChat={continueToChat}
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
            creates={smithCreates}
            edits={smithEdits}
            routingEdits={smithRoutingEdits}
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
        open={Boolean(
          forgeRunReview &&
            project?.id === forgeRunReview.projectId &&
            summary?.workspace === forgeRunReview.workspace &&
            route.destination === "runs" &&
            window.location.hash === forgeRunReview.routeHash &&
            forgeRouteGeneration.current ===
              forgeRunReview.navigationGeneration &&
            sameForgeRunIdentityScope(
              sessions.currentIdentityScope(),
              forgeRunReview.identityScope,
            ),
        )}
        title={`Prepare forge run · ${project?.name ?? ""}`}
        titleId="af-new-forge-run-title"
        onClose={() => setForgeRunReview(null)}
        returnFocusRef={forgeRunOpener}
        class="af-new-forge-run-dialog"
        initialFocus="content"
      >
        {forgeRunReview && (
          <NewForgeRun
            key={`${forgeRunReview.projectId}:${forgeRunReview.workspace}:${forgeRunReview.routeHash}`}
            projectId={forgeRunReview.projectId}
            workspace={forgeRunReview.workspace}
            beadsPage={beads.data}
            beadsLoading={beads.loading}
            beadsError={beads.error}
            onContinue={continueForgeRunToComposer}
            onReplace={applyForgeRunPrefill}
            onKeep={keepForgeRunDraft}
            onCancel={() => setForgeRunReview(null)}
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
            onOpenOriginal={(id) => {
              setComposerOpen(false);
              window.location.hash = desktopHref({
                projectId: project.id,
                destination: "sessions",
                selection: { kind: "session", id },
              }).slice(1);
            }}
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
              onReviewSession={openSessionReview}
              onReviewShift={openShiftReview}
              onCouncilSummary={() => {
                setKeeperOpen(false);
                if (summary?.workspace)
                  openCouncilSource(
                    { sourceType: "text", source: "" },
                    summary.workspace,
                    true,
                  );
              }}
            />
          </>
        )}
      </Dialog>
      <Dialog
        open={!!sessionReview && sessionReview.source.projectId === project?.id}
        title={`Review Keeper session · ${project?.name ?? ""}`}
        titleId="af-keeper-session-review-title"
        onClose={() => setSessionReview(null)}
        returnFocusRef={reviewOpener}
        class="af-session-dialog"
        initialFocus="content"
      >
        {sessionReview &&
          project &&
          sessionReview.source.projectId === project.id && (
            <>
              <section
                class="af-session-warning"
                aria-label="Keeper proposal source"
              >
                <strong>{sessionReview.source.draft.title}</strong>
                <p>{sessionReview.source.draft.detail}</p>
                <p>
                  Proposal {sessionReview.source.id}. {sessionReview.reason}
                </p>
                {sessionReview.original && (
                  <p>
                    Original Start {sessionReview.original.start.requestId}. The
                    exact reviewed input is frozen; closing this review does not
                    cancel it.
                  </p>
                )}
                {!sessionReview.loaded && (
                  <Button
                    disabled={sessionReview.view.loading}
                    onClick={() => {
                      void reviews.open(sessionReview);
                    }}
                  >
                    Check saved proposal Start
                  </Button>
                )}
                {sessionReview.view.lastStarted && (
                  <Button
                    onClick={() => {
                      const id = sessionReview.view.lastStarted;
                      if (!id) return;
                      setSessionReview(null);
                      setKeeperOpen(false);
                      window.location.hash = desktopHref({
                        projectId: project.id,
                        destination: "sessions",
                        selection: { kind: "session", id },
                      }).slice(1);
                    }}
                  >
                    Open admitted session
                  </Button>
                )}
              </section>
              <ClaudeSessionComposer
                key={`${sessionReview.source.id}:${sessionReview.source.sourceHash}`}
                providers={providers.data}
                project={project}
                client={sessionReview.owner}
                keeper={keeper}
                writesAllowed={writesAllowed}
                onCancel={() => {
                  reviews.close(sessionReview);
                  setSessionReview(null);
                }}
                onStarted={(id) => {
                  setSessionReview(null);
                  setKeeperOpen(false);
                  window.location.hash = desktopHref({
                    projectId: project.id,
                    destination: "sessions",
                    selection: { kind: "session", id },
                  }).slice(1);
                }}
              />
            </>
          )}
      </Dialog>
      <KeeperShiftReviewDialog
        entry={
          shiftReview?.state.source.projectId === project?.id
            ? shiftReview
            : null
        }
        owner={shiftReviews.owner}
        writesAllowed={writesAllowed}
        opener={shiftReviewOpener}
        onClose={closeShiftReview}
      />
    </>
  );
}
