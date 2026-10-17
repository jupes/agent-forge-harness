// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expressions are literal workflow syntax.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string;
  strategy?: { "fail-fast": boolean; matrix: { shard: number[] } };
  steps: Step[];
}
const workflow: {
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, Job>;
} = parse(
  readFileSync(
    join(import.meta.dir, "../.github/workflows/quality.yml"),
    "utf8",
  ),
);

test("PRs share a cancellation group; each push has a unique group, including pending runs", () => {
  expect(workflow.concurrency.group).toBe(
    "${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
  );
  expect(workflow.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' }}",
  );
});

test("every dependency install restores the OS and lockfile keyed Bun download cache first", () => {
  const installs = Object.values(workflow.jobs).filter((job) =>
    job.steps.some((step) => step.run === "bun install --frozen-lockfile"),
  );
  expect(installs).toHaveLength(3);
  for (const job of installs) {
    const cache = job.steps.findIndex(
      (step) => step.with?.["path"] === "~/.bun/install/cache",
    );
    expect(cache).toBeGreaterThanOrEqual(0);
    expect(job.steps[cache]?.uses).toBe("actions/cache@v4");
    expect(job.steps[cache]?.with?.["key"]).toBe(
      "bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}",
    );
    expect(cache).toBeLessThan(
      job.steps.findIndex(
        (step) => step.run === "bun install --frozen-lockfile",
      ),
    );
  }
});

test("three independent shards preserve all results and a stable failure-propagating check", () => {
  const shards = workflow.jobs["e2e"];
  expect(shards?.strategy).toEqual({
    "fail-fast": false,
    matrix: { shard: [1, 2, 3] },
  });
  expect(
    shards?.steps.some(
      (step) =>
        step.run === "bun run verify:ui -- --shard=${{ matrix.shard }}/3",
    ),
  ).toBe(true);
  expect(
    shards?.steps.some(
      (step) => step.with?.["path"] === "~/.cache/ms-playwright",
    ),
  ).toBe(true);
  expect(
    shards?.steps.find((step) => step.uses === "actions/upload-artifact@v4")
      ?.with?.["name"],
  ).toBe("playwright-test-results-${{ matrix.shard }}");
  const aggregate = workflow.jobs["playwright"];
  expect(aggregate?.name).toBe("Playwright");
  expect(aggregate?.needs).toBe("e2e");
  expect(aggregate?.if).toBe("${{ always() }}");
  expect(aggregate?.steps[0]?.run).toBe(
    'test "${{ needs.e2e.result }}" = "success"',
  );
});
