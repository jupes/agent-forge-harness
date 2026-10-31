import { expect, test } from "bun:test";
import {
  inboxDispositionOriginalSchema,
  inboxDispositionReceiptSchema,
  inboxDispositionStoredOriginalSchema,
} from "../../../types/inbox";
import { NotSent, type OperatorPost, type OperatorRead } from "../../../docs/js/operator";
import { createInboxDispositionsClient } from "./inbox-dispositions-client";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const requestId = "77c37127-1c22-4a2a-8e7d-69cc74ff1201";
const scope = { projectId, workspace: "c:/work/alpha" };
const original = inboxDispositionOriginalSchema.parse({
  requestId,
  expectedCatalogRevision: 1,
  workspace: scope.workspace,
  item: {
    sourceKind: "unknown-bead-write",
    stableItemId: "bead-write:reserve-red",
    sourceRevision: "notice-1",
  },
  expectedRevision: 0,
  operation: "done",
});
const storedOriginal = inboxDispositionStoredOriginalSchema.parse({
  ...original,
  projectId,
});
const receipt = inboxDispositionReceiptSchema.parse({
  original: storedOriginal,
  phase: "reserved",
  reservedAt: "2026-10-31T18:00:00.000Z",
});

test("reserve posts the exact immutable original to the protected route first", async () => {
  const calls: Array<{
    url: string;
    body: unknown;
    limits: { maxBodyBytes: number } | undefined;
  }> = [];
  const post: OperatorPost = async (url, body, limits) => {
    calls.push({ url, body, limits });
    return new Response(
      JSON.stringify({
        ok: true,
        data: { entry: null, receipt },
        error: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const read: OperatorRead = async () =>
    new Response(JSON.stringify({ ok: true, data: { entries: [], receipts: [] }, error: null }), { status: 200 });
  const client = createInboxDispositionsClient({ post, read, requestId: () => requestId });

  const outcome = await client.reserve(scope, original);

  expect(calls).toEqual([
    {
      url: `/__agent-forge/projects/${encodeURIComponent(projectId)}/inbox-dispositions/requests`,
      body: original,
      limits: { maxBodyBytes: 4 * 1024 * 1024 + 64 * 1024 },
    },
  ]);
  expect(outcome).toMatchObject({ state: "confirmed", value: { entry: null } });
});

test("a valid terminal 409 receipt is preserved as a known refusal", async () => {
  const refused = inboxDispositionReceiptSchema.parse({
    original: storedOriginal,
    phase: "refused",
    reservedAt: "2026-10-31T18:00:00.000Z",
    settledAt: "2026-10-31T18:01:00.000Z",
    outcome: "refused",
    refusalCode: "entry-revision-changed",
    refusalReason: "Refresh this item.",
  });
  const client = createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => new Response(JSON.stringify({ ok: true, data: { entry: null, receipt: refused }, error: null }), { status: 409 }),
  });
  const result = await client.reserve(scope, original);
  expect(result).toMatchObject({ state: "refused", value: { receipt: { phase: "refused", original: storedOriginal } } });
});

test("complete pre-effect errors are refused, malformed 503 and NotSent stay distinct", async () => {
  const validFailure = createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => new Response(JSON.stringify({ ok: false, data: null, error: "Busy" }), { status: 503 }),
  });
  expect(await validFailure.reserve(scope, original)).toMatchObject({ state: "refused", message: "Busy" });
  const malformed = createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => new Response("not-json", { status: 503 }),
  });
  expect(await malformed.reserve(scope, original)).toMatchObject({ state: "unknown" });
  const notSent = createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => { throw new NotSent("No token"); },
  });
  expect(await notSent.reserve(scope, original)).toMatchObject({ state: "not-sent", message: "No token" });
});

test("only a complete exact 404 read proves that this request is missing", async () => {
  const exact404 = createInboxDispositionsClient({
    read: async () => new Response(JSON.stringify({ ok: false, data: null, error: "Missing" }), { status: 404 }),
    requestId: () => requestId,
    post: async () => new Response("{}"),
  });
  expect(await exact404.original(scope, requestId)).toEqual({ state: "missing" });
  const malformed404 = createInboxDispositionsClient({
    read: async () => new Response("{}", { status: 404 }),
    requestId: () => requestId,
    post: async () => new Response("{}"),
  });
  expect(await malformed404.original(scope, requestId)).toMatchObject({ state: "unknown" });
});

test("invalid UTF-8 and oversized protected replies remain unknown after POST", async () => {
  const invalid = createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => new Response(Uint8Array.of(0xff), { status: 200 }),
  });
  expect(await invalid.reserve(scope, original)).toMatchObject({ state: "unknown" });
  const large = createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => new Response(" ".repeat(4 * 1024 * 1024 + 64 * 1024 + 1), { status: 200 }),
  });
  expect(await large.reserve(scope, original)).toMatchObject({ state: "unknown" });
});

test("a success-shaped reply for another original is unknown, never a receipt match", async () => {
  const other = inboxDispositionOriginalSchema.parse({ ...original, requestId: "77c37127-1c22-4a2a-8e7d-69cc74ff1298" });
  const client = createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => new Response(JSON.stringify({ ok: true, data: { entry: null, receipt: receiptForOther() }, error: null }), { status: 200 }),
  });
  function receiptForOther() {
    const saved = inboxDispositionStoredOriginalSchema.parse({ ...other, projectId });
    return inboxDispositionReceiptSchema.parse({ original: saved, phase: "reserved", reservedAt: "2026-10-31T18:00:00.000Z" });
  }
  expect(await client.reserve(scope, original)).toMatchObject({ state: "unknown" });
});

