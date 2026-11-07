import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedSessionMetadata } from "../../../types/owned-session";
import { createProjectStore } from "../../projects/store";
import type { GitRun } from "../../scheduler/worktrees";
import type { ProjectSnapshot } from "./project-summaries";
import { createSessionScopeValidator } from "./session-scope";

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0))
    rmSync(path, { recursive: true, force: true });
});
async function fixture(rootName = "repo") {
  const base = mkdtempSync(join(tmpdir(), "forge session scope "));
  folders.push(base);
  let root = join(base, rootName);
  const home = join(base, "home");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"));
  root = realpathSync.native(root);
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
  let worktrees = [root];
  const git: GitRun = (args) =>
    args[0] === "rev-parse"
      ? { status: 0, stdout: root, stderr: "" }
      : args[0] === "worktree"
        ? {
            status: 0,
            stdout: worktrees
              .map(
                (path, index) =>
                  `worktree ${path}\0HEAD ${"a".repeat(40)}\0branch refs/heads/fixture-${index}\0\0`,
              )
              .join(""),
            stderr: "",
          }
        : { status: 1, stdout: "", stderr: "unsupported fixture command" };
  const metadata: OwnedSessionMetadata = {
    mode: "chat",
    provider: "claude",
    workspace: root,
    repository: root,
    worktree: root,
    smith: "coding",
    requestedModel: "sonnet",
    requestedEffort: null,
  };
  const validate = createSessionScopeValidator(
    home,
    {
      root,
      workspace: root,
      ledgerPath: join(home, "ledger.db"),
      runBd: async () => {
        throw Error("No tracker is permitted");
      },
      git,
    },
    async () => snapshot,
  );
  return {
    base,
    root,
    project,
    metadata,
    snapshot,
    validate,
    listWorktrees(paths: string[]) {
      worktrees = paths;
    },
  };
}

test("session admission checks current project, registered worktree and bead scope before accepting context", async () => {
  const f = await fixture();
  await f.validate(
    f.project.id,
    { ...f.metadata, beadId: "alpha-epic" },
    [{ kind: "bead", id: "alpha-epic" }],
    {
      mode: "chat",
      model: "sonnet",
      prompt: "Private",
      extraDirectories: [join(f.root, "src")],
    },
  );
  await expect(
    f.validate(
      f.project.id,
      { ...f.metadata, repository: join(f.base, "foreign") },
      [],
    ),
  ).rejects.toThrow("outside");
  await expect(
    f.validate(
      f.project.id,
      { ...f.metadata, worktree: join(f.base, "foreign") },
      [],
    ),
  ).rejects.toThrow("Git registry");
  await expect(
    f.validate(
      f.project.id,
      { ...f.metadata, workspace: join(f.base, "foreign") },
      [],
    ),
  ).rejects.toThrow("workspace");
  await expect(
    f.validate(f.project.id, { ...f.metadata, beadId: "foreign" }, []),
  ).rejects.toThrow("bead");
  f.project.archived = true;
  await expect(f.validate(f.project.id, f.metadata, [])).rejects.toThrow(
    "archived",
  );
});

test("extra directories cannot escape the checked worktree through an absolute path or a directory link", async () => {
  const f = await fixture(),
    outside = join(f.base, "outside"),
    link = join(f.root, "linked");
  mkdirSync(outside);
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  for (const path of [outside, link])
    await expect(
      f.validate(f.project.id, f.metadata, [], {
        mode: "task",
        model: "sonnet",
        prompt: "Private",
        extraDirectories: [path],
      }),
    ).rejects.toThrow("checked worktree");
});

test.skipIf(process.platform === "win32")(
  "POSIX admission distinguishes physical backslash siblings and permits the actual registered literal path",
  async () => {
    const f = await fixture("nested/repo"),
      workspaceAlias = join(f.base, "nested\\repo"),
      nested = join(f.root, "trees", "a", "b"),
      literal = join(f.root, "trees", "a\\b");
    for (const path of [workspaceAlias, nested, literal])
      mkdirSync(path, { recursive: true });
    await expect(
      f.validate(
        f.project.id,
        { ...f.metadata, workspace: workspaceAlias },
        [],
      ),
    ).rejects.toThrow("workspace");
    await expect(
      f.validate(
        f.project.id,
        { ...f.metadata, repository: workspaceAlias },
        [],
      ),
    ).rejects.toThrow("outside");
    f.listWorktrees([f.root, nested]);
    await expect(
      f.validate(f.project.id, { ...f.metadata, worktree: literal }, []),
    ).rejects.toThrow("Git registry");
    f.listWorktrees([f.root, literal]);
    const metadata = { ...f.metadata, worktree: literal },
      inside = join(literal, "src"),
      sibling = `${literal}\\src`;
    mkdirSync(inside);
    mkdirSync(sibling);
    await f.validate(f.project.id, metadata, []);
    await f.validate(f.project.id, metadata, [], {
      mode: "chat",
      model: "sonnet",
      prompt: "Private",
      extraDirectories: [inside],
    });
    await expect(
      f.validate(f.project.id, metadata, [], {
        mode: "chat",
        model: "sonnet",
        prompt: "Private",
        extraDirectories: [sibling],
      }),
    ).rejects.toThrow("checked worktree");
  },
);
