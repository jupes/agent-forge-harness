/**
 * The bead source and the multi-part pack it is built from.
 *
 * No test here reads the real tracker, the real origin or a real pull request:
 * every command goes to a fake runner that records it and refuses anything a
 * test did not expect. The bead, its comments and its files are invented.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildContextPackFromParts,
  type ContextPart,
  ContextSecurityError,
} from "./context";
import type { CommandResult, CommandRunner } from "./pr-source";
import type { ContextPack } from "./types";
import { prepareCouncilContext } from "./workflow";

const BEAD = "demo-harness-ab12.3";
const EPIC = "demo-harness-ab12";
/** Shaped like a provider key; it opens nothing. */
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A scratch workspace: a checkout root with nothing in it. */
function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "council-bead-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

type Json = Record<string, unknown>;

function issue(overrides: Json = {}): Json {
  return {
    id: BEAD,
    title: "Teach the kiln to report its temperature",
    description: "The kiln runs blind today. Report a reading every minute.",
    acceptance_criteria:
      "[ ] kiln.test.ts covers a cold start.\n[ ] The reading is in Celsius.",
    status: "in_progress",
    priority: 2,
    issue_type: "task",
    assignee: "Ada Example",
    owner: "ada@example.invalid",
    created_by: "Ada Example",
    created_at: "2031-01-02T08:00:00Z",
    updated_at: "2031-01-05T09:30:00Z",
    labels: ["kiln", "telemetry"],
    parent: EPIC,
    dependencies: [
      {
        id: EPIC,
        title: "PRIVATE-EPIC-TITLE",
        description: "PRIVATE-EPIC-DESCRIPTION",
        acceptance_criteria: "PRIVATE-EPIC-CRITERIA",
        status: "open",
        dependency_type: "parent-child",
      },
      {
        id: "demo-harness-zz9",
        title: "PRIVATE-BLOCKER-TITLE",
        description: "PRIVATE-BLOCKER-DESCRIPTION",
        acceptance_criteria: "PRIVATE-BLOCKER-CRITERIA",
        status: "closed",
        dependency_type: "blocks",
      },
    ],
    dependency_count: 2,
    dependent_count: 0,
    comment_count: 3,
    ...overrides,
  };
}

function comment(createdAt: string, text: string, extra: Json = {}): Json {
  return {
    id: `c-${createdAt}`,
    issue_id: BEAD,
    author: "Ada Example",
    text,
    created_at: createdAt,
    ...extra,
  };
}

const COMMENTS = [
  comment("2031-01-03T10:00:00Z", "worklog: sensor wired to the bench rig."),
  comment("2031-01-04T11:00:00Z", "design: readings are averaged over 5 s."),
  comment("2031-01-05T09:30:00Z", "review: PASS, 0 blocker, 0 high."),
];

type Fake = { runner: CommandRunner; calls: string[][] };

const ok = (stdout: string): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

/** Answers the two bead reads; anything else a test did not arrange throws. */
function fakeRunner(
  options: {
    issue?: Json | null;
    comments?: Json[];
    extra?: (command: string[]) => CommandResult | undefined;
  } = {},
): Fake {
  const calls: string[][] = [];
  const shown = options.issue ?? issue();
  const id = String(shown.id);
  const runner: CommandRunner = async (command) => {
    calls.push(command);
    const arranged = options.extra?.(command);
    if (arranged) return arranged;
    const line = command.join(" ");
    if (line === `bd --readonly show ${id} --json`)
      return ok(JSON.stringify([shown]));
    if (line === `bd --readonly comments ${id} --json`)
      return ok(
        JSON.stringify(
          (options.comments ?? COMMENTS).map((row) => ({
            ...row,
            issue_id: row.issue_id === BEAD ? id : row.issue_id,
          })),
        ),
      );
    throw new Error(`unexpected command: ${line}`);
  };
  return { runner, calls };
}

function pack(
  fake: Fake,
  root: string,
  options: {
    maxBytes?: number;
    secretPolicy?: "reject" | "redact";
    source?: string;
  } = {},
): Promise<ContextPack> {
  return prepareCouncilContext({
    kind: "bead",
    source: options.source ?? BEAD,
    workspaceRoot: root,
    secretPolicy: options.secretPolicy ?? "reject",
    maxBytes: options.maxBytes,
    runner: fake.runner,
  });
}

function evidenceTitled(packed: ContextPack, fragment: string) {
  const item = packed.evidence.find((entry) => entry.title.includes(fragment));
  if (!item) throw new Error(`no evidence titled ${fragment}`);
  return item;
}

