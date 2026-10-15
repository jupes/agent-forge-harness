import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EVALUATIONS_DIR } from "./eval-verdict-store";
import { SESSION_MIRROR_FILE } from "./ledger/identity";
import { resolveCheckout } from "./ledger/workspace";
import {
  EVIDENCE_DIRS,
  HARNESS_FILES,
  MAX_CHECK_TIMEOUT_SECONDS,
  type RunCheckSet,
  runCheckSet,
} from "./quality-gate-repos";
import { RUN_CORRELATIONS_DIR } from "./run-correlation";

describe("what the harness keeps in a run's checkout", () => {
  test("the evidence is the correlations and verdicts directories, and the harness's files add the session mirror the ledger writes", () => {
    expect(EVIDENCE_DIRS).toEqual([RUN_CORRELATIONS_DIR, EVALUATIONS_DIR]);
    expect(HARNESS_FILES).toEqual([...EVIDENCE_DIRS, SESSION_MIRROR_FILE]);
  });
});

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory holding `harness/` (a checkout) and whatever a test adds beside it. */
function scratch(): { root: string; harness: string } {
  const root = mkdtempSync(join(tmpdir(), "gate repos test "));
  temporary.push(root);
  const harness = join(root, "harness");
  mkdirSync(join(harness, ".git"), { recursive: true });
  return { root, harness };
}

