import { expect, test } from "bun:test";
import {
  inboxDispositionOriginalSchema,
  inboxDispositionReceiptSchema,
  inboxDispositionStoredOriginalSchema,
  type InboxDispositionOriginal,
  type InboxDispositionReceipt,
} from "../../../types/inbox";
import type { OperatorPost, OperatorRead } from "../../../docs/js/operator";
import { createInboxDispositionsClient } from "./inbox-dispositions-client";
import {
  createInboxDispositionsOwner,
  type InboxDispositionActivation,
  type InboxDispositionSourceProof,
  type InboxDispositionSnapshot,
} from "./inbox-dispositions-owner";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const workspace = "c:/work/alpha";
const item = { sourceKind: "unknown-bead-write" as const, stableItemId: "bead-write:owner-test", sourceRevision: "notice-1" };
const activation: InboxDispositionActivation = { scope: { projectId, workspace }, generation: 1, sourceGeneration: 1, writable: true };
const proof = (revision = "notice-1", expectedRevision = 0): InboxDispositionSourceProof => ({
  scope: activation.scope,
  item: { ...item, sourceRevision: revision },
  sourceGeneration: 1,
  catalogRevision: 1,
  expectedRevision,
  complete: true,
  fresh: true,
  resolved: true,
});
const original = (requestId: string, sourceRevision = "notice-1", expectedRevision = 0) => inboxDispositionOriginalSchema.parse({
  requestId,
  expectedCatalogRevision: 1,
  workspace,
  item: { ...item, sourceRevision },
  expectedRevision,
  operation: "done",
});
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data, error: null }), { status });
const failed = (error = "Missing", status = 404) => new Response(JSON.stringify({ ok: false, data: null, error }), { status });
const receiptFor = (value: InboxDispositionOriginal, phase: "reserved" | "applied" = "reserved") => {
  const saved = inboxDispositionStoredOriginalSchema.parse({ ...value, projectId });
  const settledAt = "2026-10-31T18:01:00.000Z";
  const snoozedUntil = new Date(Date.parse(settledAt) + 60 * 60 * 1000).toISOString();
  return inboxDispositionReceiptSchema.parse(phase === "reserved"
    ? { original: saved, phase, reservedAt: "2026-10-31T18:00:00.000Z" }
    : { original: saved, phase, reservedAt: "2026-10-31T18:00:00.000Z", settledAt, outcome: "applied", resultingRevision: value.expectedRevision + 1, resultingValue: value.operation, ...(value.operation === "snooze-1h" ? { snoozedUntil } : {}) });
};
function fixture(post: OperatorPost, read: OperatorRead, snapshot: () => InboxDispositionSnapshot | null, ids: string[], inventory: InboxDispositionReceipt[] | (() => InboxDispositionReceipt[]) = []) {
  const boundRead: OperatorRead = async (url, init, limits) => {
    if (url === "/__agent-forge/inbox-dispositions/recovery") {
      const receipts = typeof inventory === "function" ? inventory() : inventory;
      return envelope({ version: 1, complete: true, receipts });
    }
    return read(url, init, limits);
  };
  const client = createInboxDispositionsClient({ post, read: boundRead, requestId: () => ids.shift() ?? "77c37127-1c22-4a2a-8e7d-69cc74ff1299" });
  const owner = createInboxDispositionsOwner({ client, currentSnapshot: snapshot });
  owner.activate(activation);
  return owner;
}

test("acknowledgment reserves first and applies only while the exact fresh Done join remains current", async () => {
  const posted: Array<{ url: string; body: unknown }> = [];
  let snapshot: InboxDispositionSnapshot | null = { activation, sources: [proof()] };
  const read: OperatorRead = async () => envelope({ entries: [], receipts: [] });
  const post: OperatorPost = async (url, body) => {
    posted.push({ url, body });
    const value = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) return envelope({ entry: null, receipt: receiptFor(value) });
    const receipt = receiptFor(value, "applied");
    return envelope({ entry: { projectId, workspace, item: value.item, revision: 1, operation: value.operation, updatedAt: "2026-10-31T18:01:00.000Z" }, receipt });
  };
  const owner = fixture(post, read, () => snapshot, ["77c37127-1c22-4a2a-8e7d-69cc74ff1201"]);
  await owner.refresh();
  const outcome = await owner.acknowledge(proof(), "done");
  expect(outcome.state).toBe("confirmed");
  expect(posted.map(({ url }) => url.endsWith("/requests") ? "reserve" : "apply")).toEqual(["reserve", "apply"]);
  expect(posted[0]?.body).toEqual(posted[1]?.body);
  expect(owner.view().holds).toEqual([]);

  posted.length = 0;
  const second = fixture(async (url, body) => {
    posted.push({ url, body });
    const value = inboxDispositionOriginalSchema.parse(body);
    snapshot = { activation, sources: [{ ...proof(), resolved: false }] };
    return envelope({ entry: null, receipt: receiptFor(value) });
  }, read, () => snapshot, ["77c37127-1c22-4a2a-8e7d-69cc74ff1202"]);
  await second.refresh();
  const stale = await second.acknowledge(proof(), "done");
  expect(stale).toMatchObject({ state: "not-sent" });
  expect(posted).toHaveLength(1);
  expect(second.view().holds[0]?.requestId).toBe("77c37127-1c22-4a2a-8e7d-69cc74ff1202");
});

