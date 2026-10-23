import { afterEach, expect, test } from "bun:test";
import { ownedSessionControls } from "../../apps/desktop/src/session-controls";
import { createConversationStore } from "../conversations/store";
import { seedOwnedSession } from "../hearth/routes/session-fixture";
import { startTestHearth, type TestHearth } from "../hearth/testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("controls distinguish exact Claude Chat continuation from owned Stop and never invent fork, terminal or permission producers", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const record = await seedOwnedSession(h);
  const state = createConversationStore(h.home, undefined, {
    kind: "session",
    projectId: record.projectId,
    sessionId: record.id,
  }).read(record.projectId);
  const page = {
    ...state,
    more: false,
    nextCursor: state.frames.length,
    lastSequence: state.frames.length,
    request: null,
    controllable: false,
  };
  const input = {
    record,
    page,
    loaded: true,
    live: true,
    pending: false,
    stopping: false,
  };
  const idle = ownedSessionControls(input);
  expect(idle.resume.available).toBe(true);
  expect(idle.stop.available).toBe(false);
  expect(idle.commandPreview).toContain("--print");
  expect(idle.commandPreview).not.toContain("Historical private fixture");
  expect([
    idle.fork.available,
    idle.terminal.available,
    idle.permissions.available,
  ]).toEqual([false, false, false]);
  expect(ownedSessionControls({ ...input, live: false }).resume.available).toBe(
    false,
  );
  expect(
    ownedSessionControls({ ...input, page: { ...page, binding: null } }).resume
      .available,
  ).toBe(false);
  expect(
    ownedSessionControls({ ...input, pending: true }).resume.available,
  ).toBe(false);
  expect(
    ownedSessionControls({ ...input, record: { ...record, mode: "task" } })
      .resume.available,
  ).toBe(false);
  expect(
    ownedSessionControls({
      ...input,
      record: { ...record, provider: "codex", mode: "task" },
    }).resume.reason,
  ).toContain("one-turn Tasks");
  const running = {
    ...page,
    controllable: true,
    turns: page.turns.map((turn) => ({ ...turn, phase: "running" as const })),
  };
  expect(ownedSessionControls({ ...input, page: running }).stop.available).toBe(
    true,
  );
  expect(
    ownedSessionControls({ ...input, page: running }).resume.available,
  ).toBe(false);
  expect(
    ownedSessionControls({ ...input, page: running, stopping: true }).stop
      .reason,
  ).toContain("pending");
  expect(
    ownedSessionControls({
      ...input,
      page: { ...running, controllable: false },
    }).stop.available,
  ).toBe(false);
});
