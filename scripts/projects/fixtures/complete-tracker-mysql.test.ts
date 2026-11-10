import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { withQueueLock } from "../../scheduler/queue-lock";
import { scratchDirs } from "../../test-scratch";
import { readCompleteTrackerOnce } from "../complete-tracker-entry";
import { completeTrackerFixture } from "../complete-tracker-fixture";
import {
  COMPLETE_TRACKER_SQL,
  parseCompleteTracker,
} from "../complete-tracker-source";
import {
  attendedCompleteTrackerFixture,
  completeTrackerMysqlFixture,
} from "./complete-tracker-mysql";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("the unchanged default SQL driver reads a complete zero snapshot from the isolated protocol peer and joins teardown", async () => {
  const root = scratch.make("complete mysql protocol ");
  mkdirSync(join(root, ".git"));
  const fixture = await completeTrackerMysqlFixture({
    root,
    snapshot: async (identity) => completeTrackerFixture(identity, []),
  });
  try {
    const output = await readCompleteTrackerOnce(fixture.descriptor);
    expect(parseCompleteTracker(output, fixture.identity).rows).toEqual([]);
    expect(fixture.stats.connections).toBe(1);
    expect(fixture.stats.snapshots).toBe(1);
    expect(fixture.stats.rejected).toBe(0);
  } finally {
    await fixture.close();
    await fixture.close();
  }
});
// A full result exercises real text/DATETIME/NULL decoding, not an injected database adapter.
test("the real driver preserves content, UTC milliseconds and absent due dates through the complete parser", async () => {
  const root = scratch.make("complete mysql fields ");
  const fixture = await completeTrackerMysqlFixture({
    root,
    snapshot: async (identity) =>
      completeTrackerFixture(identity, [
        {
          id: "one",
          title: "One",
          status: "open",
          issue_type: "task",
          priority: 2,
          description: "Unicode Ω and a newline\nFull body",
          acceptance_criteria: "AC",
          notes: "Notes",
          created_at: "2026-11-09T01:02:03.456Z",
          updated_at: "2026-11-09T02:03:04.987Z",
          due_at: "2026-11-10T03:04:05.123Z",
          labels: ["project:alpha"],
          dependencies: [],
          metadata: {},
        },
      ]),
  });
  try {
    const answer = parseCompleteTracker(
      await readCompleteTrackerOnce(fixture.descriptor),
      fixture.identity,
    );
    expect(answer.rows[0]).toMatchObject({
      description: "Unicode Ω and a newline\nFull body",
      acceptance_criteria: "AC",
      notes: "Notes",
      created_at: "2026-11-09T01:02:03.456Z",
      updated_at: "2026-11-09T02:03:04.987Z",
      due_at: "2026-11-10T03:04:05.123Z",
      labels: ["project:alpha"],
    });
  } finally {
    await fixture.close();
  }
});

for (const kind of ["partial", "foreign identity"] as const) {
  test(`${kind} protocol data is refused by the unchanged complete producer`, async () => {
    const fixture = await completeTrackerMysqlFixture({
      root: scratch.make("refused mysql source "),
      snapshot: async (identity) =>
        kind === "partial"
          ? "[]"
          : completeTrackerFixture(
              {
                ...identity,
                projectId: "11111111-1111-4111-8111-111111111111",
              },
              [],
            ),
    });
    try {
      await expect(readCompleteTrackerOnce(fixture.descriptor)).rejects.toThrow(
        "Complete workspace tracker unavailable.",
      );
      expect(fixture.stats.snapshots).toBe(1);
    } finally {
      await fixture.close();
    }
  });
}

