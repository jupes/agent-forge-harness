import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createConversationStore } from "../../conversations/store";
import { fakeConversationTransport } from "../../conversations/testing";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("session and activity About references require their own member bead; session reuse grants no foreign event", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [
            {
              id: "alpha-epic",
              title: "Alpha",
              issue_type: "epic",
              status: "open",
              labels: ["project:alpha"],
            },
            {
              id: "beta-epic",
              title: "Beta",
              issue_type: "epic",
              status: "open",
              labels: ["project:beta"],
            },
          ]
            .map((row) => JSON.stringify(row))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  const executor = { provider: "codex" as const, model: "fixture-model" };
  const member = h.append({
    kind: "session.started",
    beadId: "alpha-epic",
    sessionId: "member-session",
    executor,
    payload: { kind: "interactive" },
  });
  const foreign = h.append({
    kind: "session.ended",
    beadId: "beta-epic",
    sessionId: "member-session",
    executor,
    payload: { reason: "fixture foreign end" },
  });
  h.append({
    kind: "session.started",
    beadId: "beta-epic",
    sessionId: "foreign-session",
    executor,
    payload: { kind: "interactive" },
  });
  const post = (about: unknown) =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/turns`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: 0,
        text: "Explain these references",
        about,
      }),
    });
  expect((await post([{ kind: "event", id: String(foreign) }])).status).toBe(
    404,
  );
  expect(
    (await post([{ kind: "session", id: "foreign-session" }])).status,
  ).toBe(404);
  expect(
    createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns,
  ).toEqual([]);
  expect((await post([{ kind: "event", id: String(member) }])).status).toBe(
    202,
  );
});

test("About objects must belong to the project before preflight or admission; exact retries retain their saved context", async () => {
  let checks = 0;
  let starts = 0;
  const seen: unknown[] = [];
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        async check() {
          checks++;
        },
        async run(request) {
          starts++;
          seen.push(request.input.about);
          return { phase: "completed", reason: null };
        },
      },
    },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const member = {
    id: "member",
    title: "Member",
    issue_type: "task",
    status: "open",
    labels: ["project:alpha"],
    dependencies: [
      { issue_id: "member", depends_on_id: "alpha-epic", type: "parent-child" },
    ],
  };
  let available = true;
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: available ? 0 : 1,
          stdout: [
            {
              id: "alpha-epic",
              title: "Alpha",
              issue_type: "epic",
              status: "open",
              labels: ["project:alpha"],
            },
            member,
            {
              ...member,
              id: "foreign",
              labels: ["project:beta"],
              dependencies: [
                {
                  issue_id: "foreign",
                  depends_on_id: "alpha-epic",
                  type: "parent-child",
                },
              ],
            },
          ]
            .map((row) => JSON.stringify(row))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  const post = (request: unknown) =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/turns`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(request),
    });
  const input = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "Explain this selection",
    about: [{ kind: "bead", id: "foreign" }],
  };
  expect((await post(input)).status).toBe(404);
  expect(checks).toBe(0);
  expect(starts).toBe(0);
  expect(
    createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns,
  ).toEqual([]);
  const allowed = { ...input, about: [{ kind: "bead", id: "member" }] };
  expect((await post(allowed)).status).toBe(202);
  available = false;
  expect((await post(allowed)).status).toBe(202);
  expect((await post({ ...allowed, about: [] })).status).toBe(409);
  expect(starts).toBe(1);
  expect(seen).toEqual([[{ kind: "bead", id: "member" }]]);
  expect((await post({ ...allowed, requestId: randomUUID() })).status).toBe(
    404,
  );
  expect(starts).toBe(1);
  expect(JSON.stringify(h.events())).not.toContain(input.text);
});

test("the Keeper action is audited before a single durable send, while reads never start a turn", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const path = `/projects/${FIXTURE_PROJECT_ID}/keeper`;
  const get = (suffix = "") =>
    fetch(h.api + path + suffix, { headers: h.headers(h.hearth.token) });
  expect((await get()).status).toBe(200);
  expect(
    createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns,
  ).toEqual([]);
  const request = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "Private question",
    about: [],
  };
  const post = () =>
    fetch(h.api + path + "/turns", {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(request),
    });
  expect((await post()).status).toBe(202);
  expect((await post()).status).toBe(202);
  const state = createConversationStore(h.home).read(FIXTURE_PROJECT_ID);
  expect(state.turns).toHaveLength(1);
  expect(
    state.frames.filter((frame) => frame.event.kind === "user"),
  ).toHaveLength(1);
  const audits = h.events(["operator.action"]);
  expect(audits).toHaveLength(2);
  expect(audits[0]?.payload).toMatchObject({
    action: "keeper.turn.send",
    target: FIXTURE_PROJECT_ID,
  });
  expect(JSON.stringify(h.events())).not.toContain("Private question");
  const read = await get(`?after=0&limit=1&requestId=${request.requestId}`);
  const body: unknown = await read.json();
  expect(body).toMatchObject({
    ok: true,
    data: { request: { requestId: request.requestId }, frames: [{ seq: 1 }] },
  });
  expect((await get("?limit=101")).status).toBe(400);
  expect((await get("?project=other")).status).toBe(400);
});

test("a lost send response is reconciled by its original request without another provider start", async () => {
  let starts = 0;
  const fake = fakeConversationTransport();
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        async run(...args) {
          starts++;
          return fake.run(...args);
        },
      },
      decorate: (routes) =>
        routes.map((route) =>
          route.kind === "action" && route.action === "keeper.turn.send"
            ? {
                ...route,
                effect: async (input) => {
                  await route.effect(input);
                  throw new Error("Fixture lost the reply after admission");
                },
              }
            : route,
        ),
    },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const path = `/projects/${FIXTURE_PROJECT_ID}/keeper`;
  const requestId = randomUUID();
  const sent = await fetch(h.api + path + "/turns", {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      requestId,
      expectedRevision: 0,
      text: "The reply may be lost",
      about: [],
    }),
  });
  expect(sent.status).toBe(500);
  const read = await fetch(h.api + path + `?requestId=${requestId}`, {
    headers: h.headers(h.hearth.token),
  });
  const result: unknown = await read.json();
  expect(result).toMatchObject({ ok: true, data: { request: { requestId } } });
  expect(
    createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns,
  ).toHaveLength(1);
  expect(starts).toBe(1);
});
