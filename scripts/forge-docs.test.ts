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
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

/** Instruction files outside `.claude/` and `.agents/` that a run may be following. */
const ALSO_SCANNED = [
  "docs/HARNESS-GUIDE.md",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
];

const MAX_BYTES = 2 * 1024 * 1024;

/** The Markdown instructions git knows about. `docs/plans/` is history and is not among them. */
function instructionFiles(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  }
  return listed.stdout
    .toString()
    .split("\0")
    .filter(
      (path) =>
        /^\.(claude|agents)\/.*\.md$/.test(path) || ALSO_SCANNED.includes(path),
    );
}

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
        command = command.replace(/\s+#.*$/, "");
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

  test("the ship documents say what a run in another repository does instead, and that it has no linked gate entry", () => {
    for (const path of [
      ...skill("forge-ship"),
      ".claude/commands/forge-ship.md",
      ".claude/workflows/forge.md",
    ]) {
      expect(
        missing(path, ["another repository", "no linked gate entry"]),
      ).toEqual([]);
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

  test("each Forge command's skill ends with the command's text, unchanged", () => {
    for (const name of [
      "forgemaster",
      "forgemaster-auto",
      "forgemaster-mini",
      "ship",
    ]) {
      const [source, copy] = command(name);
      const body = (read(source) ?? "missing source").trimStart();
      expect({
        name,
        carried: (read(copy) ?? "").endsWith(body),
      }).toEqual({ name, carried: true });
    }
  });
});
