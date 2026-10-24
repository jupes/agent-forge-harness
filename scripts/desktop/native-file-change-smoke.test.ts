import { afterEach, expect, test } from "bun:test";
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
import { seedNativeFileChangeSession } from "./native-file-change-smoke";

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
