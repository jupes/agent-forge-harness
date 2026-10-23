import { expect, test } from "bun:test";
import {
  CODEX_CHAT_DECISION_IDENTITIES,
  createCodexChatDecisionIdentities,
} from "../../apps/desktop/src/codex-chat-decision-identities";
import { createCodexChatDecisions } from "../../apps/desktop/src/codex-chat-decisions";
import { sessionStartFixture } from "./session-start-fixture";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  sessionId = "session-2d5ed741-5528-424c-a927-263348778dad",
  turnRequestId = "18da5c95-3218-439c-a33d-e5662465f505",
  approvalId = "fa5c45ae-8487-4c61-84a5-e22ab343c227",
  requestId = "93eb33c3-9386-4dda-a4d4-4b26d04d869a";
const offer = {
  turnRequestId,
  actionable: true as const,
  detailsUnavailableReason: null,
  approval: {
    id: approvalId,
    kind: "command" as const,
    command: "PRIVATE actual command",
    cwd: "/PRIVATE/repo",
    reason: "PRIVATE native reason",
    availableDecisions: [
      "accept" as const,
      "decline" as const,
      "cancel" as const,
    ],
  },
};
const address = { projectId, sessionId };

test("approval reserves bounded metadata before POST and a lost answer or recreated client cannot mint or resend", async () => {
  const storage = sessionStartFixture(),
    sent: unknown[] = [];
  let minted = 0,
    release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const identities = () =>
    createCodexChatDecisionIdentities({
      storage: storage.storage,
      withLock: storage.withLock,
    });
  const make = () =>
    createCodexChatDecisions({
      identities: identities(),
      canWrite: () => true,
      requestId: () => {
        minted++;
        return requestId;
      },
      read: async () => ({ pending: [offer], receipt: null }),
      post: async (_p, _s, input) => {
        expect(identities().read(projectId, sessionId)).toMatchObject(input);
        sent.push(input);
        await held;
        return { state: "unknown", message: "Lost answer" };
      },
    });
  const first = make();
  first.activate({ ...address, turnRequestId, actionable: true });
  await first.refreshPending();
  const sending = first.decide(approvalId, "accept");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = make();
  second.activate({ ...address, turnRequestId, actionable: true });
  await second.refreshPending();
  await second.decide(approvalId, "decline");
  expect(second.view()?.identity).toEqual({
    ...address,
    turnRequestId,
    approvalId,
    requestId,
    decision: "accept",
  });
  expect(storage.storage.getItem(CODEX_CHAT_DECISION_IDENTITIES)).not.toContain(
    "PRIVATE",
  );
  expect(sent).toHaveLength(1);
  expect(minted).toBe(1);
  release();
  await sending;
  expect(first.view()?.identity?.requestId).toBe(requestId);
  first.dispose();
  second.dispose();
});

test("only an exact protected recorded-intent receipt clears a restored original; foreign or actionable receipt pages stay held", async () => {
  const storage = sessionStartFixture();
  const identities = createCodexChatDecisionIdentities({
    storage: storage.storage,
    withLock: storage.withLock,
  });
  const original = {
    ...address,
    turnRequestId,
    approvalId,
    decision: "decline" as const,
  };
  await identities.reserve(original, () => requestId);
  const receipt = {
    ...original,
    requestId,
    state: "recorded" as const,
    recordedAt: "2026-10-23T03:00:00.000Z",
  };
  let answer: unknown = { pending: [offer], receipt },
    posts = 0;
  const queries: (string | undefined)[] = [];
  const client = createCodexChatDecisions({
    identities,
    canWrite: () => false,
    requestId: () => {
      throw Error("Must not mint");
    },
    read: async (_p, _s, id) => {
      queries.push(id);
      return answer;
    },
    post: async () => {
      posts++;
      return { state: "unknown", message: "Must not send" };
    },
  });
  client.activate({ ...address, turnRequestId: null, actionable: false });
  await client.checkOriginal();
  expect(client.view()?.identity?.requestId).toBe(requestId);
  answer = {
    pending: [],
    receipt: { ...receipt, approvalId: "9964f120-0e87-484f-a786-fbe122c9f9ef" },
  };
  await client.checkOriginal();
  expect(client.view()?.identity?.requestId).toBe(requestId);
  answer = { pending: [], receipt: null };
  await client.checkOriginal();
  expect(client.view()?.identity?.requestId).toBe(requestId);
  answer = { pending: [], receipt };
  await client.checkOriginal();
  expect(client.view()?.identity).toBeNull();
  expect(client.view()?.receipt).toEqual(receipt);
  expect(client.view()?.notice).toContain("does not confirm native delivery");
  expect(queries).toEqual([requestId, requestId, requestId, requestId]);
  expect(posts).toBe(0);
  client.dispose();
});

