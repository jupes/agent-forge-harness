import { expect, test } from "bun:test";
import type {
  InboxDispositionEntry,
  InboxDispositionReceipt,
  InboxDispositionStoredOriginal,
} from "../../../types/inbox";
import type { InboxDispositionHistory } from "./inbox-dispositions-owner";
import type { InboxCurrentPermissionItem } from "./inbox-model";
import {
  bindInboxCardIdentity,
  hasExactPermissionTerminalProof,
  type InboxCard,
  type InboxCoverage,
  type InboxFilters,
  mergeInboxDispositionEntries,
  mergeInboxDispositionHistory,
  projectInbox,
} from "./inbox-view";

const card = (patch: Partial<InboxCard> = {}): InboxCard => ({
  key: "permission-a",
  projectId: "project-a",
  workspace: "C:/work/a",
  projectName: "Alpha",
  sourceKind: "permission",
  stableItemId: "offer-a",
  sourceRevision: "turn-a:offer-a",
  title: "Allow a command",
  detail: "The original offer is current.",
  observedAt: "2026-10-31T12:00:00.000Z",
  sourceState: "current",
  resolved: false,
  canSnooze: true,
  canCheck: false,
  notice: false,
  ...patch,
});
const coverage: InboxCoverage[] = [
  { sourceKind: "permission", state: "current", reason: "Fresh read." },
  { sourceKind: "unknown-bead-write", state: "current", reason: "Fresh read." },
];
const filters: InboxFilters = {
  projectId: "",
  sourceKind: "all",
  bucket: "needs-you",
};
const now = "2026-10-31T12:30:00.000Z";
const snooze = (item: InboxCard, until: string): InboxDispositionEntry => ({
  projectId: item.projectId,
  workspace: item.workspace,
  item: {
    sourceKind: item.sourceKind,
    stableItemId: item.stableItemId,
    sourceRevision: item.sourceRevision,
  },
  revision: 1,
  operation: "snooze-1h",
  updatedAt: now,
  snoozedUntil: until,
});

test("orders newest first and filters by exact project and source kind", () => {
  const older = card({
    key: "older",
    stableItemId: "offer-older",
    observedAt: "2026-10-31T11:00:00.000Z",
  });
  const other = card({
    key: "other",
    projectId: "project-b",
    workspace: "C:/work/b",
    projectName: "Beta",
    observedAt: "2026-10-31T13:00:00.000Z",
  });
  const all = projectInbox({
    cards: [older, other, card()],
    dispositions: [],
    coverage,
    filters,
    now,
  });
  expect(all.cards.map((item) => item.key)).toEqual([
    "other",
    "permission-a",
    "older",
  ]);
  const filtered = projectInbox({
    cards: [older, other, card()],
    dispositions: [],
    coverage,
    filters: { ...filters, projectId: "project-a", sourceKind: "permission" },
    now,
  });
  expect(filtered.cards.map((item) => item.key)).toEqual([
    "permission-a",
    "older",
  ]);
});

test("keeps permission rows visible despite matching saved Snooze and Done dispositions", () => {
  const item = card();
  const savedSnooze = snooze(item, "2026-10-31T13:00:00.000Z");
  const needsYou = projectInbox({
    cards: [item],
    dispositions: [savedSnooze],
    coverage,
    filters,
    now,
  });
  expect(needsYou.cards).toEqual([item]);
  expect(needsYou.visibleCount).toBe(1);

  const snoozedBucket = projectInbox({
    cards: [item],
    dispositions: [savedSnooze],
    coverage,
    filters: { ...filters, bucket: "snoozed" },
    now,
  });
  expect(snoozedBucket.cards).toEqual([]);
  expect(snoozedBucket.visibleCount).toBe(0);

  const resolved = card({
    key: "permission-done",
    stableItemId: "offer-done",
    resolved: true,
  });
  const savedDone: InboxDispositionEntry = {
    projectId: resolved.projectId,
    workspace: resolved.workspace,
    item: {
      sourceKind: resolved.sourceKind,
      stableItemId: resolved.stableItemId,
      sourceRevision: resolved.sourceRevision,
    },
    revision: 1,
    operation: "done",
    updatedAt: now,
  };
  const doneProjection = projectInbox({
    cards: [resolved],
    dispositions: [savedDone],
    coverage,
    filters,
    now,
  });
  expect(doneProjection.cards).toEqual([resolved]);
  expect(doneProjection.visibleCount).toBe(1);
});

