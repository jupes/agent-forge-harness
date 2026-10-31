import type {
  InboxDispositionEntry,
  InboxDispositionOriginal,
  InboxDispositionReceipt,
  InboxDispositionStoredOriginal,
} from "../../../types/inbox";
import {
  createInboxDispositionsClient,
  type InboxDispositionCollection,
  type InboxDispositionRecord,
  type InboxDispositionResult,
  type InboxDispositionScope,
} from "./inbox-dispositions-client";

type Item = InboxDispositionOriginal["item"];
type Client = ReturnType<typeof createInboxDispositionsClient>;
type HistoryState = "reserve-unknown" | "apply-unknown" | "discard-unknown" | "persisted-reserved" | "terminal";

export interface InboxDispositionSourceProof {
  scope: InboxDispositionScope;
  item: Item;
  sourceGeneration: number;
  catalogRevision: number;
  expectedRevision: number;
  complete: boolean;
  fresh: boolean;
  resolved: boolean;
}
export interface InboxDispositionActivation {
  scope: InboxDispositionScope;
  generation: number;
  sourceGeneration: number;
  writable: boolean;
}
export interface InboxDispositionSnapshot {
  activation: InboxDispositionActivation;
  sources: readonly InboxDispositionSourceProof[];
}
export interface InboxDispositionHistory {
  original: InboxDispositionStoredOriginal;
  state: HistoryState;
  receipt?: InboxDispositionReceipt;
}
export interface InboxDispositionView {
  scope: InboxDispositionScope | null;
  entries: InboxDispositionEntry[];
  receipts: InboxDispositionReceipt[];
  holds: InboxDispositionStoredOriginal[];
  history: InboxDispositionHistory[];
  loading: boolean;
  error: string;
  collectionReady: boolean;
  recoveryReady: boolean;
}

const scopeKey = (scope: InboxDispositionScope) => JSON.stringify([scope.projectId, scope.workspace]);
const itemKey = (scope: InboxDispositionScope, item: Item) => JSON.stringify([scope.projectId, scope.workspace, item.sourceKind, item.stableItemId]);
const entryKey = (entry: InboxDispositionEntry) => JSON.stringify([entry.projectId, entry.workspace, entry.item.sourceKind, entry.item.stableItemId, entry.item.sourceRevision]);
const originalEntryKey = (original: InboxDispositionStoredOriginal) => JSON.stringify([original.projectId, original.workspace, original.item.sourceKind, original.item.stableItemId, original.item.sourceRevision]);
const sameOriginal = (a: InboxDispositionStoredOriginal, b: InboxDispositionStoredOriginal) =>
  a.requestId === b.requestId && a.projectId === b.projectId && a.expectedCatalogRevision === b.expectedCatalogRevision &&
  a.workspace === b.workspace && a.item.sourceKind === b.item.sourceKind && a.item.stableItemId === b.item.stableItemId &&
  a.item.sourceRevision === b.item.sourceRevision && a.expectedRevision === b.expectedRevision && a.operation === b.operation;
const wireOriginal = (original: InboxDispositionStoredOriginal): InboxDispositionOriginal => ({
  requestId: original.requestId,
  expectedCatalogRevision: original.expectedCatalogRevision,
  workspace: original.workspace,
  item: { ...original.item },
  expectedRevision: original.expectedRevision,
  operation: original.operation,
});
const copyOriginal = (original: InboxDispositionStoredOriginal): InboxDispositionStoredOriginal => ({ ...wireOriginal(original), projectId: original.projectId });
const copyReceipt = (receipt: InboxDispositionReceipt): InboxDispositionReceipt => ({ ...receipt, original: copyOriginal(receipt.original) });
const copyEntry = (entry: InboxDispositionEntry): InboxDispositionEntry => ({ ...entry, item: { ...entry.item } });
const copyProof = (proof: InboxDispositionSourceProof): InboxDispositionSourceProof => ({ ...proof, scope: { ...proof.scope }, item: { ...proof.item } });
const sameProof = (a: InboxDispositionSourceProof, b: InboxDispositionSourceProof) =>
  scopeKey(a.scope) === scopeKey(b.scope) && JSON.stringify(a.item) === JSON.stringify(b.item) &&
  a.sourceGeneration === b.sourceGeneration && a.catalogRevision === b.catalogRevision &&
  a.expectedRevision === b.expectedRevision && a.complete && b.complete && a.fresh && b.fresh && a.resolved === b.resolved;

