/**
 * What the Forge instruction files tell a run to do, held as checks.
 *
 * A run that follows the documents must name its Beads issue on every
 * `forge:phase-gate … --write` and gate its ship step through the run's
 * correlation; otherwise nothing it does can be tied to an issue. These are
 * properties of prose, so this is a scan of the Markdown git knows about
 * (tracked, plus new files not ignored), the generated mirror included. It
 * finds what the documents say; that the commands behave as documented is
 * tested where they live (`scripts/forge/phase-gate.test.ts`,
 * `scripts/run-correlation-launchers.test.ts`, `scripts/quality-gate-hook.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join, posix } from "path";
import { parse as parseYaml } from "yaml";
import { splitFrontmatter } from "./frontmatter";

const ROOT = join(import.meta.dir, "..");

/** Instruction files outside `.claude/` and `.agents/` that a run may be following. */
const ALSO_SCANNED = [
  "docs/HARNESS-GUIDE.md",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
];

/** The task-breakdown prompt template: an instruction file the scan above does not list. */
const BEADS_TASKS_TEMPLATE = ".beads/templates/tasks.prompt.md";

const MAX_BYTES = 2 * 1024 * 1024;

/** Every file git knows about: tracked, plus new files not ignored. */
function knownFiles(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  }
  return listed.stdout.toString().split("\0");
}

/** The Markdown instructions git knows about. `docs/plans/` is history and is not among them. */
function instructionFiles(): string[] {
  return knownFiles().filter(
    (path) =>
      /^\.(claude|agents)\/.*\.md$/.test(path) || ALSO_SCANNED.includes(path),
  );
}

/** The instruction files, and the one prompt template a run is asked to paste. */
const withTasksTemplate = (): string[] => [
  ...instructionFiles(),
  BEADS_TASKS_TEMPLATE,
];

function read(path: string): string | null {
  const file = join(ROOT, path);
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    // Listed but gone from the working tree: a deletion not yet committed.
    return null;
  }
}

interface Documented {
  path: string;
  line: number;
  command: string;
}

/** A code fence, at the start of a line or straight after a list marker (`5. ```bash`). */
const FENCE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?```/;

/**
 * A shell command without its trailing `# comment`. As in the shell, a `#`
 * starts a comment only at the start of a word and outside quotes, so the
 * `#` in `--title "CI failing on PR #<n>"` is part of the title.
 */
function withoutComment(command: string): string {
  let quote: string | null = null;
  for (let at = 0; at < command.length; at++) {
    const char = command[at];
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') at++;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "\\") {
      at++;
    } else if (char === "#" && (at === 0 || /\s/.test(command[at - 1] ?? ""))) {
      return command.slice(0, at).trimEnd();
    }
  }
  return command;
}

/**
 * Every documented use of a command in one file: from its name to the end of
 * its inline code span (which may wrap onto the next lines), or, inside a
 * fenced block, to the end of its line (a trailing backslash joins the next)
 * without a trailing `# comment`, so a flag named only in a comment is not
 * taken as passed.
 */
function commandsIn(path: string, text: string, name: RegExp): Documented[] {
  const lines = text.split(/\r?\n/);
  const found: Documented[] = [];
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    for (const match of line.matchAll(new RegExp(name.source, "g"))) {
      let command = line.slice(match.index);
      if (fenced) {
        for (let next = index + 1; command.trimEnd().endsWith("\\"); next++) {
          command = `${command.trimEnd().slice(0, -1)} ${(lines[next] ?? "").trim()}`;
          if (next >= lines.length) break;
        }
        command = withoutComment(command);
      } else {
        // An inline span: read on to its closing backtick, within the paragraph.
        for (
          let next = index + 1;
          !command.includes("`") && (lines[next] ?? "").trim().length > 0;
          next++
        ) {
          command = `${command} ${(lines[next] ?? "").trim()}`;
        }
        const close = command.indexOf("`");
        if (close >= 0) command = command.slice(0, close);
      }
      found.push({ path, line: index + 1, command: command.trim() });
    }
  }
  return found;
}

const PHASE_GATE = /forge:phase-gate|scripts\/forge\/phase-gate\.ts/;
const FORGE_EXEC = /forge:exec/;

const show = (documented: Documented): string =>
  `${documented.path}:${documented.line}: ${documented.command.slice(0, 160)}`;

