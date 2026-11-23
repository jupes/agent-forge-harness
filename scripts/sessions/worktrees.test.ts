import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SessionWorktreeReceipt,
  SessionWorktreeRequest,
} from "../../types/session-worktrees";
import type { ProjectSnapshot } from "../hearth/routes/project-summaries";
import { createSessionRepositoryScopeValidator } from "../hearth/routes/session-scope";
import { writeOwnerOnly } from "../hearth/token";
import { createProjectStore } from "../projects/store";
import { type GitRun, gitRun } from "../scheduler/worktrees";
import {
  createSessionWorktreeService,
  sessionWorktreeId,
  sessionWorktreeJournalFile,
  sessionWorktreeRequestHash,
} from "./worktrees";

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0))
    rmSync(path, { recursive: true, force: true, maxRetries: 5 });
});
function git(root: string, ...args: string[]): string {
  const result = gitRun(args, root);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "session worktree "));
  folders.push(base);
  const home = join(base, "home");
  mkdirSync(join(base, "repo"));
  const root = realpathSync.native(join(base, "repo"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "maintenance.auto", "false");
  git(root, "config", "core.hooksPath", join(root, ".git", "no-hooks"));
  writeFileSync(join(root, ".gitignore"), "trees/\n");
  writeFileSync(join(root, "source.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "review-base");
  const sha = git(root, "rev-parse", "HEAD");
  const catalog = await createProjectStore(home).create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [{ root, repositories: [root], epicIds: ["alpha-epic"] }],
    },
    0,
  );
  const project = catalog.projects[0]!;
  const snapshot: ProjectSnapshot = {
    catalog,
    source: {
      workspace: root,
      asOf: project.createdAt,
      issues: [
        {
          id: "alpha-epic",
          title: "Alpha",
          type: "epic",
          status: "open",
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          labels: ["project:alpha"],
        },
      ],
      queue: [],
      sessions: [],
      sessionsComplete: true,
      problems: [],
    },
  };
  const scope = createSessionRepositoryScopeValidator(
    {
      root,
      workspace: root,
      ledgerPath: join(home, "ledger.db"),
      runBd: async () => {
        throw new Error("No real tracker");
      },
    },
    async () => snapshot,
  );
  let adds = 0,
    loseAnswer = false,
    partial = false;
  const run: GitRun = (args, cwd, timeout) => {
    if (args[0] === "worktree" && args[1] === "add") {
      adds++;
      const durable = readFileSync(sessionWorktreeJournalFile(home), "utf8");
      expect(durable).toContain(`"resolvedCommit":"${sha}"`);
      expect(durable).toContain('"receipt":null');
      if (partial) {
        git(root, "branch", String(args[3]), sha);
        return { status: null, stdout: "", stderr: "Interrupted creation" };
      }
    }
    const result = gitRun(args, cwd, timeout);
    return loseAnswer && args[0] === "worktree" && args[1] === "add"
      ? { status: null, stdout: "", stderr: "Lost creation answer" }
      : result;
  };
  const service = () =>
    createSessionWorktreeService({
      home,
      root,
      git: run,
      validateScope: (projectId, request) =>
        scope(projectId, {
          workspace: root,
          repository: request.repository,
          beadId: request.beadId,
        }),
    });
  const request: SessionWorktreeRequest = {
    requestId: randomUUID(),
    repository: realpathSync.native(root),
    baseRef: "review-base",
    branch: "feat/composer",
  };
  return {
    root,
    home,
    project,
    snapshot,
    sha,
    request,
    service,
    adds: () => adds,
    loseAnswer: () => {
      loseAnswer = true;
    },
    partial: () => {
      partial = true;
    },
  };
}

