import { expect, test } from "bun:test";
import { createKeeperRecoveryClient } from "../../apps/desktop/src/keeper-recovery-client";
import type {
  KeeperContinuationRecord,
  KeeperContinuationRequest,
  KeeperRecoveryPage,
} from "../../types/keeper-recovery";

const requestId = "f165589f-1faa-4c2a-a90b-d6d784e86649",
  at = "2026-10-22T12:00:00.000Z";
const page = (): KeeperRecoveryPage => ({
  projectId: "alpha",
  conversationRevision: 8,
  selectedSmith: "old",
  choices: ["old", "new"].map((name) => ({
    smith: {
      name,
      provider: "claude",
      model: "fixture",
      effort: "high",
      enabled: true,
      tags: [],
    },
    readiness: {
      connection: "unknown",
      allowance: "unreported",
      canStart: true,
      source: "fixture",
      asOf: at,
      reason: "Allowance not reported",
    },
  })),
  continuation: null,
  request: null,
});
const record = (
  input: KeeperContinuationRequest,
): KeeperContinuationRecord => ({
  ...input,
  hash: "a".repeat(64),
  revision: 9,
  generation: 1,
  sourceSequence: 4,
  at,
  previousBinding: null,
  resumed: false,
});

test("an unknown continuation stays frozen through a later refusal, and explicit retry uses the original request", async () => {
  const sent: KeeperContinuationRequest[] = [];
  let writes = 0,
    confirmed = 0;
  const client = createKeeperRecoveryClient({
    read: async () => page(),
    post: async (_id, input) => {
      sent.push(input);
      writes++;
      return writes === 1
        ? { state: "unknown", message: "Lost answer" }
        : { state: "refused", message: "Readiness changed" };
    },
    requestId: () => requestId,
    canChange: () => true,
    revision: () => 8,
    changed() {},
    confirmed() {
      confirmed++;
    },
  });
  await client.read("alpha");
  await client.change("alpha", {
    mode: "fresh",
    smith: "new",
    summary: "Exact reviewed context",
  });
  expect(client.get("alpha").pending?.requestId).toBe(requestId);
  expect(client.canStart("alpha")).toBe(false);
  await client.change("alpha", {
    mode: "fresh",
    smith: "old",
    summary: "Changed intent",
  });
  expect(sent).toHaveLength(1);
  await client.retry("alpha");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(client.get("alpha").pending?.summary).toBe("Exact reviewed context");
  expect(confirmed).toBe(0);
});

test("lost response reconciliation confirms the exact original request", async () => {
  let saved: KeeperContinuationRecord | null = null,
    confirmed = 0;
  const client = createKeeperRecoveryClient({
    read: async (_id, original) => ({
      ...page(),
      conversationRevision: saved ? 9 : 8,
      selectedSmith: saved ? "new" : "old",
      request: original ? saved : null,
      continuation: saved,
    }),
    post: async (_id, input) => {
      saved = record(input);
      return { state: "unknown", message: "Lost answer" };
    },
    requestId: () => requestId,
    canChange: () => true,
    revision: () => 8,
    changed() {},
    confirmed() {
      confirmed++;
    },
  });
  await client.read("alpha");
  await client.change("alpha", {
    mode: "fresh",
    smith: "new",
    summary: "Reviewed",
  });
  expect(client.get("alpha").pending).toBeNull();
  expect(confirmed).toBe(1);
  expect(client.get("alpha").notice).toContain("reviewed summary");
  expect(client.canStart("alpha")).toBe(true);
});

test("released private reads cannot repopulate a project", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const client = createKeeperRecoveryClient({
    read: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    post: async () => ({ state: "unknown", message: "Lost" }),
    requestId: () => requestId,
    canChange: () => true,
    revision: () => 8,
    changed() {},
    confirmed() {},
  });
  const reading = client.read("alpha");
  client.release("alpha");
  finish?.(page());
  await reading;
  expect(client.get("alpha").page).toBeNull();
  expect(client.canStart("alpha")).toBe(false);
});

test("a read confirming the original change cannot be downgraded by its delayed lost HTTP answer", async () => {
  let saved: KeeperContinuationRecord | null = null,
    finish: (() => void) | undefined;
  const client = createKeeperRecoveryClient({
    read: async (_id, original) => ({
      ...page(),
      conversationRevision: saved ? 9 : 8,
      selectedSmith: saved ? "new" : "old",
      request: original ? saved : null,
      continuation: saved,
    }),
    post: async (_id, input) => {
      saved = record(input);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { state: "unknown", message: "Delayed transport failure" };
    },
    requestId: () => requestId,
    canChange: () => true,
    revision: () => 8,
    changed() {},
    confirmed() {},
  });
  await client.read("alpha");
  const changing = client.change("alpha", {
    mode: "fresh",
    smith: "new",
    summary: "Reviewed",
  });
  await client.read("alpha");
  expect(client.get("alpha").pending).toBeNull();
  finish?.();
  await changing;
  expect(client.get("alpha").notice).toContain("reviewed summary");
  expect(client.get("alpha").notice).not.toContain("transport failure");
  expect(client.canStart("alpha")).toBe(true);
});

test("reviewed summary whitespace survives unknown delivery and an exact retry", async () => {
  const sent: KeeperContinuationRequest[] = [];
  const summary = "  Preserve this indentation.\n\nAnd this final newline.\n";
  const client = createKeeperRecoveryClient({
    read: async () => page(),
    post: async (_id, input) => {
      sent.push(structuredClone(input));
      return { state: "unknown", message: "Lost answer" };
    },
    requestId: () => requestId,
    canChange: () => true,
    revision: () => 8,
    changed() {},
    confirmed() {},
  });
  await client.read("alpha");
  await client.change("alpha", { mode: "fresh", smith: "new", summary });
  expect(sent[0]?.summary).toBe(summary);
  expect(client.get("alpha").pending?.summary).toBe(summary);
  await client.retry("alpha");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  client.dispose();
});
