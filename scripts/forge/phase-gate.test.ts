import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Executor, Smith } from "../../types/hearth";
import { type ForgeConfig, loadConfig } from "../config/load";
import { recordRound } from "./auto-loop";
import {
  artifactPath,
  executorFromFlags,
  type ForgeState,
  isRunComplete,
  nextPhase,
  parseGateArgs,
  parseState,
  phaseCommand,
  prereqPhase,
  recordComplete,
  validateEnter,
} from "./phase-gate";
import type { ReviewRound } from "./phases";
import { activeRuns, summarizeRun } from "./runs";

const NEVER = () => false;
const ALWAYS = () => true;
const FIXED = () => "2026-06-04T00:00:00.000Z";
/** A smiths loader for calls that must not need the smiths config. */
const neverRead = (): ForgeConfig => {
  throw new Error("the smiths config was read");
};

function stateAfter(
  completed: ForgeState["completed"],
  slug = "demo",
): ForgeState {
  return {
    slug,
    phase: completed[completed.length - 1] ?? "research",
    completed,
    artifacts: {},
    updatedAt: FIXED(),
  };
}

describe("phase topology", () => {
  test("artifact paths key off the slug", () => {
    expect(artifactPath("research", "x")).toBe("plans/research/x.md");
    expect(artifactPath("plan", "x")).toBe("plans/drafts/x.md");
    expect(artifactPath("ship", "x")).toBe("reports/x-ship.md");
  });

  test("implement has no document artifact", () => {
    expect(artifactPath("implement", "x")).toBeNull();
  });

  test("prereq and next chain through the pipeline", () => {
    expect(prereqPhase("research")).toBeNull();
    expect(prereqPhase("plan")).toBe("research");
    expect(prereqPhase("ship")).toBe("implement");
    expect(nextPhase("research")).toBe("plan");
    expect(nextPhase("ship")).toBeNull();
  });

  test("phaseCommand renders the slash command", () => {
    expect(phaseCommand("plan", "user-settings")).toBe(
      "/forge-plan user-settings",
    );
  });
});

describe("validateEnter", () => {
  test("research can always start", () => {
    expect(validateEnter("research", "x", NEVER, null).ok).toBe(true);
  });

  test("plan is blocked when the research artifact is missing", () => {
    const r = validateEnter("plan", "x", NEVER, null);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("/forge-research x");
  });

  test("plan is allowed when the research artifact exists on disk", () => {
    const exists = (p: string) => p === "plans/research/x.md";
    expect(validateEnter("plan", "x", exists, null).ok).toBe(true);
  });

  test("ship is allowed when implement is recorded complete (no artifact)", () => {
    const state = stateAfter(["research", "plan", "implement"]);
    expect(validateEnter("ship", "demo", NEVER, state).ok).toBe(true);
  });

  test("ship is blocked when implement is not complete", () => {
    const state = stateAfter(["research", "plan"]);
    expect(validateEnter("ship", "demo", NEVER, state).ok).toBe(false);
  });
});

