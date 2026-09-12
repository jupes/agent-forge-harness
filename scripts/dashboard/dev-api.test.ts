import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReview,
  type BdResult,
  gateLogsNewestFirst,
  readForgeRun,
  readReposKnowledge,
} from "../../scripts/dashboard/dev-api";

const created: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-dev-api-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, relative: string, content: string): string {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A stand-in for bd: `show` reports `status`, and every call is recorded. */
function fakeBd(
  status: string,
  overrides: Partial<Record<"show" | "comments", BdResult>> = {},
) {
  const calls: string[][] = [];
  const run = (args: string[]): BdResult => {
    calls.push(args);
    const command = args[0] === "show" ? "show" : "comments";
    return (
      overrides[command] ?? {
        status: 0,
        stdout:
          command === "show" ? JSON.stringify([{ id: args[1], status }]) : "",
        stderr: "",
      }
    );
  };
  return { calls, run };
}

describe("applyReview", () => {
  test("records a review on an in-progress checkpoint, running bd with argument arrays", () => {
    const bd = fakeBd("in_progress");
    const reply = applyReview(
      { issueId: "agent-forge-harness-j5k3", decision: "approve" },
      bd.run,
    );
    expect(bd.calls).toEqual([
      ["show", "agent-forge-harness-j5k3", "--json"],
      [
        "comments",
        "add",
        "agent-forge-harness-j5k3",
        "review: checkpoint APPROVED via Forge run dashboard",
      ],
    ]);
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(true);
  });

  test("refuses a checkpoint that is not in progress, and writes nothing", () => {
    for (const status of ["open", "blocked", "closed"]) {
      const bd = fakeBd(status);
      const reply = applyReview(
        { issueId: "a-1", decision: "approve" },
        bd.run,
      );
      expect(reply.status).toBe(409);
      expect(reply.body.error).toContain(`a-1 is ${status} in Beads`);
      expect(bd.calls.some((args) => args[0] === "comments")).toBe(false);
    }
  });

  test("an invalid request never reaches bd", () => {
    const bd = fakeBd("in_progress");
    const reply = applyReview(
      { issueId: "a-1", decision: "request-changes" },
      bd.run,
    );
    expect(bd.calls).toEqual([]);
    expect(reply.status).toBe(400);
  });

  test("a bd failure is reported, not swallowed", () => {
    const missing = fakeBd("in_progress", {
      show: {
        status: 1,
        stdout: "",
        stderr: 'Error: no issue found matching "missing-9"\n',
      },
    });
    const shown = applyReview(
      { issueId: "missing-9", decision: "approve" },
      missing.run,
    );
    expect(shown.status).toBe(502);
    expect(shown.body.error).toContain("no issue found");
    expect(missing.calls).toHaveLength(1);

    const locked = fakeBd("in_progress", {
      comments: {
        status: 1,
        stdout: "",
        stderr: "Error: database is locked\n",
      },
    });
    const added = applyReview(
      { issueId: "a-1", decision: "approve" },
      locked.run,
    );
    expect(added.status).toBe(502);
    expect(added.body.error).toContain("database is locked");
  });
});

describe("gateLogsNewestFirst", () => {
  test("yields quality-gate logs newest day first, skipping days without one", () => {
    const logs = tempRoot();
    write(logs, "2026-09-08/quality-gate.jsonl", "eighth");
    write(logs, "2026-09-10/session.jsonl", "{}");
    write(logs, "2026-09-09/quality-gate.jsonl", "ninth");
    expect([...gateLogsNewestFirst(logs)]).toEqual(["ninth", "eighth"]);
  });

  test("looks back a bounded number of days", () => {
    const logs = tempRoot();
    write(logs, "2026-09-01/quality-gate.jsonl", "older");
    write(logs, "2026-09-02/quality-gate.jsonl", "newer");
    expect([...gateLogsNewestFirst(logs, 1)]).toEqual(["newer"]);
  });

  test("yields nothing when the log directory does not exist", () => {
    expect([...gateLogsNewestFirst(join(tempRoot(), "nope"))]).toEqual([]);
  });
});

describe("readForgeRun", () => {
  function gate(fields: Record<string, unknown>): string {
    return JSON.stringify({
      event: "TaskCompleted",
      passed: true,
      checks: [{ name: "typecheck", passed: true }],
      ...fields,
    });
  }

  test("combines forge state, artifacts on disk and this checkout's latest gate run", () => {
    const root = tempRoot();
    const logs = tempRoot();
    write(
      root,
      ".tmp/work/forge-state.json",
      JSON.stringify({
        slug: "demo",
        phase: "plan",
        completed: ["research", "plan"],
        epic: "demo-epic",
        artifacts: {},
        updatedAt: "2026-09-10T00:00:00.000Z",
      }),
    );
    write(root, "plans/research/demo.md", "# research");
    // Newest first: a run from another worktree, then — in the older file — a
    // legacy entry with no identity logged after this checkout's own run.
    write(
      logs,
      "2026-09-11/quality-gate.jsonl",
      gate({
        timestamp: "other-worktree",
        checkout: join(tempRoot(), "other"),
        forgeSlug: "demo",
      }),
    );
    write(
      logs,
      "2026-09-10/quality-gate.jsonl",
      [
        gate({ timestamp: "ours", checkout: root, forgeSlug: "demo" }),
        gate({ timestamp: "legacy" }),
      ].join("\n"),
    );

    const run = readForgeRun(root, logs);
    expect(run.epic).toBe("demo-epic");
    expect(run.phases.find((p) => p.id === "research")?.artifactMissing).toBe(
      false,
    );
    // plans/drafts/demo.md was never written.
    expect(run.phases.find((p) => p.id === "plan")?.artifactMissing).toBe(true);
    expect(run.gateScope).toEqual({ checkout: root, slug: "demo" });
    expect(run.gate?.timestamp).toBe("ours");
  });

  test("shows no gate when no run in the log belongs to this checkout", () => {
    const root = tempRoot();
    const logs = tempRoot();
    write(logs, "2026-09-10/quality-gate.jsonl", gate({ timestamp: "legacy" }));
    expect(readForgeRun(root, logs).gate).toBeNull();
  });
});

describe("readReposKnowledge", () => {
  test("reads repositories, worktrees and shared conventions from disk", () => {
    const root = tempRoot();
    write(
      root,
      "repos/repos.json",
      JSON.stringify({
        repos: [
          {
            name: "game-guide-ai",
            url: "https://github.com/jupes/game-guide-ai.git",
            defaultBranch: "master",
          },
        ],
      }),
    );
    mkdirSync(join(root, "repos", "game-guide-ai"), { recursive: true });
    write(root, "knowledge/repos/game-guide-ai.yaml", "repo: game-guide-ai\n");
    write(
      root,
      "knowledge/_shared.yaml",
      'shared_conventions:\n  commit_format:\n    pattern: "<type>: <what>"\n',
    );
    const present = join(root, "trees", "live");
    mkdirSync(present, { recursive: true });
    write(
      root,
      "trees/.state.json",
      JSON.stringify({
        worktrees: [
          {
            id: "live",
            path: present,
            branch: "feat/a",
            createdAt: "2026-09-10",
          },
          {
            id: "gone",
            path: join(root, "trees", "gone"),
            branch: "fix/b",
            createdAt: "2026-09-01",
          },
        ],
      }),
    );

    const data = readReposKnowledge(root);

    expect(data.repos).toHaveLength(1);
    expect(data.repos[0]).toMatchObject({
      name: "game-guide-ai",
      defaultBranch: "master",
      cloned: true,
      freshness: "current",
    });
    expect(data.worktrees.map((w) => [w.id, w.pathExists])).toEqual([
      ["live", true],
      ["gone", false],
    ]);
    expect(data.conventions?.entries).toEqual([
      { key: "commit_format.pattern", value: "<type>: <what>" },
    ]);
  });

  test("has no conventions, rather than failing, without a shared file", () => {
    const data = readReposKnowledge(tempRoot());
    expect(data.repos).toEqual([]);
    expect(data.worktrees).toEqual([]);
    expect(data.conventions).toBeNull();
    expect(data.localStateFrom).toBeNull();
  });

  /**
   * A main checkout with one clone, its knowledge file and a worktree record,
   * plus a linked worktree at trees/wt whose own repos/ and trees/ are empty —
   * which is what git gives a worktree, since those paths are gitignored.
   */
  function mainWithLinkedWorktree(gitdirFor: (main: string) => string) {
    const main = tempRoot();
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    write(
      main,
      "repos/repos.json",
      JSON.stringify({ repos: [{ name: "clone-a", defaultBranch: "main" }] }),
    );
    mkdirSync(join(main, "repos", "clone-a"), { recursive: true });
    write(main, "knowledge/repos/clone-a.yaml", "repo: clone-a\n");
    write(
      main,
      "knowledge/_shared.yaml",
      "shared_conventions:\n  from: main\n",
    );
    const worktree = join(main, "trees", "wt");
    write(
      main,
      "trees/.state.json",
      JSON.stringify({
        worktrees: [
          {
            id: "wt",
            path: worktree,
            branch: "feat/x",
            createdAt: "2026-09-10",
          },
        ],
      }),
    );
    write(worktree, ".git", `gitdir: ${gitdirFor(main)}\n`);
    write(
      worktree,
      "knowledge/_shared.yaml",
      "shared_conventions:\n  from: branch\n",
    );
    return { main, worktree };
  }

  test("inside a linked worktree, reads the gitignored registries from the main checkout", () => {
    const { main, worktree } = mainWithLinkedWorktree(
      // Git writes forward slashes, including on Windows.
      (root) => `${root.replaceAll("\\", "/")}/.git/worktrees/wt`,
    );

    const data = readReposKnowledge(worktree);

    expect(data.localStateFrom).toBe(main);
    expect(data.repos.map((r) => [r.name, r.cloned, r.freshness])).toEqual([
      ["clone-a", true, "current"],
    ]);
    expect(data.worktrees.map((w) => [w.id, w.pathExists])).toEqual([
      ["wt", true],
    ]);
    // Committed files still come from the branch being viewed.
    expect(data.conventions?.entries).toEqual([
      { key: "from", value: "branch" },
    ]);
  });

  test("follows a relative gitdir pointer too", () => {
    const { main, worktree } = mainWithLinkedWorktree(
      () => "../../.git/worktrees/wt",
    );
    expect(readReposKnowledge(worktree).localStateFrom).toBe(main);
  });
});
