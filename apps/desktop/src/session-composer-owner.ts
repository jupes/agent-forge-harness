import type { WorktreeEntry } from "../../../types/beads";
import type { OwnedSessionStartInput } from "../../../types/codex-owned-task";
import type { SmithsView } from "../../../types/hearth";
import type { SessionStartRequest } from "../../../types/session-requests";
import type { SessionProjectView } from "./session-client";
import type { SessionComposerDraft } from "./session-composer";
import type { createSessionWorktreeClient } from "./session-worktree-client";

/** One form; ordinary and proposal starts retain separate immutable action owners. */
export interface SessionComposerOwner {
  purpose: "ordinary-session" | "keeper-proposal";
  project(id: string): Pick<
    SessionProjectView,
    | "composer"
    | "loading"
    | "starting"
    | "pendingStart"
    | "notice"
    | "lastStarted"
  > &
    Partial<
      Pick<
        SessionProjectView,
        | "startIdentity"
        | "startIdentityError"
        | "identityPage"
        | "identityLoading"
        | "identityGeneration"
        | "legacyIdentityError"
        | "legacyIdentityUnavailable"
        | "identityInspection"
        | "starting"
      >
    > & {
      inputLocked?: boolean;
      providerUnavailable?: string;
      keeperOriginalKnown?: boolean;
      retryStartAvailable?: boolean;
    };
  chooseComposerProvider?(
    id: string,
    provider: "claude" | "codex" | "gemini",
  ): void;
  editComposer(id: string, update: Partial<SessionComposerDraft>): void;
  initializeComposer?(
    project: { id: string },
    smiths: SmithsView,
    worktrees: WorktreeEntry[],
  ): void;
  start(
    id: string,
    input: Omit<SessionStartRequest, "requestId">,
  ): Promise<void>;
  refresh(id: string): Promise<void>;
  retryStart(id: string): Promise<void>;
  refreshIdentities?(id: string): Promise<void> | undefined;
  inspectIdentity?(id: string, requestId: string): Promise<boolean>;
  retireIdentity?(id: string, requestId: string): Promise<boolean>;
  resumeStart?(id: string, input: OwnedSessionStartInput): Promise<void>;
  worktrees: ReturnType<typeof createSessionWorktreeClient>;
}