/**
 * The phrases a document does not hold, as `path: does not say "…"` lines, so
 * `expect(...).toEqual([])` reads as what is missing. Line wrapping is not
 * part of what a document says: runs of whitespace compare as one space.
 */
function missing(path: string, phrases: readonly string[]): string[] {
  const text = read(path);
  if (text === null) return [`${path}: not readable`];
  const said = text.replace(/\s+/g, " ");
  return phrases
    .filter((phrase) => !said.includes(phrase))
    .map((phrase) => `${path}: does not say "${phrase}"`);
}

/** A skill and its generated copy. */
const skill = (name: string): [string, string] => [
  `.claude/skills/${name}/SKILL.md`,
  `.agents/skills/${name}/SKILL.md`,
];
/** A command and the skill the mirror turns it into. */
const command = (name: string): [string, string] => [
  `.claude/commands/${name}.md`,
  `.agents/skills/${name}/SKILL.md`,
];

/** The documents that tell a phase to record itself, and their mirror copies. */
const WRITE_LINE_DOCUMENTS = [
  ".claude/commands/forge-research.md",
  ".claude/commands/forge-plan.md",
  ".claude/commands/forge-implement.md",
  ".claude/commands/forge-ship.md",
  ...command("forgemaster"),
  ...command("forgemaster-auto"),
  ...skill("forge-research"),
  ...skill("forge-plan"),
  ...skill("forge-implement"),
  ...skill("forge-ship"),
  ".claude/workflows/forge.md",
  ".claude/workflows/forge-auto.md",
  ...command("forgemaster-mini"),
  ".claude/workflows/forge-mini.md",
];

describe("the Forge documents: every recorded phase names its Beads issue", () => {
  const files = instructionFiles();
  const texts = new Map(
    files.flatMap((path) => {
      const text = read(path);
      return text === null ? [] : ([[path, text]] as const);
    }),
  );
  const writes = [...texts].flatMap(([path, text]) =>
    commandsIn(path, text, PHASE_GATE).filter((documented) =>
      documented.command.includes("--write"),
    ),
  );

  test("the scan sees the documents: each one that records a phase is in it, with a write line found", () => {
    for (const path of WRITE_LINE_DOCUMENTS) {
      expect(files).toContain(path);
      expect({
        path,
        writeLines: writes.filter((write) => write.path === path).length > 0,
      }).toEqual({ path, writeLines: true });
    }
  });

  test("every documented `forge:phase-gate … --write` passes `--bead`: no document, and no mirror copy, records a phase without one", () => {
    expect(
      writes.filter((write) => !write.command.includes("--bead")).map(show),
    ).toEqual([]);
  });

  test("each phase's write passes that phase's id: a task for research, plan and implement, the issue the run closes for ship", () => {
    const expected: ReadonlyArray<[string, readonly string[]]> = [
      [
        "--bead <task-id>",
        [
          ".claude/commands/forge-research.md",
          ...skill("forge-research"),
          ".claude/commands/forge-plan.md",
          ...skill("forge-plan"),
          ".claude/commands/forge-implement.md",
          ...skill("forge-implement"),
        ],
      ],
      [
        "--bead <close-id>",
        [".claude/commands/forge-ship.md", ...skill("forge-ship")],
      ],
      [
        "--bead <id>",
        [
          ...command("forgemaster"),
          ...command("forgemaster-auto"),
          ".claude/workflows/forge.md",
          ".claude/workflows/forge-auto.md",
        ],
      ],
    ];
    for (const [flag, paths] of expected) {
      const other = writes
        .filter((write) => paths.includes(write.path))
        .filter((write) => !write.command.includes(flag))
        .map(show);
      expect({ flag, other }).toEqual({ flag, other: [] });
    }
  });

  test("each phase's skill says in words which issue its write names", () => {
    const said: ReadonlyArray<[string, string]> = [
      ["forge-plan", "the first task the plan created"],
      ["forge-implement", "the last task this phase closed"],
      ["forge-ship", "the issue this run closes"],
    ];
    for (const [name, phrase] of said) {
      for (const path of skill(name)) {
        expect(missing(path, [phrase])).toEqual([]);
      }
    }
  });

  test("the research documents say when the write passes no bead, and why", () => {
    for (const path of [
      ".claude/commands/forge-research.md",
      ...skill("forge-research"),
    ]) {
      expect(
        missing(path, [
          "Omit `--bead`",
          "free text, a feature or an epic",
          "no task exists",
        ]),
      ).toEqual([]);
    }
  });

  test("the workflow holds the mapping for all four writes, and the rule that a feature or an epic is named only at the close", () => {
    const workflow = read(".claude/workflows/forge.md") ?? "";
    const at = workflow.indexOf("## Which bead a phase names");
    expect(at).toBeGreaterThan(-1);
    const section = workflow.slice(at, workflow.indexOf("\n## ", at + 1));
    for (const phase of ["research", "plan", "implement", "ship"]) {
      expect({
        phase,
        row: new RegExp(`^\\| ${phase} \\|.*\\|.*\\|$`, "m").test(section),
      }).toEqual({ phase, row: true });
    }
    expect(section).toContain("only by the ship write");
    expect(section).toContain("testing-attestation");
  });
});