test("a delayed live read after Stop or a foreign accepted turn cannot revive approval controls", async () => {
  const storage = sessionStartFixture(),
    identities = createCodexChatDecisionIdentities({
      storage: storage.storage,
      withLock: storage.withLock,
    });
  let release = (_value: unknown) => {},
    posts = 0;
  const waiting = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  let answer: Promise<unknown> = waiting;
  const client = createCodexChatDecisions({
    identities,
    canWrite: () => true,
    requestId: () => requestId,
    read: () => answer,
    post: async () => {
      posts++;
      return { state: "unknown", message: "Unexpected" };
    },
  });
  client.activate({ ...address, turnRequestId, actionable: true });
  const refresh = client.refreshPending();
  client.invalidate();
  release({ pending: [offer], receipt: null });
  await refresh;
  expect(client.view()?.pending).toEqual([]);
  await client.decide(approvalId, "accept");
  expect(posts).toBe(0);
  client.activate({ ...address, turnRequestId, actionable: true });
  answer = Promise.resolve({
    pending: [
      { ...offer, turnRequestId: "9964f120-0e87-484f-a786-fbe122c9f9ef" },
    ],
    receipt: null,
  });
  await client.refreshPending();
  expect(client.view()?.pending).toEqual([]);
  expect(client.view()?.error).toContain("could not be verified");
  await client.decide(approvalId, "cancel");
  expect(posts).toBe(0);
  client.dispose();
});

test("Stop while the origin lock is pending releases only the proven-unsent reservation and makes no POST", async () => {
  const storage = sessionStartFixture();
  let grant = () => {},
    posts = 0;
  const lock = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const identities = createCodexChatDecisionIdentities({
    storage: storage.storage,
    withLock: async (work) => {
      await lock;
      return storage.withLock(work);
    },
  });
  const client = createCodexChatDecisions({
    identities,
    canWrite: () => true,
    requestId: () => requestId,
    read: async () => ({ pending: [offer], receipt: null }),
    post: async () => {
      posts++;
      return { state: "unknown", message: "Unexpected" };
    },
  });
  client.activate({ ...address, turnRequestId, actionable: true });
  await client.refreshPending();
  const sending = client.decide(approvalId, "accept");
  client.invalidate();
  grant();
  await sending;
  expect(posts).toBe(0);
  expect(identities.read(projectId, sessionId)).toBeNull();
  expect(client.view()?.notice).toContain("No decision was sent");
  client.dispose();
});

test("a failed durable erase stays latched despite a matching receipt and malformed saved data is never overwritten", async () => {
  const storage = sessionStartFixture();
  let failSave = false;
  const identities = createCodexChatDecisionIdentities({
    storage: {
      getItem: storage.storage.getItem,
      setItem: (key, value) => {
        if (failSave) throw Error("Quota");
        storage.storage.setItem(key, value);
      },
    },
    withLock: storage.withLock,
  });
  const original = {
    ...address,
    turnRequestId,
    approvalId,
    decision: "cancel" as const,
  };
  await identities.reserve(original, () => requestId);
  failSave = true;
  const receipt = {
    ...original,
    requestId,
    state: "recorded",
    recordedAt: "2026-10-23T03:00:00.000Z",
  };
  const client = createCodexChatDecisions({
    identities,
    canWrite: () => true,
    requestId: () => {
      throw Error("Must not mint");
    },
    read: async () => ({ pending: [], receipt }),
    post: async () => {
      throw Error("Must not send");
    },
  });
  client.activate({ ...address, turnRequestId, actionable: true });
  await client.checkOriginal();
  expect(client.view()?.identity?.requestId).toBe(requestId);
  expect(client.view()?.identityError).toContain("still held");
  client.refreshIdentities();
  expect(client.view()?.identity?.requestId).toBe(requestId);
  client.dispose();
  storage.storage.setItem(CODEX_CHAT_DECISION_IDENTITIES, "{future-or-corrupt");
  await expect(identities.reserve(original, () => requestId)).rejects.toThrow(
    "could not be verified",
  );
  expect(storage.storage.getItem(CODEX_CHAT_DECISION_IDENTITIES)).toBe(
    "{future-or-corrupt",
  );
});
