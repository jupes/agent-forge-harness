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
  hasVisibleNativePatchFocus,
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

test("the native focus failure reports only bounded style and active-element facts", async () => {
  const root = scratch.make("native-file-focus-diagnostic-"),
    home = join(root, "home"),
    record = await seedNativeFileChangeSession(
      home,
      root,
      "project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    socket = new EventTarget();
  let wait = 0,
    diagnosticExpression = "",
    screenshot = false;
  const tools = {
    async evaluate(_socket: EventTarget, expression: string) {
      if (expression === "location.hash") return "#/desktop/projects";
      if (expression.includes("outlineWidthCssPx")) {
        diagnosticExpression = expression;
        return {
          reportFound: true,
          preFound: true,
          preConnected: true,
          activeIsPre: true,
          activeTag: "PRE",
          focusVisible: true,
          outlineWidth: "1.71429px",
          outlineWidthCssPx: 1.71429,
          outlineStyle: "solid",
          specifiedCssPx: 2,
          dpr: 1.2,
          textContent: "PRIVATE_CONTENT_MUST_NOT_APPEAR",
        };
      }
      return undefined;
    },
    async enableRequests() {},
    async waitForPage() {
      wait++;
      if (wait === 3) throw Error("Focus wait failed");
    },
    async pressTab() {},
    async screenshot() {
      screenshot = true;
    },
  };
  const failure = await verifyNativeFileChanges(
    socket,
    record,
    home,
    tools,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('"activeIsPre":true');
  expect((failure as Error).message).toContain('"specifiedCssPx":2');
  expect((failure as Error).message).not.toContain(
    "PRIVATE_CONTENT_MUST_NOT_APPEAR",
  );
  expect(diagnosticExpression).toContain("outlineWidthCssPx");
  expect(screenshot).toBe(true);
});

test("visible patch focus requires a focused solid declared two-pixel outline within one device pixel", () => {
  const facts = {
    activeIsPre: true,
    focusVisible: true,
    outlineStyle: "solid",
    specifiedCssPx: 2,
    outlineWidthCssPx: 1.71429,
    dpr: 1.75,
  };
  expect(hasVisibleNativePatchFocus(facts)).toBe(true);
  for (const changed of [
    { activeIsPre: false },
    { focusVisible: false },
    { outlineStyle: "dashed" },
    { specifiedCssPx: 1.99 },
    { outlineWidthCssPx: 0 },
    { outlineWidthCssPx: Number.NaN },
    { dpr: 0 },
    { dpr: Number.POSITIVE_INFINITY },
    { outlineWidthCssPx: 2 - 1 / 1.75 },
    { outlineWidthCssPx: 1.4 },
  ])
    expect(hasVisibleNativePatchFocus({ ...facts, ...changed })).toBe(false);
});