test("reserve-only unknown needs GET-only 404 review and a separate distinct request id", async () => {
  const ids = ["77c37127-1c22-4a2a-8e7d-69cc74ff1203", "77c37127-1c22-4a2a-8e7d-69cc74ff1204"];
  const posted: Array<{ url: string; body: unknown }> = [];
  const old = original(ids[0] ?? "", "notice-1");
  let reserveCount = 0;
  const post: OperatorPost = async (url, body) => {
    posted.push({ url, body });
    if (reserveCount++ === 0) throw Error("connection lost");
    const value = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) return envelope({ entry: null, receipt: receiptFor(value) });
    const receipt = receiptFor(value, "applied");
    return envelope({ entry: { projectId, workspace, item: value.item, revision: 1, operation: value.operation, updatedAt: "2026-10-31T18:01:00.000Z" }, receipt });
  };
  const read: OperatorRead = async (url) => url.endsWith("/requests/" + old.requestId)
    ? failed("Original not found", 404)
    : envelope({ entries: [], receipts: [] });
  let snapshot: InboxDispositionSnapshot | null = { activation, sources: [proof()] };
  const owner = fixture(post, read, () => snapshot, ids);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "unknown" });
  const changed = proof("notice-2", 0);
  snapshot = { activation, sources: [changed] };
  expect(await owner.reviewReserveUnknown(old, changed)).toEqual({ state: "reviewed" });
  expect(posted).toHaveLength(1);
  expect(owner.canStartReviewedNewIntent(old.requestId, changed)).toBe(true);
  expect(await owner.acknowledge(changed, "done")).toMatchObject({ state: "confirmed" });
  expect(posted).toHaveLength(3);
  const first = inboxDispositionOriginalSchema.parse(posted[0]?.body);
  const next = inboxDispositionOriginalSchema.parse(posted[1]?.body);
  expect(next.requestId).not.toBe(first.requestId);
  expect(posted[2]?.body).toEqual(posted[1]?.body);
  expect(owner.view().holds.map((held) => held.requestId)).toContain(first.requestId);
});

test("a late old reservation makes the distinct reviewed request refuse without apply", async () => {
  const oldId = "77c37127-1c22-4a2a-8e7d-69cc74ff1220";
  const newId = "77c37127-1c22-4a2a-8e7d-69cc74ff1221";
  const sent: Array<{ url: string; body: unknown }> = [];
  let postCount = 0;
  const post: OperatorPost = async (url, body) => {
    sent.push({ url, body });
    if (postCount++ === 0) throw Error("reserve reply lost");
    return failed("An unresolved original already exists.", 409);
  };
  const read: OperatorRead = async (url) => url.includes("/requests/") ? failed("Original not found", 404) : envelope({ entries: [], receipts: [] });
  let snapshot: InboxDispositionSnapshot | null = { activation, sources: [proof()] };
  const owner = fixture(post, read, () => snapshot, [oldId, newId]);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "unknown" });
  const changed = proof("notice-2", 0);
  snapshot = { activation, sources: [changed] };
  expect(await owner.reviewReserveUnknown(original(oldId), changed)).toEqual({ state: "reviewed" });
  expect(await owner.acknowledge(changed, "done")).toMatchObject({ state: "refused" });
  expect(sent).toHaveLength(2);
  expect(sent.every(({ url }) => url.endsWith("/requests"))).toBe(true);
  expect(inboxDispositionOriginalSchema.parse(sent[1]?.body).requestId).toBe(newId);
  expect(owner.view().holds.map((held) => held.requestId)).toEqual([oldId]);
});

test("an apply-unknown original remains held through GET-only exact read and cannot use reserve-only review", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1205";
  const post: OperatorPost = async (url, body) => {
    const value = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) return envelope({ entry: null, receipt: receiptFor(value) });
    throw Error("reply lost after apply may have arrived");
  };
  const read: OperatorRead = async (url) => url.endsWith("/requests/" + id)
    ? envelope({ entry: null, receipt: receiptFor(original(id)) })
    : envelope({ entries: [], receipts: [] });
  const owner = fixture(post, read, () => ({ activation, sources: [proof()] }), [id]);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "unknown" });
  expect(await owner.checkOriginal(id)).toMatchObject({ state: "confirmed", value: { receipt: { phase: "reserved" } } });
  expect(await owner.discard(original(id))).toMatchObject({ state: "unknown" });
  expect(owner.view().holds.map((held) => held.requestId)).toEqual([id]);
  expect(await owner.reviewReserveUnknown(original(id), proof())).toEqual({ state: "unavailable" });
});

test("an unavailable initial collection sends no reservation", async () => {
  let posts = 0;
  const owner = fixture(async () => { posts++; return envelope({}); }, async () => failed("Unavailable", 503), () => ({ activation, sources: [proof()] }), ["77c37127-1c22-4a2a-8e7d-69cc74ff1212"]);
  await owner.refresh();
  expect(owner.view().collectionReady).toBe(false);
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "not-sent" });
  expect(posts).toBe(0);
});

test("an unverified capture fails before sending any intent", async () => {
  let posts = 0;
  const client = createInboxDispositionsClient({
    read: async (url) => url.endsWith("/recovery") ? envelope({ version: 1, complete: true, receipts: [] }) : envelope({ entries: [], receipts: [] }),
    requestId: () => { throw Error("UUID source unavailable"); },
    post: async () => { posts++; return envelope({}); },
  });
  const owner = createInboxDispositionsOwner({ client, currentSnapshot: () => ({ activation, sources: [proof()] }) });
  owner.activate(activation);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "not-sent" });
  expect(posts).toBe(0);
});

