import type { WorktreeEntry } from "../../../types/beads";
import type { SmithsView } from "../../../types/hearth";
import type { SessionStartRequest } from "../../../types/session-requests";
import type { SessionProjectView } from "./session-client";
import type { SessionComposerDraft } from "./session-composer";
import type { createSessionWorktreeClient } from "./session-worktree-client";

/** One form; ordinary and proposal starts retain separate immutable action owners. */
export interface SessionComposerOwner {
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
      Pick<SessionProjectView, "startIdentity" | "startIdentityError">
    > & {
      inputLocked?: boolean;
      providerUnavailable?: string;
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
  worktrees: ReturnType<typeof createSessionWorktreeClient>;
}
