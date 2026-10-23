import type { CodexTaskTextAttachment } from "./codex-task";
import type { SessionStartRequest } from "./session-requests";

/** Additive public Task intent. Scope/context/cwd and prepared authority are supplied by the server. */
export interface CodexTaskStartRequest
  extends Omit<SessionStartRequest, "launch"> {
  provider: "codex";
  launch: {
    mode: "task";
    model: string;
    prompt: string;
    sandbox: "read-only" | "workspace-write";
    approvalPolicy: "never";
    effort?: string | undefined;
    attachments?: CodexTaskTextAttachment[] | undefined;
  };
}

/** The original untagged Claude request remains unchanged for saved UUID/hash compatibility. */
export type OwnedSessionStartRequest =
  | SessionStartRequest
  | CodexTaskStartRequest;
