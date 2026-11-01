import type { InboxDispositionEntry } from "../../../types/inbox";
import { INBOX_SOURCE_KINDS } from "../../../types/inbox";
import type { InboxCurrentPermissionItem, InboxPermissionItem } from "./inbox-model";
import type { InboxTerminalPermissionProof } from "./inbox-client";
import type { InboxDispositionHistory } from "./inbox-dispositions-owner";
import { workspaceKey } from "../../../scripts/projects/scope";

export type InboxSourceKind = (typeof INBOX_SOURCE_KINDS)[number];
export type InboxSourceState =
  | "current"
  | "partial"
  | "unavailable"
  | "unreported";

export function hasExactPermissionTerminalProof(
  item: InboxCurrentPermissionItem,
  snapshotGeneration: number,
  proofs: readonly InboxTerminalPermissionProof[],
): boolean {
  return item.snapshotGeneration === snapshotGeneration && proofs.some((proof) =>
    proof.permissionKey === item.key &&
    proof.snapshotGeneration === snapshotGeneration &&
    proof.projectId === item.projectId &&
    proof.workspace === item.workspace &&
    proof.provider === item.provider &&
    proof.sessionId === item.sessionId &&
    proof.acceptedTurnId === item.acceptedTurnId &&
    proof.offerId === item.offerId &&
    proof.complete && proof.resolved,
  );
}

const dispositionHistoryRank = (state: InboxDispositionHistory["state"]) =>
  state === "terminal"
    ? 4
    : state === "apply-unknown" || state === "discard-unknown"
      ? 3
      : state === "persisted-reserved"
        ? 2
        : 1;

export function mergeInboxDispositionHistory(
  current: readonly InboxDispositionHistory[],
  incoming: readonly InboxDispositionHistory[],
): InboxDispositionHistory[] {
  const merged = new Map<string, InboxDispositionHistory>();
  for (const item of current) merged.set(item.original.requestId, item);
  for (const item of incoming) {
    const prior = merged.get(item.original.requestId);
    if (!prior) {
      merged.set(item.original.requestId, item);
      continue;
    }
    if (JSON.stringify(prior.original) !== JSON.stringify(item.original)) continue;
    if (
      prior.receipt && item.receipt && prior.receipt.phase !== "reserved" &&
      JSON.stringify(prior.receipt) !== JSON.stringify(item.receipt)
    ) continue;
    if (dispositionHistoryRank(item.state) > dispositionHistoryRank(prior.state)) {
      merged.set(item.original.requestId, item);
      continue;
    }
    if (
      dispositionHistoryRank(item.state) === dispositionHistoryRank(prior.state) &&
      !prior.receipt && item.receipt
    ) merged.set(item.original.requestId, item);
  }
  return [...merged.values()];
}

export function mergeInboxDispositionEntries(
  current: readonly InboxDispositionEntry[],
  incoming: readonly InboxDispositionEntry[],
): InboxDispositionEntry[] {
  const merged = new Map<string, InboxDispositionEntry>();
  const identity = (entry: InboxDispositionEntry) => JSON.stringify([
    entry.projectId,
    entry.workspace,
    entry.item.sourceKind,
    entry.item.stableItemId,
    entry.item.sourceRevision,
  ]);
  for (const entry of current) merged.set(identity(entry), entry);
  for (const entry of incoming) {
    const key = identity(entry);
    const prior = merged.get(key);
    if (!prior || entry.revision > prior.revision) merged.set(key, entry);
  }
  return [...merged.values()];
}

export interface InboxCard {
  key: string;
  projectId: string;
  workspace: string;
  projectName: string;
  sourceKind: InboxSourceKind;
  stableItemId: string;
  sourceRevision: string;
  title: string;
  detail: string;
  observedAt: string;
  sourceState: InboxSourceState;
  resolved: boolean;
  canSnooze: boolean;
  canCheck: boolean;
  checkHref?: string;
  checkLabel?: string;
  writePhase?: "done" | "refused" | "unknown";
  permissionProvider?: "codex" | "gemini";
  permission?: InboxPermissionItem;
  permissionKey?: string;
  unknownWriteKey?: string;
  notice: boolean;
}