describe("recordComplete", () => {
  test("records a phase and stores its artifact path", () => {
    const r = recordComplete("research", "demo", ALWAYS, null, {}, FIXED);
    expect(r.ok).toBe(true);
    expect(r.data?.completed).toEqual(["research"]);
    expect(r.data?.artifacts.research).toBe("plans/research/demo.md");
  });

  test("fails loudly when the phase artifact is missing", () => {
    const r = recordComplete(
      "plan",
      "demo",
      NEVER,
      stateAfter(["research"]),
      {},
      FIXED,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("plans/drafts/demo.md");
  });

  test("implement completes without an artifact", () => {
    const r = recordComplete(
      "implement",
      "demo",
      NEVER,
      stateAfter(["research", "plan"]),
      {},
      FIXED,
    );
    expect(r.ok).toBe(true);
    expect(r.data?.completed).toContain("implement");
  });

  test("rejects a slug mismatch against the active run", () => {
    const r = recordComplete(
      "plan",
      "other",
      ALWAYS,
      stateAfter(["research"], "demo"),
      {},
      FIXED,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("other");
  });

  test("does not double-add an already-completed phase", () => {
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      {},
      FIXED,
    ).data;
    const again = recordComplete("research", "demo", ALWAYS, first, {}, FIXED);
    expect(again.data?.completed).toEqual(["research"]);
  });
});

describe("state parsing", () => {
  test("round-trips a valid state", () => {
    const s = stateAfter(["research", "plan"]);
    expect(parseState(JSON.stringify(s))?.completed).toEqual([
      "research",
      "plan",
    ]);
  });

  test("returns null for invalid JSON or shape", () => {
    expect(parseState("not json")).toBeNull();
    expect(parseState(JSON.stringify({ slug: "x" }))).toBeNull();
  });

  test("drops unknown phase values defensively", () => {
    const parsed = parseState(
      JSON.stringify({
        slug: "x",
        phase: "plan",
        completed: ["research", "bogus"],
      }),
    );
    expect(parsed?.completed).toEqual(["research"]);
  });

  test("isRunComplete is true only after ship", () => {
    expect(isRunComplete(stateAfter(["research", "plan", "implement"]))).toBe(
      false,
    );
    expect(
      isRunComplete(stateAfter(["research", "plan", "implement", "ship"])),
    ).toBe(true);
  });
});

describe("the review ledger survives the pipeline", () => {
  test("advancing a phase keeps the rounds recorded so far", () => {
    const withReviews: ForgeState = {
      ...stateAfter(["research"]),
      reviews: [
        {
          phase: "research",
          round: 1,
          verdict: "PASS",
          findings: { blocker: 0, high: 0, medium: 1, low: 0 },
          at: FIXED(),
        },
      ],
    };
    const r = recordComplete("plan", "demo", ALWAYS, withReviews, {}, FIXED);
    expect(r.data?.reviews).toHaveLength(1);
    expect(r.data?.reviews?.[0]?.phase).toBe("research");
  });

  test("mode and checkout carry forward once recorded", () => {
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      { mode: "auto", checkout: "C:/trees/aa11" },
      FIXED,
    ).data;
    const second = recordComplete("plan", "demo", ALWAYS, first, {}, FIXED);
    expect(second.data?.mode).toBe("auto");
    expect(second.data?.checkout).toBe("C:/trees/aa11");
  });
});

describe("an auto run's reviews gate the next phase", () => {
  const round = (
    phase: ReviewRound["phase"],
    n: number,
    verdict: ReviewRound["verdict"],
    high = 0,
  ): ReviewRound => ({
    phase,
    round: n,
    verdict,
    findings: { blocker: 0, high, medium: 0, low: 0 },
    at: FIXED(),
  });

  const haltedPlan: ForgeState = {
    ...stateAfter(["research", "plan"]),
    mode: "auto",
    reviews: [
      round("research", 1, "PASS"),
      round("plan", 1, "FAIL", 1),
      round("plan", 2, "FAIL", 1),
    ],
  };

  test("the following phase cannot start while the prior phase is halted", () => {
    const r = validateEnter("implement", "demo", ALWAYS, haltedPlan);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"plan" is halted');
    expect(r.error).toContain("not converging");
    expect(r.error).toContain("/forge-plan demo");
    expect(r.error).toContain("bun run forge:review --slug demo --phase plan");
  });

  test("the following phase cannot start while the prior phase is awaiting review", () => {
    const unreviewed: ForgeState = {
      ...stateAfter(["research", "plan"]),
      mode: "auto",
      reviews: [round("research", 1, "PASS")],
    };
    const r = validateEnter("implement", "demo", ALWAYS, unreviewed);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"plan" has not been reviewed');
    expect(r.error).toContain("bun run forge:review --slug demo --phase plan");
  });

  test("the halted phase itself can be re-entered", () => {
    expect(validateEnter("plan", "demo", ALWAYS, haltedPlan).ok).toBe(true);
  });

  test("a gated run with the same rounds may start the following phase", () => {
    const gated: ForgeState = { ...haltedPlan, mode: "gated" };
    expect(validateEnter("implement", "demo", ALWAYS, gated).ok).toBe(true);
  });

  test("phase-gate --write does not clear a halt; a new advancing round does", () => {
    // Exercises recordComplete, the function behind --write, not the CLI.
    const rewritten = recordComplete(
      "plan",
      "demo",
      ALWAYS,
      haltedPlan,
      {},
      FIXED,
    ).data as ForgeState;
    expect(summarizeRun(rewritten).halted?.phase).toBe("plan");
    expect(validateEnter("implement", "demo", ALWAYS, rewritten).ok).toBe(
      false,
    );

    const cleared = recordRound(rewritten, round("plan", 3, "PASS"));
    expect(summarizeRun(cleared).halted).toBeNull();
    expect(summarizeRun(cleared).next).toBe("implement");
    expect(validateEnter("implement", "demo", ALWAYS, cleared).ok).toBe(true);
  });
});