test("a failed exact review does not authorize a replacement request", async () => {
  const oldId = "77c37127-1c22-4a2a-8e7d-69cc74ff1222";
  let posts = 0;
  const post: OperatorPost = async () => { posts++; throw Error("reserve reply lost"); };
  const read: OperatorRead = async (url) => url.includes("/requests/") ? failed("Read unavailable", 503) : envelope({ entries: [], receipts: [] });
  let snapshot: InboxDispositionSnapshot | null = { activation, sources: [proof()] };
  const owner = fixture(post, read, () => snapshot, [oldId, "77c37127-1c22-4a2a-8e7d-69cc74ff1223"]);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "unknown" });
  const changed = proof("notice-2");
  snapshot = { activation, sources: [changed] };
  expect(await owner.reviewReserveUnknown(original(oldId), changed)).toEqual({ state: "held" });
  expect(await owner.acknowledge(changed, "done")).toMatchObject({ state: "refused" });
  expect(posts).toBe(1);
  expect(owner.view().holds.map((held) => held.requestId)).toEqual([oldId]);
});

test("a delayed collection from an old activation cannot repopulate the new scope", async () => {
  let finish: ((response: Response) => void) | null = null;
  let startCollection: (() => void) | null = null;
  const collectionStarted = new Promise<void>((resolve) => { startCollection = resolve; });
  const read: OperatorRead = async () => {
    startCollection?.();
    return new Promise<Response>((resolve) => { finish = resolve; });
  };
  const owner = fixture(async () => envelope({}), read, () => ({ activation, sources: [proof()] }), []);
  const pending = owner.refresh();
  await collectionStarted;
  owner.activate({ ...activation, scope: { projectId, workspace: "c:/work/other" }, generation: 2 });
  const resolve = finish;
  if (!resolve) throw Error("Expected the old collection read to be waiting.");
  resolve(envelope({ entries: [], receipts: [receiptFor(original("77c37127-1c22-4a2a-8e7d-69cc74ff1215"))] }));
  await pending;
  expect(owner.view()).toMatchObject({ scope: { workspace: "c:/work/other" }, receipts: [], holds: [], collectionReady: false });
});

test("a fresh owner recovers retained originals from the server collection without posting", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1224";
  const saved = receiptFor(original(id));
  let posts = 0;
  const owner = fixture(async () => { posts++; return envelope({}); }, async (url) => url.includes("/requests/")
    ? envelope({ entry: null, receipt: saved })
    : envelope({ entries: [], receipts: [saved] }), () => ({ activation, sources: [proof()] }), [], [saved]);
  await owner.refresh();
  expect(owner.view().holds.map((held) => held.requestId)).toEqual([id]);
  expect(await owner.checkOriginal(id)).toMatchObject({ state: "confirmed", value: { receipt: { original: saved.original } } });
  expect(posts).toBe(0);
});

test("a second click cannot start another original while reservation is pending", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1216";
  let finishReserve: ((response: Response) => void) | null = null;
  const urls: string[] = [];
  const post: OperatorPost = async (url, body) => {
    urls.push(url);
    const value = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) return new Promise<Response>((resolve) => { finishReserve = (response) => resolve(response); });
    const receipt = receiptFor(value, "applied");
    return envelope({ entry: { projectId, workspace, item: value.item, revision: 1, operation: value.operation, updatedAt: "2026-10-31T18:01:00.000Z" }, receipt });
  };
  const owner = fixture(post, async () => envelope({ entries: [], receipts: [] }), () => ({ activation, sources: [proof()] }), [id]);
  await owner.refresh();
  const first = owner.acknowledge(proof(), "done");
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "not-sent" });
  const resolve = finishReserve;
  if (!resolve) throw Error("Expected the original reservation to be waiting.");
  resolve(envelope({ entry: null, receipt: receiptFor(original(id)) }));
  expect(await first).toMatchObject({ state: "confirmed" });
  expect(urls.filter((url) => url.endsWith("/requests"))).toHaveLength(1);
});

test("a checked exact reserved original may be explicitly discarded without apply", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1213";
  let postCount = 0;
  let postUrls: string[] = [];
  const read: OperatorRead = async (url) => url.endsWith("/requests/" + id)
    ? envelope({ entry: null, receipt: receiptFor(original(id)) })
    : envelope({ entries: [], receipts: [] });
  const post: OperatorPost = async (url, body) => {
    postCount++;
    postUrls.push(url);
    if (postCount === 1) throw Error("reserve reply lost");
    const value = inboxDispositionOriginalSchema.parse(body);
    const stored = inboxDispositionStoredOriginalSchema.parse({ ...value, projectId });
    const receipt = inboxDispositionReceiptSchema.parse({ original: stored, phase: "refused", reservedAt: "2026-10-31T18:00:00.000Z", settledAt: "2026-10-31T18:02:00.000Z", outcome: "refused", refusalCode: "discarded", refusalReason: "Explicitly discarded." });
    return envelope({ entry: null, receipt });
  };
  const owner = fixture(post, read, () => ({ activation, sources: [proof()] }), [id]);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "unknown" });
  expect(await owner.checkOriginal(id)).toMatchObject({ state: "confirmed" });
  expect(await owner.discard(original(id))).toMatchObject({ state: "confirmed", value: { receipt: { refusalCode: "discarded" } } });
  expect(postUrls).toHaveLength(2);
  expect(postUrls[0]).toMatch(/\/requests$/);
  expect(postUrls[1]).toContain("/discard");
  expect(owner.view().holds).toEqual([]);
});

