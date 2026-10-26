// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expressions are literal workflow syntax.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  "timeout-minutes"?: number;
  with?: Record<string, string>;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string;
  container?: { image: string; options?: string };
  strategy?: { "fail-fast": boolean; matrix: { shard: number[] } };
  steps: Step[];
}
const workflow: {
  env: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, Job>;
} = parse(
  readFileSync(
    join(import.meta.dir, "../.github/workflows/quality.yml"),
    "utf8",
  ),
);

test("the concurrency group is the PR number for pull requests and the run id for pushes, and only pull requests cancel", () => {
  expect(workflow.concurrency.group).toBe(
    "${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
  );
  expect(workflow.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' }}",
  );
});

test("one workflow-level Bun version feeds every setup-bun step", () => {
  expect(workflow.env["BUN_VERSION"]).toMatch(/^\d+\.\d+\.\d+$/);
  const setups = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((step) => step.uses === "oven-sh/setup-bun@v2"),
  );
  expect(setups).toHaveLength(3);
  for (const step of setups) {
    expect(step.with?.["bun-version"]).toBe("${{ env.BUN_VERSION }}");
  }
});

test("every dependency install first restores a Bun download cache keyed by OS, that Bun version and the lockfile", () => {
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
      "bun-${{ runner.os }}-${{ env.BUN_VERSION }}-${{ hashFiles('bun.lock') }}",
    );
    expect(cache).toBeLessThan(
      job.steps.findIndex(
        (step) => step.run === "bun install --frozen-lockfile",
      ),
    );
  }
});

test("the pinned browser image and every required serial suite remain bounded and aggregated", () => {
  const shards = workflow.jobs["e2e"];
  expect(shards?.container).toEqual({
    image:
      "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27",
    options: "--init --ipc=host",
  });
  expect(shards?.strategy).toEqual({
    "fail-fast": false,
    matrix: { shard: [1, 2, 3] },
  });
  expect(
    shards?.steps.some(
      (step) =>
        step.name === "Verify installed Playwright matches browser image" &&
        step.run?.includes('= "1.63.0"'),
    ),
  ).toBe(true);
  expect(
    shards?.steps.some(
      (step) =>
        step.run === "bun run verify:ui -- --shard=${{ matrix.shard }}/3",
    ),
  ).toBe(true);
  expect(
    shards?.steps.some(
      (step) =>
        step.name === "Run the browser suite" &&
        step.run === "bun run verify:ui -- --shard=${{ matrix.shard }}/3" &&
        step["timeout-minutes"] === 12,
    ),
  ).toBe(true);
  expect(
    shards?.steps.some(
      (step) =>
        step.name === "Run desktop browser journey shard" &&
        step.run ===
          "bun run verify:desktop -- --shard=${{ matrix.shard }}/3" &&
        step["timeout-minutes"] === 12,
    ),
  ).toBe(true);
  for (const [name, run, minutes] of [
    [
      "Run desktop temporary Git worktree journey",
      "bun run verify:desktop-worktrees",
      4,
    ],
    [
      "Run actual attended project shift journeys",
      "bun run verify:desktop-shifts",
      6,
    ],
    [
      "Run desktop original Start recovery after an owned hearth restart",
      "bun run verify:desktop-restart",
      4,
    ],
  ] as const) {
    expect(
      shards?.steps.some(
        (step) =>
          step.name === name &&
          step.run === run &&
          step.if === "matrix.shard == 1" &&
          step["timeout-minutes"] === minutes,
      ),
    ).toBe(true);
  }
  expect(
    shards?.steps.find((step) => step.uses === "actions/upload-artifact@v4")
      ?.with?.["name"],
  ).toBe("playwright-test-results-${{ matrix.shard }}");
  for (const [name, artifact] of [
    [
      "Upload desktop traces and failure screenshots",
      "desktop-playwright-test-results-${{ matrix.shard }}",
    ],
    [
      "Upload desktop worktree traces and failure screenshots",
      "desktop-worktree-playwright-test-results",
    ],
    [
      "Upload attended project shift traces and failure screenshots",
      "desktop-shift-playwright-test-results",
    ],
    [
      "Upload desktop restart traces and failure screenshots",
      "desktop-restart-playwright-test-results",
    ],
  ] as const) {
    expect(
      shards?.steps.some(
        (step) =>
          step.name === name &&
          step.uses === "actions/upload-artifact@v4" &&
          step.with?.["name"] === artifact,
      ),
    ).toBe(true);
  }
  const aggregate = workflow.jobs["playwright"];
  expect(aggregate?.name).toBe("Playwright");
  expect(aggregate?.needs).toBe("e2e");
  expect(aggregate?.if).toBe("${{ always() }}");
  expect(aggregate?.steps[0]?.run).toBe(
    'test "${{ needs.e2e.result }}" = "success"',
  );
});