export interface InboxCoverage {
  sourceKind: InboxSourceKind;
  state: InboxSourceState;
  reason: string;
}

export interface InboxFilters {
  projectId: string;
  sourceKind: InboxSourceKind | "all";
  bucket: "needs-you" | "snoozed";
}

export interface InboxProjection {
  cards: readonly InboxCard[];
  notices: readonly InboxCard[];
  visibleCount: number;
  verifiedCount: number;
  complete: boolean;
  unreported: readonly InboxSourceKind[];
}

const identity = (card: InboxCard) =>
  JSON.stringify([
    workspaceKey(card.workspace),
    card.projectId,
    card.sourceKind,
    card.stableItemId,
  ]);

/** Hashes the complete canonical tuple and source revision into a bounded app identity. */
export async function bindInboxCardIdentity(card: InboxCard): Promise<InboxCard> {
  const canonicalTuple = JSON.stringify([
    workspaceKey(card.workspace),
    card.projectId,
    card.sourceKind,
    card.stableItemId,
  ]);
  const digest = async (value: string) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };
  const stableItemId = `sha256:${await digest(canonicalTuple)}`;
  const sourceRevision = `sha256:${await digest(JSON.stringify([card.sourceKind, card.sourceRevision]))}`;
  return { ...card, key: stableItemId, stableItemId, sourceRevision };
}

function dispositionFor(card: InboxCard, entries: readonly InboxDispositionEntry[]) {
  return entries.find(
    (entry) =>
      entry.projectId === card.projectId &&
      entry.workspace === card.workspace &&
      entry.item.sourceKind === card.sourceKind &&
      entry.item.stableItemId === card.stableItemId &&
      entry.item.sourceRevision === card.sourceRevision,
  );
}

export function projectInbox(input: {
  cards: readonly InboxCard[];
  dispositions: readonly InboxDispositionEntry[];
  coverage: readonly InboxCoverage[];
  filters: InboxFilters;
  now: string;
}): InboxProjection {
  const deduped = new Map<string, InboxCard>();
  for (const card of input.cards) {
    const key = JSON.stringify([identity(card), card.notice ? "notice" : "action"]);
    const prior = deduped.get(key);
    if (!prior || card.observedAt > prior.observedAt) deduped.set(key, card);
  }
  const visible = [...deduped.values()]
    .map((card) => ({
      card,
      disposition: dispositionFor(card, input.dispositions),
    }))
    .filter(({ card, disposition }) => {
      if (card.notice) return false;
      if (input.filters.projectId && card.projectId !== input.filters.projectId)
        return false;
      if (
        input.filters.sourceKind !== "all" &&
        card.sourceKind !== input.filters.sourceKind
      )
        return false;
      const current = card.sourceState === "current";
      const snoozed = Boolean(
        current &&
          disposition?.operation === "snooze-1h" &&
          disposition.snoozedUntil &&
          Date.parse(disposition.snoozedUntil) > Date.parse(input.now),
      );
      if (disposition?.operation === "done" && current && card.resolved)
        return false;
      return input.filters.bucket === "snoozed" ? snoozed : !snoozed;
    })
    .sort(
      (a, b) =>
        b.card.observedAt.localeCompare(a.card.observedAt) ||
        a.card.projectName.localeCompare(b.card.projectName) ||
        a.card.title.localeCompare(b.card.title),
    );
  const notices = [...deduped.values()]
    .filter((card) => card.notice)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const visibleIdentities = new Set([
    ...visible.map(({ card }) => identity(card)),
    ...notices.map(identity),
  ]);
  const verifiedIdentities = new Set([
    ...visible.filter(({ card }) => card.sourceState === "current").map(({ card }) => identity(card)),
    ...notices.filter((card) => card.sourceState === "current").map(identity),
  ]);
  const unreported = INBOX_SOURCE_KINDS.filter(
    (kind) => !input.coverage.some((entry) => entry.sourceKind === kind),
  );
  const incomplete = input.coverage.some(
    (entry) => entry.state !== "current",
  );
  return {
    cards: visible.map(({ card }) => card),
    notices,
    visibleCount: visibleIdentities.size,
    verifiedCount: verifiedIdentities.size,
    complete: unreported.length === 0 && !incomplete,
    unreported,
  };
}
