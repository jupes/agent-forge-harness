// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expressions are literal workflow syntax.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

test("both hosted unit commands actually collect app clients outside the configured scripts test root", () => {
  const fixture = mkdtempSync(join(tmpdir(), "forge-unit-collection-"));
  const script = join(fixture, "scripts/core.test.ts"),
    client = join(fixture, "apps/desktop/src/client.test.ts"),
    config = join(fixture, "bunfig.toml");
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "apps/desktop/src"), { recursive: true });
  writeFileSync(config, '[test]\nroot = "scripts"\n');
  writeFileSync(
    script,
    'import {test,expect} from "bun:test";test("CORE_COLLECTION_SENTINEL",()=>expect(true).toBe(true));',
  );
  writeFileSync(
    client,
    'import {test,expect} from "bun:test";test("APP_COLLECTION_SENTINEL",()=>expect(true).toBe(true));',
  );
  try {
    for (const jobName of ["checks", "windows"]) {
      const commands = workflow.jobs[jobName]!.steps.map(
        (step) => step.run,
      ).filter((run): run is string => run?.startsWith("bun test ") ?? false);
      expect(commands).toHaveLength(1);
      const args = commands[0]!.trim().split(/\s+/).slice(1);
      expect(args.slice(-2)).toEqual(["--timeout", "15000"]);
      const result = spawnSync(process.execPath, args, {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const report = result.stdout + result.stderr;
      expect(report).toContain("CORE_COLLECTION_SENTINEL");
      expect(report).toContain("APP_COLLECTION_SENTINEL");
      expect(report).toContain("2 pass");
    }
  } finally {
    for (const file of [script, client, config]) unlinkSync(file);
    for (const directory of [
      "apps/desktop/src",
      "apps/desktop",
      "apps",
      "scripts",
      ".",
    ])
      rmdirSync(join(fixture, directory));
  }
});

test("the concurrency group is the PR number for pull requests and the run id for pushes, and only pull requests cancel", () => {
  expect(workflow.concurrency.group).toBe(
    "${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
  );
  expect(workflow.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' }}",
  );
});

test("one workflow-level Bun version feeds every action and npm runtime installation", () => {
  expect(workflow.env["BUN_VERSION"]).toMatch(/^\d+\.\d+\.\d+$/);
  const setups = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((step) => step.uses === "oven-sh/setup-bun@v2"),
  );
  expect(setups).toHaveLength(2);
  for (const step of setups) {
    expect(step.with?.["bun-version"]).toBe("${{ env.BUN_VERSION }}");
  }
  const browserSteps = workflow.jobs["e2e"]?.steps ?? [];
  const npmInstalls = browserSteps.filter((step) =>
    step.run?.includes("@oven/bun-linux-x64@"),
  );
  expect(npmInstalls).toHaveLength(1);
  const install = npmInstalls[0];
  expect(install?.["timeout-minutes"]).toBe(2);
  for (const guard of [
    '--prefix "$RUNNER_TEMP/forge-bun"',
    "--ignore-scripts",
    "--registry=https://registry.npmjs.org",
    "--strict-ssl=true",
    '"@oven/bun-linux-x64@${BUN_VERSION}"',
    'ln -s ../node_modules/@oven/bun-linux-x64/bin/bun "$RUNNER_TEMP/forge-bun/bin/bun"',
    'ln -s bun "$RUNNER_TEMP/forge-bun/bin/bunx"',
    'test "$("$RUNNER_TEMP/forge-bun/bin/bun" --version)" = "$BUN_VERSION"',
    'echo "$RUNNER_TEMP/forge-bun/bin" >> "$GITHUB_PATH"',
  ])
    expect(install?.run).toContain(guard);
  const nodeIndex = browserSteps.findIndex(
    (step) => step.uses === "actions/setup-node@v4",
  );
  expect(nodeIndex).toBeGreaterThanOrEqual(0);
  expect(nodeIndex).toBeLessThan(browserSteps.indexOf(install!));
  expect(browserSteps.some((step) => step.run?.includes("apt-get"))).toBe(
    false,
  );
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
