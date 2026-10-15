/**
 * A bead's forge run built in another worktree of the workspace's repository
 * (agent-forge-harness-x1gs.7.5): found through `git worktree list`, and read
 * inside that worktree only, behind the same path guard as the workspace.
 *
 * No test runs the real `bd`, and the bead source's `git worktree list` goes
 * to a fake runner. Worktrees are laid out on disk as `git worktree add`
 * leaves them; one test makes a real scratch repository, with its own `.git`,
 * to hold that layout against git's own. Directory links are junctions on
 * Windows, where a symbolic link needs a privilege, and directory symbolic
 * links elsewhere. Every file is invented.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { compileBead } from "./bead-source";
import {
  buildContextPackFromParts,
  ContextSecurityError,
  locateWorkspaceFile,
} from "./context";
import type { CommandResult, CommandRunner } from "./pr-source";
import type { ContextPack } from "./types";
import { prepareCouncilContext } from "./workflow";

const BEAD = "demo-harness-cd34.5";
const EPIC = "demo-harness-cd34";
/** Shaped like a provider key, joined when the file runs; it opens nothing. */
const SECRET = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
const LIST = "git worktree list --porcelain -z";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A new directory in the OS temp dir, removed after the test. */
function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A main checkout: a directory with its own `.git` directory. */
function mainCheckout(files: Record<string, string> = {}): string {
  const root = scratch("council-main-");
  mkdirSync(join(root, ".git"));
  write(root, files);
  return root;
}

const slash = (path: string): string => path.replaceAll("\\", "/");

/**
 * A linked worktree of `main` at `path`, laid out as `git worktree add`
 * leaves it: its `.git` file names an admin directory under main's
 * `.git/worktrees`, whose `gitdir` file names that `.git` file back.
 */
function linkedWorktree(
  main: string,
  path: string,
  files: Record<string, string> = {},
): string {
  const admin = join(main, ".git", "worktrees", basename(path));
  mkdirSync(admin, { recursive: true });
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), `gitdir: ${slash(admin)}\n`);
  writeFileSync(join(admin, "gitdir"), `${slash(join(path, ".git"))}\n`);
  writeFileSync(join(admin, "commondir"), "../..\n");
  write(path, files);
  return path;
}

/** What `git worktree list --porcelain -z` prints for these paths, the main checkout first. */
function porcelain(paths: string[]): string {
  return paths
    .map(
      (path, index) =>
        `worktree ${slash(path)}\0HEAD ${"a".repeat(40)}\0${index === 0 ? "branch refs/heads/main" : "detached"}\0\0`,
    )
    .join("");
}

/** A forge run's state file, as `forge:phase-gate --write` leaves it. */
function runState(
  slug: string,
  fields: Record<string, unknown>,
): [string, string] {
  return [
    `.tmp/work/forge-runs/${slug}.json`,
    JSON.stringify({
      schemaVersion: 2,
      slug,
      phase: "ship",
      completed: ["research", "plan", "implement", "ship"],
      artifacts: {
        research: `plans/research/${slug}.md`,
        plan: `plans/drafts/${slug}.md`,
        ship: `reports/${slug}-ship.md`,
      },
      updatedAt: "2031-01-05T12:00:00.000Z",
      ...fields,
    }),
  ];
}

