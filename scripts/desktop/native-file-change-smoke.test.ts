import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nativeChatFileChanges } from "../../apps/desktop/src/native-chat-file-changes";
import { conversationPage } from "../conversations/page";
import { createConversationStore } from "../conversations/store";
import {
  ownedCodingPageSchema,
  ownedCodingStateSchema,
} from "../sessions/codex-owned-journal";
import { scratchDirs } from "../test-scratch";
import {
  seedNativeFileChangeSession,
  verifyNativeFileChanges,
} from "./native-file-change-smoke";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
test("the packaged file-report fixture is strict historical Chat data with literal native snapshots and no live control", async () => {
  const root = scratch.make("native-file-report-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  const record = await seedNativeFileChangeSession(
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
    page = conversationPage(state, { limit: 100 }, false);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
  expect(page.controllable).toBe(false);
  expect(state.turns[0]?.phase).toBe("completed");
  const snapshots = nativeChatFileChanges(page, record.requestId);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.report).toMatchObject({
    source: "turn/completed",
    status: "declined",
    closure: "turn-ended",
    turnStatus: "completed",
  });
  expect(snapshots[0]?.report.changes[0]?.diff.text).toBe(
    "-old\n+<script>native patch stays text</script>",
  );
  expect(snapshots[0]?.report.changes[1]?.diff).toEqual({
    text: "",
    truncated: false,
  });
  expect(
    state.frames.some(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "approval-request",
    ),
  ).toBe(false);
});

test("the native file probe refuses any inspection POST and restores its prior route without retaining request bodies", async () => {
  const root = scratch.make("native-file-request-"),
    home = join(root, "home"),
    record = await seedNativeFileChangeSession(
      home,
      root,
      "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    socket = new EventTarget(),
    expressions: string[] = [];
  const remove = spyOn(socket, "removeEventListener");
  let screenshot = false;
  const tools = {
    async evaluate(_socket: EventTarget, expression: string) {
      expressions.push(expression);
      return expression === "location.hash" ? "#/desktop/projects" : undefined;
    },
    async enableRequests() {},
    async waitForPage() {},
    async pressTab() {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            method: "Network.requestWillBeSent",
            params: {
              request: {
                method: "POST",
                url: "https://inert.invalid/private",
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
    verifyNativeFileChanges(socket, record, home, tools),
  ).rejects.toThrow("inspection sent a POST");
  expect(expressions.at(-1)).toBe('location.hash="#/desktop/projects"');
  expect(screenshot).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
});

test("the native file probe observes reads without refusing and cleans its local listener on success or a page failure", async () => {
  for (const fail of [false, true]) {
    const root = scratch.make("native-file-probe-"),
      home = join(root, "home"),
      record = await seedNativeFileChangeSession(
        home,
        root,
        "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
      socket = new EventTarget(),
      remove = spyOn(socket, "removeEventListener"),
      expressions: string[] = [],
      cause = Error("Original native page assertion");
    let screenshot = false;
    const tools = {
      async evaluate(_socket: EventTarget, expression: string) {
        expressions.push(expression);
        return expression === "location.hash"
          ? "#/desktop/projects"
          : undefined;
      },
      async enableRequests() {},
      async waitForPage(_socket: EventTarget, expression: string) {
        // Compile the actual WebView expression without executing any DOM or I/O.
        new Function(`return (${expression});`);
        if (fail) throw cause;
      },
      async pressTab() {
        socket.dispatchEvent(new MessageEvent("message", { data: "{" }));
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              method: "Network.requestWillBeSent",
              params: { request: { method: "GET" } },
            }),
          }),
        );
      },
      async screenshot() {
        screenshot = true;
        throw Error("Secondary capture failure");
      },
    };
    if (fail)
      await expect(
        verifyNativeFileChanges(socket, record, home, tools),
      ).rejects.toBe(cause);
    else await verifyNativeFileChanges(socket, record, home, tools);
    expect(screenshot).toBe(fail);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(expressions.at(-1)).toBe('location.hash="#/desktop/projects"');
  }
});