describe("the Forge documents: the ship step gates through the run's correlation", () => {
  test("the ship skill runs the gate with the pointer the phase gate printed, and says where the pointer is and what to do without one", () => {
    for (const path of skill("forge-ship")) {
      expect(
        missing(path, [
          "bun run quality-gate --correlation <pointer>",
          "data.correlation.pointer",
          ".tmp/work/run-correlations/<slug>.json",
          "forge:correlate --bead <id> --run <slug>",
          "test-evidence",
        ]),
      ).toEqual([]);
    }
    expect(
      missing(".claude/commands/forge-ship.md", [
        "bun run quality-gate --correlation <pointer>",
      ]),
    ).toEqual([]);
    expect(
      missing(".claude/workflows/forge.md", [
        "bun run quality-gate --correlation <pointer>",
      ]),
    ).toEqual([]);
  });

  test("the ship skill says test-evidence reads the branch's own commits, and what a run with nothing to test gets", () => {
    for (const path of skill("forge-ship")) {
      expect(
        missing(path, [
          "every commit of the branch's own, the ones since `origin/HEAD`",
          "has nothing to test: the check is skipped and its entry says so",
          "the last five commits instead",
        ]),
      ).toEqual([]);
      expect(read(path)).not.toContain("there is no way past it");
    }
  });

  test("the ship documents gate a run in another repository through its correlation, from the harness, with the checks on its entry in repos/repos.json", () => {
    for (const path of [
      ...skill("forge-ship"),
      ".claude/commands/forge-ship.md",
      ".claude/workflows/forge.md",
      "docs/HARNESS-GUIDE.md",
    ]) {
      expect(
        missing(path, [
          "another repository",
          "bun run quality-gate --correlation <checkout>/<pointer>",
          "repos/repos.json",
        ]),
      ).toEqual([]);
      expect({
        path,
        limit: read(path)?.includes("no linked gate entry"),
      }).toEqual({
        path,
        limit: false,
      });
    }
  });

  test("the add-repo skill says how to write a repository's check set, and that a Windows .cmd shim cannot be named in one", () => {
    for (const path of skill("add-repo")) {
      expect(
        missing(path, [
          '"checks"',
          '"argv"',
          "without a shell",
          ".cmd",
          "the gate refuses",
        ]),
      ).toEqual([]);
    }
    for (const path of skill("syncing-repos")) {
      expect(missing(path, ['"checks"', '"argv"'])).toEqual([]);
    }
  });

  test("the ship skill asks for the testing attestation before a feature or an epic is closed", () => {
    for (const path of skill("forge-ship")) {
      expect(
        missing(path, [
          "testing-attestation automation=<yes|no> unit=<yes|no>",
        ]),
      ).toEqual([]);
    }
  });

  test("strict verdict mode stays opt-in: a Forge document that names the variable says so on the same line", () => {
    const forge = [
      ...new Set([
        ...WRITE_LINE_DOCUMENTS,
        ...command("forgemaster-mini"),
        ".claude/workflows/forge-mini.md",
        "docs/HARNESS-GUIDE.md",
      ]),
    ];
    const stray = forge.flatMap((path) =>
      (read(path) ?? "")
        .split(/\r?\n/)
        .flatMap((line, index) =>
          line.includes("AGENT_FORGE_EVAL_VERDICT") && !line.includes("opt-in")
            ? [`${path}:${index + 1}: ${line.trim().slice(0, 140)}`]
            : [],
        ),
    );
    expect(stray).toEqual([]);
  });
});

