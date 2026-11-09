import { z } from "zod";
import type { BdResult } from "../hearth/routes/dev-api";
import { completeTrackerFixture } from "./complete-tracker-fixture";
import { parseCompleteTracker } from "./complete-tracker-source";

const identity = {
  database: "isolated_fixture",
  projectId: "11111111-1111-4111-8111-111111111111",
};
const issue = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    issue_type: z.string(),
    priority: z.number().default(2),
    description: z.string().default(""),
    acceptance_criteria: z.string().default(""),
    notes: z.string().default(""),
    created_at: z.string().default("2026-01-01T00:00:00Z"),
    updated_at: z.string().default("2026-01-01T00:00:00Z"),
    due_at: z.string().optional(),
    owner: z.string().optional(),
    assignee: z.string().optional(),
    estimate: z.number().optional(),
    labels: z.array(z.string()).default([]),
    dependencies: z
      .array(
        z.object({
          issue_id: z.string(),
          depends_on_id: z.string(),
          type: z.string(),
        }),
      )
      .default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

/** TEST ONLY. Old closed-world fixture rows model empty omitted aux tables.
 * Encode an explicit complete six-table simulation, then use the real parser.
 * This never interprets a production CLI export as completeness evidence.
 */
export function completeFixtureModel(answer: BdResult) {
  if (answer.status !== 0) throw Error("Fixture source unavailable.");
  let rows: unknown[];
  try {
    rows = answer.stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    throw Error("Malformed fixture source.");
  }
  const issues = rows.map((raw) => {
    const row = issue.parse(raw);
    const metadata = z
      .record(z.string(), z.string())
      .parse(
        Object.fromEntries(
          ["queue_state", "queue_resume", "smith"].flatMap((key) =>
            row.metadata[key] === undefined ? [] : [[key, row.metadata[key]]],
          ),
        ),
      );
    const { due_at, assignee, owner, estimate, ...required } = row;
    return {
      ...required,
      ...(due_at === undefined ? {} : { due_at }),
      ...(assignee === undefined ? {} : { assignee }),
      ...(owner === undefined ? {} : { owner }),
      ...(estimate === undefined ? {} : { estimate }),
      metadata,
    };
  });
  return parseCompleteTracker(
    completeTrackerFixture(identity, issues),
    identity,
  );
}

/** Capture the fixture runner once, preserving immutable host tests. */
export function completeFixtureHost<
  T extends { runBd: import("../hearth/routes/dev-api").BdRunner },
>(host: T) {
  const runBd = host.runBd;
  return {
    ...host,
    completeTracker: async () =>
      completeFixtureModel(
        await runBd(["export", "--readonly", "--no-memories"]),
      ),
  };
}

/** TEST ONLY. Explicit complete producer, with an optional held-read lifecycle boundary. */
export function completeFixtureReader(
  runBd: import("../hearth/routes/dev-api").BdRunner,
  beforeRead?: () => Promise<void>,
) {
  return async () => {
    await beforeRead?.();
    return completeFixtureModel(
      await runBd(["export", "--readonly", "--no-memories"]),
    );
  };
}
