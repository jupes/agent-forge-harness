/** Hermetic native CLI fixture. It never forwards to Git, gh, bd, a shell or a remote. */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  answerQueueList,
  queueTracker,
  type TrackedBead,
} from "../../scheduler/queue-fixture";
import { withQueueLock } from "../../scheduler/queue-lock";

const SHA = "a".repeat(40);
const bead = z
  .object({
    id: z.string(),
    title: z.string(),
    issueType: z.string(),
    status: z.string().optional(),
    labels: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
    parent: z.object({ id: z.string() }).optional(),
    comments: z.array(z.string()).optional(),
  })
  .strict()
  .transform(
    (value): TrackedBead => ({
      id: value.id,
      title: value.title,
      issueType: value.issueType,
      labels: value.labels,
      ...(value.status === undefined ? {} : { status: value.status }),
      ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
      ...(value.description === undefined
        ? {}
        : { description: value.description }),
      ...(value.parent === undefined ? {} : { parent: value.parent }),
      ...(value.comments === undefined ? {} : { comments: value.comments }),
    }),
  );
const trees = z
  .array(z.object({ path: z.string(), branch: z.string() }).strict())
  .max(10);
function json(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw Error("Invalid planted fixture metadata");
  }
}
function checkedInside(root: string, path: string): boolean {
  const inside = relative(root, resolve(path));
  return (
    !!inside &&
    !isAbsolute(inside) &&
    !inside.split(/[\\/]/).some((part) => part === "..")
  );
}

