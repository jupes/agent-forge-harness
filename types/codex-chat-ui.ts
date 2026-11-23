import type { serializeCodexChat } from "../scripts/sessions/codex-app-server-protocol";
import type { PreparedCodexChat } from "./codex-chat";

/** A checked native Chat protocol plan; it grants no session or execution authority. */
export interface CodexChatPreviewReceipt {
  provider: "codex";
  mode: "chat";
  projectId: string;
  requestId: string;
  snapshot: PreparedCodexChat;
  serialized: ReturnType<typeof serializeCodexChat>;
}