describe("a bead as a council source", () => {
  test("a bead with no pull request packs its acceptance criteria first, then its comments newest first, from two read-only reads", async () => {
    const fake = fakeRunner();
    const packed = await pack(fake, workspace());

    expect(packed.source.kind).toBe("bead");
    expect(packed.source.locator).toBe(BEAD);
    expect(packed.source.displayName).toBe(
      `${BEAD}: Teach the kiln to report its temperature`,
    );

    const first = packed.evidence[0];
    expect(first?.id).toBe("E1");
    expect(first?.title).toContain("acceptance criteria");
    expect(first?.content).toBe(
      [
        `Bead: ${BEAD}`,
        "Title: Teach the kiln to report its temperature",
        "Type: task",
        "Priority: P2",
        "Status: in_progress",
        "Labels: kiln, telemetry",
        `Depends on: ${EPIC} (parent-child), demo-harness-zz9 (blocks)`,
        "",
        "Acceptance criteria:",
        "[ ] kiln.test.ts covers a cold start.",
        "[ ] The reading is in Celsius.",
      ].join("\n"),
    );

    const comments = evidenceTitled(packed, "latest comments");
    expect(comments.id).toBe("E2");
    expect(comments.content).toBe(
      [
        "[2031-01-05T09:30:00Z]\nreview: PASS, 0 blocker, 0 high.",
        "[2031-01-04T11:00:00Z]\ndesign: readings are averaged over 5 s.",
        "[2031-01-03T10:00:00Z]\nworklog: sensor wired to the bench rig.",
      ].join("\n\n"),
    );

    expect(packed.truncated).toBe(false);
    expect(packed.redactions).toEqual([]);
    expect(fake.calls).toEqual([
      ["bd", "--readonly", "show", BEAD, "--json"],
      ["bd", "--readonly", "comments", BEAD, "--json"],
    ]);
  });

  test("the description, design and notes follow the comments as one part", async () => {
    const fake = fakeRunner({
      issue: issue({
        design: "Average over a 5 s window.",
        notes: "Bench rig only; the field unit differs.",
      }),
    });
    const packed = await pack(fake, workspace());
    const description = evidenceTitled(packed, "description");
    expect(description.id).toBe("E3");
    expect(description.content).toBe(
      [
        "Description:\nThe kiln runs blind today. Report a reading every minute.",
        "Design:\nAverage over a 5 s window.",
        "Notes:\nBench rig only; the field unit differs.",
      ].join("\n\n"),
    );
    const sizes = packed.evidence.map((item) =>
      Buffer.byteLength(item.content, "utf8"),
    );
    expect(listingOf(packed)).toEqual([
      `E1 acceptance criteria: ${sizes[0]} bytes`,
      `E2 latest comments: 3 comments, ${sizes[1]} bytes`,
      `E3 description: ${sizes[2]} bytes`,
    ]);
  });

  test("a hostile id is refused before any command runs", async () => {
    const hostile = [
      "--help",
      "-x",
      "a b",
      "$(id)",
      "../x",
      "",
      "   ",
      "x".repeat(122),
      "id;rm",
      "id\n--json",
      "id|more",
      "`id`",
    ];
    for (const source of hostile) {
      const fake = fakeRunner();
      const attempt = prepareCouncilContext({
        kind: "bead",
        source,
        workspaceRoot: workspace(),
        secretPolicy: "reject",
        runner: fake.runner,
      });
      await expect(attempt).rejects.toThrow("Beads issue id");
      expect({ source, calls: fake.calls }).toEqual({ source, calls: [] });
    }
  });

  test("a partial id that bd resolves to another issue is refused, and nothing more is read", async () => {
    const fake = fakeRunner({
      extra: (command) =>
        command.join(" ") === "bd --readonly show ab12.3 --json"
          ? ok(JSON.stringify([issue()]))
          : undefined,
    });
    const attempt = prepareCouncilContext({
      kind: "bead",
      source: "ab12.3",
      workspaceRoot: workspace(),
      secretPolicy: "reject",
      runner: fake.runner,
    });
    await expect(attempt).rejects.toThrow("name the bead by its full id");
    expect(fake.calls).toEqual([
      ["bd", "--readonly", "show", "ab12.3", "--json"],
    ]);
  });

  test("only the listed fields are packed: no owner, assignee, comment author, close reason, unknown field, or anything of a dependency but its id and type", async () => {
    const fake = fakeRunner({
      issue: issue({
        close_reason: "PRIVATE-CLOSE-REASON",
        external_ref: "PRIVATE-EXTERNAL-REF",
        spec_id: "PRIVATE-SPEC-ID",
        a_field_added_later: "PRIVATE-NEW-FIELD",
      }),
    });
    const everything = JSON.stringify(await pack(fake, workspace()));
    for (const leaked of [
      "PRIVATE-",
      "ada@example.invalid",
      "Ada Example",
      "2031-01-02T08:00:00Z",
    ])
      expect(everything).not.toContain(leaked);
  });

  test("comments of another issue and empty comments are dropped", async () => {
    const fake = fakeRunner({
      comments: [
        comment("2031-01-03T10:00:00Z", "kept: the only real comment."),
        comment("2031-01-04T10:00:00Z", "OTHER-ISSUE-COMMENT", {
          issue_id: "demo-harness-zz9",
        }),
        comment("2031-01-05T10:00:00Z", "   "),
      ],
    });
    const packed = await pack(fake, workspace());
    expect(evidenceTitled(packed, "latest comments").content).toBe(
      "[2031-01-03T10:00:00Z]\nkept: the only real comment.",
    );
    expect(JSON.stringify(packed)).not.toContain("OTHER-ISSUE-COMMENT");
  });

  test("a bead with no comments and no description says so in the listing", async () => {
    const fake = fakeRunner({
      issue: issue({ description: "" }),
      comments: [],
    });
    const packed = await pack(fake, workspace());
    expect(packed.evidence.map((item) => item.id)).toEqual(["E1"]);
    expect(listingOf(packed).slice(1)).toEqual([
      "latest comments: none",
      "description: none",
    ]);
  });

  test("bd failing, or printing something that is not the issue, is an error that leaks nothing from its output", async () => {
    const failing: Array<[string, CommandResult, string]> = [
      [
        "show",
        {
          exitCode: 1,
          stdout: '{"error":"no issues found matching the provided IDs"}',
          stderr: `Error fetching ${BEAD}: token ${SECRET}`,
        },
        "bd --readonly show failed (1)",
      ],
      ["show", ok(`not json ${SECRET}`), "bd printed no readable issue"],
      ["show", ok("[]"), "bd printed no readable issue"],
      [
        "comments",
        { exitCode: 1, stdout: "", stderr: "database is locked" },
        "bd --readonly comments failed (1)",
      ],
      ["comments", ok('{"error":"nope"}'), "bd printed no readable comments"],
    ];
    for (const [subcommand, result, expected] of failing) {
      const fake = fakeRunner({
        extra: (command) => (command[2] === subcommand ? result : undefined),
      });
      let message = "";
      try {
        await pack(fake, workspace());
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect({ subcommand, message }).toEqual({
        subcommand,
        message: expect.stringContaining(expected),
      });
      expect(message).not.toContain(SECRET);
    }
  });

  test("a secret in a comment refuses the bead, naming that comment; in the title or the acceptance criteria, naming that part", async () => {
    const cases: Array<[Parameters<typeof fakeRunner>[0], string]> = [
      [
        {
          comments: [
            ...COMMENTS,
            comment("2031-01-04T12:00:00Z", `worklog: key is ${SECRET}`),
          ],
        },
        "the comment of 2031-01-04T12:00:00Z",
      ],
      [{ issue: issue({ title: `Rotate ${SECRET}` }) }, "acceptance criteria"],
      [
        { issue: issue({ acceptance_criteria: `[ ] uses ${SECRET}` }) },
        "acceptance criteria",
      ],
      [{ issue: issue({ notes: `token ${SECRET}` }) }, "description"],
    ];
    for (const [arranged, where] of cases) {
      let message = "";
      try {
        await pack(fakeRunner(arranged), workspace());
      } catch (error) {
        expect(error).toBeInstanceOf(ContextSecurityError);
        message = error instanceof Error ? error.message : "";
      }
      expect({ where, message }).toEqual({
        where,
        message: expect.stringContaining(
          `potential secrets detected in ${where}`,
        ),
      });
      expect(message).not.toContain(SECRET);
    }
  });

  test("with the redact policy a secret in a comment is replaced and counted, and the bead still packs", async () => {
    const fake = fakeRunner({
      comments: [comment("2031-01-04T12:00:00Z", `key is ${SECRET}`)],
    });
    const packed = await pack(fake, workspace(), { secretPolicy: "redact" });
    expect(JSON.stringify(packed)).not.toContain(SECRET);
    expect(packed.redactions).toEqual([
      { kind: "anthropic-api-key", count: 1 },
    ]);
    expect(evidenceTitled(packed, "latest comments").content).toContain(
      "key is [REDACTED:anthropic-api-key]",
    );
  });
});

/** A forge run's state file, as `forge:phase-gate --write` leaves it. */
function runState(slug: string, fields: Json): [string, string] {
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

/** A directory link: a junction on Windows, where a file link needs a privilege. */
function linkDirectory(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("a bead's linked plan, research and report", () => {
  test("the bead's forge run supplies its plan, research and report, in that order after the description; a missing one is a note, not an error", async () => {
    const root = workspace(
      Object.fromEntries([
        runState("kiln-temp", { beadId: BEAD, epic: EPIC }),
        ["plans/drafts/kiln-temp.md", "# Plan\nWire the sensor first."],
        ["plans/research/kiln-temp.md", "# Research\nThe rig reads in Kelvin."],
      ]),
    );
    const fake = fakeRunner();
    const packed = await pack(fake, root);

    expect(packed.evidence.map((item) => item.title)).toEqual([
      `bead ${BEAD}: acceptance criteria`,
      `bead ${BEAD}: latest comments, newest first`,
      `bead ${BEAD}: description`,
      "linked plan plans/drafts/kiln-temp.md",
      "linked research plans/research/kiln-temp.md",
    ]);
    expect(packed.evidence[3]?.content).toBe("# Plan\nWire the sensor first.");
    expect(packed.evidence[4]?.content).toBe(
      "# Research\nThe rig reads in Kelvin.",
    );
    expect(listingOf(packed).slice(3)).toEqual([
      "E4 linked plan plans/drafts/kiln-temp.md: 29 bytes",
      "E5 linked research plans/research/kiln-temp.md: 35 bytes",
      "linked report reports/kiln-temp-ship.md: missing, not packed",
    ]);
    expect(packed.truncated).toBe(false);
    expect(packed.source.metadata?.forgeRun).toBe("kiln-temp");
    // Still only the two bead reads: files come from disk, not from a command.
    expect(fake.calls).toHaveLength(2);
  });

  test("a run that works another bead is never used, even under the same epic; a run with no bead of its own counts through its epic; the newest run wins", async () => {
    const files = Object.fromEntries([
      runState("sibling", { beadId: "demo-harness-ab12.9", epic: EPIC }),
      ["plans/drafts/sibling.md", "SIBLING-PLAN"],
      runState("epic-old", {
        epic: EPIC,
        updatedAt: "2031-01-01T00:00:00.000Z",
      }),
      ["plans/drafts/epic-old.md", "OLD-EPIC-PLAN"],
      runState("epic-new", {
        epic: EPIC,
        updatedAt: "2031-01-09T00:00:00.000Z",
      }),
      ["plans/drafts/epic-new.md", "NEW-EPIC-PLAN"],
    ]);

    // The task: no run names it, and its epic's runs are not its own.
    const task = await pack(fakeRunner(), workspace(files));
    expect(JSON.stringify(task)).not.toContain("-PLAN");
    expect(task.source.metadata?.forgeRun).toBeUndefined();

    // The epic: its own newest run, never the sibling task's.
    const epic = await pack(
      fakeRunner({ issue: issue({ id: EPIC, parent: undefined }) }),
      workspace(files),
      { source: EPIC },
    );
    const everything = JSON.stringify(epic);
    expect(everything).toContain("NEW-EPIC-PLAN");
    expect(everything).not.toContain("OLD-EPIC-PLAN");
    expect(everything).not.toContain("SIBLING-PLAN");
    expect(epic.source.metadata?.forgeRun).toBe("epic-new");
  });

  test("a run state that names something other than a plan, research or report path is refused with a note, and a broken one is ignored", async () => {
    const root = workspace(
      Object.fromEntries([
        runState("kiln-temp", {
          beadId: BEAD,
          artifacts: {
            plan: 42,
            research: "../outside/notes.md",
            ship: "reports/council-runs/r1/report.md",
          },
        }),
        ["reports/council-runs/r1/report.md", "EARLIER-COUNCIL-EVIDENCE"],
      ]),
    );
    writeFileSync(join(root, ".tmp/work/forge-runs/broken.json"), "{ not json");
    const packed = await pack(fakeRunner(), root);
    expect(JSON.stringify(packed)).not.toContain("EARLIER-COUNCIL-EVIDENCE");
    expect(listingOf(packed).slice(3)).toEqual([
      "linked research ../outside/notes.md: refused, not a plan, research or report path",
      "linked report reports/council-runs/r1/report.md: refused, not a plan, research or report path",
    ]);
  });

  test("a plan, research or report path the bead names is packed once, in order of mention; other paths are never read", async () => {
    const root = workspace({
      "docs/plans/kiln/overview.md": "OVERVIEW-TEXT",
      "plans/drafts/extra-notes.md": "EXTRA-NOTES-TEXT",
      "reports/kiln-audit.md": "AUDIT-TEXT",
      "reports/council-runs/r1/report.md": "EARLIER-COUNCIL-EVIDENCE",
      "knowledge/kiln.md": "KNOWLEDGE-TEXT",
      ".beads/notes.md": "TRACKER-TEXT",
      "src/plans/drafts/shadow.md": "SHADOW-TEXT",
      "README.md": "README-TEXT",
    });
    const fake = fakeRunner({
      issue: issue({
        description:
          "Spec: docs/plans/kiln/overview.md#readings (see also knowledge/kiln.md, README.md and src/plans/drafts/shadow.md).",
        notes:
          "Earlier run: reports/council-runs/r1/report.md, .beads/notes.md",
      }),
      comments: [
        comment(
          "2031-01-03T10:00:00Z",
          "worklog: notes in plans/drafts/extra-notes.md, audit at `reports/kiln-audit.md`.",
        ),
        comment(
          "2031-01-04T10:00:00Z",
          "design: per docs/plans/kiln/overview.md and plans/drafts/../../README.md",
        ),
      ],
    });
    const packed = await pack(fake, root);

    expect(packed.evidence.slice(3).map((item) => item.title)).toEqual([
      "linked file docs/plans/kiln/overview.md",
      "linked file plans/drafts/extra-notes.md",
      "linked file reports/kiln-audit.md",
    ]);
    const everything = JSON.stringify(packed.evidence.slice(3));
    for (const unread of [
      "EARLIER-COUNCIL-EVIDENCE",
      "KNOWLEDGE-TEXT",
      "TRACKER-TEXT",
      "SHADOW-TEXT",
      "README-TEXT",
    ])
      expect(everything).not.toContain(unread);
    expect(listingOf(packed).slice(3)).toHaveLength(3);
  });

  test("a named path that leads out of the workspace, or back in to a place that is not a plan, research or report, is refused with a note", async () => {
    const outside = workspace({ "leak.md": "OUTSIDE-TEXT" });
    const root = workspace({
      "reports/council-runs/r1/report.md": "EARLIER-COUNCIL-EVIDENCE",
      "plans/research/binary.md": "placeholder",
    });
    linkDirectory(outside, join(root, "plans", "drafts", "out"));
    linkDirectory(
      join(root, "reports", "council-runs"),
      join(root, "plans", "drafts", "runs"),
    );
    writeFileSync(
      join(root, "plans/research/binary.md"),
      Buffer.from([0x66, 0x00, 0xff, 0xfe]),
    );
    const fake = fakeRunner({
      issue: issue({
        description:
          "See plans/drafts/out/leak.md, plans/drafts/runs/r1/report.md, plans/research/binary.md and plans/drafts/gone.md",
      }),
    });
    const packed = await pack(fake, root);
    const everything = JSON.stringify(packed);
    expect(everything).not.toContain("OUTSIDE-TEXT");
    expect(everything).not.toContain("EARLIER-COUNCIL-EVIDENCE");
    expect(listingOf(packed).slice(3)).toEqual([
      "linked file plans/drafts/out/leak.md: not packed, it resolves outside the workspace",
      "linked file plans/drafts/runs/r1/report.md: refused, it resolves to a path that is not a plan, research or report",
      "linked file plans/research/binary.md: not packed, not UTF-8 text",
      "linked file plans/drafts/gone.md: missing, not packed",
    ]);
    expect(packed.truncated).toBe(false);
  });

  test("at most six linked files are packed; the rest are counted in one note", async () => {
    const names = Array.from({ length: 8 }, (_, index) => `n${index + 1}`);
    const root = workspace(
      Object.fromEntries(
        names.map((name) => [
          `plans/drafts/${name}.md`,
          `TEXT-${name.toUpperCase()}`,
        ]),
      ),
    );
    const fake = fakeRunner({
      issue: issue({
        description: names.map((name) => `plans/drafts/${name}.md`).join(" "),
      }),
    });
    const packed = await pack(fake, root);
    expect(packed.evidence.slice(3).map((item) => item.content)).toEqual([
      "TEXT-N1",
      "TEXT-N2",
      "TEXT-N3",
      "TEXT-N4",
      "TEXT-N5",
      "TEXT-N6",
    ]);
    expect(listingOf(packed).at(-1)).toBe(
      "2 more linked files: not packed (limit 6)",
    );
  });

  test("a secret in a linked file refuses the bead, naming the file", async () => {
    const root = workspace(
      Object.fromEntries([
        runState("kiln-temp", { beadId: BEAD }),
        ["plans/drafts/kiln-temp.md", `# Plan\nexport KEY=${SECRET}`],
      ]),
    );
    await expect(pack(fakeRunner(), root)).rejects.toThrow(
      "potential secrets detected in linked plan plans/drafts/kiln-temp.md",
    );
  });
});

/** The bytes a pack would really send, measured from the content itself. */
function sentBytes(packed: ContextPack): number {
  return packed.evidence.reduce(
    (sum, item) => sum + Buffer.byteLength(item.content, "utf8"),
    0,
  );
}

function listingOf(packed: ContextPack): string[] {
  const parts = packed.source.metadata?.parts;
  if (!Array.isArray(parts)) throw new Error("the pack has no listing");
  return parts;
}

function fromParts(parts: ContextPart[], maxBytes?: number): ContextPack {
  return buildContextPackFromParts({
    kind: "bead",
    displayName: "demo",
    locator: "demo",
    parts,
    maxBytes,
  });
}

describe("a pack made of parts", () => {
  const ORDERED: ContextPart[] = [
    { label: "first", chunks: [{ text: "a".repeat(30) }] },
    {
      label: "notes",
      unit: "comment",
      chunks: ["n1", "n2", "n3"].map((name) => ({
        text: name.padEnd(10, "."),
      })),
    },
    { label: "third", chunks: [{ text: "c".repeat(20) }] },
    { label: "fourth", chunks: [{ text: "d".repeat(5) }] },
    { label: "absent", chunks: [], note: "missing, not packed" },
  ];

  test("parts fill the budget in order: earlier parts are whole, a later one is cut, the last is left out, and the listing says so", () => {
    const packed = fromParts(ORDERED, 60);

    expect(packed.evidence.map((item) => item.id)).toEqual(["E1", "E2", "E3"]);
    expect(packed.evidence.map((item) => item.content)).toEqual([
      "a".repeat(30),
      "n1........\n\nn2........",
      "c".repeat(8),
    ]);
    expect(packed.evidence.map((item) => item.truncated)).toEqual([
      false,
      true,
      true,
    ]);
    expect(packed.truncated).toBe(true);
    expect(sentBytes(packed)).toBe(60);
    expect(packed.byteLength).toBe(60);
    expect(listingOf(packed)).toEqual([
      "E1 first: 30 bytes",
      "E2 notes: 2 of 3 comments, 22 bytes; 1 left out by the evidence budget",
      "E3 third: 8 of 20 bytes, cut to fit the evidence budget",
      "fourth: left out, the evidence budget is spent",
      "absent: missing, not packed",
    ]);
  });

  test("whatever the budget, the bytes sent never exceed it and every item reports its real size", () => {
    for (let maxBytes = 1; maxBytes <= 100; maxBytes += 1) {
      const packed = fromParts(ORDERED, maxBytes);
      expect({ maxBytes, sent: sentBytes(packed) <= maxBytes }).toEqual({
        maxBytes,
        sent: true,
      });
      for (const item of packed.evidence) {
        expect(item.byteLength).toBe(Buffer.byteLength(item.content, "utf8"));
        expect(item.byteLength).toBeGreaterThan(0);
      }
      expect(packed.byteLength).toBe(sentBytes(packed));
      // Everything fits from 89 bytes: 30 + 34 + 20 + 5; parts are separate items.
      expect({ maxBytes, truncated: packed.truncated }).toEqual({
        maxBytes,
        truncated: maxBytes < 89,
      });
    }
  });

  test("a part held to its ceiling is made whole again when budget is left over, and stays cut when the budget is contended", () => {
    const parts: ContextPart[] = [
      { label: "head", chunks: [{ text: "h".repeat(10) }] },
      { label: "capped", maxShare: 0.1, chunks: [{ text: "m".repeat(50) }] },
      { label: "tail", chunks: [{ text: "t".repeat(20) }] },
    ];

    const roomy = fromParts(parts, 100);
    expect(roomy.truncated).toBe(false);
    expect(roomy.evidence.map((item) => item.byteLength)).toEqual([10, 50, 20]);

    // 60 bytes: the ceiling gives the capped part 6, the tail its 20, and the
    // 24 left over go back to the capped part.
    const contended = fromParts(parts, 60);
    expect(contended.evidence.map((item) => item.byteLength)).toEqual([
      10, 30, 20,
    ]);
    expect(contended.evidence.map((item) => item.truncated)).toEqual([
      false,
      true,
      false,
    ]);
    expect(contended.truncated).toBe(true);
    expect(listingOf(contended)[1]).toBe(
      "E2 capped: 30 of 50 bytes, cut to fit the evidence budget",
    );
  });

  /** Why a pack was refused, or "" when it was built. */
  function refusal(build: () => unknown): string {
    try {
      build();
      return "";
    } catch (error) {
      if (!(error instanceof ContextSecurityError)) throw error;
      return error.message;
    }
  }

  test("a secret in any chunk refuses the pack, naming the chunk and never the match, even in a part the budget would drop", () => {
    const parts = (where: "first" | "last"): ContextPart[] => [
      {
        label: "head",
        chunks: [{ text: where === "first" ? `key ${SECRET}` : "fine" }],
      },
      {
        label: "notes",
        unit: "comment",
        chunks: [
          { text: "fine", name: "the note of Monday" },
          {
            text: where === "last" ? `token:${SECRET}` : "fine",
            name: "the note of Tuesday",
          },
        ],
      },
    ];

    const inHead = refusal(() => fromParts(parts("first")));
    expect(inHead).toContain("potential secrets detected in head");
    expect(inHead).not.toContain(SECRET);

    // 4 bytes hold only the head: the note that carries the key would be dropped.
    const dropped = refusal(() => fromParts(parts("last"), 4));
    expect(dropped).toContain(
      "potential secrets detected in the note of Tuesday",
    );
    expect(dropped).toContain("context was not sent");
    expect(dropped).not.toContain(SECRET);
  });

  test("with the redact policy the secret is replaced, counted and absent from the whole pack", () => {
    const packed = buildContextPackFromParts({
      kind: "bead",
      displayName: "demo",
      locator: "demo",
      secretPolicy: "redact",
      parts: [
        { label: "head", chunks: [{ text: `key ${SECRET} end` }] },
        { label: "tail", chunks: [{ text: `again ${SECRET}` }] },
      ],
    });
    expect(JSON.stringify(packed)).not.toContain(SECRET);
    expect(packed.evidence[0]?.content).toContain("key ");
    expect(packed.evidence[0]?.content).toContain(" end");
    expect(packed.redactions).toEqual([
      { kind: "anthropic-api-key", count: 2 },
    ]);
  });

  test("the source name, the locator, the metadata, a title and a listing line are scanned too, each refusal naming where", () => {
    const base = {
      kind: "bead" as const,
      displayName: "demo",
      locator: "demo",
      parts: [{ label: "head", chunks: [{ text: "fine" }] }],
    };
    const cases: Array<[string, () => unknown]> = [
      [
        "the source name",
        () => buildContextPackFromParts({ ...base, displayName: SECRET }),
      ],
      [
        "the source locator",
        () => buildContextPackFromParts({ ...base, locator: SECRET }),
      ],
      [
        "the source metadata",
        () =>
          buildContextPackFromParts({ ...base, metadata: { note: SECRET } }),
      ],
      [
        "an evidence title",
        () =>
          buildContextPackFromParts({
            ...base,
            parts: [
              { label: "head", title: SECRET, chunks: [{ text: "fine" }] },
            ],
          }),
      ],
      [
        "the evidence listing",
        () =>
          buildContextPackFromParts({
            ...base,
            parts: [
              ...base.parts,
              { label: `reference ${SECRET}`, chunks: [], note: "not fetched" },
            ],
          }),
      ],
    ];
    for (const [where, build] of cases) {
      const message = refusal(build);
      expect({ where, message }).toEqual({
        where,
        message: expect.stringContaining(
          `potential secrets detected in ${where}`,
        ),
      });
      expect(message).not.toContain(SECRET);
    }
  });

  test("labels are scanned before they are cut: a key that straddles the title limit leaves no prefix behind", () => {
    const packed = buildContextPackFromParts({
      kind: "bead",
      displayName: `${"n".repeat(190)} ${SECRET}`,
      locator: "demo",
      secretPolicy: "redact",
      parts: [
        {
          label: `${"l".repeat(290)} ${SECRET}`,
          title: `${"t".repeat(190)} ${SECRET}`,
          chunks: [{ text: "fine" }],
        },
      ],
    });
    const everything = JSON.stringify(packed);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(SECRET.slice(0, 9));
    expect(packed.source.displayName.length).toBeLessThanOrEqual(200);
    expect(packed.evidence[0]?.title.length).toBeLessThanOrEqual(200);
    expect(listingOf(packed)[0]?.length).toBeLessThanOrEqual(300);
  });
});

const ORIGIN = "https://github.com/demo-org/kiln-works.git";
const prUrl = (number: number): string =>
  `https://github.com/demo-org/kiln-works/pull/${number}`;

const PATCH = [
  "diff --git a/src/kiln.ts b/src/kiln.ts",
  "--- a/src/kiln.ts",
  "+++ b/src/kiln.ts",
  "@@ -0,0 +1 @@",
  "+export const celsius = true;",
  "",
].join("\n");

/**
 * Answers for the origin and for one pull request. `origin: null` makes the
 * remote lookup fail; `view`/`diff` replace what `gh` prints.
 */
function withPullRequest(
  options: {
    origin?: string | null;
    patch?: string;
    view?: CommandResult;
  } = {},
): (command: string[]) => CommandResult | undefined {
  return (command) => {
    const line = command.join(" ");
    if (line === "git remote get-url origin")
      return options.origin === null
        ? { exitCode: 2, stdout: "", stderr: "error: No such remote 'origin'" }
        : ok(`${options.origin ?? ORIGIN}\n`);
    if (command[0] !== "gh") return undefined;
    const url = command[3] ?? "";
    const number = Number(url.slice(url.lastIndexOf("/") + 1));
    if (command[2] === "view")
      return (
        options.view ??
        ok(
          JSON.stringify({
            number,
            url,
            title: "Report the kiln temperature",
            // Names another bead: a bead source must not go and read it.
            body: `Reads the sensor.\n\nRefs: ${BEAD}, demo-harness-zz9`,
            baseRefName: "main",
            baseRefOid: "base000",
            headRefName: "kiln-temp",
            headRefOid: "head111",
            additions: 1,
            deletions: 0,
            changedFiles: 1,
            files: [{ path: "src/kiln.ts", additions: 1, deletions: 0 }],
          }),
        )
      );
    if (command[2] === "diff") return ok(options.patch ?? PATCH);
    return undefined;
  };
}

const ghCalls = (fake: Fake): string[][] =>
  fake.calls.filter((call) => call[0] === "gh");

describe("a bead's pull request", () => {
  test("a comment carrying this repository's pull request URL packs that PR last, through gh with a rebuilt URL, and reads no other bead", async () => {
    const fake = fakeRunner({
      comments: [
        ...COMMENTS,
        comment("2031-01-06T10:00:00Z", `worklog: opened ${prUrl(12)}`),
      ],
      extra: withPullRequest(),
    });
    const packed = await pack(fake, workspace());

    const last = packed.evidence.at(-1);
    expect(last?.id).toBe("E4");
    expect(last?.title).toBe("PR #12: Report the kiln temperature");
    expect(last?.content).toContain("Pull request #12");
    expect(last?.content).toContain("+export const celsius = true;");
    expect(last?.content).toContain("(not looked up for this source)");
    expect(listingOf(packed).at(-1)).toBe(
      `E4 pull request #12: ${last?.byteLength} bytes`,
    );
    expect(packed.source.metadata?.pullRequest).toBe(prUrl(12));
    expect(packed.truncated).toBe(false);

    expect(fake.calls.map((call) => call.slice(0, 4).join(" "))).toEqual([
      `bd --readonly show ${BEAD}`,
      `bd --readonly comments ${BEAD}`,
      "git remote get-url origin",
      `gh pr view ${prUrl(12)}`,
      `gh pr diff ${prUrl(12)}`,
      `gh pr view ${prUrl(12)}`,
    ]);
  });

  test("with several pull request URLs the most recent mention is packed and the others are named; a comment counts as later than a field", async () => {
    const fake = fakeRunner({
      issue: issue({
        description: `First try: ${prUrl(3)}.`,
        // Notes are a field: mentioned "before" every comment, whatever they say.
        notes: `Superseded by ${prUrl(20)}`,
      }),
      comments: [
        comment(
          "2031-01-03T10:00:00Z",
          `worklog: reopened as ${prUrl(7)}, then`,
        ),
        comment(
          "2031-01-06T10:00:00Z",
          `review: see [the PR](${prUrl(9)}). Earlier: <${prUrl(7)}> (and ${prUrl(9)}/files).`,
        ),
      ],
      extra: withPullRequest(),
    });
    const packed = await pack(fake, workspace());

    expect(packed.evidence.at(-1)?.title).toContain("PR #9:");
    expect(new Set(ghCalls(fake).map((call) => call[3]))).toEqual(
      new Set([prUrl(9)]),
    );
    expect(listingOf(packed).slice(-4)).toEqual([
      `E4 pull request #9: ${packed.evidence.at(-1)?.byteLength} bytes`,
      "pull request #3: named, not packed (a later mention was packed)",
      "pull request #20: named, not packed (a later mention was packed)",
      "pull request #7: named, not packed (a later mention was packed)",
    ]);
  });

  test("the same pull request written with a longer path, a query, another case or the default port is still that pull request", async () => {
    const variants = [
      `${prUrl(12)}/files`,
      `${prUrl(12)}?diff=split#discussion_r1`,
      "https://GitHub.com/Demo-Org/Kiln-Works/pull/12",
      "https://github.com:443/demo-org/kiln-works/pull/12/commits/abc",
    ];
    for (const variant of variants) {
      const fake = fakeRunner({
        comments: [comment("2031-01-06T10:00:00Z", `see ${variant}`)],
        extra: withPullRequest(),
      });
      const packed = await pack(fake, workspace());
      expect({
        variant,
        fetched: ghCalls(fake).map((call) => call[3]),
      }).toEqual({ variant, fetched: [prUrl(12), prUrl(12), prUrl(12)] });
      expect(packed.evidence.at(-1)?.title).toContain("PR #12:");
    }
  });

  test("a URL that is not this repository's pull request is never fetched: it is named as a reference, without credentials or query", async () => {
    const foreign: Array<[string, string]> = [
      [
        "https://github.com/other-org/kiln-works/pull/1",
        "https://github.com/other-org/kiln-works/pull/1",
      ],
      [
        "https://github.com/demo-org/other-repo/pull/1",
        "https://github.com/demo-org/other-repo/pull/1",
      ],
      [
        "https://github.com.evil.example/demo-org/kiln-works/pull/1",
        "https://github.com.evil.example/demo-org/kiln-works/pull/1",
      ],
      [
        "https://evil.example/github.com/demo-org/kiln-works/pull/1",
        "https://evil.example/github.com/demo-org/kiln-works/pull/1",
      ],
      [
        "https://someone:PRIVATE-PASSWORD@github.com/demo-org/kiln-works/pull/1?token=PRIVATE-QUERY",
        "https://github.com/demo-org/kiln-works/pull/1",
      ],
      [
        "https://github.com:8443/demo-org/kiln-works/pull/1",
        "https://github.com:8443/demo-org/kiln-works/pull/1",
      ],
      [
        "http://github.com/demo-org/kiln-works/pull/1",
        "http://github.com/demo-org/kiln-works/pull/1",
      ],
      [
        "https://github.com/demo-org/kiln-works/pull/1/../../../../other-org/x/pull/2",
        "https://github.com/other-org/x/pull/2",
      ],
      [
        "https://github.com/demo-org/kiln-works.evil/pull/1",
        "https://github.com/demo-org/kiln-works.evil/pull/1",
      ],
      [
        "https://github.com/demo-org/kiln-works/pull/0",
        "https://github.com/demo-org/kiln-works/pull/0",
      ],
    ];
    for (const [mention, shown] of foreign) {
      const fake = fakeRunner({
        comments: [comment("2031-01-06T10:00:00Z", `see ${mention} please`)],
        extra: withPullRequest(),
      });
      const packed = await pack(fake, workspace());
      expect({ mention, gh: ghCalls(fake) }).toEqual({ mention, gh: [] });
      expect({ mention, last: listingOf(packed).at(-1) }).toEqual({
        mention,
        last: `reference ${shown}: not fetched, not this workspace's origin repository`,
      });
      const listing = JSON.stringify(packed.source);
      expect(listing).not.toContain("PRIVATE-PASSWORD");
      expect(listing).not.toContain("PRIVATE-QUERY");
      expect(packed.source.metadata?.pullRequest).toBeUndefined();
    }
  });

  test("a bead that mentions no pull request never asks for the origin; one that mentions only something else PR-like does not either", async () => {
    const fake = fakeRunner({
      comments: [
        comment(
          "2031-01-06T10:00:00Z",
          "see https://github.com/demo-org/kiln-works/pulls and https://github.com/demo-org/kiln-works/issues/4",
        ),
      ],
      extra: withPullRequest(),
    });
    const packed = await pack(fake, workspace());
    expect(fake.calls).toHaveLength(2);
    expect(listingOf(packed)).toHaveLength(3);
  });

  test("the origin is understood in its https, scp-style and ssh forms, and its credentials never leave the parser", async () => {
    const origins = [
      "https://github.com/demo-org/kiln-works.git",
      "https://github.com/demo-org/kiln-works",
      "git@github.com:demo-org/kiln-works.git",
      "ssh://git@github.com/demo-org/kiln-works.git",
      "ssh://git@github.com:22/demo-org/kiln-works",
      "https://oauth-user:PRIVATE-ORIGIN-TOKEN@github.com/demo-org/kiln-works.git",
      "https://GitHub.com/Demo-Org/Kiln-Works.git",
    ];
    for (const origin of origins) {
      const fake = fakeRunner({
        comments: [comment("2031-01-06T10:00:00Z", `see ${prUrl(12)}`)],
        extra: withPullRequest({ origin }),
      });
      const packed = await pack(fake, workspace());
      const fetched = ghCalls(fake).map((call) => call[3]?.toLowerCase());
      expect({ origin, fetched }).toEqual({
        origin,
        fetched: [prUrl(12), prUrl(12), prUrl(12)],
      });
      const everything = JSON.stringify(packed);
      expect(everything).not.toContain("PRIVATE-ORIGIN-TOKEN");
      expect(everything).not.toContain("oauth-user");
    }
  });

  test("with no origin, or one that cannot be read as host/owner/repository, no pull request is fetched and the listing says why without echoing the origin", async () => {
    const unreadable: Array<string | null> = [
      null,
      "",
      "C:/repos/PRIVATE-ORIGIN-PATH",
      "/srv/git/PRIVATE-ORIGIN-PATH.git",
      "file:///repos/PRIVATE-ORIGIN-PATH",
      "git://github.com/demo-org/kiln-works.git",
      "https://PRIVATE-ORIGIN-TOKEN@github.com:8443/demo-org/kiln-works.git",
      "https://github.com/demo-org/kiln-works/PRIVATE-ORIGIN-PATH",
      "https://github.com/kiln-works.git",
      "localhost:demo-org/kiln-works.git",
    ];
    for (const origin of unreadable) {
      const fake = fakeRunner({
        comments: [comment("2031-01-06T10:00:00Z", `see ${prUrl(12)}`)],
        extra: withPullRequest({ origin }),
      });
      const packed = await pack(fake, workspace());
      expect({ origin, gh: ghCalls(fake) }).toEqual({ origin, gh: [] });
      expect({ origin, last: listingOf(packed).at(-1) }).toEqual({
        origin,
        last: `reference ${prUrl(12)}: not fetched, the origin repository could not be read`,
      });
      expect(JSON.stringify(packed)).not.toContain("PRIVATE-ORIGIN");
      expect(packed.truncated).toBe(false);
    }
  });

  test("a pull request that cannot be captured is a note and an incomplete pack, not an error, and nothing from gh's output leaks", async () => {
    const fake = fakeRunner({
      comments: [comment("2031-01-06T10:00:00Z", `see ${prUrl(12)}`)],
      extra: withPullRequest({
        view: {
          exitCode: 1,
          stdout: "",
          stderr: `HTTP 401: bad credentials ${SECRET}`,
        },
      }),
    });
    const packed = await pack(fake, workspace());
    const last = listingOf(packed).at(-1) ?? "";
    expect(last).toStartWith(
      "pull request #12: not packed, capture failed (gh pr view failed (1)",
    );
    expect(JSON.stringify(packed)).not.toContain(SECRET);
    expect(packed.truncated).toBe(true);
    expect(packed.evidence).toHaveLength(3);
    expect(packed.source.metadata?.pullRequest).toBeUndefined();
  });

  test("a secret in the pull request's patch refuses the bead, naming the pull request; with the redact policy it is replaced and counted", async () => {
    const leaky = `${PATCH}+const key = "${SECRET}";\n`;
    const arrange = () =>
      fakeRunner({
        comments: [comment("2031-01-06T10:00:00Z", `see ${prUrl(12)}`)],
        extra: withPullRequest({ patch: leaky }),
      });

    let message = "";
    try {
      await pack(arrange(), workspace());
    } catch (error) {
      expect(error).toBeInstanceOf(ContextSecurityError);
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain(
      "potential secrets detected in pull request #12; context was not sent",
    );
    expect(message).not.toContain(SECRET);

    const packed = await pack(arrange(), workspace(), {
      secretPolicy: "redact",
    });
    expect(JSON.stringify(packed)).not.toContain(SECRET);
    expect(packed.redactions).toEqual([
      { kind: "anthropic-api-key", count: 1 },
    ]);
    expect(packed.evidence.at(-1)?.content).toContain(
      "[REDACTED:anthropic-api-key]",
    );
  });

  test("a secret that reaches only a listing line refuses the bead, naming the evidence listing", async () => {
    const fake = fakeRunner({
      // The external reference is not packed; its URL only becomes a reference line.
      issue: issue({
        external_ref: `https://tracker.example/team/repo/pull/8/${SECRET}`,
      }),
      extra: withPullRequest(),
    });
    await expect(pack(fake, workspace())).rejects.toThrow(
      "potential secrets detected in the evidence listing",
    );
  });

  test("at most ten pull request references are listed; the rest are counted", async () => {
    const mentions = Array.from(
      { length: 13 },
      (_, index) => `https://github.com/other-org/repo-${index + 1}/pull/1`,
    );
    const fake = fakeRunner({
      comments: [comment("2031-01-06T10:00:00Z", mentions.join(" "))],
      extra: withPullRequest(),
    });
    const listing = listingOf(await pack(fake, workspace()));
    expect(
      listing.filter((line) => line.startsWith("reference ")),
    ).toHaveLength(10);
    expect(listing.at(-1)).toBe(
      "3 more pull request references: not listed (limit 10)",
    );
  });
});

describe("a bead under the evidence budget", () => {
  /** A bead with every part: criteria, five comments, description, a plan and a pull request. */
  function fullBead(): { fake: Fake; root: string } {
    const root = workspace(
      Object.fromEntries([
        runState("kiln-temp", { beadId: BEAD }),
        ["plans/drafts/kiln-temp.md", `# Plan\n${"plan line\n".repeat(60)}`],
      ]),
    );
    const fake = fakeRunner({
      issue: issue({ description: "d".repeat(400) }),
      comments: [1, 2, 3, 4, 5].map((day) =>
        comment(
          `2031-01-0${day}T10:00:00Z`,
          `worklog day ${day}: ${"x".repeat(80)}`,
        ),
      ),
      extra: withPullRequest(),
    });
    // The newest comment is the one that names the pull request.
    fake.runner = ((inner) => async (command, cwd) => {
      const result = await inner(command, cwd);
      if (command.join(" ") !== `bd --readonly comments ${BEAD} --json`)
        return result;
      const rows = JSON.parse(result.stdout) as Json[];
      rows.push(
        comment("2031-01-06T10:00:00Z", `worklog: opened ${prUrl(12)}`),
      );
      return ok(JSON.stringify(rows));
    })(fake.runner);
    return { fake, root };
  }

  test("with room for everything, every part is packed whole in the ruled order", async () => {
    const { fake, root } = fullBead();
    const packed = await pack(fake, root);
    expect(packed.truncated).toBe(false);
    expect(packed.evidence.map((item) => item.title)).toEqual([
      `bead ${BEAD}: acceptance criteria`,
      `bead ${BEAD}: latest comments, newest first`,
      `bead ${BEAD}: description`,
      "linked plan plans/drafts/kiln-temp.md",
      "PR #12: Report the kiln temperature",
    ]);
  });

  test("when the budget is short, the acceptance criteria and the latest comments survive first: older comments, then the description, the plan and the pull request give way", async () => {
    const { fake, root } = fullBead();
    const whole = await pack(fake, root);
    const criteria = whole.evidence[0]?.byteLength ?? 0;
    const newestTwo =
      Buffer.byteLength(
        "[2031-01-06T10:00:00Z]\nworklog: opened https://github.com/demo-org/kiln-works/pull/12",
        "utf8",
      ) +
      2 +
      Buffer.byteLength(
        `[2031-01-05T10:00:00Z]\nworklog day 5: ${"x".repeat(80)}`,
        "utf8",
      );

    // Room for the criteria, the two newest comments and 20 bytes more.
    const again = fullBead();
    const packed = await pack(again.fake, again.root, {
      maxBytes: criteria + newestTwo + 20,
    });

    expect(packed.truncated).toBe(true);
    expect(sentBytes(packed)).toBeLessThanOrEqual(criteria + newestTwo + 20);
    expect(packed.evidence[0]?.content).toBe(whole.evidence[0]?.content);
    expect(packed.evidence[0]?.truncated).toBe(false);
    expect(packed.evidence[1]?.content).toBe(
      [
        "[2031-01-06T10:00:00Z]\nworklog: opened https://github.com/demo-org/kiln-works/pull/12",
        `[2031-01-05T10:00:00Z]\nworklog day 5: ${"x".repeat(80)}`,
      ].join("\n\n"),
    );
    expect(packed.evidence[1]?.truncated).toBe(true);
    const listing = listingOf(packed);
    expect(listing[1]).toContain(
      "2 of 6 comments, " +
        `${newestTwo} bytes; 4 left out by the evidence budget`,
    );
    // The 20 spare bytes went to the next part in line, the description, cut.
    expect(packed.evidence[2]?.title).toBe(`bead ${BEAD}: description`);
    expect(packed.evidence[2]?.byteLength).toBeLessThanOrEqual(20);
    expect(packed.evidence).toHaveLength(3);
    expect(listing.slice(3)).toEqual([
      "linked plan plans/drafts/kiln-temp.md: left out, the evidence budget is spent",
      "linked research plans/research/kiln-temp.md: missing, not packed",
      "linked report reports/kiln-temp-ship.md: missing, not packed",
      "pull request #12: left out, the evidence budget is spent",
    ]);
  });

  test("with room for the criteria alone, the criteria are whole and everything else is left out or cut", async () => {
    const { fake, root } = fullBead();
    const criteria = (await pack(fake, root)).evidence[0]?.byteLength ?? 0;
    const again = fullBead();
    const packed = await pack(again.fake, again.root, { maxBytes: criteria });
    expect(packed.evidence).toHaveLength(1);
    expect(packed.evidence[0]?.title).toBe(`bead ${BEAD}: acceptance criteria`);
    expect(packed.evidence[0]?.content).toContain("Acceptance criteria:\n[ ]");
    expect(packed.evidence[0]?.truncated).toBe(false);
    expect(packed.truncated).toBe(true);
    expect(sentBytes(packed)).toBe(criteria);
  });

  test("a pull request whose patch is larger than the budget marks the pack incomplete even though its part is cut anyway", async () => {
    const fake = fakeRunner({
      comments: [comment("2031-01-06T10:00:00Z", `see ${prUrl(12)}`)],
      extra: withPullRequest({
        patch: `${PATCH}${"+// filler line\n".repeat(400)}`,
      }),
    });
    const packed = await pack(fake, workspace(), { maxBytes: 3000 });
    expect(packed.truncated).toBe(true);
    expect(sentBytes(packed)).toBeLessThanOrEqual(3000);
    expect(packed.evidence.at(-1)?.title).toContain("PR #12:");
    expect(packed.evidence.at(-1)?.truncated).toBe(true);
  });

  test("an oversized bead stays inside the budget with its acceptance criteria intact", async () => {
    const fake = fakeRunner({
      issue: issue({ description: "D".repeat(3_000_000) }),
      comments: Array.from({ length: 2000 }, (_, index) =>
        comment(
          new Date(Date.UTC(2031, 0, 1, 0, index)).toISOString(),
          `comment ${index} ${"y".repeat(500)}`,
        ),
      ),
    });
    const packed = await pack(fake, workspace(), { maxBytes: 50_000 });
    expect(sentBytes(packed)).toBeLessThanOrEqual(50_000);
    expect(packed.byteLength).toBe(sentBytes(packed));
    expect(packed.evidence[0]?.truncated).toBe(false);
    expect(packed.evidence[0]?.content).toContain("Acceptance criteria:");
    // Comments come before the description: they took whole comments, newest
    // first, and the description got only the slack after the last whole one.
    expect(packed.evidence[1]?.content).toStartWith(
      "[2031-01-02T09:19:00.000Z]\ncomment 1999 ",
    );
    expect(packed.evidence[1]?.byteLength).toBeGreaterThan(45_000);
    expect(packed.evidence.map((item) => item.title).slice(2)).toEqual([
      `bead ${BEAD}: description`,
    ]);
    expect(packed.evidence[2]?.byteLength).toBeLessThan(600);
    expect(packed.truncated).toBe(true);
  });
});