describe("the executor and bead on a run", () => {
  test("recording a phase stores the executor and bead it was given and keeps them on the next write", () => {
    const executor = { provider: "claude", model: "m-1", effort: "high" };
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      { executor, beadId: "bd-7" },
      FIXED,
    ).data;
    expect(first?.schemaVersion).toBe(2);
    expect(first?.executor).toEqual(executor);
    expect(first?.beadId).toBe("bd-7");

    const second = recordComplete("plan", "demo", ALWAYS, first, {}, FIXED);
    expect(second.data?.executor).toEqual(executor);
    expect(second.data?.beadId).toBe("bd-7");
  });

  test("a later executor or bead replaces the stored one", () => {
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      { executor: { provider: "claude", model: "m-1" }, beadId: "bd-7" },
      FIXED,
    ).data;
    const second = recordComplete(
      "plan",
      "demo",
      ALWAYS,
      first,
      { executor: { provider: "codex", model: "m-2" }, beadId: "bd-8" },
      FIXED,
    ).data;
    expect(second?.executor).toEqual({ provider: "codex", model: "m-2" });
    expect(second?.beadId).toBe("bd-8");
  });

  test("the announced review status carries across a write", () => {
    const base: ForgeState = {
      ...stateAfter(["research"]),
      announcedPhase: "research",
      announcedStatus: "awaiting-review",
    };
    const next = recordComplete("plan", "demo", ALWAYS, base, {}, FIXED).data;
    expect(next?.announcedStatus).toBe("awaiting-review");
  });

  test("with no smith named, executor flags need a provider and a model together", () => {
    expect(executorFromFlags({}, neverRead)).toEqual({
      ok: true,
      data: undefined,
      error: null,
    });
    expect(executorFromFlags({ provider: "claude" }, neverRead).ok).toBe(false);
    expect(executorFromFlags({ model: "m-1" }, neverRead).ok).toBe(false);
    expect(executorFromFlags({ effort: "high" }, neverRead).ok).toBe(false);
    expect(
      executorFromFlags({ provider: "claude", model: "" }, neverRead).ok,
    ).toBe(false);
    expect(
      executorFromFlags(
        { provider: "claude", model: "m-1", effort: "high" },
        neverRead,
      ).data,
    ).toEqual({ provider: "claude", model: "m-1", effort: "high" });
  });
});

/** The builtin smiths and nothing from this machine: no workspace file, no user file, no environment. */
const NOWHERE = join(tmpdir(), "phase-gate-test-no-such-directory");
const BUILTIN = loadConfig({
  harnessRoot: join(NOWHERE, "checkout"),
  home: join(NOWHERE, "home"),
  env: {},
}).config;
const builtin = () => BUILTIN;