describe("the Forge documents: a gate result belongs to a run through its correlation", () => {
  test("no instruction says the quality gate tells runs apart by their checkout", () => {
    const stray = instructionFiles().flatMap((path) =>
      (read(path) ?? "")
        .split(/\r?\n/)
        .flatMap((line, index) =>
          /quality gate can(not|'t)? tell their results apart/i.test(line)
            ? [`${path}:${index + 1}: ${line.trim().slice(0, 140)}`]
            : [],
        ),
    );
    expect(stray).toEqual([]);
  });

  test("each document that had that sentence now says what does tie a result to a run, and where `--checkout` puts the correlation", () => {
    for (const path of [
      ".claude/workflows/forge.md",
      ".claude/workflows/forge-auto.md",
      ...command("forgemaster-auto"),
    ]) {
      expect(
        missing(path, [
          "belongs to a run only through that run's correlation",
          "where the phase gate writes that correlation",
        ]),
      ).toEqual([]);
    }
  });

  test("the workflow says a run's checkout must ignore `.tmp/`, where the opt-in strict verdict is filed, and that a task handed to a spawned CLI needs the run moved to it first", () => {
    expect(
      missing(".claude/workflows/forge.md", [
        "must ignore `.tmp/`",
        "git rev-parse --git-path info/exclude",
        "file it in the ship step",
        "forge:correlate --bead <task-id> --run <slug>",
      ]),
    ).toEqual([]);
  });

  test("every documented `forge:exec` that names a bead also names the run, so its child's gate can be linked", () => {
    const files = instructionFiles();
    const unlinked = files.flatMap((path) =>
      commandsIn(path, read(path) ?? "", FORGE_EXEC)
        .filter(
          (documented) =>
            documented.command.includes("--bead") &&
            !documented.command.includes("--run"),
        )
        .map(show),
    );
    expect(files).toContain(".claude/protocols/model-tier-policy.md");
    expect(unlinked).toEqual([]);
  });

  test("nothing still says that the documented workflows name no bead", () => {
    const stale: ReadonlyArray<[string, string]> = [
      [".claude/protocols/evaluation-verdict.md", "do not pass `--bead` yet"],
      [
        ".claude/agents/evaluator.md",
        "which today includes a re-evaluation run",
      ],
      [
        ".agents/skills/forge-roles/references/evaluator.md",
        "which today includes a re-evaluation run",
      ],
    ];
    for (const [path, phrase] of stale) {
      expect({ path, says: (read(path) ?? phrase).includes(phrase) }).toEqual({
        path,
        says: false,
      });
    }
  });
});

describe("the Forge documents: --smith, the file map and the mini path", () => {
  /** The seven commands, and what the mirror carries for them (the four phase commands have no copy of their own: their skills do). */
  const SMITH_DOCUMENTS = [
    ".claude/commands/forge-research.md",
    ".claude/commands/forge-plan.md",
    ".claude/commands/forge-implement.md",
    ".claude/commands/forge-ship.md",
    ...command("forgemaster"),
    ...command("forgemaster-auto"),
    ...command("forgemaster-mini"),
    ...skill("forge-research"),
    ...skill("forge-plan"),
    ...skill("forge-implement"),
    ...skill("forge-ship"),
  ];

  test("every command that takes --smith documents it and says it does not change the session's model, and so does what the mirror carries", () => {
    for (const path of SMITH_DOCUMENTS) {
      expect(
        missing(path, ["--smith <name>", "does not change the model of"]),
      ).toEqual([]);
    }
  });

  test("the workflow says what --smith is: given on every phase-gate call, what a write without it records, and whom the rank check then reads", () => {
    expect(
      missing(".claude/workflows/forge.md", [
        "## `--smith`",
        "every `forge:phase-gate` call",
        "records the live session",
        "does not change the model of",
        "the builder the evaluator's rank is compared against",
        "bun run forge:runs show <slug>",
      ]),
    ).toEqual([]);
  });

  test("where the workflow hands work to a spawned CLI, the command passes the smith, the bead and the run", () => {
    const text = read(".claude/workflows/forge.md") ?? "";
    const handOffs = commandsIn(".claude/workflows/forge.md", text, FORGE_EXEC)
      .map((documented) => documented.command)
      .filter((documented) => documented.includes("--smith"));
    expect(handOffs.length).toBeGreaterThan(0);
    for (const handOff of handOffs) {
      expect(handOff).toContain("--bead <task-id>");
      expect(handOff).toContain("--run <slug>");
      expect(handOff).toContain("--smith <name>");
    }
  });

  test("the mini documents record a --smith run with one ship write that names the task and the smith", () => {
    for (const path of [
      ...command("forgemaster-mini"),
      ".claude/workflows/forge-mini.md",
    ]) {
      const writes = commandsIn(path, read(path) ?? "", PHASE_GATE)
        .map((documented) => documented.command)
        .filter((documented) => documented.includes("--write"));
      expect({ path, writes: writes.length }).toEqual({ path, writes: 1 });
      for (const flag of [" ship ", "--bead <task-id>", "--smith <name>"]) {
        expect({ path, flag, has: writes[0]?.includes(flag) }).toEqual({
          path,
          flag,
          has: true,
        });
      }
      expect(
        missing(path, ["reports/<slug>-ship.md", "no linked gate entry"]),
      ).toEqual([]);
    }
  });

  test("every place that says the mini path keeps no run state names the --smith exception", () => {
    for (const path of [
      ...command("forgemaster"),
      ...command("forgemaster-mini"),
      ".claude/workflows/forge-mini.md",
    ]) {
      const flat = (read(path) ?? "").replace(/\s+/g, " ");
      const claims = [...flat.matchAll(/run state file/g)].length;
      const exceptions = [...flat.matchAll(/unless it was given `--smith`/g)]
        .length;
      expect({
        path,
        claims: claims > 0,
        covered: exceptions >= claims,
      }).toEqual({ path, claims: true, covered: true });
    }
  });

  test("the implement documents hold the worker to the task's file map, and say what to do when the work leaves it", () => {
    for (const path of skill("forge-implement")) {
      expect(
        missing(path, [
          "Stay inside the task's file map",
          "worklog: outside the file map:",
          "`## Files`",
        ]),
      ).toEqual([]);
    }
    expect(
      missing(".claude/commands/forge-implement.md", [
        "Stay inside the task's file map",
      ]),
    ).toEqual([]);
  });

  test("the harness guide has a Forge section that documents --smith, the bead each phase names and the file map", () => {
    const guide = read("docs/HARNESS-GUIDE.md") ?? "";
    const at = guide.indexOf("## The Forge pipeline");
    expect(at).toBeGreaterThan(-1);
    const next = guide.indexOf("\n## ", at + 1);
    const section = guide
      .slice(at, next < 0 ? undefined : next)
      .replace(/\s+/g, " ");
    for (const phrase of [
      "--smith <name>",
      "does not change the model of",
      "--bead <id>",
      "bun run quality-gate --correlation <pointer>",
      "`## Files`",
      "complexity:low",
    ]) {
      expect({ phrase, said: section.includes(phrase) }).toEqual({
        phrase,
        said: true,
      });
    }
  });

  test("the model-tier policy says the phase gate takes a smith by name", () => {
    const policy = ".claude/protocols/model-tier-policy.md";
    const named = commandsIn(policy, read(policy) ?? "", PHASE_GATE).filter(
      (documented) => documented.command.includes("--smith <name>"),
    );
    expect(named.length).toBeGreaterThan(0);
  });
});

describe("the Forge documents: what the review of the first build found", () => {
  test("the implement documents read the file map from the stored description, not from the rendered one", () => {
    for (const path of skill("forge-implement")) {
      expect(
        missing(path, [
          "bd show <task-id> --json",
          "renders the description as Markdown",
          "bun run scripts/scheduler/filemap-cli.ts",
        ]),
      ).toEqual([]);
    }
  });

  test("no Forge document gives `bd dep add` a flag this bd does not have", () => {
    const forge = [
      ...new Set([
        ...WRITE_LINE_DOCUMENTS,
        ".claude/skills/forge-plan/references/example-plan.md",
      ]),
    ];
    const wrong = forge.flatMap((path) =>
      commandsIn(path, read(path) ?? "", /bd dep add/)
        .filter((documented) =>
          /--(requires|blocks)\b/.test(documented.command),
        )
        .map(show),
    );
    expect(wrong).toEqual([]);
    for (const path of skill("forge-plan")) {
      expect(missing(path, ["bd dep add <later-id> <earlier-id>"])).toEqual([]);
    }
  });

  test("no instruction file gives `bd dep add` the --requires or --blocks flag, which this bd rejects as unknown", () => {
    const wrong = withTasksTemplate().flatMap((path) =>
      commandsIn(path, read(path) ?? "", /bd dep add/)
        .filter((documented) =>
          /--(requires|blocks)\b/.test(documented.command),
        )
        .map(show),
    );
    expect(wrong).toEqual([]);
  });

  test("no instruction file gives `bd create` or `bd update` the --ac flag, which this bd rejects as unknown (it is --acceptance)", () => {
    const wrong = withTasksTemplate().flatMap((path) =>
      commandsIn(path, read(path) ?? "", /bd (?:create|update)\b/)
        .filter((documented) =>
          /(?:^|\s)--ac(?=[\s="']|$)/.test(documented.command),
        )
        .map(show),
    );
    expect(wrong).toEqual([]);
  });

  test("no `bd create` example joins its flags with a literal backslash-n, which the shell passes on as an argument", () => {
    const wrong = withTasksTemplate().flatMap((path) =>
      commandsIn(path, read(path) ?? "", /bd create\b/)
        .filter((documented) => /\\n\s/.test(documented.command))
        .map(show),
    );
    expect(wrong).toEqual([]);
  });

  test("each `bd dep add` line that used to name its direction with a flag still puts the dependent issue first", () => {
    const directions: Array<[string, readonly string[]]> = [
      ["CLAUDE.md", ["bd dep add <later-id> <earlier-id>"]],
      [BEADS_TASKS_TEMPLATE, ["bd dep add <task-b-id> <task-a-id>"]],
      ...command("go").map((path): [string, readonly string[]] => [
        path,
        ["bd dep add <B-id> <A-id>"],
      ]),
      ...command("plan").map((path): [string, readonly string[]] => [
        path,
        ["bd dep add <step-2-id> <step-1-id>"],
      ]),
      ...skill("qa").map((path): [string, readonly string[]] => [
        path,
        ["bd dep add <blocked-id> <blocker-id>"],
      ]),
      ...skill("to-issues").map((path): [string, readonly string[]] => [
        path,
        ["bd dep add <blocked-id> <slice-id>"],
      ]),
    ];
    for (const [path, phrases] of directions) {
      expect(missing(path, phrases)).toEqual([]);
    }
  });

  test("no instruction file `cat`s a repo's knowledge file without a fallback for the file not being there", () => {
    const bare = withTasksTemplate().flatMap((path) =>
      commandsIn(path, read(path) ?? "", /cat knowledge\/repos\//)
        .filter((documented) => !documented.command.includes("||"))
        .map(show),
    );
    expect(bare).toEqual([]);
  });

  test("each instruction that loads a repo's knowledge file says the directory is empty in a fresh checkout", () => {
    const loaders = [
      ...skill("forge-research"),
      ...command("plan"),
      ...command("ask"),
      ...command("review"),
      ".claude/agents/worker.md",
      ".agents/skills/forge-roles/references/worker.md",
      ".claude/workflows/feature.md",
      ".claude/workflows/fix.md",
    ];
    for (const path of loaders) {
      expect(missing(path, ["is empty in a fresh checkout"])).toEqual([]);
    }
  });

  test("the research skill says what to do when a repo has no knowledge file", () => {
    for (const path of skill("forge-research")) {
      expect(
        missing(path, [
          "the directory is empty in a fresh checkout",
          "say in the research document that no knowledge file existed",
        ]),
      ).toEqual([]);
    }
  });

  test("the tasks template creates each task with a priority and points at the skill that chooses it", () => {
    const create = commandsIn(
      BEADS_TASKS_TEMPLATE,
      read(BEADS_TASKS_TEMPLATE) ?? "",
      /bd create\b/,
    );
    expect(create.length).toBeGreaterThan(0);
    expect(
      create.filter((documented) => !documented.command.includes("--priority")),
    ).toEqual([]);
    expect(
      missing(BEADS_TASKS_TEMPLATE, [
        ".claude/skills/beads-priority-assignment/SKILL.md",
      ]),
    ).toEqual([]);
  });

  test("the plan skill gives the command that checks a plan's maps, checkpoint by checkpoint, and says where a reason for `**` goes", () => {
    for (const path of skill("forge-plan")) {
      expect(
        missing(path, [
          "bun run scripts/scheduler/filemap-cli.ts plans/drafts/<slug>.md --plan",
          "bun run scripts/scheduler/filemap-cli.ts .tmp/work/<slug>-task-<letter>.md",
          "one-line `<!-- … -->` comment",
          "--parent <id>",
        ]),
      ).toEqual([]);
    }
  });

  test("the documents say forge:exec does not read the bead: the label and the bead's smith reach it as flags", () => {
    expect(
      missing(".claude/workflows/forge.md", [
        "--bead-smith",
        "--complexity <low|medium|high>",
        "It does not read the bead",
      ]),
    ).toEqual([]);
    for (const path of skill("forge-plan")) {
      expect(missing(path, ["Nothing reads the label from Beads yet"])).toEqual(
        [],
      );
    }
  });

  test("a write without --smith: both documents say what it records, and what the run keeps when the session's model is not known", () => {
    for (const path of [
      ".claude/workflows/forge.md",
      ".claude/protocols/model-tier-policy.md",
    ]) {
      expect(
        missing(path, [
          "whenever the ledger knows that session's model",
          "keeps the executor it had",
        ]),
      ).toEqual([]);
    }
  });

  test("the workflow names the one case where a feature or an epic is bound before the close, and what --epic does to the run's events", () => {
    expect(
      missing(".claude/workflows/forge.md", [
        "One exception, for unattended runs",
        "carry the `--epic` id",
      ]),
    ).toEqual([]);
  });
});

describe("the generated mirror carries what its source says", () => {
  test("each Forge skill's copy is its source, byte for byte", () => {
    for (const name of [
      "forge-research",
      "forge-plan",
      "forge-implement",
      "forge-ship",
    ]) {
      const [source, copy] = skill(name);
      expect({ name, same: read(copy) === read(source) }).toEqual({
        name,
        same: true,
      });
    }
    expect(read(".agents/skills/forge-roles/references/evaluator.md")).toBe(
      read(".claude/agents/evaluator.md"),
    );
  });

  test("each Forge command's skill ends with the command's text, unchanged: what follows its frontmatter", () => {
    for (const name of [
      "forgemaster",
      "forgemaster-auto",
      "forgemaster-mini",
      "ship",
    ]) {
      const [source, copy] = command(name);
      const body = splitFrontmatter(
        read(source) ?? "missing source",
      ).body.trimStart();
      expect({
        name,
        carried: (read(copy) ?? "").endsWith(body),
      }).toEqual({ name, carried: true });
    }
  });
});

const BD_CREATE = /bd create\b/;

/** The instruction files, and every Beads template a run may paste from. */
const withBeadsTemplates = (): string[] => [
  ...instructionFiles(),
  ...knownFiles().filter((path) => /^\.beads\/templates\/.*\.md$/.test(path)),
];

/** One key of a parsed YAML mapping, or `undefined` when there is no such key. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** A repository path compared as a path: `./` is `.`, and `./repos/x/` is `repos/x`. */
const repositoryKey = (path: string): string =>
  posix.normalize(path.replace(/\\/g, "/")).replace(/(.)\/$/, "$1");

/** The repositories bd knows here: the primary and any additional ones the tracker's config lists. */
function registeredRepositories(): Set<string> {
  const repos = field(parseYaml(read(".beads/config.yaml") ?? ""), "repos");
  const additional = field(repos, "additional");
  return new Set(
    [field(repos, "primary"), ...(Array.isArray(additional) ? additional : [])]
      .filter((path): path is string => typeof path === "string")
      .map(repositoryKey),
  );
}

/** Each `--repo` value a documented command passes, its quotes taken off. */
const repoValues = (command: string): string[] =>
  [
    ...command.matchAll(/(?:^|\s)--repo(?:=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/g),
  ].map((match) => (match[1] ?? "").replace(/^(["'])(.*)\1$/, "$2"));

describe("the documents: no `bd create` names a repository bd does not know", () => {
  const registered = registeredRepositories();
  const files = withBeadsTemplates();
  const creates = files.flatMap((path) =>
    commandsIn(path, read(path) ?? "", BD_CREATE),
  );

  test("the registered repositories are read from the tracker's config, the primary `.` among them, and the scan covers the instruction files and the Beads templates", () => {
    expect(registered.has(".")).toBe(true);
    for (const path of ["CLAUDE.md", "AGENTS.md", BEADS_TASKS_TEMPLATE]) {
      expect(files).toContain(path);
    }
  });

  test("the scan reads a `--repo` on a continuation line of a multi-line `bd create`, after a quoted `#`, and in an inline code span", () => {
    const fenced = [
      "```bash",
      "bd create \\",
      "  --type task \\",
      "  --repo <repo> \\",
      "  --priority 2",
      "",
      "bd create \\",
      '  --title "CI failing on PR #<n>: <pr title>" \\',
      "  --repo <other> \\",
      "  --priority 1   # a comment, which is not read",
      "```",
    ].join("\n");
    const found = commandsIn("fenced.md", fenced, BD_CREATE);
    expect(found.map((documented) => repoValues(documented.command))).toEqual([
      ["<repo>"],
      ["<other>"],
    ]);
    expect(found[1]?.command).toEndWith("--priority 1");
    expect(
      commandsIn(
        "inline.md",
        'Create it with `bd create --repo "./repos/<repo>" --priority 2`.',
        BD_CREATE,
      ).map((documented) => repoValues(documented.command)),
    ).toEqual([["./repos/<repo>"]]);
  });

  test("every documented `bd create` passes no `--repo`, or one registered with bd: any other value prints an id and files the issue in a tracker under that path", () => {
    const unknown = creates
      .filter((documented) =>
        repoValues(documented.command).some(
          (value) => !registered.has(repositoryKey(value)),
        ),
      )
      .map(show);
    expect(unknown).toEqual([]);
  });

  test("each document whose `bd create` passed a placeholder repository names the repository at the start of the title instead", () => {
    const documents = [
      ...skill("forge-plan"),
      ...command("forgemaster"),
      ".claude/workflows/forge-mini.md",
      ...command("go"),
      ...command("plan"),
      ...command("triage"),
      BEADS_TASKS_TEMPLATE,
      ".claude/workflows/fix.md",
      ...skill("beads-priority-assignment"),
      ...skill("qa"),
      "CLAUDE.md",
      "AGENTS.md",
    ];
    for (const path of documents) {
      const titled = creates.filter(
        (documented) =>
          documented.path === path &&
          documented.command.includes('--title "[<repo'),
      );
      expect({ path, titled: titled.length > 0 }).toEqual({
        path,
        titled: true,
      });
    }
  });

  test("CLAUDE.md and AGENTS.md give the same rule: the sub-repo is named in the title, no `--repo` but `.`, and why", () => {
    for (const path of ["CLAUDE.md", "AGENTS.md"]) {
      expect(
        missing(path, [
          "Name the sub-repo at the start of the title",
          "pass no `--repo` other than `--repo .`",
          "`bd repo list` shows `.` as the only registered repository",
          "still prints an id but files the issue in a tracker under that path (making one if there is none)",
          "`/add-repo` registers a sub-repo with the harness, not with `bd`",
        ]),
      ).toEqual([]);
    }
  });

  test("the add-bead command names the sub-repo in the title, and no document still says to pass a sub-repo path as `--repo`", () => {
    for (const path of command("add-bead")) {
      expect(missing(path, ["start the title with **`[<name>]`**"])).toEqual(
        [],
      );
    }
    const stale: ReadonlyArray<[readonly string[], string]> = [
      [command("add-bead"), "pass **`--repo ./repos/<name>`**"],
      [
        skill("request-refactor-plan"),
        "Use `--repo ./repos/<repo-name>` for a registered sub-repo",
      ],
      [skill("authoring-agent-skills"), "e.g. `--repo ./repos/<name>`"],
    ];
    for (const [paths, phrase] of stale) {
      for (const path of paths) {
        expect({ path, says: (read(path) ?? phrase).includes(phrase) }).toEqual(
          { path, says: false },
        );
      }
    }
  });
});