test("a delayed exact read cannot restore a hold after a newer terminal discard", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1214";
  const value = original(id);
  const reserved = receiptFor(value);
  const stored = inboxDispositionStoredOriginalSchema.parse({ ...value, projectId });
  const discarded = inboxDispositionReceiptSchema.parse({ original: stored, phase: "refused", reservedAt: reserved.reservedAt, settledAt: "2026-10-31T18:02:00.000Z", outcome: "refused", refusalCode: "discarded", refusalReason: "Explicitly discarded." });
  let finishExact: ((response: Response) => void) | null = null;
  const read: OperatorRead = async (url) => url.endsWith("/requests/" + id)
    ? new Promise<Response>((resolve) => { finishExact = resolve; })
    : envelope({ entries: [], receipts: [reserved] });
  const post: OperatorPost = async () => envelope({ entry: null, receipt: discarded });
  const owner = fixture(post, read, () => ({ activation, sources: [proof()] }), [id], [reserved]);
  await owner.refresh();
  const pendingRead = owner.checkOriginal(id);
  expect(await owner.discard(value)).toMatchObject({ state: "confirmed", value: { receipt: { phase: "refused" } } });
  const resolve = finishExact;
  if (!resolve) throw Error("Expected the exact read to be waiting.");
  resolve(envelope({ entry: null, receipt: reserved }));
  await pendingRead;
  expect(owner.view().holds).toEqual([]);
});

test("a successful reserve-only review never releases a different unresolved hold", async () => {
  const oldId = "77c37127-1c22-4a2a-8e7d-69cc74ff1210";
  const other = inboxDispositionOriginalSchema.parse({ ...original("77c37127-1c22-4a2a-8e7d-69cc74ff1211"), item: { ...item, stableItemId: "bead-write:other" } });
  const otherReceipt = receiptFor(other);
  let collections = 0;
  const read: OperatorRead = async (url) => {
    if (url.includes("/requests/")) return failed("Original not found", 404);
    collections++;
    return envelope({ entries: [], receipts: collections === 1 ? [] : [otherReceipt] });
  };
  let posts = 0;
  const post: OperatorPost = async () => { posts++; throw Error("reserve response lost"); };
  const owner = fixture(post, read, () => ({ activation, sources: [proof()] }), [oldId], () => collections > 0 ? [otherReceipt] : []);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "unknown" });
  expect(await owner.reviewReserveUnknown(original(oldId), proof())).toEqual({ state: "reviewed" });
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "refused" });
  expect(posts).toBe(1);
  expect(owner.view().holds.map((held) => held.requestId)).toEqual([oldId, other.requestId]);
});

test("scope changes refuse exact-original access and source revisions cannot bypass a reserved fence", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1206";
  const post: OperatorPost = async (url, body) => {
    const value = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) return envelope({ entry: null, receipt: receiptFor(value) });
    throw Error("uncertain apply retains the reservation");
  };
  const read: OperatorRead = async () => envelope({ entries: [], receipts: [] });
  let snapshot: InboxDispositionSnapshot | null = { activation, sources: [proof()] };
  const owner = fixture(post, read, () => snapshot, [id]);
  await owner.refresh();
  await owner.acknowledge(proof(), "snooze-1h");
  const newer = proof("notice-2", 0);
  snapshot = { activation, sources: [newer] };
  expect(await owner.acknowledge(newer, "snooze-1h")).toMatchObject({ state: "refused" });
  owner.activate({ ...activation, scope: { projectId, workspace: "c:/work/other" }, generation: 2 });
  expect(await owner.checkOriginal(id)).toMatchObject({ state: "unavailable" });
});

test("a complete recovery hold in another workspace blocks writes without entering the active collection", async () => {
  const foreignScope = { projectId: "project-b5832fa0-7a21-403b-8184-44892f0d8d87", workspace: "d:/archived/old" };
  const foreignOriginal = inboxDispositionOriginalSchema.parse({ ...original("77c37127-1c22-4a2a-8e7d-69cc74ff1280"), workspace: foreignScope.workspace });
  const foreign = receiptFor(foreignOriginal);
  let posts = 0;
  const owner = fixture(async () => { posts++; return envelope({}); }, async () => envelope({ entries: [], receipts: [] }),
    () => ({ activation, sources: [proof()] }), [], [foreign]);
  await owner.refresh();
  expect(owner.view()).toMatchObject({ scope: { projectId }, receipts: [], holds: [foreign.original], recoveryReady: true, collectionReady: true });
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "refused" });
  expect(posts).toBe(0);
});

test("an injected operator-client replacement invalidates previously ready admission", async () => {
  let posts = 0;
  const first = createInboxDispositionsClient({
    read: async (url) => url.endsWith("/recovery") ? envelope({ version: 1, complete: true, receipts: [] }) : envelope({ entries: [], receipts: [] }),
    post: async () => { posts++; return envelope({}); },
    requestId: () => "77c37127-1c22-4a2a-8e7d-69cc74ff1281",
  });
  const next = createInboxDispositionsClient({
    read: async (url) => url.endsWith("/recovery") ? envelope({ version: 1, complete: true, receipts: [] }) : envelope({ entries: [], receipts: [] }),
    post: async () => { posts++; return envelope({}); },
    requestId: () => "77c37127-1c22-4a2a-8e7d-69cc74ff1282",
  });
  const dependencies = { client: first, currentSnapshot: () => ({ activation, sources: [proof()] }) };
  const owner = createInboxDispositionsOwner(dependencies);
  owner.activate(activation);
  await owner.refresh();
  dependencies.client = next;
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "not-sent" });
  expect(posts).toBe(0);
});

