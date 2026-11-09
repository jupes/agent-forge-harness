import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOwnTracker } from "./complete-tracker-descriptor";
import { readCompleteTrackerOnce } from "./complete-tracker-entry";
import { completeTrackerFixture } from "./complete-tracker-fixture";
import {
  COMPLETE_TRACKER_SQL,
  parseCompleteTracker,
} from "./complete-tracker-source";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "complete-tracker-entry-"));
  roots.push(root);
  mkdirSync(join(root, ".beads"));
  const identity = {
    database: "test_db",
    projectId: "11111111-1111-4111-8111-111111111111",
  };
  writeFileSync(
    join(root, ".beads/metadata.json"),
    JSON.stringify({
      backend: "dolt",
      dolt_mode: "server",
      dolt_database: identity.database,
      project_id: identity.projectId,
    }),
  );
  writeFileSync(join(root, ".beads/dolt-server.port"), "3308\n");
  let rows: Array<Record<string, unknown>>;
  try {
    rows = JSON.parse(
      completeTrackerFixture(identity, [
        {
          id: "one",
          title: "One",
          status: "open",
          issue_type: "task",
          priority: 2,
          description: "Full",
          acceptance_criteria: "AC",
          notes: "Notes",
          created_at: "2026-11-09T01:00:00Z",
          updated_at: "2026-11-09T02:00:00Z",
          due_at: "2026-11-10T01:00:00Z",
          labels: [],
          dependencies: [],
          metadata: {},
        },
      ]),
    );
  } catch {
    throw Error("fixture JSON");
  }
  for (const row of rows)
    for (const key of ["created_at", "updated_at", "due_at"])
      if (typeof row[key] === "string") row[key] = new Date(row[key]);
  return { identity, descriptor: captureOwnTracker(root), rows };
}
test("the actual entry core issues only the fixed snapshot query and returns validated UTC dates after close", async () => {
  const { identity, descriptor, rows } = fixture();
  let closed = 0;
  const statements: string[] = [];
  const stdout = await readCompleteTrackerOnce(descriptor, () => ({
    query: async (statement) => {
      statements.push(statement);
      return rows;
    },
    close: async () => {
      closed++;
    },
  }));
  expect(statements).toEqual([COMPLETE_TRACKER_SQL]);
  expect(closed).toBe(1);
  expect(parseCompleteTracker(stdout, identity).rows[0]?.due_at).toBe(
    "2026-11-10T01:00:00.000Z",
  );
});
test("an invalid native due Date cannot silently serialize as an absent due date", async () => {
  const { descriptor, rows } = fixture();
  rows.find((row) => row.part === "issues")!.due_at = new Date(NaN);
  let closed = 0;
  await expect(
    readCompleteTrackerOnce(descriptor, () => ({
      query: async () => rows,
      close: async () => {
        closed++;
      },
    })),
  ).rejects.toThrow("Complete workspace tracker unavailable.");
  expect(closed).toBe(1);
});
test("a completed query cannot publish while actual teardown is held", async () => {
  const { descriptor, rows } = fixture();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let delivered = false;
  const pending = readCompleteTrackerOnce(descriptor, () => ({
    query: async () => rows,
    close: async () => {
      entered();
      await hold;
    },
  })).then((value) => {
    delivered = true;
    return value;
  });
  await closing;
  expect(delivered).toBe(false);
  release();
  expect(await pending).toContain('"manifest"');
  expect(delivered).toBe(true);
});
test("read and close errors remain private and cleanup is attempted exactly once", async () => {
  for (const operation of ["query", "close"]) {
    const { descriptor, rows } = fixture();
    let closed = 0;
    await expect(
      readCompleteTrackerOnce(descriptor, () => ({
        query: async () => {
          if (operation === "query") throw Error("private query");
          return rows;
        },
        close: async () => {
          closed++;
          if (operation === "close") throw Error("private close");
        },
      })),
    ).rejects.toThrow("Complete workspace tracker unavailable.");
    expect(closed).toBe(1);
  }
});
