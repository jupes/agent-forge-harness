import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import { createQueue } from "./queue";
import { queueTracker } from "./queue-fixture";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
test("fresh project admission is checked inside canonical queue ownership immediately before Start and never fences cleanup", async () => {
  const root = scratch.make("project-shift-admission-"),
    tracker = queueTracker([
      {
        id: "alpha-task",
        labels: ["queue:queued", "project:alpha"],
        metadata: { queue_state: "queued" },
      },
    ]);
  let checks = 0,
    eventId = 0;
  let pausing: ReturnType<ReturnType<typeof createQueue>["move"]> | undefined;
  const options = {
    workspace: root,
    runBd: tracker.run,
    lockFile: join(root, "queue.db"),
    appendEvent: () => ({
      ok: true as const,
      id: ++eventId,
      ulid: "01JG0000000000000000000000",
    }),
  };
  const operator = createQueue(options);
  const scheduler = createQueue({
    ...options,
    beforeStart: async (id: string, shown: Record<string, unknown>) => {
      checks++;
      expect(shown["labels"]).toContain("project:alpha");
      pausing = operator.move(id, "pause", "operator");
      await Bun.sleep(1);
      expect(tracker.calls).toHaveLength(1);
      return false;
    },
  });
  const result = await scheduler.move("alpha-task", "start", "scheduler");
  expect(result).toMatchObject({ ok: false, kind: "refused" });
  expect((await pausing)?.ok).toBe(true);
  expect(tracker.updates().flat()).not.toContain("--add-label=queue:running");
  expect(checks).toBe(1);
  // Cleanup remains the existing queue operation, even when fresh admission is no longer permitted.
  tracker.beads.set("alpha-task", {
    id: "alpha-task",
    labels: ["queue:running"],
    metadata: { queue_state: "running" },
  });
  expect((await scheduler.move("alpha-task", "release", "scheduler")).ok).toBe(
    true,
  );
  expect(checks).toBe(1);
});