export async function runAttendedNativeToolFixture(
  plantedRoot: string,
): Promise<void> {
  const root = realpathSync.native(plantedRoot),
    cwd = realpathSync.native(process.cwd()),
    tool = basename(process.execPath).replace(/\.exe$/i, ""),
    args = process.argv.slice(2),
    state = join(root, "fixture");
  if (
    readFileSync(join(root, "attended-native-fixture.marker"), "utf8") !==
      "agent-forge-attended-native-fixture-v1" ||
    !(
      cwd === root ||
      (checkedInside(root, cwd) &&
        /^shift-\d{8}-\d{6}-[0-9a-f]{4}-\d+$/.test(basename(cwd)))
    )
  )
    throw Error("Native fixture scope refused");
  appendFileSync(
    join(state, "calls.jsonl"),
    `${JSON.stringify({ tool, args, cwd })}\n`,
  );
  if (tool === "bd") {
    const locked = await withQueueLock(
      join(state, "tracker.lock.db"),
      async () => {
        const rows = z
            .array(bead)
            .max(10)
            .parse(json(join(state, "tracker.json"))),
          tracker = queueTracker(rows);
        if (args[0] === "export")
          return {
            status: 0,
            stderr: "",
            stdout:
              rows
                .map((row) =>
                  JSON.stringify({
                    id: row.id,
                    title: row.title,
                    issue_type: row.issueType,
                    status: row.status ?? "open",
                    priority: 2,
                    labels: row.labels,
                    metadata: row.metadata ?? {},
                    description: row.description ?? "",
                    created_at: "2026-10-23T00:00:00.000Z",
                    updated_at: "2026-10-23T00:00:00.000Z",
                    dependencies: row.parent
                      ? [
                          {
                            issue_id: row.id,
                            depends_on_id: row.parent.id,
                            type: "parent-child",
                          },
                        ]
                      : [],
                  }),
                )
                .join("\n") + "\n",
          };
        const result =
          tracker.answer(args) ??
          tracker.answerComment(args) ??
          answerQueueList(args, [...tracker.beads.values()]);
        if (!result) throw Error("Native fixture tracker command refused");
        if (args[0] === "update" || args[0] === "comments")
          writeFileSync(
            join(state, "tracker.json"),
            JSON.stringify([...tracker.beads.values()]),
          );
        return result;
      },
      { waitMs: 2000 },
    );
    if (!locked.ok) throw Error("Native fixture tracker busy");
    process.stdout.write(locked.value.stdout);
    process.stderr.write(locked.value.stderr);
    process.exitCode = locked.value.status ?? 1;
    return;
  }
  const treeFile = join(state, "trees.json"),
    known = trees.parse(json(treeFile));
  if (tool === "git") {
    if (args.length === 1 && args[0] === "--startup-held-helper") {
      await Bun.sleep(60_000);
      throw Error("Startup helper exceeded its inert fixture bound");
    }
    if (
      args[0] === "fetch" &&
      args[1] === "--no-tags" &&
      args[2] === "origin" &&
      args[3] === "+refs/heads/main:refs/remotes/origin/main" &&
      args.length === 4
    ) {
      const held = join(state, "hold-startup");
      if (existsSync(held)) {
        const helper = Bun.spawn([process.execPath, "--startup-held-helper"], {
          cwd: root,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        const file = join(state, "startup-tree.json"),
          draft = `${file}.draft`;
        writeFileSync(
          draft,
          JSON.stringify({ pid: process.pid, childPid: helper.pid }),
        );
        renameSync(draft, file);
        try {
          const deadline = Date.now() + 60_000;
          while (existsSync(held) && Date.now() < deadline) await Bun.sleep(10);
          if (existsSync(held) || existsSync(join(state, "abandon-startup")))
            process.exitCode = 1;
        } finally {
          helper.kill();
          await helper.exited;
        }
      }
      return;
    }
    if (args[0] === "rev-parse") {
      if (args[1] === "--show-toplevel" && args.length === 2) {
        console.log(cwd);
        return;
      }
      const target = args.at(-1) ?? "";
      if (args.includes("--git-common-dir")) {
        console.log(join(root, ".git"));
        return;
      }
      if (target === "HEAD" || target.endsWith("^{commit}")) {
        console.log(SHA);
        return;
      }
      if (target.startsWith("refs/heads/")) {
        const found = known.some(
          (tree) => `refs/heads/${tree.branch}` === target,
        );
        if (found) console.log(SHA);
        else process.exitCode = 1;
        return;
      }
    }
    if (
      args[0] === "check-ref-format" &&
      args[1] === "--branch" &&
      /^shift\/shift-\d{8}-\d{6}-[0-9a-f]{4}\/alpha-work$/.test(
        args[2] ?? "",
      ) &&
      args.length === 3
    ) {
      console.log(args[2]);
      return;
    }
    if (
      args[0] === "check-ignore" &&
      args[1] === "-v" &&
      args[2] === "--" &&
      /^trees\/shift-\d{8}-\d{6}-[0-9a-f]{4}-\d+$/.test(args[3] ?? "") &&
      args.length === 4
    ) {
      console.log(`.gitignore:1:trees/\t${args[3]}`);
      return;
    }
    if (
      args[0] === "worktree" &&
      args[1] === "add" &&
      args[2] === "-b" &&
      args[4] === "--" &&
      args.length === 7 &&
      args[6] === SHA
    ) {
      const branch = args[3] ?? "",
        path = resolve(args[5] ?? ""),
        id = basename(path);
      if (
        cwd !== root ||
        path !== join(root, "trees", id) ||
        !/^shift-\d{8}-\d{6}-[0-9a-f]{4}-\d+$/.test(id) ||
        !/^shift\/shift-\d{8}-\d{6}-[0-9a-f]{4}\/alpha-work$/.test(branch) ||
        existsSync(path)
      )
        throw Error("Native fixture worktree command refused");
      const gitdir = join(root, ".git/worktrees", id);
      mkdirSync(gitdir, { recursive: true });
      mkdirSync(path, { recursive: true });
      writeFileSync(join(gitdir, "commondir"), "../..\n");
      writeFileSync(join(path, ".git"), `gitdir: ${gitdir}\n`);
      cpSync(join(root, ".claude"), join(path, ".claude"), { recursive: true });
      cpSync(join(root, "agent-forge.toml"), join(path, "agent-forge.toml"));
      known.push({ path, branch });
      writeFileSync(treeFile, JSON.stringify(known));
      return;
    }
    if (
      args[0] === "worktree" &&
      args[1] === "list" &&
      args.includes("--porcelain")
    ) {
      process.stdout.write(
        [{ path: root, branch: "main" }, ...known]
          .map((tree) =>
            [
              `worktree ${tree.path}`,
              `HEAD ${SHA}`,
              `branch refs/heads/${tree.branch}`,
              "",
              "",
            ].join("\0"),
          )
          .join(""),
      );
      return;
    }
    if (args[0] === "log") {
      console.log("abc1234 Inert provider work");
      return;
    }
    if (
      args[0] === "push" &&
      args.includes("--porcelain") &&
      args.some((arg) => arg.startsWith(`${SHA}:refs/heads/shift/`))
    )
      return;
  } else if (
    tool === "gh" &&
    args[0] === "pr" &&
    args[1] === "create" &&
    args.includes("--draft")
  ) {
    const body = args[args.indexOf("--body-file") + 1];
    if (!body || !checkedInside(join(root, "home/shifts"), body))
      throw Error("Native fixture PR body refused");
    console.log("https://github.com/example/attended-fixture/pull/1");
    return;
  }
  throw Error("Native fixture tool command refused");
}