test("explicit creation resolves the reviewed base once, saves intent before Git, and leaves main clean", async () => {
  const f = await fixture();
  writeFileSync(
    join(f.root, "source.txt"),
    "main moved after the reviewed base\n",
  );
  git(f.root, "add", "source.txt");
  git(f.root, "commit", "-qm", "main advanced");
  const mainHead = git(f.root, "rev-parse", "HEAD");
  const service = f.service();
  const receipt = await service.create(f.project.id, {
    ...f.request,
    beadId: "alpha-epic",
  });
  expect(receipt.state).toBe("created");
  expect(receipt.resolvedCommit).toBe(f.sha);
  expect(receipt.worktree?.id.length).toBeLessThanOrEqual(32);
  expect(git(receipt.worktree!.path, "rev-parse", "HEAD")).toBe(f.sha);
  expect(readFileSync(join(receipt.worktree!.path, "source.txt"), "utf8")).toBe(
    "base\n",
  );
  expect(git(f.root, "branch", "--show-current")).toBe("main");
  expect(git(f.root, "rev-parse", "HEAD")).toBe(mainHead);
  expect(git(f.root, "status", "--porcelain")).toBe("");
  f.project.archived = true;
  expect(
    await f
      .service()
      .create(f.project.id, { ...f.request, beadId: "alpha-epic" }),
  ).toEqual(receipt);
  expect(await service.read(f.project.id, f.request.requestId)).toEqual(
    receipt,
  );
  expect(f.adds()).toBe(1);
  await expect(
    service.create(f.project.id, { ...f.request, branch: "feat/changed" }),
  ).rejects.toThrow("different");
  await expect(
    service.create(`project-${randomUUID()}`, {
      ...f.request,
      beadId: "alpha-epic",
    }),
  ).rejects.toThrow("different");
});

test("two service owners and a restart reconcile a lost Git answer without another creation", async () => {
  const f = await fixture();
  f.loseAnswer();
  const [first, second] = await Promise.all([
    f.service().create(f.project.id, f.request),
    f.service().create(f.project.id, f.request),
  ]);
  expect(first.state).toBe("unknown");
  expect(second.state).toBe("created");
  const before = readFileSync(sessionWorktreeJournalFile(f.home), "utf8");
  expect(
    (await f.service().read(f.project.id, f.request.requestId)).state,
  ).toBe("created");
  expect(readFileSync(sessionWorktreeJournalFile(f.home), "utf8")).toBe(before);
  expect((await f.service().create(f.project.id, f.request)).state).toBe(
    "created",
  );
  expect(f.adds()).toBe(1);
});

test("another repository's hearth cannot read or retry the same project's worktree receipt in a shared private home", async () => {
  const source = await fixture(),
    other = await fixture();
  source.loseAnswer();
  expect(
    (await source.service().create(source.project.id, source.request)).state,
  ).toBe("unknown");
  const before = readFileSync(sessionWorktreeJournalFile(source.home), "utf8"),
    calls: string[] = [];
  const service = createSessionWorktreeService({
    home: source.home,
    root: other.root,
    git: (args, cwd, timeout) => {
      calls.push(cwd);
      return gitRun(args, cwd, timeout);
    },
    validateScope: async () => {
      throw Error("Mutable configuration must not run for an original receipt");
    },
  });
  await expect(
    service.read(source.project.id, source.request.requestId),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    service.create(source.project.id, source.request),
  ).rejects.toMatchObject({ status: 409 });
  expect(calls).toEqual([]);
  expect(readFileSync(sessionWorktreeJournalFile(source.home), "utf8")).toBe(
    before,
  );
  expect(source.adds()).toBe(1);
});

test("partial creation stays unknown and original retries never rerun or clean Git", async () => {
  const f = await fixture();
  f.partial();
  const receipt = await f.service().create(f.project.id, f.request);
  expect(receipt.state).toBe("unknown");
  expect(receipt.reason).toContain("preserved");
  expect(receipt.worktree?.path).toContain("trees");
  expect(
    (await f.service().read(f.project.id, f.request.requestId)).state,
  ).toBe("unknown");
  expect((await f.service().create(f.project.id, f.request)).state).toBe(
    "unknown",
  );
  expect(f.adds()).toBe(1);
  expect(git(f.root, "branch", "--list", f.request.branch)).toContain(
    f.request.branch,
  );
});