test("a caller-mutated proof cannot authorize applying the captured original", async () => {
  const mutableProof = proof();
  let snapshot: InboxDispositionSnapshot | null = { activation, sources: [mutableProof] };
  const posted: string[] = [];
  const owner = fixture(async (url, body) => {
    posted.push(url);
    const submitted = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) {
      mutableProof.item.sourceRevision = "changed-after-capture";
      return envelope({ entry: null, receipt: receiptFor(submitted) });
    }
    return envelope({ entry: null, receipt: receiptFor(submitted, "applied") });
  }, async () => envelope({ entries: [], receipts: [] }), () => snapshot, ["77c37127-1c22-4a2a-8e7d-69cc74ff1283"]);
  await owner.refresh();
  const result = await owner.acknowledge(mutableProof, "done");
  expect(result).toMatchObject({ state: "not-sent" });
  expect(posted).toHaveLength(1);
  expect(owner.view().holds[0]?.item.sourceRevision).toBe("notice-1");
});

test("a late A-scope reservation reply remains a global hold and never enters B's visible rows", async () => {
  let finishReserve: ((response: Response) => void) | null = null;
  const urls: string[] = [];
  const owner = fixture(async (url) => {
    urls.push(url);
    if (url.endsWith("/requests")) return new Promise<Response>((resolve) => { finishReserve = resolve; });
    return envelope({});
  }, async () => envelope({ entries: [], receipts: [] }), () => ({ activation, sources: [proof()] }), ["77c37127-1c22-4a2a-8e7d-69cc74ff1284"]);
  await owner.refresh();
  const pending = owner.acknowledge(proof(), "done");
  owner.activate({ ...activation, scope: { projectId, workspace: "c:/work/other" }, generation: 2 });
  const resolve = finishReserve;
  if (!resolve) throw Error("Expected the A-scope reservation to remain pending.");
  resolve(envelope({ entry: null, receipt: receiptFor(original("77c37127-1c22-4a2a-8e7d-69cc74ff1284")) }));
  await pending;
  expect(owner.view()).toMatchObject({ scope: { workspace: "c:/work/other" }, receipts: [], entries: [], holds: [{ requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1284", workspace }] });
  expect(urls.filter((url) => url.endsWith("/requests"))).toHaveLength(1);
  expect(urls.some((url) => url.endsWith("/inbox-dispositions"))).toBe(false);
});

test("reviewing a missing reserve preserves its typed history after a distinct new intent", async () => {
  const oldId = "77c37127-1c22-4a2a-8e7d-69cc74ff1285";
  const newId = "77c37127-1c22-4a2a-8e7d-69cc74ff1286";
  let posts = 0;
  let currentProof = proof("notice-1");
  const owner = fixture(async (url, body) => {
    posts++;
    if (posts === 1) throw Error("The first reserve reply was lost.");
    const submitted = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) return envelope({ entry: null, receipt: receiptFor(submitted) });
    return envelope({ entry: null, receipt: receiptFor(submitted, "applied") });
  }, async (url) => url.includes("/requests/") ? failed("Original not found", 404) : envelope({ entries: [], receipts: [] }),
  () => ({ activation, sources: [currentProof] }), [oldId, newId]);
  await owner.refresh();
  const oldProof = proof("notice-1");
  expect(await owner.acknowledge(oldProof, "done")).toMatchObject({ state: "unknown" });
  const newProof = proof("notice-2");
  currentProof = newProof;
  expect(await owner.reviewReserveUnknown(original(oldId), newProof)).toEqual({ state: "reviewed" });
  expect(owner.canStartReviewedNewIntent(oldId, newProof)).toBe(true);
  expect(await owner.acknowledge(newProof, "done")).toMatchObject({ state: "confirmed" });
  expect(owner.view().history).toContainEqual(expect.objectContaining({ original: expect.objectContaining({ requestId: oldId }), state: "reserve-unknown" }));
  expect(owner.view().holds.map((held) => held.requestId)).toContain(oldId);
});

test("an unavailable global recovery inventory cannot admit an acknowledgment", async () => {
  let posts = 0;
  const client = createInboxDispositionsClient({
    read: async (url) => url.endsWith("/recovery") ? failed("Recovery unavailable", 503) : envelope({ entries: [], receipts: [] }),
    post: async () => { posts++; return envelope({}); },
    requestId: () => "77c37127-1c22-4a2a-8e7d-69cc74ff1287",
  });
  const owner = createInboxDispositionsOwner({ client, currentSnapshot: () => ({ activation, sources: [proof()] }) });
  owner.activate(activation);
  await owner.refresh();
  expect(owner.view()).toMatchObject({ recoveryReady: false, collectionReady: false });
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "not-sent" });
  expect(posts).toBe(0);
});

test("checking an exact original during refresh does not supersede that refresh", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1301";
  const reserved = receiptFor(original(id));
  let recoveryReads = 0;
  let exactReads = 0;
  let finishRecovery: ((response: Response) => void) | null = null;
  let markSecondRecoveryStarted: (() => void) | null = null;
  const secondRecoveryStarted = new Promise<void>((resolve) => { markSecondRecoveryStarted = resolve; });
  const client = createInboxDispositionsClient({
    post: async () => envelope({}),
    read: async (url) => {
      if (url.endsWith("/recovery")) {
        if (++recoveryReads === 2) {
          markSecondRecoveryStarted?.();
          return new Promise<Response>((resolve) => { finishRecovery = resolve; });
        }
        return envelope({ version: 1, complete: true, receipts: [reserved] });
      }
      if (url.endsWith("/requests/" + id)) exactReads++;
      return url.endsWith("/requests/" + id)
        ? envelope({ entry: null, receipt: reserved })
        : envelope({ entries: [], receipts: [reserved] });
    },
    requestId: () => id,
  });
  const owner = createInboxDispositionsOwner({ client, currentSnapshot: () => ({ activation, sources: [proof()] }) });
  owner.activate(activation);
  await owner.refresh();
  const refreshing = owner.refresh();
  await secondRecoveryStarted;

  expect(await owner.checkOriginal(id)).toMatchObject({ state: "unavailable" });
  expect(exactReads).toBe(0);
  expect(recoveryReads).toBe(2);
  const finish = finishRecovery;
  if (!finish) throw Error("Expected the active recovery read to remain pending.");
  finish(envelope({ version: 1, complete: true, receipts: [reserved] }));
  await refreshing;
  expect(owner.view()).toMatchObject({ loading: false, collectionReady: true, recoveryReady: true });
});

