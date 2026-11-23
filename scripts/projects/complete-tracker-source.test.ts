import { expect, test } from "bun:test";
import { issuesAndDepsFromExportRows } from "../beads-dashboard";
import { queueEntries } from "../hearth/routes/operator-reads";
import { completeTrackerFixture } from "./complete-tracker-fixture";
import {
  COMPLETE_TRACKER_BYTES,
  type CompleteBeadRow,
  parseCompleteTracker,
} from "./complete-tracker-source";

const identity = {
  database: "fixture_db",
  projectId: "11111111-1111-4111-8111-111111111111",
};
const row = (id: string): CompleteBeadRow => ({
  id,
  title: id,
  status: "open",
  issue_type: id === "epic" ? "epic" : "task",
  priority: 2,
  description: "Full description",
  acceptance_criteria: "Full acceptance",
  notes: "Full private notes",
  created_at: "2026-11-09T01:00:00Z",
  updated_at: "2026-11-09T02:00:00Z",
  owner: "owner",
  assignee: "smith",
  labels: ["project:example"],
  dependencies: [],
  metadata: {},
});
const fixture = () =>
  completeTrackerFixture(
    identity,
    [
      row("epic"),
      {
        ...row("task"),
        labels: ["project:example", "queue:paused"],
        metadata: {
          queue_state: "paused",
          queue_resume: "queued",
          smith: "s1",
        },
        dependencies: [
          { issue_id: "task", depends_on_id: "epic", type: "parent-child" },
        ],
      },
      {
        ...row("wisp"),
        dependencies: [
          { issue_id: "wisp", depends_on_id: "task", type: "blocks" },
        ],
      },
    ],
    ["wisp"],
  );
function mutate(
  change: (parts: Array<Record<string, unknown>>) => void,
): string {
  let parts: Array<Record<string, unknown>>;
  try {
    parts = JSON.parse(fixture());
  } catch {
    throw Error("fixture JSON");
  }
  change(parts);
  return JSON.stringify(parts);
}
function body(part: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(String(part.payload));
  } catch {
    throw Error("fixture body");
  }
}

test("complete durable and wisp families preserve ancestry, labels, full content and backed queue metadata", () => {
  const result = parseCompleteTracker(fixture(), identity);
  expect(result.identity).toEqual(identity);
  expect(result.rows).toHaveLength(3);
  const task = result.rows.find((item) => item.id === "task")!;
  expect(task).toMatchObject({
    description: "Full description",
    acceptance_criteria: "Full acceptance",
    notes: "Full private notes",
    owner: "owner",
    assignee: "smith",
  });
  const normalized = issuesAndDepsFromExportRows(result.rows);
  expect(normalized.issues.find((item) => item.id === "task")?.parent).toBe(
    "epic",
  );
  expect(normalized.deps).toContainEqual({
    from: "wisp",
    to: "task",
    type: "blocks",
  });
  expect(queueEntries(JSON.stringify(result.rows))).toMatchObject({
    ok: true,
    entries: [
      {
        beadId: "task",
        state: "paused",
        backed: true,
        resume: "queued",
        smith: "s1",
      },
    ],
  });
});
test("a complete zero manifest is empty; missing rows or identity are unavailable", () => {
  expect(
    parseCompleteTracker(completeTrackerFixture(identity, []), identity).rows,
  ).toEqual([]);
  for (const input of ["[]", "", "not JSON", "{}", fixture().slice(0, -1)])
    expect(() => parseCompleteTracker(input, identity)).toThrow(
      "unavailable or incomplete",
    );
  expect(() =>
    parseCompleteTracker(fixture(), { ...identity, database: "other" }),
  ).toThrow();
  expect(() =>
    parseCompleteTracker(fixture(), {
      ...identity,
      projectId: "22222222-2222-4222-8222-222222222222",
    }),
  ).toThrow();
});
const corruptions: Array<
  [string, (parts: Array<Record<string, unknown>>) => void]
> = [
  [
    "missing label row",
    (parts) => {
      parts.splice(
        parts.findIndex((p) => p.part === "labels"),
        1,
      );
    },
  ],
  [
    "missing wisp dependency",
    (parts) => {
      parts.splice(
        parts.findIndex((p) => p.part === "wisp_dependencies"),
        1,
      );
    },
  ],
  [
    "missing counter",
    (parts) => {
      const m = body(parts[0]!);
      delete (m.counts as Record<string, unknown>).wisp_labels;
      parts[0]!.payload = JSON.stringify(m);
    },
  ],
  [
    "duplicate manifest",
    (parts) => {
      parts.push(parts[0]!);
    },
  ],
  [
    "duplicate identity",
    (parts) => {
      const p = parts.find((p) => p.part === "wisps")!,
        value = body(p);
      value.id = "task";
      p.payload = JSON.stringify(value);
    },
  ],
  [
    "wrong label family",
    (parts) => {
      const p = parts.find((p) => p.part === "labels")!,
        value = body(p);
      value.issue_id = "wisp";
      p.payload = JSON.stringify(value);
    },
  ],
  [
    "two dependency targets",
    (parts) => {
      const p = parts.find((p) => p.part === "dependencies")!,
        value = body(p);
      value.depends_on_wisp_id = "wisp";
      p.payload = JSON.stringify(value);
    },
  ],
  [
    "missing target",
    (parts) => {
      const p = parts.find((p) => p.part === "dependencies")!,
        value = body(p);
      value.depends_on_issue_id = "absent";
      p.payload = JSON.stringify(value);
    },
  ],
  [
    "missing timestamp",
    (parts) => {
      parts.find((p) => p.part === "issues")!.created_at = null;
    },
  ],
  [
    "invented local timestamp",
    (parts) => {
      parts.find((p) => p.part === "issues")!.updated_at =
        "2026-11-09 01:00:00";
    },
  ],
  [
    "malformed inner JSON",
    (parts) => {
      parts.find((p) => p.part === "issues")!.payload =
        "private invalid content";
    },
  ],
  [
    "unprojected metadata",
    (parts) => {
      const p = parts.find((p) => p.part === "issues")!,
        value = body(p);
      (value.metadata as Record<string, unknown>).secret = "private";
      p.payload = JSON.stringify(value);
    },
  ],
];
for (const [name, change] of corruptions)
  test(`${name} cannot publish a complete source`, () => {
    expect(() => parseCompleteTracker(mutate(change), identity)).toThrow(
      "The tracker snapshot is unavailable or incomplete.",
    );
  });
test("oversized source and counts refuse without echoing private fields", () => {
  expect(() =>
    parseCompleteTracker(" ".repeat(COMPLETE_TRACKER_BYTES + 1), identity),
  ).toThrow("unavailable or incomplete");
  const input = mutate((parts) => {
    const m = body(parts[0]!);
    (m.counts as Record<string, unknown>).issues = 100001;
    parts[0]!.payload = JSON.stringify(m);
  });
  expect(() => parseCompleteTracker(input, identity)).toThrow(
    "unavailable or incomplete",
  );
});
