import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeChatWebSearches } from "../../apps/desktop/src/native-chat-web-search";
import { conversationPage } from "../conversations/page";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import {
  ownedCodingPageSchema,
  ownedCodingStateSchema,
} from "../sessions/codex-owned-journal";
import { scratchDirs } from "../test-scratch";
import {
  seedNativeWebSearchSession,
  verifyNativeWebSearches,
} from "./native-chat-web-search-smoke";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("the packaged WebSearch fixture is historical private Chat data with truthful native report shapes", async () => {
  const root = scratch.make("native-web-search-report-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  const record = await seedNativeWebSearchSession(
      home,
      root,
      "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    store = createConversationStore(home, undefined, {
      kind: "session",
      projectId: record.projectId,
      sessionId: record.id,
    }),
    state = store.read(record.projectId),
    page = conversationPage(state, { limit: 100 }, false),
    reports = nativeChatWebSearches(page, record.requestId);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
  expect(page.controllable).toBe(false);
  expect(state.turns[0]?.phase).toBe("completed");
  expect(reports).toHaveLength(4);
  expect(reports.map(({ report }) => report.itemId)).toEqual([
    "native-smoke-web-search-main",
    "native-smoke-web-search-empty",
    "native-smoke-web-search-absent",
    "native-smoke-web-search-clipped",
  ]);
  expect(reports[0]?.report).toMatchObject({
    source: "turn/completed",
    query: { text: "literal query <tag>", truncated: false },
    action: {
      json: '{"type":"search","query":"literal query <tag>","queries":["literal query <tag>"]}',
      truncated: false,
    },
    results: {
      json: '[{"title":"<literal>","url":"https://fixture.invalid/private"}]',
      truncated: false,
    },
    closure: "turn-ended",
    turnStatus: "completed",
  });
  expect(reports[1]?.report).toMatchObject({
    query: { text: "", truncated: false },
    action: {
      json: '{"type":"search","query":null,"queries":[]}',
      truncated: false,
    },
    results: { json: "[]", truncated: false },
    closure: "item-ended",
    turnStatus: null,
  });
  expect(reports[2]?.report).toMatchObject({
    action: null,
    results: null,
    closure: "open",
    turnStatus: null,
  });
  expect(reports[3]?.report).toMatchObject({
    query: { text: "", truncated: true },
    results: { json: "", truncated: true, omitted: "size" },
    closure: "open",
  });
  expect(
    state.frames.some(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "approval-request",
    ),
  ).toBe(false);
});

test("the packaged WebSearch probe compiles read-only WebView assertions and restores bytes, route and listener", async () => {
  const root = scratch.make("native-web-search-probe-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  const record = await seedNativeWebSearchSession(
      home,
      root,
      "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    file = conversationFile(home, record.projectId, {
      kind: "session",
      projectId: record.projectId,
      sessionId: record.id,
    }),
    before = readFileSync(file),
    socket = new EventTarget(),
    remove = spyOn(socket, "removeEventListener"),
    expressions: string[] = [];
  const tools = {
    async evaluate(_socket: EventTarget, expression: string) {
      expressions.push(expression);
      return expression === "location.hash" ? "#/desktop/projects" : undefined;
    },
    async enableRequests() {},
    async waitForPage(_socket: EventTarget, expression: string) {
      new Function(`return (${expression});`);
      expect(expression).not.toContain("fetch(");
      expect(expression).not.toContain("XMLHttpRequest");
    },
    async pressTab() {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            method: "Network.requestWillBeSent",
            params: { request: { method: "GET" } },
          }),
        }),
      );
    },
  };
  await verifyNativeWebSearches(socket, record, home, tools);
  expect(expressions.at(-1)).toBe('location.hash="#/desktop/projects"');
  expect(readFileSync(file).equals(before)).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
});

test("the packaged WebSearch probe fails on inspection POST and still restores its route and listener", async () => {
  const root = scratch.make("native-web-search-post-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  const record = await seedNativeWebSearchSession(
      home,
      root,
      "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    socket = new EventTarget(),
    remove = spyOn(socket, "removeEventListener"),
    expressions: string[] = [];
  const tools = {
    async evaluate(_socket: EventTarget, expression: string) {
      expressions.push(expression);
      return expression === "location.hash" ? "#/desktop/projects" : undefined;
    },
    async enableRequests() {},
    async waitForPage(_socket: EventTarget, expression: string) {
      new Function(`return (${expression});`);
    },
    async pressTab() {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            method: "Network.requestWillBeSent",
            params: {
              request: {
                method: "POST",
                url: "https://fixture.invalid/private",
                postData: "PRIVATE_BODY_MUST_NOT_APPEAR",
              },
            },
          }),
        }),
      );
    },
  };
  await expect(
    verifyNativeWebSearches(socket, record, home, tools),
  ).rejects.toThrow("inspection sent a POST");
  expect(expressions.at(-1)).toBe('location.hash="#/desktop/projects"');
  expect(remove).toHaveBeenCalledTimes(1);
});
