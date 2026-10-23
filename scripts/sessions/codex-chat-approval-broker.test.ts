import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CodexChatApproval } from "../../types/codex-chat";
import type { CodexChatDecisionIntent } from "../../types/codex-owned-chat";
import { createCodexChatApprovalBroker } from "./codex-chat-approval-broker";

const address = {
  projectId: `project-${randomUUID()}`,
  sessionId: `session-${randomUUID()}`,
};
function approval(): CodexChatApproval {
  return {
    id: randomUUID(),
    provider: "codex",
    processId: 1234,
    nativeRequestId: 1,
    nativeApprovalId: null,
    threadId: randomUUID(),
    turnId: randomUUID(),
    itemId: "command-1",
    kind: "command",
    command: "echo private",
    cwd: "/private",
    reason: null,
    availableDecisions: ["accept", "decline", "cancel"],
  };
}

test("an approval decision durably records intent before one callback release, and exact retry after recreation never answers again", async () => {
  const intents: CodexChatDecisionIntent[] = [];
  const options = { readIntents: () => intents };
  let broker = createCodexChatApprovalBroker(options);
  const selected = approval(),
    turnRequestId = randomUUID(),
    controller = new AbortController();
  let save: (() => void) | undefined,
    replied = false;
  const offered = broker
    .offer({
      ...address,
      turnRequestId,
      approval: selected,
      version: "0.163.0-alpha.10.2",
      signal: controller.signal,
      persist: async (event) => {
        await new Promise<void>((resolve) => {
          save = resolve;
        });
        intents.push(event);
      },
    })
    .then((decision) => {
      replied = true;
      return decision;
    });
  const request = {
    requestId: randomUUID(),
    turnRequestId,
    approvalId: selected.id,
    decision: "accept" as const,
  };
  expect(broker.read(address).pending).toHaveLength(1);
  const deciding = broker.decide(address, request);
  await Promise.resolve();
  expect(replied).toBe(false);
  expect(broker.read(address).pending).toHaveLength(0);
  if (!save) throw Error("Intent was not offered to private persistence");
  save();
  const receipt = await deciding;
  expect(await offered).toBe("accept");
  expect(receipt.state).toBe("recorded");
  expect(intents[0]?.receipt).toEqual(receipt);
  broker = createCodexChatApprovalBroker(options);
  expect(broker.read(address, request.requestId)).toEqual({
    pending: [],
    receipt,
  });
  expect(await broker.decide(address, request)).toEqual(receipt);
  await expect(
    broker.decide(address, { ...request, decision: "decline" }),
  ).rejects.toThrow("different");
});

test("Stop during a held private intent invalidates actionability and a late save cannot release the callback", async () => {
  const intents: CodexChatDecisionIntent[] = [],
    broker = createCodexChatApprovalBroker({ readIntents: () => intents });
  const selected = approval(),
    controller = new AbortController(),
    turnRequestId = randomUUID();
  let saved: (() => void) | undefined,
    replies = 0;
  const offered = broker
    .offer({
      ...address,
      approval: selected,
      turnRequestId,
      version: "0.163.0-alpha.10.2",
      signal: controller.signal,
      persist: async (event) => {
        await new Promise<void>((resolve) => {
          saved = resolve;
        });
        intents.push(event);
      },
    })
    .then(
      () => {
        replies++;
        return "answered";
      },
      () => "invalidated",
    );
  const request = {
    requestId: randomUUID(),
    turnRequestId,
    approvalId: selected.id,
    decision: "decline" as const,
  };
  const pending = broker.decide(address, request);
  await Promise.resolve();
  controller.abort();
  expect(await offered).toBe("invalidated");
  expect(broker.read(address).pending).toEqual([]);
  if (!saved) throw Error("No held private intent");
  saved();
  const receipt = await pending;
  expect(receipt.state).toBe("recorded");
  expect(replies).toBe(0);
  expect(await broker.decide(address, request)).toEqual(receipt);
});

test("an unconfirmed writer is deadline bounded and cannot revive an approval with late completion", async () => {
  const intents: CodexChatDecisionIntent[] = [],
    broker = createCodexChatApprovalBroker({
      readIntents: () => intents,
      persistenceTimeoutMs: 20,
    });
  const selected = approval(),
    controller = new AbortController(),
    turnRequestId = randomUUID();
  let saved: (() => void) | undefined,
    replies = 0;
  const offered = broker
    .offer({
      ...address,
      approval: selected,
      turnRequestId,
      version: "0.163.0-alpha.10.2",
      signal: controller.signal,
      persist: async (event) => {
        await new Promise<void>((resolve) => {
          saved = resolve;
        });
        intents.push(event);
      },
    })
    .then(
      () => {
        replies++;
      },
      () => {},
    );
  const request = {
    requestId: randomUUID(),
    turnRequestId,
    approvalId: selected.id,
    decision: "accept" as const,
  };
  const started = Date.now();
  await expect(broker.decide(address, request)).rejects.toThrow("uncertain");
  expect(Date.now() - started).toBeLessThan(1000);
  await offered;
  expect(broker.read(address).pending).toEqual([]);
  if (!saved) throw Error("No held private intent");
  saved();
  await Bun.sleep(1);
  expect(replies).toBe(0);
  expect((await broker.decide(address, request)).state).toBe("recorded");
});

test("foreign or widened decisions and a competing original UUID cannot answer a live approval", async () => {
  const intents: CodexChatDecisionIntent[] = [],
    broker = createCodexChatApprovalBroker({ readIntents: () => intents });
  const selected = { ...approval(), availableDecisions: ["decline" as const] },
    controller = new AbortController(),
    turnRequestId = randomUUID();
  const offered = broker
    .offer({
      ...address,
      approval: selected,
      turnRequestId,
      version: "0.163.0-alpha.10.2",
      signal: controller.signal,
      persist: async (event) => {
        intents.push(event);
      },
    })
    .catch(() => "invalidated");
  const request = {
    requestId: randomUUID(),
    turnRequestId,
    approvalId: selected.id,
    decision: "decline" as const,
  };
  await expect(
    broker.decide(
      { ...address, sessionId: `session-${randomUUID()}` },
      request,
    ),
  ).rejects.toThrow("live");
  await expect(
    broker.decide(address, { ...request, turnRequestId: randomUUID() }),
  ).rejects.toThrow("live");
  await expect(
    broker.decide(address, { ...request, decision: "accept" }),
  ).rejects.toThrow("offer");
  expect(intents).toEqual([]);
  const receipt = await broker.decide(address, request);
  expect(await offered).toBe("decline");
  await expect(
    broker.decide(address, { ...request, requestId: randomUUID() }),
  ).rejects.toThrow("recorded");
  expect(receipt).not.toHaveProperty("nativeRequestId");
  expect(intents).toHaveLength(1);
});