test("the complete recovery read is protected and strictly accepts retained receipts from any scope", async () => {
  let requested = "";
  const foreign = inboxDispositionReceiptSchema.parse({
    ...receipt,
    original: { ...storedOriginal, projectId: "project-b5832fa0-7a21-403b-8184-44892f0d8d87", workspace: "d:/archived/old" },
  });
  const client = createInboxDispositionsClient({
    read: async (url) => {
      requested = url;
      return new Response(JSON.stringify({ ok: true, data: { version: 1, complete: true, receipts: [foreign] }, error: null }), { status: 200 });
    },
    post: async () => new Response("{}"),
    requestId: () => requestId,
  });
  expect(await client.recovery()).toEqual({ state: "confirmed", value: [foreign] });
  expect(requested).toBe("/__agent-forge/inbox-dispositions/recovery");
});

test("incomplete or duplicate recovery inventories are unavailable, never partial", async () => {
  const clientFor = (data: unknown) => createInboxDispositionsClient({
    read: async () => new Response(JSON.stringify({ ok: true, data, error: null }), { status: 200 }),
    post: async () => new Response("{}"),
    requestId: () => requestId,
  });
  expect(await clientFor({ version: 1, complete: false, receipts: [] }).recovery()).toMatchObject({ state: "unavailable" });
  expect(await clientFor({ version: 1, complete: true, receipts: [receipt, receipt] }).recovery()).toMatchObject({ state: "unavailable" });
  expect(await clientFor({ version: 2, complete: true, receipts: [] }).recovery()).toMatchObject({ state: "unavailable" });
});

test("same-result-revision contradictions are unknown while a newer entry may differ", async () => {
  const applied = inboxDispositionReceiptSchema.parse({
    original: storedOriginal,
    phase: "applied",
    reservedAt: "2026-10-31T18:00:00.000Z",
    settledAt: "2026-10-31T18:01:00.000Z",
    outcome: "applied",
    resultingRevision: 1,
    resultingValue: "done",
  });
  const forEntry = (revision: number, operation: "done" | "snooze-1h", updatedAt: string) => ({
    projectId,
    workspace: scope.workspace,
    item: storedOriginal.item,
    revision,
    operation,
    updatedAt,
    ...(operation === "snooze-1h" ? { snoozedUntil: "2026-10-31T19:01:00.000Z" } : {}),
  });
  const clientFor = (entry: unknown) => createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => new Response(JSON.stringify({ ok: true, data: { entry, receipt: applied }, error: null }), { status: 200 }),
  });
  expect(await clientFor(forEntry(1, "snooze-1h", "2026-10-31T18:01:00.000Z")).apply(scope, original)).toMatchObject({ state: "unknown" });
  expect(await clientFor(forEntry(2, "snooze-1h", "2026-10-31T18:02:00.000Z")).apply(scope, original)).toMatchObject({ state: "confirmed", value: { entry: { revision: 2 } } });
});

test("apply reserved and discard with another terminal reason remain unknown", async () => {
  const discarded = inboxDispositionReceiptSchema.parse({
    original: storedOriginal,
    phase: "refused",
    reservedAt: receipt.reservedAt,
    settledAt: "2026-10-31T18:02:00.000Z",
    outcome: "refused",
    refusalCode: "entry-revision-changed",
    refusalReason: "Refresh before continuing.",
  });
  const clientFor = (saved: unknown) => createInboxDispositionsClient({
    read: async () => new Response("{}"),
    requestId: () => requestId,
    post: async () => new Response(JSON.stringify({ ok: true, data: { entry: null, receipt: saved }, error: null }), { status: 200 }),
  });
  expect(await clientFor(receipt).apply(scope, original)).toMatchObject({ state: "unknown" });
  expect(await clientFor(discarded).discard(scope, original)).toMatchObject({ state: "unknown" });
});

test("the client keeps the injected transport functions fixed for its lifetime", async () => {
  let originalReads = 0;
  let replacementReads = 0;
  let originalPosts = 0;
  let replacementPosts = 0;
  const dependencies = {
    read: async () => { originalReads++; return new Response(JSON.stringify({ ok: true, data: { version: 1, complete: true, receipts: [] }, error: null }), { status: 200 }); },
    post: async () => { originalPosts++; return new Response(JSON.stringify({ ok: true, data: { entry: null, receipt }, error: null }), { status: 200 }); },
    requestId: () => requestId,
  };
  const client = createInboxDispositionsClient(dependencies);
  const originalBinding = client.bindingIdentity;
  dependencies.read = async () => { replacementReads++; return new Response("{}"); };
  dependencies.post = async () => { replacementPosts++; return new Response("{}"); };
  expect(await client.recovery()).toMatchObject({ state: "confirmed", value: [] });
  expect(await client.reserve(scope, original)).toMatchObject({ state: "confirmed" });
  expect(client.bindingIdentity).toBe(originalBinding);
  expect(originalReads).toBe(1);
  expect(replacementReads).toBe(0);
  expect(originalPosts).toBe(1);
  expect(replacementPosts).toBe(0);
});
