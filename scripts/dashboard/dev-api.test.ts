import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReview,
  type BdResult,
  latestGateLog,
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

describe("applyReview", () => {
  test("runs bd with an argument array, never a shell string", () => {
    const calls: string[][] = [];
    const reply = applyReview(
      { issueId: "agent-forge-harness-j5k3", decision: "approve" },
      (args): BdResult => {
        calls.push(args);
        return { status: 0, stderr: "" };
      },
    );
    expect(calls).toEqual([
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

  test("an invalid request never reaches bd", () => {
    let called = false;
    const reply = applyReview(
      { issueId: "a-1", decision: "request-changes" },
      () => {
        called = true;
        return { status: 0, stderr: "" };
      },
    );
    expect(called).toBe(false);
    expect(reply.status).toBe(400);
  });

  test("a bd failure is reported, not swallowed", () => {
    const reply = applyReview(
      { issueId: "missing-9", decision: "approve" },
      () => ({ status: 1, stderr: "Error: issue not found\n" }),
    );
    expect(reply.status).toBe(502);
    expect(reply.body.error).toContain("issue not found");
  });
});

describe("latestGateLog", () => {
  test("reads the newest day that has a quality-gate log", () => {
    const logs = tempRoot();
    write(logs, "2026-09-08/quality-gate.jsonl", '{"passed":true,"checks":[]}');
    write(logs, "2026-09-10/session.jsonl", "{}");
    write(
      logs,
      "2026-09-09/quality-gate.jsonl",
      '{"passed":false,"checks":[]}',
    );
    expect(latestGateLog(logs)).toBe('{"passed":false,"checks":[]}');
  });

  test("is null when the log directory does not exist", () => {
    expect(latestGateLog(join(tempRoot(), "nope"))).toBeNull();
  });
});

describe("readForgeRun", () => {
  test("combines forge state, artifacts on disk and the latest gate run", () => {
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
    write(
      logs,
      "2026-09-10/quality-gate.jsonl",
      JSON.stringify({
        event: "TaskCompleted",
        timestamp: "t",
        passed: true,
        checks: [{ name: "typecheck", passed: true }],
      }),
    );

    const run = readForgeRun(root, logs);
    expect(run.epic).toBe("demo-epic");
    expect(run.phases.find((p) => p.id === "research")?.artifactMissing).toBe(
      false,
    );
    // plans/drafts/demo.md was never written.
    expect(run.phases.find((p) => p.id === "plan")?.artifactMissing).toBe(true);
    expect(run.gate?.checks[0]?.name).toBe("typecheck");
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
