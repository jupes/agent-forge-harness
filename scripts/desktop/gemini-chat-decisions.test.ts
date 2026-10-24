import { expect, test } from "bun:test";
import {
  createGeminiChatDecisionIdentities,
  GEMINI_CHAT_DECISION_IDENTITIES,
} from "../../apps/desktop/src/gemini-chat-decision-identities";
import { createGeminiChatDecisions } from "../../apps/desktop/src/gemini-chat-decisions";
import { sessionStartFixture } from "./session-start-fixture";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  sessionId = "session-2d5ed741-5528-424c-a927-263348778dad",
  turnRequestId = "18da5c95-3218-439c-a33d-e5662465f505",
  approvalId = "fa5c45ae-8487-4c61-84a5-e22ab343c227",
  requestId = "93eb33c3-9386-4dda-a4d4-4b26d04d869a";
const offer = {
  turnRequestId,
  actionable: true as const,
  approval: {
    id: approvalId,
    detail: { json: '{"command":"PRIVATE native detail"}', truncated: false },
    detailsComplete: true,
    options: [
      {
        optionId: "native-allow",
        name: "Native allow once",
        kind: "allow_once" as const,
      },
      {
        optionId: "native-reject",
        name: "Native reject once",
        kind: "reject_once" as const,
      },
    ],
  },
};
const address = { projectId, sessionId };

test("only offered once option ids or explicit cancellation can be sent; changing project clears the live surface", async () => {
  const fixture = sessionStartFixture(),
    sent: unknown[] = [];
  const client = createGeminiChatDecisions({
    identities: createGeminiChatDecisionIdentities({
      storage: fixture.storage,
      withLock: fixture.withLock,
    }),
    canWrite: () => true,
    requestId: () => requestId,
    read: async () => ({ pending: [offer], receipt: null }),
    post: async (_p, _s, input) => {
      sent.push(input);
      return { state: "unknown", message: "Lost answer" };
    },
  });
  client.activate({ ...address, turnRequestId, actionable: true });
  await client.refreshPending();
  await client.decide(approvalId, "allow-always");
  await client.decide(approvalId, "fabricated-id");
  expect(sent).toEqual([]);
  client.activate({
    ...address,
    projectId: "project-9964f120-0e87-484f-a786-fbe122c9f9ef",
    turnRequestId: null,
    actionable: false,
  });
  expect(client.view()?.pending).toEqual([]);
  await client.decide(approvalId, "native-allow");
  expect(sent).toEqual([]);
  client.activate({ ...address, turnRequestId, actionable: true });
  await client.refreshPending();
  await client.decide(approvalId, null);
  expect(sent).toEqual([
    { requestId, turnRequestId, approvalId, optionId: null },
  ]);
  client.dispose();
});