test("leaves unknown outcome notices visible while their action card is snoozed", () => {
  const notice = card({
    key: "write-1",
    sourceKind: "unknown-bead-write",
    stableItemId: "write-1",
    sourceRevision: "write:unknown:comment",
    title: "Comment outcome unknown",
    notice: true,
    canCheck: true,
    canSnooze: false,
  });
  const action = {
    ...notice,
    key: "write-1:action",
    title: "Review comment outcome",
    notice: false,
    canCheck: false,
    canSnooze: true,
  };
  const snoozed = projectInbox({
    cards: [notice, action],
    dispositions: [snooze(action, "2026-10-31T13:00:00.000Z")],
    coverage,
    filters,
    now,
  });
  expect(snoozed.cards).toEqual([]);
  expect(snoozed.notices).toEqual([notice]);
  expect(snoozed.visibleCount).toBe(1);
  const snoozedBucket = projectInbox({
    cards: [notice, action],
    dispositions: [snooze(action, "2026-10-31T13:00:00.000Z")],
    coverage,
    filters: { ...filters, bucket: "snoozed" },
    now,
  });
  expect(snoozedBucket.cards).toEqual([action]);
  expect(snoozedBucket.notices).toEqual([notice]);
  expect(snoozedBucket.visibleCount).toBe(1);
});

test("stable identity is independent from source version and keeps permission sessions distinct", async () => {
  const base = card({
    stableItemId: JSON.stringify(["codex", "session-a", "turn-a", "offer-a"]),
    sourceRevision: "version-a",
  });
  const changedVersion = { ...base, sourceRevision: "version-b" };
  const otherSession = {
    ...base,
    stableItemId: JSON.stringify(["codex", "session-b", "turn-a", "offer-a"]),
  };
  const first = await bindInboxCardIdentity(base);
  const nextVersion = await bindInboxCardIdentity(changedVersion);
  const other = await bindInboxCardIdentity(otherSession);
  expect(first.stableItemId).toBe(nextVersion.stableItemId);
  expect(first.sourceRevision).not.toBe(nextVersion.sourceRevision);
  expect(first.stableItemId).not.toBe(other.stableItemId);
  expect(first.stableItemId.length).toBeLessThanOrEqual(200);
  expect(first.sourceRevision.length).toBeLessThanOrEqual(200);
});

test("expires Snooze and never hides stale or unverified source rows", () => {
  const item = card();
  const activeSnooze = snooze(item, "2026-10-31T13:00:00.000Z");
  const expired = projectInbox({
    cards: [item],
    dispositions: [snooze(item, "2026-10-31T12:29:59.000Z")],
    coverage,
    filters,
    now,
  });
  expect(expired.cards).toEqual([item]);
  const stale = card({ sourceState: "unavailable", resolved: true });
  const staleDone: InboxDispositionEntry = {
    projectId: stale.projectId,
    workspace: stale.workspace,
    item: {
      sourceKind: stale.sourceKind,
      stableItemId: stale.stableItemId,
      sourceRevision: stale.sourceRevision,
    },
    revision: 2,
    operation: "done",
    updatedAt: now,
  };
  const retained = projectInbox({
    cards: [stale],
    dispositions: [activeSnooze, staleDone],
    coverage,
    filters,
    now,
  });
  expect(retained.cards).toEqual([stale]);
});

test("does not report a complete or zero Inbox while any producer is unreported", () => {
  const projection = projectInbox({
    cards: [],
    dispositions: [],
    coverage,
    filters,
    now,
  });
  expect(projection.visibleCount).toBe(0);
  expect(projection.complete).toBe(false);
  expect(projection.unreported).toContain("usage-threshold");
  expect(projection.unreported).toHaveLength(7);
});

test("distinguishes retained rows from source-checked rows when coverage is partial", () => {
  const projection = projectInbox({
    cards: [card({ sourceState: "unavailable", canSnooze: false })],
    dispositions: [],
    coverage: [
      {
        sourceKind: "permission",
        state: "unavailable",
        reason: "Protected source is unavailable.",
      },
    ],
    filters,
    now,
  });
  expect(projection.visibleCount).toBe(1);
  expect(projection.verifiedCount).toBe(0);
  expect(projection.complete).toBe(false);
});