test("unrecognized SQL and prepared commands are refused without reading or forwarding fixture data", async () => {
  for (const parameters of [[], [1]]) {
    const fixture = await completeTrackerMysqlFixture({
      root: scratch.make("mysql unknown command "),
      snapshot: async () => {
        throw Error("Snapshot must not be read.");
      },
    });
    const sql = new SQL({
      adapter: "mysql",
      hostname: "127.0.0.1",
      port: fixture.descriptor.port,
      username: "root",
      password: "",
      database: fixture.identity.database,
      tls: false,
      max: 1,
      connectionTimeout: 1,
      idleTimeout: 0,
      maxLifetime: 2,
    });
    try {
      await expect(
        sql
          .unsafe(
            parameters.length ? COMPLETE_TRACKER_SQL : "SELECT 1",
            parameters,
          )
          .execute(),
      ).rejects.toThrow("Fixture command refused");
      expect(fixture.stats.snapshots).toBe(0);
      expect(fixture.stats.rejected).toBe(1);
      expect(fixture.stats.rejectedCommand).toBe(parameters.length ? 0x16 : 3);
    } finally {
      await sql.close({ timeout: 0 });
      await fixture.close();
    }
  }
});

test("the attended fixture returns current closed-world state under the same tracker lock as its CLI", async () => {
  const root = scratch.make("attended mysql state "),
    state = join(root, "fixture");
  mkdirSync(state);
  writeFileSync(
    join(root, "attended-native-fixture.marker"),
    "agent-forge-attended-native-fixture-v1",
  );
  const rows = [
    { id: "epic", title: "Epic", issueType: "epic", labels: ["project:alpha"] },
    {
      id: "work",
      title: "Work",
      issueType: "task",
      parent: { id: "epic" },
      labels: ["project:alpha", "queue:queued"],
      metadata: { queue_state: "queued" },
    },
  ];
  writeFileSync(join(state, "tracker.json"), JSON.stringify(rows));
  const fixture = await attendedCompleteTrackerFixture(root);
  try {
    const first = parseCompleteTracker(
      await readCompleteTrackerOnce(fixture.descriptor),
      fixture.identity,
    );
    expect(first.rows.find((row) => row.id === "work")?.dependencies).toEqual([
      { issue_id: "work", depends_on_id: "epic", type: "parent-child" },
    ]);
    const changed = await withQueueLock(
      join(state, "tracker.lock.db"),
      async () => {
        writeFileSync(
          join(state, "tracker.json"),
          JSON.stringify([
            rows[0],
            {
              ...rows[1],
              status: "closed",
              labels: ["project:alpha", "queue:review"],
              metadata: { queue_state: "review" },
            },
          ]),
        );
      },
    );
    expect(changed.ok).toBe(true);
    const second = parseCompleteTracker(
      await readCompleteTrackerOnce(fixture.descriptor),
      fixture.identity,
    );
    expect(second.rows.find((row) => row.id === "work")).toMatchObject({
      status: "closed",
      labels: ["project:alpha", "queue:review"],
      metadata: { queue_state: "review" },
    });
    expect(fixture.stats.snapshots).toBe(2);
    expect(fixture.stats.rejected).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("closing while a synthetic read is pending joins it and discards its late response", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  const fixture = await completeTrackerMysqlFixture({
    root: scratch.make("closing mysql source "),
    snapshot: async (identity) => {
      entered();
      await held;
      return completeTrackerFixture(identity, []);
    },
  });
  const read = readCompleteTrackerOnce(fixture.descriptor);
  const result = read.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error: String(error.message) }),
  );
  await started;
  const closed = fixture.close();
  release();
  await closed;
  expect(await result).toEqual({
    value: null,
    error: "Complete workspace tracker unavailable.",
  });
  expect(fixture.stats.snapshots).toBe(1);
  expect(fixture.stats.rejected).toBe(0);
});

test("a response timeout cannot release fixture cleanup while its actual snapshot operation is still held", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await completeTrackerMysqlFixture({
    root: scratch.make("timed out mysql source "),
    snapshot: async (identity) => {
      await held;
      return completeTrackerFixture(identity, []);
    },
  });
  let closed = false;
  try {
    await expect(readCompleteTrackerOnce(fixture.descriptor)).rejects.toThrow(
      "Complete workspace tracker unavailable.",
    );
    expect(fixture.stats.snapshots).toBe(1);
    expect(fixture.stats.rejected).toBe(1);
    const closing = fixture.close().then(() => {
      closed = true;
    });
    await Promise.race([closing, Bun.sleep(20)]);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  } finally {
    release();
    await fixture.close();
  }
});
