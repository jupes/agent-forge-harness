import type {
  InboxDispositionEntry,
  InboxDispositionOriginal,
  InboxDispositionReceipt,
} from "../../../types/inbox";
import type { OperatorPost } from "../../../docs/js/operator";

export interface InboxDispositionScope {
  projectId: string;
  workspace: string;
}

export interface InboxDispositionRecord {
  entry: InboxDispositionEntry | null;
  receipt: InboxDispositionReceipt;
}

export type InboxDispositionClientResult =
  | { state: "confirmed"; value: InboxDispositionRecord }
  | { state: "not-sent"; message: string }
  | { state: "refused"; message: string }
  | { state: "unknown"; message: string }
  | { state: "unavailable"; message: string };

/** Minimal fail-closed scaffold for the first transport RED. */
export function createInboxDispositionsClient(_deps: {
  post: OperatorPost;
}) {
  return {
    async reserve(
      _scope: InboxDispositionScope,
      _original: InboxDispositionOriginal,
    ): Promise<InboxDispositionClientResult> {
      return {
        state: "unavailable",
        message: "Inbox disposition transport is not available yet.",
      };
    },
  };
}