test("a reserve review during refresh revokes old permission without superseding refresh", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1302";
  let recoveryReads = 0;
  let exactReads = 0;
  let finishRecovery: ((response: Response) => void) | null = null;
  let markThirdRecoveryStarted: (() => void) | null = null;
  const thirdRecoveryStarted = new Promise<void>((resolve) => { markThirdRecoveryStarted = resolve; });
  const client = createInboxDispositionsClient({
    post: async () => { throw Error("Reserve response lost."); },
    read: async (url) => {
      if (url.endsWith("/recovery")) {
        if (++recoveryReads === 3) {
          markThirdRecoveryStarted?.();
          return new Promise<Response>((resolve) => { finishRecovery = resolve; });
        }
        return envelope({ version: 1, complete: true, receipts: [] });
      }
      if (url.endsWith("/requests/" + id)) {
        exactReads++;
        return failed("Missing", 404);
      }
      return envelope({ entries: [], receipts: [] });
    },
    requestId: () => id,
  });
  const owner = createInboxDispositionsOwner({ client, currentSnapshot: () => ({ activation, sources: [proof()] }) });
  owner.activate(activation);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "unknown" });
  expect(await owner.reviewReserveUnknown(original(id), proof())).toEqual({ state: "reviewed" });
  expect(owner.canStartReviewedNewIntent(id, proof())).toBe(true);

  const refreshing = owner.refresh();
  await thirdRecoveryStarted;
  expect(await owner.reviewReserveUnknown(original(id), proof())).toEqual({ state: "unavailable" });
  expect(exactReads).toBe(1);
  expect(recoveryReads).toBe(3);
  expect(owner.canStartReviewedNewIntent(id, proof())).toBe(false);
  const finish = finishRecovery;
  if (!finish) throw Error("Expected the active recovery read to remain pending.");
  finish(envelope({ version: 1, complete: true, receipts: [] }));
  await refreshing;
  expect(owner.view()).toMatchObject({ loading: false, collectionReady: true, recoveryReady: true });
});

test("a terminal apply reply arriving after scope change is reconciled globally only", async () => {
  let completeApply: ((response: Response) => void) | null = null;
  let markApplyStarted: (() => void) | null = null;
  const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1288";
  const owner = fixture(async (url, body) => {
    const submitted = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) return envelope({ entry: null, receipt: receiptFor(submitted) });
    if (url.endsWith("/inbox-dispositions")) {
      markApplyStarted?.();
      return new Promise<Response>((resolve) => { completeApply = resolve; });
    }
    return envelope({});
  }, async () => envelope({ entries: [], receipts: [] }), () => ({ activation, sources: [proof()] }), [id]);
  await owner.refresh();
  const pending = owner.acknowledge(proof(), "done");
  await applyStarted;
  owner.activate({ ...activation, scope: { projectId, workspace: "c:/work/other" }, generation: 2 });
  const finish = completeApply;
  if (!finish) throw Error("Expected the old-scope apply to remain pending.");
  const applied = receiptFor(original(id), "applied");
  finish(envelope({ entry: { projectId, workspace, item, revision: 1, operation: "done", updatedAt: "2026-10-31T18:01:00.000Z" }, receipt: applied }));
  expect(await pending).toMatchObject({ state: "confirmed" });
  expect(owner.view()).toMatchObject({ scope: { workspace: "c:/work/other" }, entries: [], receipts: [], holds: [], history: [{ original: { requestId: id }, state: "terminal" }] });
});

test("a stale recovery completion cannot mark the replacement activation ready", async () => {
  let finishRecovery: ((response: Response) => void) | null = null;
  let recoveryReads = 0;
  const client = createInboxDispositionsClient({
    read: async (url) => {
      if (url.endsWith("/recovery")) {
        recoveryReads++;
        return new Promise<Response>((resolve) => { finishRecovery = resolve; });
      }
      return envelope({ entries: [], receipts: [] });
    },
    post: async () => envelope({}),
    requestId: () => "77c37127-1c22-4a2a-8e7d-69cc74ff1289",
  });
  const owner = createInboxDispositionsOwner({ client, currentSnapshot: () => ({ activation, sources: [proof()] }) });
  owner.activate(activation);
  const pending = owner.refresh();
  owner.activate({ ...activation, scope: { projectId, workspace: "c:/work/other" }, generation: 2 });
  const finish = finishRecovery;
  if (!finish) throw Error("Expected the first private-home recovery read to be pending.");
  finish(envelope({ version: 1, complete: true, receipts: [receiptFor(original("77c37127-1c22-4a2a-8e7d-69cc74ff1290"))] }));
  await pending;
  expect(recoveryReads).toBe(1);
  expect(owner.view()).toMatchObject({ scope: { workspace: "c:/work/other" }, recoveryReady: false, collectionReady: false, holds: [] });
});