export function createInboxDispositionsOwner(deps: {
  client: Client;
  currentSnapshot(): InboxDispositionSnapshot | null;
}) {
  let activation: InboxDispositionActivation | null = null;
  let boundClient = deps.client;
  let boundIdentity = deps.client.bindingIdentity;
  let collection: InboxDispositionCollection = { entries: [], receipts: [] };
  let loading = false;
  let error = "";
  let generation = 0;
  let writeInFlight = false;
  let collectionFor: { scope: string; activation: number; binding: object } | null = null;
  let recoveryFor: { activation: number; sourceGeneration: number; binding: object } | null = null;
  const exactChecks = new Map<string, { original: InboxDispositionStoredOriginal; activation: number; binding: object }>();
  const allReceipts = new Map<string, InboxDispositionReceipt>();
  const unresolved = new Map<string, InboxDispositionStoredOriginal>();
  const history = new Map<string, InboxDispositionHistory>();
  const reserveOnlyUnknown = new Set<string>();
  const applyOrDiscardPossible = new Set<string>();
  const permits = new Map<string, { proof: InboxDispositionSourceProof; oldItemKey: string }>();

  const bound = () => deps.client === boundClient && deps.client.bindingIdentity === boundIdentity;
  const view = (): InboxDispositionView => ({
    scope: activation?.scope ? { ...activation.scope } : null,
    entries: collection.entries.map(copyEntry),
    receipts: collection.receipts.map(copyReceipt),
    holds: [...unresolved.values()].map(copyOriginal),
    history: [...history.values()].map((item) => ({ ...item, original: copyOriginal(item.original), ...(item.receipt ? { receipt: copyReceipt(item.receipt) } : {}) })),
    loading,
    error,
    collectionReady: !!activation && bound() && !!collectionFor && collectionFor.scope === scopeKey(activation.scope) && collectionFor.activation === activation.generation && collectionFor.binding === boundIdentity,
    recoveryReady: !!activation && bound() && !!recoveryFor && recoveryFor.activation === activation.generation && recoveryFor.sourceGeneration === activation.sourceGeneration && recoveryFor.binding === boundIdentity,
  });
  const settleWrite = () => {
    writeInFlight = false;
    generation++;
    collectionFor = null;
    recoveryFor = null;
    if (loading) {
      loading = false;
      error = "An Inbox write settled during refresh; refresh again before acting.";
    }
  };
  const current = (capture: InboxDispositionActivation, client: Client, identity: object) => activation === capture && deps.client === client && client.bindingIdentity === identity && boundClient === client && boundIdentity === identity;
  const latestSnapshot = (capture: InboxDispositionActivation, client: Client, identity: object) => {
    if (!current(capture, client, identity) || !capture.writable) return null;
    let snapshot: InboxDispositionSnapshot | null;
    try { snapshot = deps.currentSnapshot(); } catch { return null; }
    if (!snapshot || !snapshot.activation.writable || snapshot.activation.generation !== capture.generation ||
      snapshot.activation.sourceGeneration !== capture.sourceGeneration || scopeKey(snapshot.activation.scope) !== scopeKey(capture.scope)) return null;
    return snapshot;
  };
  const currentAuthority = (capture: InboxDispositionActivation, client: Client, identity: object) => latestSnapshot(capture, client, identity) !== null;
  const findCurrentProof = (proof: InboxDispositionSourceProof, capture: InboxDispositionActivation, client: Client, identity: object) => {
    if (proof.sourceGeneration !== capture.sourceGeneration || scopeKey(capture.scope) !== scopeKey(proof.scope)) return false;
    const snapshot = latestSnapshot(capture, client, identity);
    if (!snapshot) return false;
    return !!snapshot?.sources.some((candidate) => sameProof(candidate, proof));
  };
  const ready = (capture: InboxDispositionActivation, client: Client, identity: object) =>
    current(capture, client, identity) && !!recoveryFor && recoveryFor.activation === capture.generation &&
    recoveryFor.sourceGeneration === capture.sourceGeneration && recoveryFor.binding === identity && !!collectionFor &&
    collectionFor.scope === scopeKey(capture.scope) && collectionFor.activation === capture.generation && collectionFor.binding === identity;
  const prunePermits = () => {
    let snapshot: InboxDispositionSnapshot | null;
    try { snapshot = deps.currentSnapshot(); } catch { permits.clear(); return; }
    for (const [id, permission] of permits) {
      if (!activation || !bound() || !snapshot || !snapshot.activation.writable ||
        snapshot.activation.generation !== activation.generation || snapshot.activation.sourceGeneration !== activation.sourceGeneration ||
        scopeKey(snapshot.activation.scope) !== scopeKey(activation.scope) ||
        !snapshot.sources.some((candidate) => sameProof(candidate, permission.proof))) permits.delete(id);
    }
  };
  const reconcile = (receipt: InboxDispositionReceipt, state: HistoryState) => {
    const original = receipt.original;
    const prior = history.get(original.requestId);
    const saved = allReceipts.get(original.requestId);
    if (prior && !sameOriginal(prior.original, original)) return false;
    if (saved && !sameOriginal(saved.original, original)) return false;
    const previousReceipt = prior?.receipt ?? saved;
    if (previousReceipt && previousReceipt.phase !== "reserved" &&
      (receipt.phase === "reserved" || JSON.stringify(previousReceipt) !== JSON.stringify(receipt))) return false;
    const known = unresolved.get(original.requestId);
    if (known && !sameOriginal(known, original)) return false;
    allReceipts.set(original.requestId, copyReceipt(receipt));
    const preservedUnknown = prior && (prior.state === "apply-unknown" || prior.state === "discard-unknown")
      ? prior.state
      : null;
    const nextState = receipt.phase === "reserved" ? preservedUnknown ?? state : "terminal";
    history.set(original.requestId, { original: copyOriginal(original), state: nextState, receipt: copyReceipt(receipt) });
    if (receipt.phase === "reserved") unresolved.set(original.requestId, copyOriginal(original));
    else {
      unresolved.delete(original.requestId);
      exactChecks.delete(original.requestId);
      reserveOnlyUnknown.delete(original.requestId);
      applyOrDiscardPossible.delete(original.requestId);
    }
    return true;
  };
  const compatible = (receipt: InboxDispositionReceipt) => {
    const prior = history.get(receipt.original.requestId);
    const saved = allReceipts.get(receipt.original.requestId);
    const known = unresolved.get(receipt.original.requestId);
    if ((prior && !sameOriginal(prior.original, receipt.original)) || (saved && !sameOriginal(saved.original, receipt.original)) || (known && !sameOriginal(known, receipt.original))) return false;
    const previousReceipt = prior?.receipt ?? saved;
    return !previousReceipt || previousReceipt.phase === "reserved" ||
      (receipt.phase !== "reserved" && JSON.stringify(previousReceipt) === JSON.stringify(receipt));
  };
  const markUnknown = (original: InboxDispositionStoredOriginal, state: Extract<HistoryState, "reserve-unknown" | "apply-unknown" | "discard-unknown">) => {
    const previous = history.get(original.requestId);
    const saved = allReceipts.get(original.requestId);
    if ((previous && (!sameOriginal(previous.original, original) || previous.state === "terminal")) || (saved && saved.phase !== "reserved")) return false;
    history.set(original.requestId, { original: copyOriginal(original), state, ...(previous?.receipt ? { receipt: copyReceipt(previous.receipt) } : {}) });
    unresolved.set(original.requestId, copyOriginal(original));
    return true;
  };
  const rememberVisible = (saved: InboxDispositionRecord, capture: InboxDispositionActivation, client: Client, identity: object) => {
    if (!current(capture, client, identity) || saved.receipt.original.projectId !== capture.scope.projectId || saved.receipt.original.workspace !== capture.scope.workspace) return;
    const entry = saved.entry;
    collection = {
      entries: entry ? [...collection.entries.filter((item) => entryKey(item) !== entryKey(entry)), copyEntry(entry)] : collection.entries.filter((item) => entryKey(item) !== originalEntryKey(saved.receipt.original)),
      receipts: [...collection.receipts.filter((item) => item.original.requestId !== saved.receipt.original.requestId), copyReceipt(saved.receipt)],
    };
  };
  const otherHolds = (requestId?: string) => [...unresolved.values()].filter((original) => original.requestId !== requestId);

  return {
    activate(next: InboxDispositionActivation | null) {
      generation++;
      boundClient = deps.client;
      boundIdentity = deps.client.bindingIdentity;
      activation = next ? { ...next, scope: { ...next.scope } } : null;
      permits.clear();
      collection = { entries: [], receipts: [] };
      collectionFor = null;
      recoveryFor = null;
      exactChecks.clear();
      loading = false;
      error = "";
      return view();
    },
    view,
    async refresh() {
      const capture = activation;
      const client = boundClient;
      const identity = boundIdentity;
      if (!capture || !current(capture, client, identity)) return view();
      const read = ++generation;
      loading = true;
      collectionFor = null;
      recoveryFor = null;
      error = "";
      const recovery = await client.recovery();
      if (read !== generation || !current(capture, client, identity)) return view();
      if (recovery.state !== "confirmed") {
        loading = false;
        error = recovery.state === "missing" ? "The Inbox recovery inventory is unavailable." : recovery.message;
        return view();
      }
      if (recovery.value.some((receipt) => !compatible(receipt))) {
        loading = false;
        error = "The complete Inbox recovery inventory conflicts with a retained original.";
        return view();
      }
      for (const receipt of recovery.value) {
        const state: HistoryState = receipt.phase === "reserved" ? "persisted-reserved" : "terminal";
        if (!reconcile(receipt, state)) {
          loading = false;
          error = "The complete Inbox recovery inventory conflicts with a retained original.";
          return view();
        }
      }
      recoveryFor = { activation: capture.generation, sourceGeneration: capture.sourceGeneration, binding: identity };
      const scoped = await client.collection(capture.scope);
      if (read !== generation || !current(capture, client, identity)) return view();
      loading = false;
      if (scoped.state !== "confirmed") {
        collectionFor = null;
        error = scoped.state === "missing" ? "The Inbox collection is unavailable." : scoped.message;
        return view();
      }
      const inventoryById = new Map(recovery.value.map((receipt) => [receipt.original.requestId, receipt]));
      const globalForScope = recovery.value.filter((receipt) => receipt.original.projectId === capture.scope.projectId && receipt.original.workspace === capture.scope.workspace);
      if (globalForScope.length !== scoped.value.receipts.length || scoped.value.receipts.some((receipt) => {
        const all = inventoryById.get(receipt.original.requestId);
        return !all || !sameOriginal(all.original, receipt.original) || JSON.stringify(all) !== JSON.stringify(receipt);
      }) || globalForScope.some((receipt) => !scoped.value.receipts.some((local) => local.original.requestId === receipt.original.requestId && JSON.stringify(local) === JSON.stringify(receipt)))) {
        collectionFor = null;
        error = "The Inbox collection conflicts with its complete recovery inventory.";
        return view();
      }
      collection = { entries: scoped.value.entries.map(copyEntry), receipts: scoped.value.receipts.map(copyReceipt) };
      collectionFor = { scope: scopeKey(capture.scope), activation: capture.generation, binding: identity };
      error = "";
      return view();
    },
    createOriginal(proof: InboxDispositionSourceProof, operation: InboxDispositionOriginal["operation"]) {
      const capture = activation;
      const capturedProof = copyProof(proof);
      if (!capture || !findCurrentProof(capturedProof, capture, boundClient, boundIdentity)) return null;
      return boundClient.mintOriginal(capturedProof.scope, { expectedCatalogRevision: capturedProof.catalogRevision, item: { ...capturedProof.item }, expectedRevision: capturedProof.expectedRevision, operation });
    },
    async acknowledge(proof: InboxDispositionSourceProof, operation: InboxDispositionOriginal["operation"]): Promise<InboxDispositionResult<InboxDispositionRecord>> {
      const capture = activation;
      const client = boundClient;
      const identity = boundIdentity;
      const capturedProof = copyProof(proof);
      prunePermits();
      const reviewed = [...permits.entries()].find(([, permission]) => sameProof(permission.proof, capturedProof));
      const reviewedId = reviewed?.[0];
      if (capture && !writeInFlight && !reviewed && unresolved.size > 0)
        return { state: "refused", message: "An unresolved Inbox original must be checked before another item can be acknowledged." };
      if (!capture || writeInFlight || !ready(capture, client, identity) || !findCurrentProof(capturedProof, capture, client, identity) || (operation === "done" && !capturedProof.resolved))
        return { state: "not-sent", message: "The Inbox item, recovery inventory, or write authority changed before reservation." };
      if (otherHolds(reviewedId).length || (!reviewed && [...unresolved.values()].some((held) => itemKey({ projectId: held.projectId, workspace: held.workspace }, held.item) === itemKey(capturedProof.scope, capturedProof.item))))
        return { state: "refused", message: "An unresolved Inbox original already holds this item." };
      const savedEntry = collection.entries.find((entry) => itemKey({ projectId: entry.projectId, workspace: entry.workspace }, entry.item) === itemKey(capturedProof.scope, capturedProof.item) && entry.item.sourceRevision === capturedProof.item.sourceRevision);
      if ((savedEntry?.revision ?? 0) !== capturedProof.expectedRevision)
        return { state: "refused", message: "The saved Inbox disposition changed; refresh before acknowledging this item." };
      let original: InboxDispositionOriginal;
      try { original = client.mintOriginal(capturedProof.scope, { expectedCatalogRevision: capturedProof.catalogRevision, item: { ...capturedProof.item }, expectedRevision: capturedProof.expectedRevision, operation }); }
      catch { return { state: "not-sent", message: "The Inbox intent could not be captured safely." }; }
      if (unresolved.has(original.requestId) || allReceipts.has(original.requestId) || (reviewed && original.requestId === reviewed[0]))
        return { state: "not-sent", message: "A new Inbox action requires a distinct unused request id." };
      const stored: InboxDispositionStoredOriginal = { ...original, projectId: capturedProof.scope.projectId, item: { ...original.item } };
      if (reviewed) permits.delete(reviewed[0]);
      markUnknown(stored, "reserve-unknown");
      generation++;
      loading = false;
      collectionFor = null;
      writeInFlight = true;
      let reserved: InboxDispositionResult<InboxDispositionRecord>;
      try { reserved = await client.reserve(capturedProof.scope, original); }
      finally { settleWrite(); }
      if (reserved.state === "unknown") reserveOnlyUnknown.add(original.requestId);
      if (reserved.state === "not-sent" || reserved.state === "refused" && !reserved.value) {
        unresolved.delete(original.requestId);
        history.delete(original.requestId);
      }
      if ((reserved.state === "confirmed" || reserved.state === "refused" && reserved.value) && reserved.value) {
        if (!reconcile(reserved.value.receipt, reserved.value.receipt.phase === "reserved" ? "persisted-reserved" : "terminal"))
          return { state: "unknown", message: "The reserve reply conflicts with an immutable retained receipt." };
        rememberVisible(reserved.value, capture, client, identity);
      }
      if (reserved.state !== "confirmed" || reserved.value.receipt.phase !== "reserved" || !sameOriginal(reserved.value.receipt.original, stored)) return reserved;
      if (!findCurrentProof(capturedProof, capture, client, identity) || otherHolds(original.requestId).some((held) => held.requestId !== reviewedId))
        return { state: "not-sent", message: "The exact reserved original remains held because fresh source, collection, or write authority changed." };
      if (writeInFlight) return { state: "not-sent", message: "Another Inbox write is in progress; the reservation remains held." };
      writeInFlight = true;
      applyOrDiscardPossible.add(original.requestId);
      markUnknown(stored, "apply-unknown");
      let applied: InboxDispositionResult<InboxDispositionRecord>;
      try { applied = await client.apply(capturedProof.scope, original); }
      finally { settleWrite(); }
      if (applied.state === "not-sent") applyOrDiscardPossible.delete(original.requestId);
      if ((applied.state === "confirmed" || applied.state === "refused" && applied.value) && applied.value) {
        if (!reconcile(applied.value.receipt, applied.value.receipt.phase === "reserved" ? "apply-unknown" : "terminal"))
          return { state: "unknown", message: "The apply reply conflicts with an immutable retained receipt." };
        rememberVisible(applied.value, capture, client, identity);
      }
      return applied;
    },
    async checkOriginal(requestId: string): Promise<InboxDispositionResult<InboxDispositionRecord>> {
      const capture = activation;
      const client = boundClient;
      const identity = boundIdentity;
      const original = unresolved.get(requestId);
      if (!capture || !current(capture, client, identity) || !original || original.projectId !== capture.scope.projectId || original.workspace !== capture.scope.workspace)
        return { state: "unavailable", message: "The exact Inbox original is not available in this served scope." };
      const read = ++generation;
      const result = await client.original(capture.scope, requestId);
      if (read === generation && current(capture, client, identity) && result.state === "confirmed" && sameOriginal(result.value.receipt.original, original)) {
        if (!reconcile(result.value.receipt, result.value.receipt.phase === "reserved" ? "persisted-reserved" : "terminal"))
          return { state: "unknown", message: "The exact Inbox reply conflicts with the immutable retained receipt." };
        rememberVisible(result.value, capture, client, identity);
        if (result.value.receipt.phase === "reserved") exactChecks.set(requestId, { original: copyOriginal(result.value.receipt.original), activation: capture.generation, binding: identity });
      } else if (result.state === "confirmed") return { state: "unknown", message: "The exact Inbox reply did not match its retained original." };
      return result;
    },
    async discard(candidate: InboxDispositionOriginal): Promise<InboxDispositionResult<InboxDispositionRecord>> {
      const capture = activation;
      const client = boundClient;
      const identity = boundIdentity;
      const held = unresolved.get(candidate.requestId);
      const prior = allReceipts.get(candidate.requestId);
      const exact = exactChecks.get(candidate.requestId);
      const exactCurrent = !!exact && exact.activation === capture?.generation && exact.binding === identity && sameOriginal(exact.original, held ?? exact.original);
      if (!capture || !current(capture, client, identity) || !capture.writable || writeInFlight || !held || !prior || prior.phase !== "reserved" ||
        (!ready(capture, client, identity) && !exactCurrent) ||
        held.projectId !== capture.scope.projectId || held.workspace !== capture.scope.workspace ||
        !sameOriginal(held, { ...candidate, projectId: held.projectId }))
        return { state: "not-sent", message: "Only the exact confirmed reserved original in this served scope may be discarded." };
      const wire = wireOriginal(held);
      if (!currentAuthority(capture, client, identity))
        return { state: "not-sent", message: "The Inbox scope or write authority changed before discard." };
      generation++;
      loading = false;
      collectionFor = null;
      writeInFlight = true;
      exactChecks.delete(candidate.requestId);
      applyOrDiscardPossible.add(candidate.requestId);
      markUnknown(held, "discard-unknown");
      let result: InboxDispositionResult<InboxDispositionRecord>;
      try { result = await client.discard({ projectId: held.projectId, workspace: held.workspace }, wire); }
      finally { settleWrite(); }
      if (result.state === "not-sent") applyOrDiscardPossible.delete(candidate.requestId);
      if ((result.state === "confirmed" || result.state === "refused" && result.value) && result.value) {
        if (!reconcile(result.value.receipt, result.value.receipt.phase === "reserved" ? "discard-unknown" : "terminal"))
          return { state: "unknown", message: "The discard reply conflicts with an immutable retained receipt." };
        rememberVisible(result.value, capture, client, identity);
      }
      return result;
    },
    async reviewReserveUnknown(candidate: InboxDispositionOriginal, proof: InboxDispositionSourceProof) {
      const capture = activation;
      const client = boundClient;
      const identity = boundIdentity;
      const capturedProof = copyProof(proof);
      permits.clear();
      collectionFor = null;
      recoveryFor = null;
      const read = ++generation;
      const held = unresolved.get(candidate.requestId);
      if (writeInFlight || !capture || !current(capture, client, identity) || !held || !reserveOnlyUnknown.has(candidate.requestId) || applyOrDiscardPossible.has(candidate.requestId) ||
        !sameOriginal(held, { ...candidate, projectId: held.projectId }) ||
        itemKey({ projectId: held.projectId, workspace: held.workspace }, held.item) !== itemKey(capturedProof.scope, capturedProof.item) ||
        !findCurrentProof(capturedProof, capture, client, identity)) return { state: "unavailable" as const };
      const recovery = await client.recovery();
      if (read !== generation || !current(capture, client, identity) || !findCurrentProof(capturedProof, capture, client, identity) || recovery.state !== "confirmed") return { state: "unavailable" as const };
      if (recovery.value.some((receipt) => !compatible(receipt))) return { state: "held" as const };
      for (const receipt of recovery.value) if (!reconcile(receipt, receipt.phase === "reserved" ? "persisted-reserved" : "terminal")) return { state: "held" as const };
      if (recovery.value.some((receipt) => receipt.original.requestId === candidate.requestId)) return { state: "held" as const };
      const list = await client.collection(capturedProof.scope);
      if (read !== generation || !current(capture, client, identity) || !findCurrentProof(capturedProof, capture, client, identity) || list.state !== "confirmed") return { state: "unavailable" as const };
      const inventoryById = new Map(recovery.value.map((receipt) => [receipt.original.requestId, receipt]));
      const globalForScope = recovery.value.filter((receipt) => receipt.original.projectId === capturedProof.scope.projectId && receipt.original.workspace === capturedProof.scope.workspace);
      if (globalForScope.length !== list.value.receipts.length || list.value.receipts.some((receipt) => {
        const saved = inventoryById.get(receipt.original.requestId);
        return !saved || JSON.stringify(saved) !== JSON.stringify(receipt);
      }) || globalForScope.some((receipt) => !list.value.receipts.some((local) => local.original.requestId === receipt.original.requestId && JSON.stringify(local) === JSON.stringify(receipt)))) return { state: "unavailable" as const };
      if (list.value.receipts.some((receipt) => receipt.original.requestId === candidate.requestId)) return { state: "held" as const };
      const exact = await client.original(capturedProof.scope, candidate.requestId);
      if (read !== generation || !current(capture, client, identity) || !findCurrentProof(capturedProof, capture, client, identity) || exact.state !== "missing") return { state: "held" as const };
      const fence = itemKey(capturedProof.scope, capturedProof.item);
      if (recovery.value.some((receipt) => receipt.phase === "reserved" && itemKey({ projectId: receipt.original.projectId, workspace: receipt.original.workspace }, receipt.original.item) === fence)) return { state: "held" as const };
      const savedEntry = list.value.entries.find((entry) => itemKey({ projectId: entry.projectId, workspace: entry.workspace }, entry.item) === fence && entry.item.sourceRevision === capturedProof.item.sourceRevision);
      if ((savedEntry?.revision ?? 0) !== capturedProof.expectedRevision) return { state: "held" as const };
      collection = { entries: list.value.entries.map(copyEntry), receipts: list.value.receipts.map(copyReceipt) };
      collectionFor = { scope: scopeKey(capturedProof.scope), activation: capture.generation, binding: identity };
      recoveryFor = { activation: capture.generation, sourceGeneration: capture.sourceGeneration, binding: identity };
      permits.set(candidate.requestId, { proof: copyProof(capturedProof), oldItemKey: fence });
      return { state: "reviewed" as const };
    },
    canStartReviewedNewIntent(oldRequestId: string, proof: InboxDispositionSourceProof) {
      prunePermits();
      const permission = permits.get(oldRequestId);
      const capture = activation;
      const capturedProof = copyProof(proof);
      return !!permission && !!capture && ready(capture, boundClient, boundIdentity) && findCurrentProof(capturedProof, capture, boundClient, boundIdentity) && sameProof(permission.proof, capturedProof) && permission.oldItemKey === itemKey(capturedProof.scope, capturedProof.item);
    },
    dispose() { generation++; activation = null; loading = false; collectionFor = null; recoveryFor = null; exactChecks.clear(); permits.clear(); },
  };
}