test("approval reserves bounded metadata before POST and a lost answer or recreated client cannot mint or resend", async () => {
  const storage = sessionStartFixture(),
    sent: unknown[] = [];
  let minted = 0,
    release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const identities = () =>
    createGeminiChatDecisionIdentities({
      storage: storage.storage,
      withLock: storage.withLock,
    });
  const make = () =>
    createGeminiChatDecisions({
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
  const sending = first.decide(approvalId, "native-allow");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = make();
  second.activate({ ...address, turnRequestId, actionable: true });
  await second.refreshPending();
  await second.decide(approvalId, "native-reject");
  expect(second.view()?.identity).toEqual({
    ...address,
    turnRequestId,
    approvalId,
    requestId,
    optionId: "native-allow",
  });
  expect(
    storage.storage.getItem(GEMINI_CHAT_DECISION_IDENTITIES),
  ).not.toContain("PRIVATE");
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
  const identities = createGeminiChatDecisionIdentities({
    storage: storage.storage,
    withLock: storage.withLock,
  });
  const original = {
    ...address,
    turnRequestId,
    approvalId,
    optionId: "native-reject",
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
  const client = createGeminiChatDecisions({
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
    identities = createGeminiChatDecisionIdentities({
      storage: storage.storage,
      withLock: storage.withLock,
    });
  let release = (_value: unknown) => {},
    posts = 0;
  const waiting = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  let answer: Promise<unknown> = waiting;
  const client = createGeminiChatDecisions({
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
  await client.decide(approvalId, "native-allow");
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
  await client.decide(approvalId, null);
  expect(posts).toBe(0);
  client.dispose();
});

test("same-scope background checks retain the reviewed offer and cannot repopulate it after a decision dispatch", async () => {
  const fixture = sessionStartFixture(),
    identities = createGeminiChatDecisionIdentities({
      storage: fixture.storage,
      withLock: fixture.withLock,
    });
  let release = (_value: unknown) => {},
    reads = 0,
    posts = 0;
  const waiting = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const client = createGeminiChatDecisions({
    identities,
    canWrite: () => true,
    requestId: () => requestId,
    read: async () =>
      ++reads === 1 ? { pending: [offer], receipt: null } : waiting,
    post: async () => {
      posts++;
      return { state: "unknown", message: "Lost answer" };
    },
  });
  client.activate({ ...address, turnRequestId, actionable: true });
  await client.refreshPending();
  const retained = client.view()?.pending;
  const background = client.refreshPending();
  expect(client.view()?.pending).toBe(retained);
  expect(client.view()?.loading).toBe(false);
  await client.decide(approvalId, "native-allow");
  expect(posts).toBe(1);
  release({ pending: [offer], receipt: null });
  await background;
  expect(client.view()?.pending).toEqual([]);
  expect(client.view()?.identity?.requestId).toBe(requestId);
  client.dispose();
});

test("Stop while the origin lock is pending releases only the proven-unsent reservation and makes no POST", async () => {
  const storage = sessionStartFixture();
  let grant = () => {},
    posts = 0;
  const lock = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const identities = createGeminiChatDecisionIdentities({
    storage: storage.storage,
    withLock: async (work) => {
      await lock;
      return storage.withLock(work);
    },
  });
  const client = createGeminiChatDecisions({
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
  const sending = client.decide(approvalId, "native-allow");
  client.invalidate();
  grant();
  await sending;
  expect(posts).toBe(0);
  expect(identities.read(projectId, sessionId)).toBeNull();
  expect(client.view()?.notice).toContain("No decision was sent");
  client.dispose();
});

test("a protected refresh that withdraws an offer during origin-lock acquisition prevents its pending decision dispatch", async () => {
  const fixture = sessionStartFixture();
  let grant = () => {},
    reads = 0,
    posts = 0;
  const waiting = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const identities = createGeminiChatDecisionIdentities({
    storage: fixture.storage,
    withLock: async (work) => {
      await waiting;
      return fixture.withLock(work);
    },
  });
  const client = createGeminiChatDecisions({
    identities,
    canWrite: () => true,
    requestId: () => requestId,
    read: async () => ({
      pending: ++reads === 1 ? [offer] : [],
      receipt: null,
    }),
    post: async () => {
      posts++;
      return { state: "unknown", message: "Must not send" };
    },
  });
  client.activate({ ...address, turnRequestId, actionable: true });
  await client.refreshPending();
  // Start a protected refresh before the decision's lock wait; it may complete
  // while the original is being durably reserved.
  const refresh = client.refreshPending(),
    sending = client.decide(approvalId, "native-allow");
  await refresh;
  grant();
  await sending;
  expect(posts).toBe(0);
  expect(client.view()?.identity).toBeNull();
  client.dispose();
});

test("a failed durable erase stays latched despite a matching receipt and malformed saved data is never overwritten", async () => {
  const storage = sessionStartFixture();
  let failSave = false;
  const identities = createGeminiChatDecisionIdentities({
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
    optionId: null,
  };
  await identities.reserve(original, () => requestId);
  failSave = true;
  const receipt = {
    ...original,
    requestId,
    state: "recorded",
    recordedAt: "2026-10-23T03:00:00.000Z",
  };
  const client = createGeminiChatDecisions({
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
  storage.storage.setItem(
    GEMINI_CHAT_DECISION_IDENTITIES,
    "{future-or-corrupt",
  );
  await expect(identities.reserve(original, () => requestId)).rejects.toThrow(
    "could not be verified",
  );
  expect(storage.storage.getItem(GEMINI_CHAT_DECISION_IDENTITIES)).toBe(
    "{future-or-corrupt",
  );
});