/** A directory link: a junction on Windows, a directory symbolic link elsewhere. */
function linkDirectory(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

type Fake = { runner: CommandRunner; calls: string[][] };

const ok = (stdout: string): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

/**
 * Answers the two bead reads and, when given, the worktree listing; anything
 * else a test did not arrange throws.
 */
function fakeRunner(
  options: { id?: string; listing?: CommandResult; description?: string } = {},
): Fake {
  const calls: string[][] = [];
  const id = options.id ?? BEAD;
  const runner: CommandRunner = async (command) => {
    calls.push(command);
    const line = command.join(" ");
    if (line === `bd --readonly show ${id} --json`)
      return ok(
        JSON.stringify([
          {
            id,
            title: "Teach the kiln to report its temperature",
            description: options.description ?? "The kiln runs blind today.",
            acceptance_criteria: "[ ] The reading is in Celsius.",
            status: "open",
            priority: 2,
            issue_type: "task",
          },
        ]),
      );
    if (line === `bd --readonly comments ${id} --json`)
      return ok(
        JSON.stringify([
          {
            issue_id: id,
            text: "worklog: sensor wired to the bench rig.",
            created_at: "2031-01-03T10:00:00Z",
          },
        ]),
      );
    if (line === LIST && options.listing) return options.listing;
    throw new Error(`unexpected command: ${line}`);
  };
  return { runner, calls };
}

const listed = (paths: string[]): CommandResult => ok(porcelain(paths));

function pack(
  fake: Fake,
  root: string,
  options: { secretPolicy?: "reject" | "redact"; source?: string } = {},
): Promise<ContextPack> {
  return prepareCouncilContext({
    kind: "bead",
    source: options.source ?? BEAD,
    workspaceRoot: root,
    secretPolicy: options.secretPolicy ?? "reject",
    runner: fake.runner,
  });
}

function listingOf(packed: ContextPack): string[] {
  const parts = packed.source.metadata?.parts;
  if (!Array.isArray(parts)) throw new Error("the pack has no listing");
  return parts;
}

/** The listing past the bead's own three parts. */
const linkedListing = (packed: ContextPack): string[] =>
  listingOf(packed).slice(3);

describe("a bead's forge run built in another worktree", () => {
  test("a run built in a linked worktree is found from the main checkout: its plan and research are packed from that worktree, and the listing names it", async () => {
    const main = mainCheckout({
      "plans/drafts/kiln-temp.md": "MAIN-COPY-OF-THE-PLAN",
    });
    const tree = linkedWorktree(
      main,
      join(main, ".claude", "worktrees", "kiln-wt"),
      Object.fromEntries([
        runState("kiln-temp", { beadId: BEAD }),
        ["plans/drafts/kiln-temp.md", "# Plan\nWire the sensor first."],
        ["plans/research/kiln-temp.md", "# Research\nThe rig reads in Kelvin."],
      ]),
    );
    const fake = fakeRunner({ listing: listed([main, tree]) });
    const packed = await pack(fake, main);

    expect(
      packed.evidence.slice(3).map((item) => [item.title, item.content]),
    ).toEqual([
      [
        "linked plan plans/drafts/kiln-temp.md",
        "# Plan\nWire the sensor first.",
      ],
      [
        "linked research plans/research/kiln-temp.md",
        "# Research\nThe rig reads in Kelvin.",
      ],
    ]);
    expect(linkedListing(packed)).toEqual([
      "E4 linked plan plans/drafts/kiln-temp.md from worktree .claude/worktrees/kiln-wt: 29 bytes",
      "E5 linked research plans/research/kiln-temp.md from worktree .claude/worktrees/kiln-wt: 35 bytes",
      "linked report reports/kiln-temp-ship.md from worktree .claude/worktrees/kiln-wt: missing, not packed",
    ]);
    expect(packed.source.metadata?.forgeRun).toBe("kiln-temp");
    // The main checkout's file of the same name is not the run's.
    expect(JSON.stringify(packed)).not.toContain("MAIN-COPY-OF-THE-PLAN");
    // Evidence titles go to providers: they never name the local layout.
    expect(packed.evidence.map((item) => item.title).join("\n")).not.toContain(
      "worktree",
    );
    expect(fake.calls.map((call) => call.join(" "))).toEqual([
      `bd --readonly show ${BEAD} --json`,
      `bd --readonly comments ${BEAD} --json`,
      LIST,
    ]);
  });

  test("the newest run that owns the bead wins across checkouts, and a tie keeps the workspace's", async () => {
    const arrange = (treeUpdatedAt: string) => {
      const main = mainCheckout(
        Object.fromEntries([
          runState("main-run", {
            beadId: BEAD,
            updatedAt: "2031-01-05T12:00:00.000Z",
          }),
          ["plans/drafts/main-run.md", "MAIN-PLAN"],
        ]),
      );
      const tree = linkedWorktree(
        main,
        join(main, "trees", "kiln"),
        Object.fromEntries([
          runState("tree-run", { beadId: BEAD, updatedAt: treeUpdatedAt }),
          ["plans/drafts/tree-run.md", "TREE-PLAN"],
        ]),
      );
      return { main, fake: fakeRunner({ listing: listed([main, tree]) }) };
    };

    const newer = arrange("2031-01-09T12:00:00.000Z");
    const fromTree = await pack(newer.fake, newer.main);
    expect(fromTree.source.metadata?.forgeRun).toBe("tree-run");
    expect(JSON.stringify(fromTree.evidence)).toContain("TREE-PLAN");
    expect(JSON.stringify(fromTree.evidence)).not.toContain("MAIN-PLAN");

    const tie = arrange("2031-01-05T12:00:00.000Z");
    const fromMain = await pack(tie.fake, tie.main);
    expect(fromMain.source.metadata?.forgeRun).toBe("main-run");
    expect(JSON.stringify(fromMain.evidence)).toContain("MAIN-PLAN");
    expect(linkedListing(fromMain)[0]).toBe(
      "E4 linked plan plans/drafts/main-run.md: 9 bytes",
    );
  });

  test("from a linked worktree, a run in the main checkout is found and named by its directory", async () => {
    const main = mainCheckout(
      Object.fromEntries([
        runState("kiln-temp", { beadId: BEAD }),
        ["plans/drafts/kiln-temp.md", "MAIN-PLAN"],
      ]),
    );
    const tree = linkedWorktree(main, join(scratch("council-wt-"), "kiln-wt"));
    const packed = await pack(
      fakeRunner({ listing: listed([main, tree]) }),
      tree,
    );
    expect(JSON.stringify(packed.evidence)).toContain("MAIN-PLAN");
    expect(linkedListing(packed)[0]).toBe(
      `E4 linked plan plans/drafts/kiln-temp.md from worktree ${basename(main)}: 9 bytes`,
    );
  });

  test("worktrees git itself made, one linked by absolute paths and one by relative paths, are both followed", async () => {
    const git = (cwd: string, ...args: string[]): string => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (result.status !== 0)
        throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    // A path with a space; its own `git init`, as the OS home may be a repository.
    const main = join(scratch("council git "), "main");
    mkdirSync(main);
    git(main, "init", "-q");
    git(
      main,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    const absolute = join(dirname(main), "abs-tree");
    git(
      main,
      "worktree",
      "add",
      "-q",
      "--detach",
      "--no-relative-paths",
      "--",
      absolute,
    );
    const relativeTree = join(main, ".claude", "worktrees", "rel-tree");
    git(
      main,
      "worktree",
      "add",
      "-q",
      "--detach",
      "--relative-paths",
      "--",
      relativeTree,
    );
    write(
      absolute,
      Object.fromEntries([
        runState("abs-run", { beadId: BEAD }),
        ["plans/drafts/abs-run.md", "ABS-PLAN"],
      ]),
    );
    write(
      relativeTree,
      Object.fromEntries([
        runState("rel-run", { epic: EPIC }),
        ["plans/drafts/rel-run.md", "REL-PLAN"],
      ]),
    );
    const listing = ok(git(main, "worktree", "list", "--porcelain", "-z"));

    const bead = await pack(fakeRunner({ listing }), main);
    expect(JSON.stringify(bead.evidence)).toContain("ABS-PLAN");
    expect(linkedListing(bead)[0]).toBe(
      "E4 linked plan plans/drafts/abs-run.md from worktree abs-tree: 8 bytes",
    );

    const epic = await pack(fakeRunner({ id: EPIC, listing }), main, {
      source: EPIC,
    });
    expect(JSON.stringify(epic.evidence)).toContain("REL-PLAN");
    expect(linkedListing(epic)[0]).toBe(
      "E4 linked plan plans/drafts/rel-run.md from worktree .claude/worktrees/rel-tree: 8 bytes",
    );
  }, 60_000);
});

describe("the path guard inside another worktree", () => {
  /** Text that would be packed if it were read; none of it may be. */
  const OUTSIDE = [
    "OUTSIDE-TEXT",
    "OUTSIDE-REPORT",
    "MAIN-TEXT",
    "WORKTREE-KNOWLEDGE",
  ];

  type Case = {
    name: string;
    /** Makes the links the case needs; answers the run's artifacts. */
    arrange: (paths: { main: string; tree: string; outside: string }) => {
      plan?: string;
      research?: string;
      ship?: string;
    };
    /** The listing lines past the bead's own parts, `W` for the worktree's name. */
    expected: string[];
  };

  const cases: Case[] = [
    {
      name: "a link out of the worktree",
      arrange: ({ tree, outside }) => {
        linkDirectory(
          join(outside, "plans", "drafts"),
          join(tree, "plans", "drafts", "out"),
        );
        return { plan: "plans/drafts/out/leak.md" };
      },
      expected: [
        "linked plan plans/drafts/out/leak.md from worktree W: not packed, it resolves outside the worktree",
      ],
    },
    {
      name: "a link from the worktree into the main checkout",
      arrange: ({ main, tree }) => {
        linkDirectory(
          join(main, "plans", "drafts"),
          join(tree, "plans", "research", "main"),
        );
        return { research: "plans/research/main/main-plan.md" };
      },
      expected: [
        "linked research plans/research/main/main-plan.md from worktree W: not packed, it resolves outside the worktree",
      ],
    },
    {
      name: "the worktree's reports directory linked out of it",
      arrange: ({ tree, outside }) => {
        linkDirectory(join(outside, "reports"), join(tree, "reports"));
        return { ship: "reports/kiln-ship.md" };
      },
      expected: [
        "linked report reports/kiln-ship.md from worktree W: not packed, it resolves outside the worktree",
      ],
    },
    {
      name: "a link inside the worktree to a place that is not a plan, research or report",
      arrange: ({ tree }) => {
        linkDirectory(
          join(tree, "knowledge"),
          join(tree, "plans", "drafts", "k"),
        );
        return { plan: "plans/drafts/k/notes.md" };
      },
      expected: [
        "linked plan plans/drafts/k/notes.md from worktree W: refused, it resolves to a path that is not a plan, research or report",
      ],
    },
    {
      name: "dot-dot segments",
      arrange: () => ({ plan: "plans/drafts/../../knowledge/notes.md" }),
      expected: [
        "linked plan from worktree W: refused, the run state names a path that is not a plan, research or report",
      ],
    },
    {
      name: "an absolute path elsewhere",
      arrange: ({ outside }) => ({
        plan: slash(join(outside, "plans", "drafts", "leak.md")),
      }),
      expected: [
        "linked plan from worktree W: refused, the run state names a path that is not a plan, research or report",
      ],
    },
    {
      name: "backslashes and dot-dot segments",
      arrange: () => ({ plan: "plans\\drafts\\..\\..\\knowledge\\notes.md" }),
      expected: [
        "linked plan from worktree W: refused, the run state names a path that is not a plan, research or report",
      ],
    },
  ];

  test.each(
    cases.map((entry) => [entry.name, entry] as const),
  )("%s: refused with a note, and nothing outside the worktree is read", async (_name, entry) => {
    const main = mainCheckout({
      "plans/drafts/main-plan.md": "MAIN-TEXT",
    });
    const outside = scratch("council-outside-");
    write(outside, {
      "plans/drafts/leak.md": "OUTSIDE-TEXT",
      "reports/kiln-ship.md": "OUTSIDE-REPORT",
    });
    const tree = join(main, ".claude", "worktrees", "kiln-wt");
    linkedWorktree(main, tree, {
      "knowledge/notes.md": "WORKTREE-KNOWLEDGE",
    });
    const artifacts = entry.arrange({ main, tree, outside });
    write(
      tree,
      Object.fromEntries([runState("kiln-temp", { beadId: BEAD, artifacts })]),
    );

    const packed = await pack(
      fakeRunner({ listing: listed([main, tree]) }),
      main,
    );
    const everything = JSON.stringify(packed);
    for (const text of OUTSIDE) expect(everything).not.toContain(text);
    expect(everything).not.toContain(basename(outside));
    expect(linkedListing(packed)).toEqual(
      entry.expected.map((line) =>
        line.replace(" W:", " .claude/worktrees/kiln-wt:"),
      ),
    );
    expect(packed.evidence).toHaveLength(3);
  });

  test("a run state reached through a link out of its checkout is not read, in a worktree or in the workspace", async () => {
    const outside = scratch("council-outside-");
    // A run state file, in a directory outside every checkout.
    const [, state] = runState("kiln-temp", { beadId: BEAD });
    write(outside, { "kiln-temp.json": state });

    const main = mainCheckout();
    const tree = linkedWorktree(main, join(main, "trees", "kiln"), {
      "plans/drafts/kiln-temp.md": "PLAN-OF-A-STATE-OUTSIDE",
    });
    linkDirectory(outside, join(tree, ".tmp", "work", "forge-runs"));
    const fromTree = await pack(
      fakeRunner({ listing: listed([main, tree]) }),
      main,
    );
    expect(fromTree.source.metadata?.forgeRun).toBeUndefined();
    expect(JSON.stringify(fromTree)).not.toContain("PLAN-OF-A-STATE-OUTSIDE");
    expect(linkedListing(fromTree)).toEqual([]);

    const alone = mainCheckout({
      "plans/drafts/kiln-temp.md": "PLAN-OF-A-STATE-OUTSIDE",
    });
    linkDirectory(outside, join(alone, ".tmp", "work", "forge-runs"));
    const fromWorkspace = await pack(fakeRunner(), alone);
    expect(fromWorkspace.source.metadata?.forgeRun).toBeUndefined();
    expect(JSON.stringify(fromWorkspace)).not.toContain(
      "PLAN-OF-A-STATE-OUTSIDE",
    );
  });
});

describe("what git lists", () => {
  test("only a worktree of the workspace's own repository is searched: a directory outside it, a half-forged link, another repository's worktree, a directory whose .git is a link and a relative path are refused, a file is passed over, a gone one is a note", async () => {
    const main = mainCheckout();
    const tree = linkedWorktree(
      main,
      join(main, "trees", "kiln"),
      Object.fromEntries([
        runState("kiln-temp", { beadId: BEAD }),
        ["plans/drafts/kiln-temp.md", "GENUINE-PLAN"],
      ]),
    );
    // Each holds a newer run of the bead, which would win if it were searched.
    const newer = (slug: string, text: string) =>
      Object.fromEntries([
        runState(slug, { beadId: BEAD, updatedAt: "2031-02-01T00:00:00.000Z" }),
        [`plans/drafts/${slug}.md`, text],
      ]);

    // A directory with no tie to the repository.
    const stranger = scratch("council-stranger-");
    write(stranger, newer("stranger", "STRANGER-PLAN"));
    // A .git file that names an admin directory of this repository, whose
    // gitdir file names another checkout.
    const halfForged = scratch("council-half-");
    mkdirSync(join(main, ".git", "worktrees", "half"), { recursive: true });
    writeFileSync(
      join(halfForged, ".git"),
      `gitdir: ${slash(join(main, ".git", "worktrees", "half"))}\n`,
    );
    writeFileSync(
      join(main, ".git", "worktrees", "half", "gitdir"),
      `${slash(join(tree, ".git"))}\n`,
    );
    write(halfForged, newer("half", "HALF-FORGED-PLAN"));
    // A genuine worktree, of another repository.
    const otherMain = mainCheckout();
    const otherTree = linkedWorktree(
      otherMain,
      join(scratch("council-other-"), "other-tree"),
      newer("other", "OTHER-REPOSITORY-PLAN"),
    );
    // A directory whose .git is a link to this repository's .git.
    const posing = scratch("council-posing-");
    linkDirectory(join(main, ".git"), join(posing, ".git"));
    write(posing, newer("posing", "POSING-PLAN"));
    const file = join(scratch("council-file-"), "not-a-directory");
    writeFileSync(file, "a file");
    const gone = join(scratch("council-gone-"), "removed-tree");

    const fake = fakeRunner({
      listing: ok(
        porcelain([
          main,
          tree,
          stranger,
          halfForged,
          otherTree,
          posing,
          file,
          gone,
        ]) + "worktree plans\0HEAD 0000\0detached\0\0",
      ),
    });
    const packed = await pack(fake, main);

    const everything = JSON.stringify(packed);
    expect(everything).toContain("GENUINE-PLAN");
    for (const text of [
      "STRANGER-PLAN",
      "HALF-FORGED-PLAN",
      "OTHER-REPOSITORY-PLAN",
      "POSING-PLAN",
    ])
      expect(everything).not.toContain(text);
    expect(packed.source.metadata?.forgeRun).toBe("kiln-temp");
    const refused = "not searched, not a worktree of this repository";
    expect(linkedListing(packed)).toEqual([
      "E4 linked plan plans/drafts/kiln-temp.md from worktree trees/kiln: 12 bytes",
      "linked research plans/research/kiln-temp.md from worktree trees/kiln: missing, not packed",
      "linked report reports/kiln-temp-ship.md from worktree trees/kiln: missing, not packed",
      `worktree ${basename(stranger)}: ${refused}`,
      `worktree ${basename(halfForged)}: ${refused}`,
      `worktree other-tree: ${refused}`,
      `worktree ${basename(posing)}: ${refused}`,
      // A listed path with no forge runs directory (here a file) is passed
      // over without a note: nothing there could be read.
      "worktree removed-tree: listed by git but gone, not searched",
      `worktree plans: ${refused}`,
    ]);
  });

  test("a path that holds a line break is one path, not a second worktree", async () => {
    const main = mainCheckout();
    linkedWorktree(main, join(main, "trees", "kiln"));
    const stranger = scratch("council-stranger-");
    write(
      stranger,
      Object.fromEntries([
        runState("stranger", { beadId: BEAD }),
        ["plans/drafts/stranger.md", "STRANGER-PLAN"],
      ]),
    );
    const forged = `${slash(join(main, "trees", "x"))}\nworktree ${slash(stranger)}`;
    const packed = await pack(
      fakeRunner({
        listing: ok(
          `worktree ${slash(main)}\0\0worktree ${forged}\0detached\0\0`,
        ),
      }),
      main,
    );
    expect(JSON.stringify(packed)).not.toContain("STRANGER-PLAN");
    expect(packed.source.metadata?.forgeRun).toBeUndefined();
    expect(linkedListing(packed)).toEqual([
      expect.stringMatching(/: listed by git but gone, not searched$/),
    ]);
  });

  test("at most ten worktrees that were not searched are named; the rest are counted, naming that limit", async () => {
    const main = mainCheckout();
    const base = scratch("council-gone-");
    const gone = Array.from({ length: 12 }, (_, index) =>
      join(base, `gone-${String(index + 1).padStart(2, "0")}`),
    );
    linkedWorktree(main, join(main, "trees", "kiln"));
    const packed = await pack(
      fakeRunner({ listing: listed([main, ...gone]) }),
      main,
    );
    const lines = linkedListing(packed);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe(
      "worktree gone-01: listed by git but gone, not searched",
    );
    expect(lines.at(-1)).toBe(
      "2 more worktrees: not searched, not named here (limit 10 named)",
    );
  });

  /** `count` linked worktrees of `main` under `.claude/worktrees`, as git lists them: by name. */
  const manyWorktrees = (main: string, count: number): string[] =>
    Array.from({ length: count }, (_, index) =>
      linkedWorktree(
        main,
        join(
          main,
          ".claude",
          "worktrees",
          `wt-${String(index + 1).padStart(3, "0")}`,
        ),
      ),
    );

  test("a run in a worktree far down a long listing is found: no worktree is passed over for where git lists it", async () => {
    // As on the machine this was found on: 93 linked worktrees, and the one
    // that built the run 85th in git's (alphabetical) listing.
    const main = mainCheckout();
    const trees = manyWorktrees(main, 93);
    const holder = trees[84] ?? "";
    write(
      holder,
      Object.fromEntries([
        runState("kiln-temp", {
          beadId: BEAD,
          artifacts: { plan: "plans/drafts/kiln-temp.md" },
        }),
        ["plans/drafts/kiln-temp.md", "THE-PLAN"],
      ]),
    );
    const packed = await pack(
      fakeRunner({ listing: listed([main, ...trees]) }),
      main,
    );
    expect(packed.source.metadata?.forgeRun).toBe("kiln-temp");
    expect(linkedListing(packed)).toEqual([
      "E4 linked plan plans/drafts/kiln-temp.md from worktree .claude/worktrees/wt-085: 8 bytes",
    ]);
  }, 60_000);

  test("at most 100 worktrees that hold forge runs are searched, in the order git lists them; the rest are counted, naming that limit", async () => {
    const main = mainCheckout();
    const trees = manyWorktrees(main, 102);
    // Every one holds a run, of another bead; the bead's own runs are in the
    // 100th (older) and the 101st (newer).
    for (const [index, tree] of trees.entries())
      write(
        tree,
        Object.fromEntries([
          runState(`other-${index + 1}`, { beadId: "demo-harness-zz9" }),
        ]),
      );
    write(
      trees[99] ?? "",
      Object.fromEntries([
        runState("hundredth", { beadId: BEAD, artifacts: {} }),
      ]),
    );
    write(
      trees[100] ?? "",
      Object.fromEntries([
        runState("past-the-limit", {
          beadId: BEAD,
          artifacts: {},
          updatedAt: "2031-03-01T00:00:00.000Z",
        }),
      ]),
    );
    const packed = await pack(
      fakeRunner({ listing: listed([main, ...trees]) }),
      main,
    );
    expect(packed.source.metadata?.forgeRun).toBe("hundredth");
    expect(linkedListing(packed)).toEqual([
      "2 more worktrees with forge runs: not searched (limit 100 searched)",
    ]);
  }, 60_000);

  test("when git cannot list the worktrees the workspace alone is searched, and the listing says so", async () => {
    const failures: Array<[string, CommandResult | "throws"]> = [
      [
        "a failed command",
        { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" },
      ],
      ["output without -z separators", ok("worktree /somewhere\nHEAD 0000\n")],
      ["a runner that throws", "throws"],
    ];
    for (const [how, answer] of failures) {
      const main = mainCheckout(
        Object.fromEntries([
          runState("kiln-temp", { beadId: BEAD }),
          ["plans/drafts/kiln-temp.md", "MAIN-PLAN"],
        ]),
      );
      linkedWorktree(main, join(main, "trees", "kiln"));
      const fake =
        answer === "throws" ? fakeRunner() : fakeRunner({ listing: answer });
      const packed = await pack(fake, main);
      expect({
        how,
        plan: JSON.stringify(packed.evidence).includes("MAIN-PLAN"),
      }).toEqual({ how, plan: true });
      expect({ how, last: linkedListing(packed).at(-1) }).toEqual({
        how,
        last: "worktrees: not searched, git could not list them",
      });
    }
  });

  test("a repository with no linked worktree is never asked for a listing, and a secret in the bead refuses before git is asked", async () => {
    const plain = mainCheckout();
    mkdirSync(join(plain, ".git", "worktrees"));
    const quiet = fakeRunner();
    await pack(quiet, plain);
    expect(quiet.calls.map((call) => call[0])).toEqual(["bd", "bd"]);

    const main = mainCheckout();
    const tree = linkedWorktree(main, join(main, "trees", "kiln"));
    const leaky = fakeRunner({
      listing: listed([main, tree]),
      description: `export KEY=${SECRET}`,
    });
    await expect(pack(leaky, main)).rejects.toBeInstanceOf(
      ContextSecurityError,
    );
    expect(leaky.calls.map((call) => call[0])).toEqual(["bd", "bd"]);
  });
});

describe("a checkout that changes while it is read", () => {
  /**
   * As `prepareCouncilContext` packs a bead, with the test seam that runs
   * between a linked file being located and being read.
   */
  async function packWith(
    fake: Fake,
    root: string,
    beforeLinkedRead: (path: string) => void,
  ): Promise<ContextPack> {
    const compiled = await compileBead(BEAD, {
      cwd: root,
      runner: fake.runner,
      secretPolicy: "reject",
      beforeLinkedRead,
    });
    return buildContextPackFromParts({
      kind: "bead",
      ...compiled,
      secretPolicy: "reject",
    });
  }

  /** Calls `act` the first time only. */
  const once = (act: (path: string) => void) => {
    let done = false;
    return (path: string): void => {
      if (done) return;
      done = true;
      act(path);
    };
  };

  /** A main checkout and a worktree in it whose run has a plan and research. */
  function arrange(): { main: string; tree: string; fake: Fake } {
    const main = mainCheckout();
    const tree = linkedWorktree(
      main,
      join(main, ".claude", "worktrees", "kiln-wt"),
      Object.fromEntries([
        runState("kiln-temp", {
          beadId: BEAD,
          artifacts: {
            plan: "plans/drafts/kiln-temp.md",
            research: "plans/research/kiln-temp.md",
          },
        }),
        ["plans/drafts/kiln-temp.md", "TREE-PLAN"],
        ["plans/research/kiln-temp.md", "TREE-RESEARCH"],
      ]),
    );
    return { main, tree, fake: fakeRunner({ listing: listed([main, tree]) }) };
  }

  test("a linked file removed after it is located and before it is read is a note, not an error, and no local path is shown", async () => {
    const { main, fake } = arrange();
    const packed = await packWith(
      fake,
      main,
      once((path) => rmSync(path)),
    );
    expect(linkedListing(packed)).toEqual([
      "linked plan plans/drafts/kiln-temp.md from worktree .claude/worktrees/kiln-wt: missing, not packed",
      "E4 linked research plans/research/kiln-temp.md from worktree .claude/worktrees/kiln-wt: 13 bytes",
    ]);
    expect(JSON.stringify(packed)).not.toContain(basename(main));
  });

  test("locating a file under a root that is gone answers missing and throws nothing", () => {
    const file = join(scratch("council-file-"), "plan.md");
    writeFileSync(file, "a plan");
    const gone = join(scratch("council-gone-"), "removed-root");
    expect(locateWorkspaceFile(file, gone)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("a worktree removed while its files are read leaves a note for each file not yet read, and the pack is still made", async () => {
    const { main, tree, fake } = arrange();
    const packed = await packWith(
      fake,
      main,
      once(() => rmSync(tree, { recursive: true, force: true })),
    );
    expect(linkedListing(packed)).toEqual([
      "linked plan plans/drafts/kiln-temp.md from worktree .claude/worktrees/kiln-wt: missing, not packed",
      "linked research plans/research/kiln-temp.md from worktree .claude/worktrees/kiln-wt: missing, not packed",
    ]);
    expect(JSON.stringify(packed)).not.toContain(basename(main));
  });

  test("when git lists a worktree through a link, the reads stay in the real path that was verified: the link pointed elsewhere after the check does not move them", async () => {
    const main = mainCheckout();
    const tree = linkedWorktree(
      main,
      join(main, "trees", "kiln"),
      Object.fromEntries([
        runState("kiln-temp", {
          beadId: BEAD,
          artifacts: {
            plan: "plans/drafts/kiln-temp.md",
            research: "plans/research/kiln-temp.md",
          },
        }),
        ["plans/drafts/kiln-temp.md", "TREE-PLAN"],
        ["plans/research/kiln-temp.md", "TREE-RESEARCH"],
      ]),
    );
    const outside = scratch("council-outside-");
    write(outside, {
      "plans/drafts/kiln-temp.md": "OUTSIDE-PLAN",
      "plans/research/kiln-temp.md": "OUTSIDE-RESEARCH",
    });
    // Git lists the worktree by a path that is a link to it.
    const listedPath = join(scratch("council-listed-"), "kiln-link");
    linkDirectory(tree, listedPath);
    const packed = await packWith(
      fakeRunner({ listing: listed([main, listedPath]) }),
      main,
      once(() => {
        // After the check, the link is pointed somewhere else.
        if (process.platform === "win32") rmdirSync(listedPath);
        else unlinkSync(listedPath);
        linkDirectory(outside, listedPath);
      }),
    );
    const everything = JSON.stringify(packed);
    expect(everything).toContain("TREE-PLAN");
    expect(everything).toContain("TREE-RESEARCH");
    expect(everything).not.toContain("OUTSIDE-");
  });

  test("a worktree moved away after the check and replaced by a link is not read through: the file already located and the next one are missing (checked at locate and again just before each read; a swap between that last check and the read itself is not covered)", async () => {
    const main = mainCheckout();
    // Listed as itself, a real directory: the usual case.
    const tree = linkedWorktree(
      main,
      join(main, "trees", "kiln"),
      Object.fromEntries([
        runState("kiln-temp", {
          beadId: BEAD,
          artifacts: {
            plan: "plans/drafts/kiln-temp.md",
            research: "plans/research/kiln-temp.md",
          },
        }),
        ["plans/drafts/kiln-temp.md", "TREE-PLAN"],
        ["plans/research/kiln-temp.md", "TREE-RESEARCH"],
      ]),
    );
    const outside = scratch("council-outside-");
    write(outside, {
      "plans/drafts/kiln-temp.md": "OUTSIDE-PLAN",
      "plans/research/kiln-temp.md": "OUTSIDE-RESEARCH",
    });
    const packed = await packWith(
      fakeRunner({ listing: listed([main, tree]) }),
      main,
      once(() => {
        // Between the plan being located and being read.
        renameSync(tree, `${tree}-moved`);
        linkDirectory(outside, tree);
      }),
    );
    expect(JSON.stringify(packed)).not.toContain("OUTSIDE-");
    expect(linkedListing(packed)).toEqual([
      "linked plan plans/drafts/kiln-temp.md from worktree trees/kiln: missing, not packed",
      "linked research plans/research/kiln-temp.md from worktree trees/kiln: missing, not packed",
    ]);
  });
});