describe("a smith named on the command line", () => {
  test("--smith alone is enough: it resolves to the smith's provider, model and effort", () => {
    const smith = BUILTIN.smiths["claude-master"] as Smith;
    expect(executorFromFlags({ smith: "claude-master" }, builtin)).toEqual({
      ok: true,
      data: {
        provider: smith.provider,
        model: smith.model,
        effort: smith.effort,
        smith: "claude-master",
      },
      error: null,
    });
  });

  test("an unknown smith is refused, and the refusal lists the configured ones", () => {
    const refused = executorFromFlags({ smith: "anvil" }, builtin);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('unknown smith "anvil"');
    for (const name of Object.keys(BUILTIN.smiths)) {
      expect(refused.error).toContain(name);
    }
  });

  test("an unknown smith is refused even beside a provider and a model: a smith is always a configured one", () => {
    const refused = executorFromFlags(
      { provider: "claude", model: "m-1", smith: "anvil" },
      builtin,
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('unknown smith "anvil"');
  });

  test("a name every object has as a key is an unknown smith like any other, not a disabled one", () => {
    for (const smith of ["constructor", "__proto__", "toString"]) {
      const refused = executorFromFlags({ smith }, builtin);
      expect({ smith, ok: refused.ok }).toEqual({ smith, ok: false });
      expect(refused.error).toContain(`unknown smith "${smith}"`);
      expect(refused.error).toContain("claude-master");
    }
  });

  test("a disabled smith is refused, without the list", () => {
    const withIdle: ForgeConfig = {
      ...BUILTIN,
      smiths: {
        ...BUILTIN.smiths,
        idle: {
          name: "idle",
          provider: "claude",
          model: "m-0",
          effort: "low",
          enabled: false,
          tags: [],
        },
      },
    };
    const refused = executorFromFlags({ smith: "idle" }, () => withIdle);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('smith "idle" is disabled');
    expect(refused.error).not.toContain("claude-master");
  });

  test("--smith with no name is refused, rather than read as the default smith or as the next flag", () => {
    for (const smith of ["", "  ", "--write"]) {
      const refused = executorFromFlags({ smith }, builtin);
      expect({ smith, ok: refused.ok }).toEqual({ smith, ok: false });
      expect(refused.error).toContain("--smith needs the name");
    }
  });

  test("a provider, model or effort that contradicts the smith is refused; one that agrees is accepted", () => {
    const smith = BUILTIN.smiths["claude-journeyman"] as Smith;
    for (const [flag, value] of [
      ["provider", "codex"],
      ["model", "some-other-model"],
      ["effort", "max"],
    ] as const) {
      const refused = executorFromFlags(
        { smith: "claude-journeyman", [flag]: value },
        builtin,
      );
      expect({ flag, ok: refused.ok }).toEqual({ flag, ok: false });
      expect(refused.error).toContain(`--${flag} ${value} contradicts`);
      expect(refused.error).toContain("claude-journeyman");
    }
    expect(
      executorFromFlags(
        {
          smith: "claude-journeyman",
          provider: smith.provider,
          model: smith.model,
          effort: smith.effort,
        },
        builtin,
      ).data,
    ).toEqual({
      provider: smith.provider,
      model: smith.model,
      effort: smith.effort,
      smith: "claude-journeyman",
    });
  });

  test("the smiths config is read only when a smith is named, and a config that cannot be read is then a refusal", () => {
    expect(executorFromFlags({}, neverRead).ok).toBe(true);
    expect(
      executorFromFlags({ provider: "claude", model: "m-1" }, neverRead).data,
    ).toEqual({ provider: "claude", model: "m-1" });
    const refused = executorFromFlags({ smith: "claude-master" }, () => {
      throw new Error("agent-forge.toml: cannot parse TOML: line 3");
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("--smith claude-master");
    expect(refused.error).toContain("cannot parse TOML: line 3");
  });

  test("pure: the executor a smith resolves to is stored on the run by recordComplete and kept by a later write that names none", () => {
    const executor = executorFromFlags({ smith: "claude-apprentice" }, builtin)
      .data as Executor;
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      { executor, beadId: "bd-7" },
      FIXED,
    ).data;
    expect(first?.executor).toEqual(executor);
    expect(first?.executor?.smith).toBe("claude-apprentice");
    const second = recordComplete("plan", "demo", ALWAYS, first, {}, FIXED);
    expect(second.data?.executor).toEqual(executor);
  });

  test("pure: a run recorded by one ship write, as the mini path records itself, is complete and not in flight", () => {
    const executor = executorFromFlags({ smith: "claude-apprentice" }, builtin)
      .data as Executor;
    const only = recordComplete(
      "ship",
      "mini-demo",
      ALWAYS,
      null,
      { executor, beadId: "bd-9" },
      FIXED,
    ).data as ForgeState;
    expect(only.completed).toEqual(["ship"]);
    expect(only.executor?.smith).toBe("claude-apprentice");
    expect(only.beadId).toBe("bd-9");
    expect(isRunComplete(only)).toBe(true);
    expect(activeRuns([summarizeRun(only)])).toEqual([]);
  });
});

describe("the command line, read strictly", () => {
  test("a phase, --write and the value flags are read, in either form", () => {
    expect(
      parseGateArgs([
        "plan",
        "--slug",
        "demo",
        "--write",
        "--bead=bd-7",
        "--checkout",
        "C:/trees/demo",
        "--smith=claude-master",
      ]),
    ).toEqual({
      ok: true,
      data: {
        phase: "plan",
        write: true,
        values: {
          slug: "demo",
          bead: "bd-7",
          checkout: "C:/trees/demo",
          smith: "claude-master",
        },
      },
      error: null,
    });
  });

  test("a flag with no value is refused, rather than dropped or fed the next flag", () => {
    for (const argv of [
      ["plan", "--slug", "demo", "--write", "--bead"],
      ["plan", "--slug", "demo", "--write", "--checkout", "--bead", "bd-7"],
      [
        "plan",
        "--slug",
        "demo",
        "--write",
        "--bead",
        "--smith",
        "claude-master",
      ],
      ["plan", "--slug", "demo", "--write", "--bead="],
      ["plan", "--slug", "demo", "--write", "--bead", ""],
    ]) {
      const refused = parseGateArgs(argv);
      expect({ argv, ok: refused.ok }).toEqual({ argv, ok: false });
      expect(refused.error).toMatch(/--(bead|checkout) needs a value/);
    }
  });

  test("--smith with no name keeps its own message", () => {
    for (const argv of [
      ["plan", "--slug", "demo", "--smith"],
      ["plan", "--slug", "demo", "--smith", "--write"],
      ["plan", "--slug", "demo", "--smith="],
    ]) {
      expect(parseGateArgs(argv).error).toContain(
        "--smith needs the name of a configured smith",
      );
    }
  });

  test("an unknown flag is refused with the known ones, so a mistyped --bead cannot record a run that names none", () => {
    for (const flag of ["--baed", "--smth", "--executor", "--bead-id=bd-7"]) {
      const refused = parseGateArgs([
        "plan",
        "--slug",
        "demo",
        "--write",
        flag,
        "x",
      ]);
      expect({ flag, ok: refused.ok }).toEqual({ flag, ok: false });
      expect(refused.error).toContain(`unknown flag ${flag.split("=")[0]}`);
      expect(refused.error).toContain("--bead");
    }
  });

  test("a flag given twice, a value on --write, and a second word that is not a flag are refused", () => {
    expect(
      parseGateArgs(["plan", "--slug", "a", "--bead", "bd-1", "--bead", "bd-2"])
        .error,
    ).toContain("--bead is given twice");
    expect(
      parseGateArgs(["plan", "--slug", "a", "--write=yes"]).error,
    ).toContain("--write takes no value");
    expect(parseGateArgs(["plan", "ship", "--slug", "a"]).error).toContain(
      'unexpected argument "ship"',
    );
  });

  test("the phase and the slug are not this function's to judge: it returns what was typed", () => {
    expect(parseGateArgs([]).data).toEqual({
      phase: undefined,
      write: false,
      values: {},
    });
    expect(parseGateArgs(["nonsense", "--slug", "x"]).data?.phase).toBe(
      "nonsense",
    );
  });
});

describe("the command line: a value that cannot be one", () => {
  test("a value still in its angle brackets is refused, so a copied line with an unfilled <id> records nothing", () => {
    for (const [flag, value] of [
      ["--bead", "<id>"],
      ["--bead", "<task-id>"],
      ["--epic", "<feature-or-epic-id>"],
      ["--checkout", "<checkout>"],
      ["--smith", "<name>"],
      ["--slug", "<slug>"],
    ] as const) {
      const refused = parseGateArgs(
        flag === "--slug"
          ? ["plan", flag, value]
          : ["plan", "--slug", "demo", flag, value],
      );
      expect({ flag, ok: refused.ok }).toEqual({ flag, ok: false });
      expect(refused.error).toContain("placeholder");
    }
    expect(parseGateArgs(["plan", "--slug", "demo", "--bead=<id>"]).ok).toBe(
      false,
    );
  });

  test("--mode is checked wherever it is given, an entry check included", () => {
    const refused = parseGateArgs([
      "plan",
      "--slug",
      "demo",
      "--mode",
      "unattended",
    ]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('--mode must be "gated" or "auto"');
    expect(parseGateArgs(["plan", "--slug", "demo", "--mode", "auto"]).ok).toBe(
      true,
    );
  });

  test("the refusal for a missing smith name says where the names are", () => {
    expect(
      parseGateArgs(["plan", "--slug", "demo", "--smith"]).error,
    ).toContain("bun run forge:config show");
  });
});

// ── The command ──────────────────────────────────────────────────────────────

const PHASE_GATE = join(import.meta.dir, "phase-gate.ts");
const RUNS = join(import.meta.dir, "runs-cli.ts");
const HARNESS = join(import.meta.dir, "..", "..");

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A ledger file a child still holds on Windows: the OS temp directory reclaims it.
    }
  }
});

