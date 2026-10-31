import type { ChatDecisionActivation } from "./chat-decision-owners";
import type { DesktopRoute } from "./navigation";

export interface ChatDecisionAuthorityScopeInput {
  address: ChatDecisionActivation;
  provider: "codex" | "gemini";
  route: DesktopRoute;
  actualRoute: DesktopRoute;
  project: {
    id: string;
    workspaces: readonly { root: string }[];
  } | null;
  summary: { projectId: string; workspace: string } | null;
  session: {
    id: string;
    projectId: string;
    mode: string;
    provider: string;
  } | null;
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
}: ChatDecisionAuthorityScopeInput): boolean {
  return Boolean(
    route.destination === actualRoute.destination &&
      route.projectId === actualRoute.projectId &&
      route.selection?.kind === actualRoute.selection?.kind &&
      route.selection?.id === actualRoute.selection?.id &&
      route.destination === "sessions" &&
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
}
