/**
 * The launcher boundary, end to end: each launcher writes a run correlation
 * and hands on a pointer, and that pointer — as the launcher delivered it —
 * resolves in the quality gate to the same Beads issue and run.
 *
 * `forge:phase-gate` and `forge:correlate` are spawned as commands; their
 * pointer travels on the gate's command line. `forge:exec` is run in process
 * with a stand-in provider CLI that dumps the environment it was started
 * with; its pointer travels in that environment. The gate end is
 * `runQualityGate` with recording runners, not a spawned hook.
 */

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
import { type GateDeps, runQualityGate } from "../.claude/hooks/quality-gate";
import { claudeAdapter } from "./executors/claude";
import { type ExecDeps, runExec } from "./executors/exec-cli";
import { closeLedger } from "./ledger/db";
import { RUN_CORRELATION_ENV, RUN_CORRELATIONS_DIR } from "./run-correlation";
import { runCorrelate } from "./run-correlation-cli";
import {
  initRunCorrelation,
  loadRunCorrelation,
} from "./run-correlation-store";

const PHASE_GATE = join(import.meta.dir, "forge", "phase-gate.ts");
const CORRELATE = join(import.meta.dir, "run-correlation-cli.ts");
const FAKE = join(import.meta.dir, "executors", "fixtures", "fake-cli.ts");

const temporary: string[] = [];

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A ledger file a child still holds on Windows: the OS temp directory reclaims it.
    }
  }
});

interface Box {
  root: string;
  /** A scratch checkout: a directory with `.git`. */
  cwd: string;
  home: string;
}

function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "launcher test "));
  temporary.push(root);
  const box = {
    root,
    cwd: join(root, "check out"),
    home: join(root, "forge home"),
  };
  mkdirSync(join(box.cwd, ".git"), { recursive: true });
  return box;
}

interface Printed {
  ok: boolean;
  data: {
    correlation: {
      pointer: string;
      beadsIssueId: string;
      executionRunId: string;
    } | null;
    correlationNote?: string;
  } | null;
  error: string | null;
}

/** Run one of the launcher commands in the scratch checkout; stdout must be one JSON object. */
async function command(
  box: Box,
  script: string,
  args: string[],
): Promise<{ exitCode: number; printed: Printed; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: box.cwd,
    env: { ...process.env, AGENT_FORGE_HOME: box.home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode: await child.exited,
    printed: JSON.parse(stdout) as Printed,
    stderr,
  };
}

/** The gate's view of an invocation: which bead and run it ends up linked to. */
function gateLink(
  cwd: string,
  input: { argv?: string[]; env?: Record<string, string> },
): { beadsIssueId: string | null; executionRunId: string | null } {
  const deps: GateDeps = {
    cwd,
    env: input.env ?? {},
    run: () => ({ ok: false, output: "" }),
    execFile: () => ({ ok: false, output: "" }),
    hasScript: () => false,
    hasTestFiles: () => false,
  };
  const outcome = runQualityGate({
    stdin: { kind: "none", reason: "terminal" },
    argv: input.argv ?? [],
    deps,
  });
  if (outcome.kind !== "ran") throw new Error(`gate refused: ${outcome.error}`);
  return {
    beadsIssueId: outcome.result.beadsIssueId,
    executionRunId: outcome.result.executionRunId,
  };
}

const SPAWN_TIMEOUT_MS = 60_000;

