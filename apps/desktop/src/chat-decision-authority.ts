import type { ChatDecisionActivation } from "./chat-decision-owners";
import type { DesktopRoute } from "./navigation";
import { workspaceKey } from "../../../scripts/projects/scope";
import type { InboxPermissionSelection } from "./inbox-model";

export interface ChatDecisionAuthorityScopeInput {
  address: ChatDecisionActivation;
  provider: "codex" | "gemini";
  route: DesktopRoute;
  actualRoute: DesktopRoute;
  project: {
    id: string;
    workspaces: readonly { root: string }[];
  } | null;
  summary: {
    projectId: string;
    workspace: string;
    complete?: boolean;
    sessionsComplete?: boolean;
    problems?: readonly unknown[];
  } | null;
  session: {
    id: string;
    projectId: string;
    mode: string;
    provider: string;
    workspace?: string;
  } | null;
  sessionList: { loaded: boolean; loading: boolean; error: string } | null;
  inboxSelection: InboxPermissionSelection | null;
}

/** The current root owner is scoped only to the exact selected chat session. */
export function chatDecisionAuthorityScopeIsCurrent({
  address,
  provider,
  route,
  actualRoute,
  project,
  summary,
  session,
  sessionList,
  inboxSelection,
}: ChatDecisionAuthorityScopeInput): boolean {
  const routeMatches =
    route.destination === actualRoute.destination &&
    route.projectId === actualRoute.projectId &&
    route.selection?.kind === actualRoute.selection?.kind &&
    route.selection?.id === actualRoute.selection?.id;
  const selectedSessionMatches = Boolean(
    route.projectId === address.projectId &&
      route.selection?.kind === "session" &&
      route.selection.id === address.sessionId &&
      project?.id === address.projectId &&
      summary?.projectId === address.projectId &&
      summary.workspace === address.workspace &&
      project.workspaces.some((scope) => scope.root === address.workspace) &&
      session?.projectId === address.projectId &&
      session.id === address.sessionId &&
      session.mode === "chat" &&
      session.provider === provider,
  );
  if (!routeMatches) return false;
  if (route.destination === "sessions") return selectedSessionMatches;
  return Boolean(
      route.destination === "inbox" &&
      project?.id === address.projectId &&
      project.workspaces.some(
        (scope) => workspaceKey(scope.root) === workspaceKey(address.workspace),
      ) &&
      summary?.projectId === address.projectId &&
      workspaceKey(summary.workspace) === workspaceKey(address.workspace) &&
      summary?.complete === true &&
      summary.sessionsComplete === true &&
      summary.problems?.length === 0 &&
      sessionList?.loaded === true &&
      sessionList.loading === false &&
      sessionList.error === "" &&
      session?.id === address.sessionId &&
      session.projectId === address.projectId &&
      session.mode === "chat" &&
      session.provider === provider &&
      (!session.workspace ||
        workspaceKey(session.workspace) === workspaceKey(address.workspace)) &&
      inboxSelection?.kind === "permission" &&
      inboxSelection.complete &&
      address.inboxSelectionGeneration !== undefined &&
      address.inboxSelectionGeneration === inboxSelection.selectionGeneration &&
      inboxSelection.snapshotGeneration ===
        inboxSelection.currentSnapshotGeneration &&
      inboxSelection.selectionGeneration ===
        inboxSelection.currentSelectionGeneration &&
      inboxSelection.projectId === address.projectId &&
      workspaceKey(inboxSelection.workspace) === workspaceKey(address.workspace) &&
      inboxSelection.provider === provider &&
      inboxSelection.sessionId === address.sessionId &&
      inboxSelection.acceptedTurnId === address.acceptedTurnId &&
      inboxSelection.acceptedTurnId === address.turnRequestId &&
      inboxSelection.offerId === address.requestId &&
      (inboxSelection.state === "current" || inboxSelection.state === "held"),
  );
}