test("a restart after the durable plan but before Git does not turn a read or retry into creation", async () => {
  const f = await fixture();
  const id = sessionWorktreeId(f.project.id, f.request.requestId);
  const plan: SessionWorktreeReceipt = {
    projectId: f.project.id,
    requestId: f.request.requestId,
    repository: f.request.repository,
    baseRef: f.request.baseRef,
    resolvedCommit: f.sha,
    branch: f.request.branch,
    worktree: {
      id,
      path: join(f.root, "trees", id),
      branch: f.request.branch,
      createdAt: "2026-10-23T00:00:00.000Z",
    },
    state: "unknown",
    reason: "The process stopped after saving its original intent.",
  };
  const content = JSON.stringify({
    version: 1,
    records: [
      {
        request: f.request,
        requestHash: sessionWorktreeRequestHash(f.project.id, f.request),
        plan,
        receipt: null,
      },
    ],
  });
  writeOwnerOnly(sessionWorktreeJournalFile(f.home), content);
  f.project.archived = true;
  expect(await f.service().read(f.project.id, f.request.requestId)).toEqual(
    plan,
  );
  expect(await f.service().create(f.project.id, f.request)).toEqual(plan);
  expect(readFileSync(sessionWorktreeJournalFile(f.home), "utf8")).toBe(
    content,
  );
  expect(f.adds()).toBe(0);
  expect(git(f.root, "branch", "--list", f.request.branch)).toBe("");
});

test("new invalid branches, refs, foreign scope, beads and archived projects cannot mutate Git", async () => {
  const f = await fixture();
  for (const branch of [
    "--bad",
    "refs/heads/bad",
    "bad..name",
    "a/b.lock",
    "a//b",
    "HEAD",
  ])
    await expect(
      f.service().create(f.project.id, { ...f.request, branch }),
    ).rejects.toThrow();
  await expect(
    f.service().create(f.project.id, { ...f.request, baseRef: "absent-ref" }),
  ).rejects.toThrow("commit");
  await expect(
    f.service().create(f.project.id, { ...f.request, branch: "main" }),
  ).rejects.toThrow("already exists");
  await expect(
    f.service().create(`project-${randomUUID()}`, f.request),
  ).rejects.toThrow("catalog");
  await expect(
    f.service().create(f.project.id, {
      ...f.request,
      repository: join(f.root, "foreign"),
    }),
  ).rejects.toThrow("scope");
  await expect(
    f.service().create(f.project.id, { ...f.request, beadId: "foreign" }),
  ).rejects.toThrow("bead");
  f.project.archived = true;
  await expect(f.service().create(f.project.id, f.request)).rejects.toThrow(
    "archived",
  );
  expect(f.adds()).toBe(0);
  expect(existsSync(sessionWorktreeJournalFile(f.home))).toBe(false);
  expect(git(f.root, "branch", "--list", "feat/composer")).toBe("");
});

test("corrupt, future and linked private receipts are preserved without Git writes", async () => {
  const f = await fixture();
  const file = sessionWorktreeJournalFile(f.home);
  for (const content of [
    "not json",
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: new Array(1001).fill(null) }),
  ]) {
    writeOwnerOnly(file, content);
    await expect(f.service().create(f.project.id, f.request)).rejects.toThrow(
      "kept",
    );
    await expect(
      f.service().read(f.project.id, f.request.requestId),
    ).rejects.toThrow("kept");
    expect(readFileSync(file, "utf8")).toBe(content);
  }
  rmSync(file);
  const target = join(f.home, "foreign.json");
  writeOwnerOnly(target, "unchanged");
  linkSync(target, file);
  await expect(f.service().create(f.project.id, f.request)).rejects.toThrow(
    "kept",
  );
  expect(readFileSync(target, "utf8")).toBe("unchanged");
  expect(f.adds()).toBe(0);
});