interface Sandbox {
  /** A scratch checkout: a directory with `.git`, holding the phases' artifacts. */
  cwd: string;
  env: Record<string, string | undefined>;
}

function sandbox(slug: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "phase gate smith "));
  scratch.push(root);
  const cwd = join(root, "check out");
  const home = join(root, "home");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const artifact of [
    `plans/research/${slug}.md`,
    `plans/drafts/${slug}.md`,
    `reports/${slug}-ship.md`,
  ]) {
    mkdirSync(join(cwd, artifact, ".."), { recursive: true });
    writeFileSync(join(cwd, artifact), "# artifact\n");
  }
  return {
    cwd,
    // The ledger and the user config of a scratch home: nothing of this
    // machine's is read or written.
    env: {
      ...process.env,
      AGENT_FORGE_HOME: join(home, ".agent-forge"),
      HOME: home,
      USERPROFILE: home,
      AGENT_FORGE_SMITH: undefined,
    },
  };
}

async function run(
  box: Sandbox,
  script: string,
  args: string[],
): Promise<{
  exitCode: number;
  printed: { ok: boolean; data: unknown; error: string | null };
}> {
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: box.cwd,
    env: box.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, printed: JSON.parse(stdout) };
}

/** A smith the command will find enabled: the config is the one the child reads. */
function configuredSmith(box: Sandbox): Smith {
  const { config } = loadConfig({
    harnessRoot: HARNESS,
    home: box.env["HOME"],
    env: box.env,
  });
  const smith = Object.values(config.smiths).find((one) => one.enabled);
  if (!smith) throw new Error("no enabled smith is configured");
  return smith;
}