test("an old-scope write settling during refresh clears loading and requires fresh evidence", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1300";
  const nextActivation: InboxDispositionActivation = { ...activation, scope: { projectId, workspace: "c:/work/other" }, generation: 2 };
  let currentActivation = activation;
  let recoveryReads = 0;
  let finishRecovery: ((response: Response) => void) | null = null;
  let finishApply: ((response: Response) => void) | null = null;
  let markNextRecoveryStarted: (() => void) | null = null;
  let markApplyStarted: (() => void) | null = null;
  const nextRecoveryStarted = new Promise<void>((resolve) => { markNextRecoveryStarted = resolve; });
  const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
  const client = createInboxDispositionsClient({
    post: async (url, body) => {
      const submitted = inboxDispositionOriginalSchema.parse(body);
      if (url.endsWith("/requests")) return envelope({ entry: null, receipt: receiptFor(submitted) });
      markApplyStarted?.();
      return new Promise<Response>((resolve) => { finishApply = resolve; });
    },
    read: async (url) => {
    if (url.endsWith("/recovery") && ++recoveryReads === 2) {
      markNextRecoveryStarted?.();
      return new Promise<Response>((resolve) => { finishRecovery = resolve; });
    }
    return url.endsWith("/recovery")
      ? envelope({ version: 1, complete: true, receipts: [] })
      : envelope({ entries: [], receipts: [] });
    },
    requestId: () => id,
  });
  const owner = createInboxDispositionsOwner({ client, currentSnapshot: () => ({ activation: currentActivation, sources: [proof()] }) });
  owner.activate(activation);
  await owner.refresh();
  const writing = owner.acknowledge(proof(), "done");
  await applyStarted;

  currentActivation = nextActivation;
  owner.activate(nextActivation);
  const refreshing = owner.refresh();
  await nextRecoveryStarted;

  const settleApply = finishApply;
  if (!settleApply) throw Error("Expected the old-scope apply to remain pending.");
  settleApply(envelope({
    entry: { projectId, workspace, item, revision: 1, operation: "done", updatedAt: "2026-10-31T18:01:00.000Z" },
    receipt: receiptFor(original(id), "applied"),
  }));
  expect(await writing).toMatchObject({ state: "confirmed" });
  expect(owner.view()).toMatchObject({
    scope: { workspace: "c:/work/other" }, loading: false, collectionReady: false, recoveryReady: false,
    error: "An Inbox write settled during refresh; refresh again before acting.",
  });

  const staleRecovery = finishRecovery;
  if (!staleRecovery) throw Error("Expected the replacement-scope recovery read to be pending.");
  staleRecovery(envelope({ version: 1, complete: true, receipts: [] }));
  await refreshing;
  expect(owner.view()).toMatchObject({ loading: false, collectionReady: false, recoveryReady: false });

  await owner.refresh();
  expect(owner.view()).toMatchObject({ loading: false, collectionReady: true, recoveryReady: true, error: "" });
});

test("a scoped collection absent from the complete inventory cannot authorize writes", async () => {
  const saved = receiptFor(original("77c37127-1c22-4a2a-8e7d-69cc74ff1291"));
  let posts = 0;
  const owner = fixture(async () => { posts++; return envelope({}); }, async () => envelope({ entries: [], receipts: [saved] }),
    () => ({ activation, sources: [proof()] }), []);
  await owner.refresh();
  expect(owner.view()).toMatchObject({ recoveryReady: true, collectionReady: false });
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "not-sent" });
  expect(posts).toBe(0);
});

test("a retained reservation from another served scope cannot be discarded here", async () => {
  const foreign = receiptFor(inboxDispositionOriginalSchema.parse({ ...original("77c37127-1c22-4a2a-8e7d-69cc74ff1292"), workspace: "d:/archived/old" }));
  let posts = 0;
  const owner = fixture(async () => { posts++; return envelope({}); }, async () => envelope({ entries: [], receipts: [] }),
    () => ({ activation, sources: [proof()] }), [], [foreign]);
  await owner.refresh();
  expect(await owner.discard(original(foreign.original.requestId))).toMatchObject({ state: "not-sent" });
  expect(posts).toBe(0);
  expect(owner.view().holds.map((held) => held.requestId)).toContain(foreign.original.requestId);
});

test("a malformed terminal HTTP outcome never reconciles the held reservation", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1293";
  const posted: string[] = [];
  const owner = fixture(async (url, body) => {
    posted.push(url);
    const submitted = inboxDispositionOriginalSchema.parse(body);
    if (url.endsWith("/requests")) return envelope({ entry: null, receipt: receiptFor(submitted) });
    return envelope({ entry: null, receipt: receiptFor(submitted, "applied") }, 409);
  }, async () => envelope({ entries: [], receipts: [] }), () => ({ activation, sources: [proof()] }), [id]);
  await owner.refresh();
  expect(await owner.acknowledge(proof(), "done")).toMatchObject({ state: "unknown" });
  expect(posted).toHaveLength(2);
  expect(owner.view().holds.map((held) => held.requestId)).toContain(id);
  expect(owner.view().history).toContainEqual(expect.objectContaining({ original: expect.objectContaining({ requestId: id }), state: "apply-unknown", receipt: expect.objectContaining({ phase: "reserved" }) }));
});

