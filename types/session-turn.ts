import type { ConversationSend } from "./conversation";
import type {
  ClaudeLaunchCapabilities,
  ClaudeSessionLaunch,
  SessionAttachment,
} from "./session-launch";

/** Public generic-session message; no prepared launch or command is accepted. */
export interface SessionMessage extends ConversationSend {
  attachments?: SessionAttachment[] | undefined;
}

/** Trusted preparation persisted in the owner-only journal before dispatch. */
export interface SessionTurnSnapshot {
  version: 1;
  provider: "claude";
  smith: string;
  cwd: string;
  launch: ClaudeSessionLaunch;
  capabilities: ClaudeLaunchCapabilities;
}