test("Done proof is exact to the original permission address and current snapshot", () => {
  const permission: InboxCurrentPermissionItem = {
    kind: "permission",
    state: "current",
    complete: true,
    projectId: "project-a",
    workspace: "C:/work/a",
    provider: "codex",
    sessionId: "session-a",
    acceptedTurnId: "turn-a",
    offerId: "offer-a",
    key: "permission-a",
    actionable: false,
    snapshotGeneration: 8,
    observedAt: now,
    approval: {
      provider: "codex",
      value: {
        id: "offer-a",
        kind: "command",
        command: "bun test",
        cwd: "C:/work/a",
        availableDecisions: ["accept"],
        reason: null,
      },
    },
  };
  const proof = {
    permissionKey: "permission-a",
    projectId: "project-a",
    workspace: "C:/work/a",
    provider: "codex" as const,
    sessionId: "session-a",
    acceptedTurnId: "turn-a",
    offerId: "offer-a",
    snapshotGeneration: 8,
    conversationRevision: 4,
    lastSequence: 3,
    complete: true as const,
    resolved: true as const,
  };
  expect(hasExactPermissionTerminalProof(permission, 8, [proof])).toBe(true);
  expect(hasExactPermissionTerminalProof(permission, 7, [proof])).toBe(false);
  expect(
    hasExactPermissionTerminalProof(permission, 8, [
      { ...proof, sessionId: "session-b" },
    ]),
  ).toBe(false);
  expect(
    hasExactPermissionTerminalProof(permission, 8, [
      { ...proof, offerId: "offer-b" },
    ]),
  ).toBe(false);
  expect(
    hasExactPermissionTerminalProof(permission, 8, [
      { ...proof, projectId: "project-b" },
    ]),
  ).toBe(false);
});

test("disposition history only advances from unknown to reserved to terminal", () => {
  const original: InboxDispositionStoredOriginal = {
    requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1290",
    projectId: "project-a",
    expectedCatalogRevision: 2,
    workspace: "C:/work/a",
    item: {
      sourceKind: "unknown-bead-write",
      stableItemId: "write-a",
      sourceRevision: "write:1",
    },
    expectedRevision: 0,
    operation: "snooze-1h",
  };
  const unknown: InboxDispositionHistory = {
    original,
    state: "reserve-unknown",
  };
  const reserved: InboxDispositionReceipt = {
    original,
    phase: "reserved",
    reservedAt: now,
  };
  const applied: InboxDispositionReceipt = {
    original,
    phase: "applied",
    reservedAt: now,
    settledAt: "2026-10-31T12:31:00.000Z",
    outcome: "applied",
    resultingRevision: 1,
    resultingValue: "snooze-1h",
    snoozedUntil: "2026-10-31T13:31:00.000Z",
  };
  const persisted = mergeInboxDispositionHistory(
    [unknown],
    [{ original, state: "persisted-reserved", receipt: reserved }],
  );
  expect(persisted[0]).toMatchObject({
    state: "persisted-reserved",
    receipt: { phase: "reserved" },
  });
  const mayHaveApplied: InboxDispositionHistory = {
    original,
    state: "apply-unknown",
  };
  expect(
    mergeInboxDispositionHistory([mayHaveApplied], persisted)[0],
  ).toMatchObject({ state: "apply-unknown" });
  const mayHaveDiscarded: InboxDispositionHistory = {
    original,
    state: "discard-unknown",
  };
  expect(
    mergeInboxDispositionHistory([mayHaveDiscarded], persisted)[0],
  ).toMatchObject({ state: "discard-unknown" });
  const terminal = mergeInboxDispositionHistory(persisted, [
    { original, state: "terminal", receipt: applied },
  ]);
  expect(terminal[0]).toMatchObject({
    state: "terminal",
    receipt: { phase: "applied" },
  });
  expect(mergeInboxDispositionHistory(terminal, [unknown])[0]).toMatchObject({
    state: "terminal",
    receipt: { phase: "applied" },
  });
  expect(
    mergeInboxDispositionHistory(terminal, [
      { original: { ...original, operation: "done" }, state: "terminal" },
    ]),
  ).toEqual(terminal);
});

test("an older background collection cannot replace a newer disposition revision", () => {
  const older: InboxDispositionEntry = {
    projectId: "project-a",
    workspace: "C:/work/a",
    item: {
      sourceKind: "permission",
      stableItemId: "offer-a",
      sourceRevision: "offer-revision-a",
    },
    revision: 3,
    operation: "snooze-1h",
    updatedAt: now,
    snoozedUntil: "2026-10-31T13:00:00.000Z",
  };
  const newer: InboxDispositionEntry = {
    ...older,
    revision: 4,
    updatedAt: "2026-10-31T12:31:00.000Z",
    snoozedUntil: "2026-10-31T13:31:00.000Z",
  };
  expect(mergeInboxDispositionEntries([newer], [older])).toEqual([newer]);
  expect(mergeInboxDispositionEntries([older], [newer])).toEqual([newer]);
});