test("terminal history cannot regress to reserved or be replaced by another terminal receipt", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1294";
  const terminal = receiptFor(original(id), "applied");
  const changedTerminal = inboxDispositionReceiptSchema.parse({
    original: terminal.original,
    phase: "refused",
    reservedAt: terminal.reservedAt,
    settledAt: "2026-10-31T18:02:00.000Z",
    outcome: "refused",
    refusalCode: "entry-revision-changed",
    refusalReason: "A conflicting terminal receipt.",
  });
  let recoveryRead = 0;
  const owner = fixture(async () => envelope({}), async () => envelope({ entries: [], receipts: [terminal] }),
    () => ({ activation, sources: [proof()] }), [], () => {
      recoveryRead++;
      return [recoveryRead === 1 ? terminal : recoveryRead === 2 ? changedTerminal : receiptFor(original(id))];
    });
  await owner.refresh();
  await owner.refresh();
  await owner.refresh();
  expect(owner.view().history).toMatchObject([{ original: { requestId: id }, state: "terminal", receipt: { phase: "applied" } }]);
  expect(owner.view().holds).toEqual([]);
  expect(owner.view().collectionReady).toBe(false);
});

test("a read started during discard cannot replace the terminal receipt after the write settles", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1295";
  const reserved = receiptFor(original(id));
  const stored = inboxDispositionStoredOriginalSchema.parse({ ...original(id), projectId });
  const discarded = inboxDispositionReceiptSchema.parse({
    original: stored,
    phase: "refused",
    reservedAt: reserved.reservedAt,
    settledAt: "2026-10-31T18:02:00.000Z",
    outcome: "refused",
    refusalCode: "discarded",
    refusalReason: "Explicit discard.",
  });
  let finishRead: ((response: Response) => void) | null = null;
  let finishDiscard: ((response: Response) => void) | null = null;
  let markReadStarted: (() => void) | null = null;
  let markDiscardStarted: (() => void) | null = null;
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  const discardStarted = new Promise<void>((resolve) => { markDiscardStarted = resolve; });
  const read: OperatorRead = async (url) => url.endsWith("/requests/" + id)
    ? new Promise<Response>((resolve) => { finishRead = resolve; markReadStarted?.(); })
    : envelope({ entries: [], receipts: [reserved] });
  const post: OperatorPost = async () => new Promise<Response>((resolve) => { finishDiscard = resolve; markDiscardStarted?.(); });
  const owner = fixture(post, read, () => ({ activation, sources: [proof()] }), [id], [reserved]);
  await owner.refresh();
  const discarding = owner.discard(original(id));
  await discardStarted;
  const staleRead = owner.checkOriginal(id);
  await readStarted;
  const settle = finishDiscard;
  if (!settle) throw Error("Expected the discard write to be pending.");
  settle(envelope({ entry: null, receipt: discarded }));
  expect(await discarding).toMatchObject({ state: "confirmed", value: { receipt: { phase: "refused" } } });
  const finish = finishRead;
  if (!finish) throw Error("Expected the older exact read to be pending.");
  finish(envelope({ entry: null, receipt: reserved }));
  expect(await staleRead).toMatchObject({ state: "unknown" });
  expect(owner.view().history).toMatchObject([{ original: { requestId: id }, state: "terminal", receipt: { refusalCode: "discarded" } }]);
  expect(owner.view().holds).toEqual([]);
});

test("a repeated failed reserve review revokes its previous one-use permission", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1296";
  let exactReads = 0;
  const oldProof = proof();
  const currentProof = proof("notice-2");
  let current = oldProof;
  const owner = fixture(async () => { throw Error("Reserve response lost."); }, async (url) => {
    if (url.includes("/requests/")) return exactReads++ === 0 ? failed("Missing", 404) : failed("Unavailable", 503);
    return envelope({ entries: [], receipts: [] });
  }, () => ({ activation, sources: [current] }), [id]);
  await owner.refresh();
  expect(await owner.acknowledge(oldProof, "done")).toMatchObject({ state: "unknown" });
  current = currentProof;
  expect(await owner.reviewReserveUnknown(original(id), currentProof)).toEqual({ state: "reviewed" });
  expect(owner.canStartReviewedNewIntent(id, currentProof)).toBe(true);
  expect(await owner.reviewReserveUnknown(original(id), currentProof)).toEqual({ state: "held" });
  expect(owner.canStartReviewedNewIntent(id, currentProof)).toBe(false);
  expect(owner.view()).toMatchObject({ collectionReady: false, recoveryReady: false });
});

test("discard refuses if latest authority changes after the original was loaded", async () => {
  const id = "77c37127-1c22-4a2a-8e7d-69cc74ff1297";
  const saved = receiptFor(original(id));
  let current = { activation, sources: [proof()] };
  let posts = 0;
  const owner = fixture(async () => { posts++; return envelope({}); }, async () => envelope({ entries: [], receipts: [saved] }),
    () => current, [id], [saved]);
  await owner.refresh();
  current = { activation: { ...activation, writable: false }, sources: [proof()] };
  expect(await owner.discard(original(id))).toMatchObject({ state: "not-sent" });
  expect(posts).toBe(0);
  expect(owner.view().holds.map((held) => held.requestId)).toContain(id);
});
