import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type RepoConfig,
  selectRepos,
} from "../.claude/skills/syncing-repos/scripts/repo-select";

const REPO_CLI = resolve(
  import.meta.dir,
  "..",
  ".claude",
  "skills",
  "syncing-repos",
  "scripts",
  "repo.ts",
);

const entry = (name: string, extra: Partial<RepoConfig> = {}): RepoConfig => ({
  name,
  url: `https://example.invalid/${name}.git`,
  defaultBranch: "main",
  ...extra,
});

const REGISTRY = [
  entry("api"),
  entry("old-docs", { archived: true }),
  entry("web", { archived: false }),
];

describe("selectRepos", () => {
  test("by default every repository but the archived ones, which are listed as skipped", () => {
    const { targets, skipped } = selectRepos(REGISTRY, {
      includeArchived: false,
    });
    expect(targets.map((r) => r.name)).toEqual(["api", "web"]);
    expect(skipped).toEqual(["old-docs"]);
  });

  test("an archived repository named with --repo is selected", () => {
    const { targets, skipped } = selectRepos(REGISTRY, {
      repo: "old-docs",
      includeArchived: false,
    });
    expect(targets.map((r) => r.name)).toEqual(["old-docs"]);
    expect(skipped).toEqual([]);
  });

  test("--include-archived selects the archived ones too", () => {
    const { targets, skipped } = selectRepos(REGISTRY, {
      includeArchived: true,
    });
    expect(targets.map((r) => r.name)).toEqual(["api", "old-docs", "web"]);
    expect(skipped).toEqual([]);
  });

  test("only archived: true archives: a missing, false or non-boolean flag is an active repository", () => {
    const loose = [
      entry("a"),
      entry("b", { archived: false }),
      { ...entry("c"), archived: "yes" } as unknown as RepoConfig,
    ];
    const { targets } = selectRepos(loose, { includeArchived: false });
    expect(targets.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });
});

describe("bun run repo status", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  /** A scratch harness root with this registry and no clones. */
  function harness(): string {
    const dir = mkdtempSync(join(tmpdir(), "af-repo-cli-"));
    dirs.push(dir);
    mkdirSync(join(dir, "repos"));
    writeFileSync(
      join(dir, "repos", "repos.json"),
      JSON.stringify({ repos: REGISTRY }),
    );
    return dir;
  }

  function status(cwd: string, ...flags: string[]) {
    const run = Bun.spawnSync(
      [process.execPath, REPO_CLI, "status", ...flags],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      exitCode: run.exitCode,
      result: JSON.parse(run.stdout.toString()) as {
        repos: { name: string; action: string }[];
        skipped: string[];
      },
    };
  }

  test("reports every repository but the archived ones, and lists those as skipped", () => {
    const { exitCode, result } = status(harness());
    expect(exitCode).toBe(0);
    expect(result.repos.map((r) => [r.name, r.action])).toEqual([
      ["api", "not-cloned"],
      ["web", "not-cloned"],
    ]);
    expect(result.skipped).toEqual(["old-docs"]);
  });

  test("with --include-archived, or naming the archived one with --repo, it is reported", () => {
    const cwd = harness();
    expect(
      status(cwd, "--include-archived").result.repos.map((r) => r.name),
    ).toEqual(["api", "old-docs", "web"]);
    expect(
      status(cwd, "--repo", "old-docs").result.repos.map((r) => r.name),
    ).toEqual(["old-docs"]);
  });
});
