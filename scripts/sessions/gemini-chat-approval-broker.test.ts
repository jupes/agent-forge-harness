import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  GeminiChatDecisionIntent,
  GeminiChatPrivateFrame,
} from "../../types/gemini-owned-chat";
import { createGeminiChatApprovalBroker } from "./gemini-chat-approval-broker";

const address = {
  projectId: `project-${randomUUID()}`,
  sessionId: `session-${randomUUID()}`,
};
function fixture(persistenceTimeoutMs = 1000) {
  const saved: GeminiChatDecisionIntent[] = [],
    events: Array<GeminiChatPrivateFrame | GeminiChatDecisionIntent> = [];
  const broker = createGeminiChatApprovalBroker({
    readIntents: () => saved,
    persistenceTimeoutMs,
  });
  const controller = new AbortController(),
    turnRequestId = randomUUID();
  const offer = {
    kind: "permission" as const,
    rpcId: 41,
    requestId: turnRequestId,
    toolCallId: "tool-one",
    processId: 42,
    sessionId: randomUUID(),
    detail: { json: '{"title":"Actual native choice"}', truncated: false },
    detailsComplete: true,
    options: [
      {
        optionId: "native-once",
        name: "Allow once",
        kind: "allow_once" as const,
      },
      {
        optionId: "native-deny",
        name: "Reject once",
        kind: "reject_once" as const,
      },
    ],
  };
  const persist = async (
    event: GeminiChatPrivateFrame | GeminiChatDecisionIntent,
  ) => {
    events.push(event);
    if (event.kind === "coding-gemini-chat-decision") saved.push(event);
  };
  return { saved, events, broker, controller, turnRequestId, offer, persist };
}
async function active(f: ReturnType<typeof fixture>) {
  const end = Date.now() + 1000;
  for (;;) {
    const offered = f.broker.read(address).pending[0];
    if (offered) return offered;
    if (Date.now() >= end) throw Error("Offer not published");
    await Bun.sleep(1);
  }
}

test("uncertain bounded persistence and Stop never release a late permission callback or revive actionability", async () => {
  const f = fixture(40);
  let complete: (() => void) | undefined,
    callbacks = 0;
  const answer = f.broker
    .offer({
      ...address,
      turnRequestId: f.turnRequestId,
      offer: f.offer,
      signal: f.controller.signal,
      persist: async (event) => {
        if (event.kind !== "coding-gemini-chat-decision")
          return f.persist(event);
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
        await f.persist(event);
      },
    })
    .then(
      () => {
        callbacks++;
      },
      () => {},
    );
  const offered = await active(f);
  const decision = {
    requestId: randomUUID(),
    turnRequestId: f.turnRequestId,
    approvalId: offered.approval.id,
    optionId: "native-once",
  };
  const pending = f.broker.decide(address, decision);
  const observed = expect(pending).rejects.toMatchObject({ status: 503 });
  expect(f.broker.read(address).pending).toEqual([]);
  f.controller.abort();
  await answer;
  await observed;
  complete?.();
  await Bun.sleep(10);
  expect(callbacks).toBe(0);
  expect(f.broker.read(address).pending).toEqual([]);
  expect((await f.broker.decide(address, decision)).state).toBe("recorded");
  expect(callbacks).toBe(0);
});

test("a pending original is reserved synchronously and foreign/conflicting/unoffered decisions cannot answer it", async () => {
  const f = fixture();
  let release: (() => void) | undefined,
    callback = 0;
  const answer = f.broker
    .offer({
      ...address,
      turnRequestId: f.turnRequestId,
      offer: f.offer,
      signal: f.controller.signal,
      persist: async (event) => {
        if (event.kind === "coding-gemini-chat-decision")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        await f.persist(event);
      },
    })
    .then((value) => {
      callback++;
      return value;
    });
  const offered = await active(f),
    decision = {
      requestId: randomUUID(),
      turnRequestId: f.turnRequestId,
      approvalId: offered.approval.id,
      optionId: null,
    };
  await expect(
    f.broker.decide(
      { ...address, projectId: `project-${randomUUID()}` },
      decision,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.broker.decide(address, { ...decision, turnRequestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.broker.decide(address, { ...decision, optionId: "always" }),
  ).rejects.toMatchObject({ status: 409 });
  const first = f.broker.decide(address, decision),
    retry = f.broker.decide(address, decision);
  await expect(
    f.broker.decide(address, { ...decision, optionId: "native-once" }),
  ).rejects.toMatchObject({ status: 409 });
  await Bun.sleep(0);
  release?.();
  expect(await retry).toEqual(await first);
  expect(await answer).toEqual({
    requestId: decision.requestId,
    optionId: null,
  });
  expect(callback).toBe(1);
  expect(f.saved).toHaveLength(1);
  const recreated = createGeminiChatApprovalBroker({
    readIntents: () => f.saved,
  });
  expect(await recreated.decide(address, decision)).toEqual(await first);
  expect(recreated.read(address, decision.requestId).pending).toEqual([]);
  await expect(
    recreated.decide(address, { ...decision, requestId: randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
});

test("unconfirmed offer publication is bounded together with live offers", async () => {
  const f = fixture(40),
    refused: Promise<unknown>[] = [];
  let publications = 0;
  const persist = async () => {
    publications++;
    await new Promise<void>(() => {});
  };
  for (let i = 0; i < 129; i++)
    refused.push(
      f.broker
        .offer({
          ...address,
          turnRequestId: f.turnRequestId,
          offer: { ...f.offer, rpcId: i },
          signal: f.controller.signal,
          persist,
        })
        .catch(() => null),
    );
  await Promise.all(refused);
  expect(publications).toBe(128);
  expect(f.broker.read(address).pending).toEqual([]);
});