describe("forge:phase-gate --write", () => {
  const write = (box: Box, extra: string[] = []) => {
    mkdirSync(join(box.cwd, "plans", "research"), { recursive: true });
    writeFileSync(join(box.cwd, "plans", "research", "run-x.md"), "x");
    return command(box, PHASE_GATE, [
      "research",
      "--slug",
      "run-x",
      "--write",
      ...extra,
    ]);
  };

  test(
    "with --bead it writes the run's correlation and prints a pointer the gate links through",
    async () => {
      const box = sandbox();
      const wrote = await write(box, ["--bead", "bead-1"]);

      expect(wrote.exitCode).toBe(0);
      expect(wrote.printed.data?.correlation).toEqual({
        pointer: `${RUN_CORRELATIONS_DIR}/run-x.json`,
        beadsIssueId: "bead-1",
        executionRunId: "run-x",
      });
      const pointer = wrote.printed.data?.correlation?.pointer ?? "";
      // The run id is the run's slug: one id for run state and correlation.
      expect(
        existsSync(join(box.cwd, ".tmp", "work", "forge-runs", "run-x.json")),
      ).toBe(true);
      expect<unknown>(
        gateLink(box.cwd, { argv: ["--correlation", pointer] }),
      ).toEqual({
        beadsIssueId: "bead-1",
        executionRunId: "run-x",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a run that names no bead gets no correlation, and its epic is not used as one",
    async () => {
      const box = sandbox();
      const wrote = await write(box, ["--epic", "epic-1"]);
      expect(wrote.exitCode).toBe(0);
      expect(wrote.printed.data?.correlation).toBeNull();
      expect(existsSync(join(box.cwd, RUN_CORRELATIONS_DIR))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "only an explicit --bead rebinds: a later write keeps a correlation made elsewhere and says which bead it holds",
    async () => {
      const box = sandbox();
      await write(box, ["--bead", "bead-1"]);
      // Someone correlates the run to a narrower task.
      const rebound = initRunCorrelation({
        checkout: box.cwd,
        beadsIssueId: "task-9",
        executionRunId: "run-x",
        rebind: true,
      });
      expect(rebound.ok).toBe(true);

      const later = await write(box);
      expect(later.printed.data?.correlation).toMatchObject({
        beadsIssueId: "task-9",
      });

      const explicit = await write(box, ["--bead", "bead-2"]);
      expect(explicit.printed.data?.correlation).toMatchObject({
        beadsIssueId: "bead-2",
      });
      expect<unknown>(
        gateLink(box.cwd, {
          argv: ["--correlation", `${RUN_CORRELATIONS_DIR}/run-x.json`],
        }).beadsIssueId,
      ).toBe("bead-2");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("forge:correlate", () => {
  test(
    "mints a run id when none is given and prints a pointer the gate links through",
    async () => {
      const box = sandbox();
      const made = await command(box, CORRELATE, ["--bead", "bead-1"]);
      expect(made.exitCode).toBe(0);
      const correlation = made.printed.data?.correlation;
      expect(correlation?.beadsIssueId).toBe("bead-1");
      expect(correlation?.executionRunId).toMatch(/^[0-9A-Z]{26}$/);
      expect(correlation?.pointer).toBe(
        `${RUN_CORRELATIONS_DIR}/${correlation?.executionRunId}.json`,
      );
      expect<unknown>(
        gateLink(box.cwd, {
          argv: ["--correlation", correlation?.pointer ?? ""],
        }),
      ).toEqual({
        beadsIssueId: "bead-1",
        executionRunId: correlation?.executionRunId ?? "",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test("uses a run id it is given, rebinds it when told another bead, and refuses a bad id", () => {
    const box = sandbox();
    const first = runCorrelate(["--bead", "bead-1", "--run", "run-7"], {
      cwd: box.cwd,
    });
    expect(first.body.data).toMatchObject({
      correlation: { beadsIssueId: "bead-1", executionRunId: "run-7" },
    });
    const second = runCorrelate(["--bead", "bead-2", "--run", "run-7"], {
      cwd: box.cwd,
    });
    expect(second.code).toBe(0);
    const loaded = loadRunCorrelation(
      `${RUN_CORRELATIONS_DIR}/run-7.json`,
      box.cwd,
    );
    expect(loaded.ok && String(loaded.value.beadsIssueId)).toBe("bead-2");

    for (const argv of [
      ["--bead", "--json"],
      ["--bead", "a; echo pwned"],
      ["--bead", "bead-1", "--run", "../escape"],
      [],
    ]) {
      const refused = runCorrelate(argv, { cwd: box.cwd });
      expect(refused.code).toBe(2);
      expect(refused.body.ok).toBe(false);
    }
  });
});

describe("forge:exec", () => {
  function setup(): { box: Box; deps: ExecDeps; dump: string } {
    const box = sandbox();
    return {
      box,
      dump: join(box.root, "dump.json"),
      deps: {
        harnessRoot: box.root,
        home: box.root,
        env: { PATH: process.env.PATH },
        adapters: { claude: claudeAdapter },
        sink: () => undefined,
      },
    };
  }

  const fake = (dump: string) => [
    process.execPath,
    FAKE,
    "--fake-provider",
    "claude",
    "--fake-dump",
    dump,
  ];

  const seenEnv = (dump: string): Record<string, string> =>
    (JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> })
      .env;

  test("with --run the child starts with a pointer the gate links through, to the bead and run it was launched for", async () => {
    const { box, deps, dump } = setup();
    const out = await runExec(
      [
        "--bead",
        "bead-1",
        "--run",
        "run-1",
        "--worktree",
        box.cwd,
        "--prompt",
        "x",
      ],
      { ...deps, command: fake(dump) },
    );
    expect(out.code).toBe(0);
    expect(out.body.data).toMatchObject({
      correlation: {
        pointer: `${RUN_CORRELATIONS_DIR}/run-1.json`,
        beadsIssueId: "bead-1",
        executionRunId: "run-1",
      },
    });

    const pointer = seenEnv(dump)[RUN_CORRELATION_ENV];
    expect(typeof pointer).toBe("string");
    // What a hook inside that child would see: the same environment.
    expect<unknown>(
      gateLink(box.cwd, { env: { [RUN_CORRELATION_ENV]: pointer ?? "" } }),
    ).toEqual({ beadsIssueId: "bead-1", executionRunId: "run-1" });
  });

  test("without --run nothing is written and an inherited pointer does not reach the child", async () => {
    const { box, deps, dump } = setup();
    writeFileSync(
      join(box.root, "agent-forge.toml"),
      `[execution.env]\npass = ["${RUN_CORRELATION_ENV}"]\n`,
    );
    const out = await runExec(
      ["--bead", "bead-1", "--worktree", box.cwd, "--prompt", "x"],
      {
        ...deps,
        env: { ...deps.env, [RUN_CORRELATION_ENV]: "someone/elses.json" },
        command: fake(dump),
      },
    );
    expect(out.code).toBe(0);
    expect(out.body.data).toMatchObject({ correlation: null });
    expect(RUN_CORRELATION_ENV in seenEnv(dump)).toBe(false);
    expect(existsSync(join(box.cwd, RUN_CORRELATIONS_DIR))).toBe(false);
  });

  test("a run already correlated to another bead is not handed to this child: it runs unlinked and the output says how to rebind", async () => {
    const { box, deps, dump } = setup();
    const held = initRunCorrelation({
      checkout: box.cwd,
      beadsIssueId: "bead-a",
      executionRunId: "run-1",
    });
    expect(held.ok).toBe(true);

    const out = await runExec(
      [
        "--bead",
        "bead-b",
        "--run",
        "run-1",
        "--worktree",
        box.cwd,
        "--prompt",
        "x",
      ],
      { ...deps, command: fake(dump) },
    );
    expect(out.code).toBe(0);
    expect(out.body.data).toMatchObject({
      correlation: null,
      correlationNote:
        "run run-1 is already correlated to bead-a; rebind it with: bun run forge:correlate --bead bead-b --run run-1",
    });
    expect(RUN_CORRELATION_ENV in seenEnv(dump)).toBe(false);
    // The file still names the bead it was written for.
    const loaded = loadRunCorrelation(
      `${RUN_CORRELATIONS_DIR}/run-1.json`,
      box.cwd,
    );
    expect(loaded.ok && String(loaded.value.beadsIssueId)).toBe("bead-a");
  });
});

describe("no launcher reaches for a host task tool", () => {
  test("the launcher sources never name one", () => {
    for (const file of [
      "run-correlation.ts",
      "run-correlation-store.ts",
      "run-correlation-cli.ts",
      join("forge", "phase-gate.ts"),
      join("executors", "exec-cli.ts"),
    ]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source).not.toMatch(/TaskCreate|TaskUpdate|TodoWrite/);
    }
  });
});
