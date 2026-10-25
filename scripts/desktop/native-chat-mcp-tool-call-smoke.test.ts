import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeChatMcpToolCalls } from "../../apps/desktop/src/native-chat-mcp-tool-calls";
import { conversationPage } from "../conversations/page";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import {
  ownedCodingPageSchema,
  ownedCodingStateSchema,
} from "../sessions/codex-owned-journal";
import { scratchDirs } from "../test-scratch";
import {
  seedNativeMcpToolCallSession,
  verifyNativeMcpToolCalls,
} from "./native-chat-mcp-tool-call-smoke";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("the packaged MCP fixture is historical, identity-bound private Chat data with distinct result shapes", async () => {
  const root = scratch.make("native-mcp-report-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  const record = await seedNativeMcpToolCallSession(
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
    reports = nativeChatMcpToolCalls(page, record.requestId);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
  expect(page.controllable).toBe(false);
  expect(state.turns[0]?.phase).toBe("completed");
  expect(reports).toHaveLength(3);
  expect(reports[0]?.report).toMatchObject({
    source: "turn/completed",
    status: "completed",
    closure: "turn-ended",
    arguments: {
      json: '{"filter":"<script>literal</script>"',
      truncated: true,
      omitted: "size",
    },
    result: {
      content: { json: "[]", truncated: false },
      structuredContent: null,
    },
  });
  expect(reports[1]?.report).toMatchObject({
    status: "failed",
    result: null,
    error: { text: "<script>reported failure</script>", truncated: false },
  });
  expect(reports[2]?.report).toMatchObject({
    status: "failed",
    result: null,
    error: { text: "", truncated: true },
  });
  expect(
    state.frames.some(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "approval-request",
    ),
  ).toBe(false);
});

test("the packaged MCP probe inspects literal snapshots, compiles its WebView assertions, masks the synthetic screenshot and restores state", async () => {
  const root = scratch.make("native-mcp-probe-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  const record = await seedNativeMcpToolCallSession(
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
  let screenshot = "",
    posts = false;
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
    async screenshot(_socket: EventTarget, name: string) {
      screenshot = name;
      expect(expressions.at(-1)).toContain("identifiers masked");
      expect(posts).toBe(false);
    },
  };
  await verifyNativeMcpToolCalls(socket, record, home, tools);
  expect(screenshot).toBe("native-chat-mcp-tool-calls.png");
  expect(expressions.at(-1)).toBe('location.hash="#/desktop/projects"');
  expect(
    expressions.some((expression) => expression.includes("identifiers masked")),
  ).toBe(true);
  expect(readFileSync(file).equals(before)).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
});

test("the MCP inspection rejects POSTs without retaining their bodies and always restores route/listener", async () => {
  const root = scratch.make("native-mcp-post-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  const record = await seedNativeMcpToolCallSession(
      home,
      root,
      "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    socket = new EventTarget(),
    remove = spyOn(socket, "removeEventListener"),
    expressions: string[] = [];
  let screenshot = false;
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
    async screenshot() {
      screenshot = true;
    },
  };
  await expect(
    verifyNativeMcpToolCalls(socket, record, home, tools),
  ).rejects.toThrow("inspection sent a POST");
  expect(expressions.at(-1)).toBe('location.hash="#/desktop/projects"');
  expect(screenshot).toBe(false);
  expect(remove).toHaveBeenCalledTimes(1);
});