/** A checkout of its own at `dir`. */
function checkoutAt(dir: string): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** A linked worktree of `main` at `dir`, as `git worktree add` lays one out. */
function worktreeOf(main: string, dir: string, name: string): string {
  const gitDir = join(main, ".git", "worktrees", name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
  return dir;
}

const comparable = (dir: string) => resolveCheckout(dir).worktree;

const FOO_CHECKS = [
  { name: "typecheck", argv: ["bun", "run", "typecheck"] },
  { name: "unit", argv: ["cargo", "test", "--", "a b"] },
];

/** `repos/repos.json` text with these entries. */
const registry = (...repos: unknown[]) => JSON.stringify({ repos });

/** The check set for a run, with the registry text given and the files read recorded. */
function decide(input: {
  run: string;
  gate: string;
  harness: string;
  text?: string | null;
}): { set: RunCheckSet; read: string[] } {
  const read: string[] = [];
  const set = runCheckSet({
    runCheckout: comparable(input.run),
    gateCheckout: input.gate,
    harness: input.harness,
    registry: (file) => {
      read.push(file);
      return input.text ?? null;
    },
  });
  return { set, read };
}

describe("runCheckSet: which checks a correlated run gets", () => {
  test("a run in the checkout the gate runs in gets the gate's own checks, and the registry is not read", () => {
    const { harness } = scratch();
    expect(decide({ run: harness, gate: harness, harness })).toEqual({
      set: { kind: "gate" },
      read: [],
    });
  });

  test("a run in a repository under repos/ gets the checks on its entry in repos/repos.json, to run in its checkout", () => {
    const { harness } = scratch();
    const foo = checkoutAt(join(harness, "repos", "foo"));
    const { set, read } = decide({
      run: foo,
      gate: harness,
      harness,
      text: registry(
        { name: "bar", checks: [{ name: "x", argv: ["x"] }] },
        { name: "foo", url: "u", defaultBranch: "main", checks: FOO_CHECKS },
      ),
    });
    expect(set).toEqual({
      kind: "repository",
      repository: "foo",
      checkout: comparable(foo),
      checks: FOO_CHECKS,
    });
    expect(read).toEqual([`${comparable(harness)}/repos/repos.json`]);
  });

  test("a worktree of a repository under repos/ is that repository, wherever the worktree is", () => {
    const { root, harness } = scratch();
    const foo = checkoutAt(join(harness, "repos", "foo"));
    const tree = worktreeOf(foo, join(root, "foo tree"), "foo-tree");
    const { set } = decide({
      run: tree,
      gate: harness,
      harness,
      text: registry({ name: "foo", checks: FOO_CHECKS }),
    });
    expect(set).toEqual({
      kind: "repository",
      repository: "foo",
      checkout: comparable(tree),
      checks: FOO_CHECKS,
    });
  });

  test("the gate started inside the repository's own checkout still runs the repository's checks", () => {
    const { harness } = scratch();
    const foo = checkoutAt(join(harness, "repos", "foo"));
    const { set } = decide({
      run: foo,
      gate: foo,
      harness,
      text: registry({ name: "foo", checks: FOO_CHECKS }),
    });
    expect(set.kind).toBe("repository");
  });

  test("a gate that belongs to a worktree of the harness reads repos/ and repos/repos.json in the main checkout", () => {
    const { root, harness } = scratch();
    const foo = checkoutAt(join(harness, "repos", "foo"));
    const tree = worktreeOf(harness, join(root, "harness tree"), "h");
    const { set, read } = decide({
      run: foo,
      gate: tree,
      harness: tree,
      text: registry({ name: "foo", checks: FOO_CHECKS }),
    });
    expect(set.kind).toBe("repository");
    expect(read).toEqual([`${comparable(harness)}/repos/repos.json`]);
  });

  test("a run in a checkout that is neither the gate's nor a repository under repos/ is somewhere the gate cannot judge", () => {
    const { root, harness } = scratch();
    const other = checkoutAt(join(root, "other"));
    const { set, read } = decide({ run: other, gate: harness, harness });
    expect(set).toEqual({
      kind: "elsewhere",
      reason: `the run builds in ${comparable(other)}, which is neither this checkout nor a repository under ${comparable(harness)}/repos: run the gate in that checkout`,
    });
    expect(read).toEqual([]);
  });
});

describe("runCheckSet: a repository with no usable check set is refused, naming the entry", () => {
  /** The refusal for repository foo with this registry text. */
  function refusal(text: string | null): string {
    const { harness } = scratch();
    const foo = checkoutAt(join(harness, "repos", "foo"));
    const { set } = decide({ run: foo, gate: harness, harness, text });
    if (set.kind !== "unconfigured") {
      throw new Error(`not refused: ${JSON.stringify(set)}`);
    }
    return set.error.replace(comparable(harness), "<harness>");
  }

  const ENTRY = 'the "foo" entry in <harness>/repos/repos.json';

  test("no registry, or one that is not a repos list", () => {
    expect(refusal(null)).toBe(
      'the run builds in repository "foo", and <harness>/repos/repos.json could not be read: the gate runs a repository\'s checks only from the "checks" list on its entry there',
    );
    expect(refusal("{ not json")).toBe(
      "<harness>/repos/repos.json is not valid JSON",
    );
    for (const text of ["[]", "{}", '{"repos": {}}']) {
      expect({ text, error: refusal(text) }).toEqual({
        text,
        error: '<harness>/repos/repos.json must be { "repos": [ ... ] }',
      });
    }
  });

  test("no entry for the repository", () => {
    expect(refusal(registry({ name: "bar", checks: FOO_CHECKS }))).toBe(
      '<harness>/repos/repos.json has no entry named "foo": add one with a "checks" list, each check { "name": ..., "argv": [program, ...arguments] }',
    );
  });

  test("an entry with no checks list, or an empty one", () => {
    for (const entry of [
      { name: "foo" },
      { name: "foo", checks: [] },
      { name: "foo", checks: "bun test" },
    ]) {
      expect({ entry, error: refusal(registry(entry)) }).toEqual({
        entry,
        error: `${ENTRY} has no "checks" list: add the checks the gate runs for it, each { "name": ..., "argv": [program, ...arguments] }`,
      });
    }
  });

  test("a check that is not a name and a non-empty argument list", () => {
    const cases: Array<[unknown, string]> = [
      ["bun test", "checks[0] must be an object"],
      [
        { argv: ["bun"] },
        "checks[0].name must be letters, digits, dot, dash or underscore (40 at most)",
      ],
      [
        { name: "a b", argv: ["bun"] },
        "checks[0].name must be letters, digits, dot, dash or underscore (40 at most)",
      ],
      [
        { name: "clean-tree", argv: ["bun"] },
        'checks[0].name "clean-tree" is a check the gate runs itself',
      ],
      [
        { name: "test-evidence", argv: ["bun"] },
        'checks[0].name "test-evidence" is a check the gate runs itself',
      ],
      [
        { name: "unit" },
        "checks[0].argv must be a list of strings, the program first",
      ],
      [
        { name: "unit", argv: "bun test" },
        "checks[0].argv must be a list of strings, the program first",
      ],
      [
        { name: "unit", argv: [] },
        "checks[0].argv must be a list of strings, the program first",
      ],
      [
        { name: "unit", argv: ["bun", 7] },
        "checks[0].argv must be a list of strings, the program first",
      ],
      [
        { name: "unit", argv: ["  ", "test"] },
        "checks[0].argv[0] must name a program",
      ],
    ];
    for (const [check, problem] of cases) {
      expect({
        check,
        error: refusal(registry({ name: "foo", checks: [check] })),
      }).toEqual({
        check,
        error: `${ENTRY}: ${problem}`,
      });
    }
    expect(
      refusal(
        registry({
          name: "foo",
          checks: [
            { name: "unit", argv: ["bun", "test"] },
            { name: "unit", argv: ["cargo", "test"] },
          ],
        }),
      ),
    ).toBe(`${ENTRY}: checks[1].name "unit" is given twice`);
  });
});

describe("runCheckSet: a check's own time limit", () => {
  /** The check set for repository foo with these checks. */
  function checksOf(checks: unknown[]): RunCheckSet {
    const { harness } = scratch();
    const foo = checkoutAt(join(harness, "repos", "foo"));
    return decide({
      run: foo,
      gate: harness,
      harness,
      text: registry({ name: "foo", checks }),
    }).set;
  }

  test("a check may set timeoutSeconds, up to the bound; a check that sets none has none", () => {
    expect(MAX_CHECK_TIMEOUT_SECONDS).toBe(3600);
    const set = checksOf([
      { name: "unit", argv: ["cargo", "test"], timeoutSeconds: 900 },
      { name: "lint", argv: ["cargo", "clippy"] },
      {
        name: "slow",
        argv: ["cargo", "bench"],
        timeoutSeconds: MAX_CHECK_TIMEOUT_SECONDS,
      },
    ]);
    expect(set).toMatchObject({
      kind: "repository",
      checks: [
        { name: "unit", argv: ["cargo", "test"], timeoutSeconds: 900 },
        { name: "lint", argv: ["cargo", "clippy"] },
        { name: "slow", argv: ["cargo", "bench"], timeoutSeconds: 3600 },
      ],
    });
    if (set.kind !== "repository") throw new Error("not a repository");
    expect("timeoutSeconds" in (set.checks[1] ?? {})).toBe(false);
  });

  test("a time limit that is not a whole number of seconds from 1 to the bound is refused, naming the check", () => {
    for (const timeoutSeconds of [0, -5, 3601, 1.5, "900", null, true]) {
      const set = checksOf([
        { name: "unit", argv: ["cargo", "test"], timeoutSeconds },
      ]);
      expect({ timeoutSeconds, set }).toMatchObject({
        timeoutSeconds,
        set: {
          kind: "unconfigured",
          error: expect.stringContaining(
            ": checks[0].timeoutSeconds must be a whole number of seconds from 1 to 3600",
          ),
        },
      });
    }
  });
});