describe("forge:phase-gate --smith, as a command", () => {
  test("a write with --smith alone puts the smith's executor in the run's state file, and the next --smith write keeps it", async () => {
    const box = sandbox("smith-run");
    const smith = configuredSmith(box);
    const expected = {
      provider: smith.provider,
      model: smith.model,
      effort: smith.effort,
      smith: smith.name,
    };

    const first = await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "smith-run",
      "--write",
      "--bead",
      "bd-1",
      "--smith",
      smith.name,
    ]);
    expect(first.exitCode).toBe(0);
    const stored = () =>
      JSON.parse(
        readFileSync(
          join(box.cwd, ".tmp", "work", "forge-runs", "smith-run.json"),
          "utf8",
        ),
      ) as ForgeState;
    expect(stored().executor).toMatchObject(expected);

    const second = await run(box, PHASE_GATE, [
      "plan",
      "--slug",
      "smith-run",
      "--write",
      "--bead",
      "bd-1",
      "--smith",
      smith.name,
    ]);
    expect(second.exitCode).toBe(0);
    expect(stored().completed).toEqual(["research", "plan"]);
    expect(stored().executor).toMatchObject(expected);
  });

  test("an unknown smith, and --smith with no name, exit 2 on a write and on an entry check, and no run state file is written", async () => {
    const box = sandbox("refused-run");
    for (const args of [
      [
        "research",
        "--slug",
        "refused-run",
        "--write",
        "--smith",
        "no-such-smith",
      ],
      ["research", "--slug", "refused-run", "--smith", "no-such-smith"],
      ["research", "--slug", "refused-run", "--write", "--smith"],
      ["research", "--slug", "refused-run", "--smith"],
    ]) {
      const refused = await run(box, PHASE_GATE, args);
      expect({ args, exitCode: refused.exitCode }).toEqual({
        args,
        exitCode: 2,
      });
      expect(refused.printed.ok).toBe(false);
    }
    const unknown = await run(box, PHASE_GATE, [
      "research",
      "--slug",
      "refused-run",
      "--write",
      "--smith",
      "no-such-smith",
    ]);
    expect(unknown.printed.error).toContain('unknown smith "no-such-smith"');
    expect(unknown.printed.error).toContain(configuredSmith(box).name);
    expect(
      existsSync(
        join(box.cwd, ".tmp", "work", "forge-runs", "refused-run.json"),
      ),
    ).toBe(false);
  });

  test("one ship write with a bead and a smith, the way the mini path records itself, leaves a shipped run that is not in flight", async () => {
    const box = sandbox("mini-run");
    const smith = configuredSmith(box);
    const written = await run(box, PHASE_GATE, [
      "ship",
      "--slug",
      "mini-run",
      "--write",
      "--bead",
      "bd-9",
      "--smith",
      smith.name,
    ]);
    expect(written.exitCode).toBe(0);
    expect(written.printed.data).toMatchObject({
      completed: ["ship"],
      beadId: "bd-9",
      executor: {
        smith: smith.name,
        provider: smith.provider,
        model: smith.model,
      },
      correlation: { beadsIssueId: "bd-9", executionRunId: "mini-run" },
    });

    const active = await run(box, RUNS, ["--active", "--json"]);
    expect(active.exitCode).toBe(0);
    expect(active.printed.data).toEqual([]);
  });
});

