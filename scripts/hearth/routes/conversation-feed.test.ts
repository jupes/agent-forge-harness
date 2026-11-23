import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fetchTransport } from "../../../docs/js/use-stream";
import type { ConversationPage } from "../../../types/conversation";
import { conversationPageSchema } from "../../conversations/protocol";
import { createConversationStore } from "../../conversations/store";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const homes: TestHearth[] = [];
const connections: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  for (const h of homes.splice(0)) await h.close();
});
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Conversation feed deadline");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};
const seed = (h: TestHearth) => {
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
};
const observe = (h: TestHearth, after: number | null = null) => {
  const pages: ConversationPage[] = [];
  const errors: unknown[] = [];
  const connection = fetchTransport(
    h.api + `/projects/${FIXTURE_PROJECT_ID}/keeper/events`,
    { headers: h.headers(h.hearth.token) },
  )(after, {
    onOpen() {},
    onActivity() {},
    onEnd(reason) {
      errors.push(reason);
    },
    onMessage(message) {
      try {
        pages.push(conversationPageSchema.parse(JSON.parse(message.data)));
      } catch (error) {
        errors.push(error);
      }
    },
  });
  connections.push(connection);
  return { pages, errors, connection };
};

test("private replay paginates from an exact cursor without creating a turn or ledger content", async () => {
  const h = await startTestHearth();
  homes.push(h);
  seed(h);
  const store = createConversationStore(h.home);
  const requestId = randomUUID();
  const owner = randomUUID();
  await store.accept(FIXTURE_PROJECT_ID, {
    requestId,
    expectedRevision: 0,
    text: "PRIVATE_QUESTION",
    about: [],
  });
  await store.start(FIXTURE_PROJECT_ID, requestId, owner);
  await store.append(FIXTURE_PROJECT_ID, requestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: randomUUID(),
    version: "fixture",
  });
  for (let index = 0; index < 25; index++)
    await store.append(FIXTURE_PROJECT_ID, requestId, owner, {
      kind: "text",
      text: `PRIVATE_REPLY_${index}`,
    });
  await store.finish(FIXTURE_PROJECT_ID, requestId, owner, "completed", null);
  const stream = observe(h, 4);
  await until(() => stream.pages.at(-1)?.more === false);
  expect(stream.pages.every((page) => page.frames.length <= 10)).toBe(true);
  expect(
    stream.pages.flatMap((page) => page.frames.map((frame) => frame.seq)),
  ).toEqual(Array.from({ length: 23 }, (_, index) => index + 5));
  expect(stream.pages.at(-1)?.lastSequence).toBe(27);
  expect(stream.errors).toEqual([]);
  expect(JSON.stringify(h.events())).not.toContain("PRIVATE_");
  expect(store.read(FIXTURE_PROJECT_ID).turns).toHaveLength(1);
  const invalid = await fetch(
    h.api + `/projects/${FIXTURE_PROJECT_ID}/keeper/events`,
    { headers: { ...h.headers(h.hearth.token), "Last-Event-ID": "999" } },
  );
  expect(invalid.status).toBe(409);
}, 20_000);

test("closing an observer preserves its running turn; only explicit Stop controls its lifetime", async () => {
  let starts = 0;
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        async run(_request, persist, signal) {
          starts++;
          await persist({
            kind: "identity",
            provider: "claude",
            sessionId: randomUUID(),
            version: "fixture",
          });

          await persist({ kind: "text", text: "Partial private reply" });
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { phase: "failed", reason: "Stopped" };
        },
      },
    },
  });
  homes.push(h);
  seed(h);
  const stream = observe(h);
  await until(() => stream.pages.length > 0);
  expect(starts).toBe(0);
  const requestId = randomUUID();
  const response = await fetch(
    h.api + `/projects/${FIXTURE_PROJECT_ID}/keeper/turns`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        requestId,
        expectedRevision: 0,
        text: "Explicit question",
        about: [],
      }),
    },
  );
  expect(response.status).toBe(202);
  await until(() =>
    stream.pages.some((page) =>
      page.frames.some((frame) => frame.event.kind === "text"),
    ),
  );
  stream.connection.close();
  expect(
    createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns[0]?.phase,
  ).toBe("running");
  const stopped = await fetch(
    h.api + `/projects/${FIXTURE_PROJECT_ID}/keeper/stop`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({ requestId }),
    },
  );
  expect(stopped.status).toBe(200);
  await until(
    () =>
      createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns[0]
        ?.phase === "cancelled",
  );
  expect(starts).toBe(1);
}, 20_000);

test("private transcript reads and body streams require operator authority before address validation", async () => {
  const h = await startTestHearth();
  homes.push(h);
  seed(h);
  for (const suffix of ["", "/events"]) {
    for (const token of [null, "wrong-token"]) {
      const response = await fetch(
        h.api + `/projects/${FIXTURE_PROJECT_ID}/keeper${suffix}`,
        { headers: h.headers(token) },
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("frames");
    }
    const invalid = await fetch(h.api + `/projects/invalid/keeper${suffix}`, {
      headers: h.headers(null),
    });
    expect(invalid.status).toBe(403);
    const accepted = await fetch(
      h.api + `/projects/${FIXTURE_PROJECT_ID}/keeper${suffix}`,
      { headers: h.headers(h.hearth.token) },
    );
    expect(accepted.status).toBe(200);
    await accepted.body?.cancel();
  }
  // The model's separate scoped reader remains readonly and never needs the operator token.
  const reader = await fetch(
    h.api + `/projects/${FIXTURE_PROJECT_ID}/keeper/read?kind=beads`,
    { headers: h.headers(null) },
  );
  expect(reader.status).toBe(200);
  expect(h.events(["operator.action"])).toEqual([]);
});
