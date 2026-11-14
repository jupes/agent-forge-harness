import { workspaceKey } from "../../../scripts/projects/scope";
import type { CodexChatApprovalPage } from "../../../types/codex-owned-chat";
import type { GeminiChatApprovalPage } from "../../../types/gemini-owned-chat";
import type { CodexChatDecisionIdentity } from "./codex-chat-decision-identities";
import type { GeminiChatDecisionIdentity } from "./gemini-chat-decision-identities";

export type InboxPermissionProvider = "codex" | "gemini";

export interface InboxPermissionAddress {
  projectId: string;
  workspace: string;
  provider: InboxPermissionProvider;
  sessionId: string;
  acceptedTurnId: string;
  offerId: string;
}

export interface InboxCurrentPermissionItem extends InboxPermissionAddress {
  kind: "permission";
  state: "current";
  complete: true;
  key: string;
  actionable: boolean;
  snapshotGeneration: number;
  observedAt: string;
  approval:
    | {
        provider: "codex";
        value: CodexChatApprovalPage["pending"][number]["approval"];
      }
    | {
        provider: "gemini";
        value: GeminiChatApprovalPage["pending"][number]["approval"];
      };
}

export interface InboxHeldPermissionItem extends InboxPermissionAddress {
  kind: "permission";
  state: "held";
  complete: boolean;
  key: string;
  actionable: false;
  snapshotGeneration: number;
  observedAt: string;
  identity: CodexChatDecisionIdentity | GeminiChatDecisionIdentity;
}

export type InboxPermissionItem =
  | InboxCurrentPermissionItem
  | InboxHeldPermissionItem;

/** Synchronous authority facts from the currently selected immutable snapshot row. */
export interface InboxPermissionSelection extends InboxPermissionAddress {
  kind: "permission";
  state: "current" | "held";
  complete: boolean;
  actionable: boolean;
  snapshotGeneration: number;
  currentSnapshotGeneration: number;
  selectionGeneration: number;
  currentSelectionGeneration: number;
}

export type InboxCoverageState =
  | "current"
  | "partial"
  | "unavailable"
  | "unreported";

export interface InboxSessionCoverage {
  projectId: string;
  workspace: string;
  sessionId: string | null;
  provider: InboxPermissionProvider | null;
  state: InboxCoverageState;
  observedAt: string | null;
  reason: string | null;
}

export interface InboxPermissionSnapshot {
  generation: number;
  loading: boolean;
  items: readonly InboxPermissionItem[];
  coverage: readonly InboxSessionCoverage[];
  observedAt: string | null;
}

export function permissionItemKey(address: InboxPermissionAddress): string {
  return JSON.stringify([
    "permission",
    workspaceKey(address.workspace),
    address.projectId,
    address.provider,
    address.sessionId,
    address.acceptedTurnId,
    address.offerId,
  ]);
}

export function permissionSelection(
  item: InboxPermissionItem,
  snapshotGeneration: number,
  currentSnapshotGeneration: number,
  selectionGeneration: number,
  currentSelectionGeneration: number,
): InboxPermissionSelection {
  return {
    kind: "permission",
    state: item.state,
    complete: item.complete,
    actionable: item.actionable,
    snapshotGeneration,
    currentSnapshotGeneration,
    selectionGeneration,
    currentSelectionGeneration,
    projectId: item.projectId,
    workspace: item.workspace,
    provider: item.provider,
    sessionId: item.sessionId,
    acceptedTurnId: item.acceptedTurnId,
    offerId: item.offerId,
  };
}