describe("forge:phase-gate, as a command: a flag it cannot read stops the write", () => {
  test("a valueless, mistyped or repeated flag exits 2 and writes no run state: the run is never recorded without the bead it meant to name", async () => {
    const box = sandbox("strict-run");
    for (const args of [
      [
        "research",
        "--slug",
        "strict-run",
        "--write",
        "--checkout",
        "--bead",
        "bd-1",
      ],
      ["research", "--slug", "strict-run", "--write", "--bead", "--smith", "x"],
      ["research", "--slug", "strict-run", "--write", "--baed", "bd-1"],
      [
        "research",
        "--slug",
        "strict-run",
        "--write",
        "--bead",
        "bd-1",
        "--bead",
        "bd-2",
      ],
    ]) {
      const refused = await run(box, PHASE_GATE, args);
      expect({ args, exitCode: refused.exitCode }).toEqual({
        args,
        exitCode: 2,
      });
      expect(refused.printed.ok).toBe(false);
    }
    expect(
      existsSync(
        join(box.cwd, ".tmp", "work", "forge-runs", "strict-run.json"),
      ),
    ).toBe(false);
  });

  test("--bead=<id> and --smith=<name> are read like the spaced forms", async () => {
    const box = sandbox("equals-run");
    const smith = configuredSmith(box);
    const written = await run(box, PHASE_GATE, [
      "research",
      "--slug=equals-run",
      "--write",
      "--bead=bd-3",
      `--smith=${smith.name}`,
    ]);
    expect(written.exitCode).toBe(0);
    expect(written.printed.data).toMatchObject({
      beadId: "bd-3",
      executor: { smith: smith.name },
      correlation: { beadsIssueId: "bd-3", executionRunId: "equals-run" },
    });
  });
});
