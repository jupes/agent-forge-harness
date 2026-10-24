import { expect, test } from "bun:test";
import { createKeeperProposalsClient } from "../../apps/desktop/src/keeper-proposals-client";
import type {
  KeeperProposalPage,
  KeeperProposalReceipt,
} from "../../types/keeper-proposal";

const requestId = "f165589f-1faa-4c2a-a90b-d6d784e86649";
const sourceRequestId = "e7dbef4f-a76d-4152-b676-7ea35f94ec6e";
const at = "2026-10-22T12:00:00.000Z";
const cardId = `proposal-${sourceRequestId}-0`;
const page = (): KeeperProposalPage => ({
  projectId: "alpha",
  revision: 0,
  conversationRevision: 8,
  asOf: at,
  request: null,
  complete: true,
  problems: [],
  proposals: [
    {
      proposal: {
        id: cardId,
        projectId: "alpha",
        sourceRequestId,
        sourceHash: "a".repeat(64),
        createdAt: at,
        draft: {
          title: "Record a decision",
          detail: "Review the wording.",
          action: {
            kind: "record-decision",
            beadId: "alpha-1",
            decision: "Original wording",
          },
        },
      },
      record: null,
      available: true,
      destinationAvailable: true,
      reason: null,
      activity: null,
    },
  ],
});
const receipt = (): KeeperProposalReceipt => ({
  projectId: "alpha",
  revision: 2,
  record: {
    ...page().proposals[0]!.proposal,
    requestId,
    requestHash: "b".repeat(64),
    operation: "approve",
    auditEventId: 9,
    phase: "done",
    pending: false,
    updatedAt: at,
    message: "Decision saved.",
    objects: [{ kind: "bead", id: "alpha-1" }],
  },
});
test("double approval has one immutable original request; a lost response reconciles outside the recent cards", async () => {
  const sent: unknown[] = [],
    queries: unknown[] = [];
  let resolve!: () => void,
    written = false,
    canRead = true;
  const client = createKeeperProposalsClient({
    requestId: () => requestId,
    canWrite: () => true,
    read: async (_id, query) => {
      queries.push(query);
      if (!canRead) throw new Error("offline");
      return written
        ? {
            ...page(),
            revision: 2,
            proposals: [],
            request: query.requestId ? receipt().record : null,
          }
        : page();
    },
    post: async (_id, _operation, body) => {
      sent.push(structuredClone(body));
      await new Promise<void>((done) => {
        resolve = done;
      });
      written = true;
      canRead = false;
      return { state: "unknown", message: "Response lost" };
    },
  });
  await client.refresh("alpha");
  const first = client.review("alpha", cardId, "approve");
  await client.review("alpha", cardId, "approve");
  client.draft("alpha", cardId, {
    ...page().proposals[0]!.proposal.draft,
    action: {
      kind: "record-decision",
      beadId: "alpha-1",
      decision: "Later local edit",
    },
  });
  resolve();
  await first;
  expect(sent).toHaveLength(1);
  expect(client.get("alpha").pending?.body.draft?.action).toMatchObject({
    decision: "Original wording",
  });
  expect(client.get("alpha").drafts.get(cardId)?.action).toMatchObject({
    decision: "Later local edit",
  });
  canRead = true;
  await client.refresh("alpha");
  expect(queries.at(-1)).toEqual({ requestId });
  expect(client.get("alpha").pending).toBeNull();
  expect(client.get("alpha").receipts.get(cardId)?.phase).toBe("done");
  await client.retry("alpha");
  expect(sent).toHaveLength(1);
  client.dispose();
});
test("an explicit retry reuses the original request, a later refusal cannot release an uncertain review, and foreign receipts never confirm", async () => {
  const sent: unknown[] = [];
  let calls = 0;
  const client = createKeeperProposalsClient({
    requestId: () => requestId,
    canWrite: () => true,
    read: async () => page(),
    post: async (_id, _operation, body) => {
      sent.push(body);
      calls++;
      return calls === 1
        ? { state: "unknown", message: "Response lost" }
        : calls === 2
          ? { state: "refused", message: "Busy" }
          : {
              state: "done",
              data: {
                ...receipt(),
                projectId: "beta",
                record: { ...receipt().record, projectId: "beta" },
              },
            };
    },
  });
  await client.refresh("alpha");
  await client.review("alpha", cardId, "approve");
  await client.retry("alpha");
  await client.retry("alpha");
  expect(sent).toHaveLength(3);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2]).toEqual(sent[0]);
  expect(client.get("alpha").pending?.uncertain).toBe(true);
  expect(client.get("alpha").receipts.size).toBe(0);
  client.dispose();
});
test("confirmed results survive failed or regressing reads and fence new approvals", async () => {
  let current: unknown = page();
  const client = createKeeperProposalsClient({
    requestId: () => requestId,
    canWrite: () => true,
    read: async () => current,
    post: async () => ({ state: "done", data: receipt() }),
  });
  await client.refresh("alpha");
  await client.review("alpha", cardId, "approve");
  expect(client.get("alpha").error).toContain("could not be verified");
  expect(client.get("alpha").receipts.get(cardId)?.phase).toBe("done");
  current = { ...page(), revision: 2, conversationRevision: 9 };
  await client.refresh("alpha");
  expect(client.get("alpha").error).toBeNull();
  current = { ...page(), revision: 3, conversationRevision: 7 };
  await client.refresh("alpha");
  expect(client.get("alpha").page?.conversationRevision).toBe(9);
  client.dispose();
});

test("a stream-triggered read can confirm before the write response without losing the original result or permitting a second write", async () => {
  let written = false,
    release!: () => void,
    calls = 0;
  const client = createKeeperProposalsClient({
    requestId: () => requestId,
    canWrite: () => true,
    read: async (_id, query) =>
      written
        ? {
            ...page(),
            revision: 2,
            request: query.requestId ? receipt().record : null,
            proposals: [{ ...page().proposals[0]!, record: receipt().record }],
          }
        : page(),
    post: async () => {
      calls++;
      written = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { state: "done", data: receipt() };
    },
  });
  await client.refresh("alpha");
  const write = client.review("alpha", cardId, "approve");
  await client.refresh("alpha");
  expect(client.get("alpha").pending).toBeNull();
  await client.review("alpha", cardId, "approve");
  release();
  await write;
  expect(calls).toBe(1);
  expect(client.get("alpha").notice).toBe("Decision saved.");
  expect(client.get("alpha").receipts.get(cardId)?.phase).toBe("done");
  client.dispose();
});

test("an incomplete local edit cannot block dismissal and never enters the dismissal request", async () => {
  let sent: unknown;
  const client = createKeeperProposalsClient({
    requestId: () => requestId,
    canWrite: () => true,
    read: async () => page(),
    post: async (_id, _operation, body) => {
      sent = body;
      return { state: "refused", message: "fixture" };
    },
  });
  await client.refresh("alpha");
  client.draft("alpha", cardId, {
    ...page().proposals[0]!.proposal.draft,
    action: { kind: "record-decision", beadId: "", decision: "" },
  });
  await client.review("alpha", cardId, "dismiss");
  expect(sent).toMatchObject({ id: cardId, requestId });
  expect(sent).not.toHaveProperty("draft");
  client.dispose();
});
