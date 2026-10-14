import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { comparableCheckout } from "../forge/runs";
import { closeLedger } from "../ledger/db";
import { SESSION_MIRROR_FILE } from "../ledger/identity";
import { ledgerPath } from "../ledger/paths";
import { queryEvents } from "../ledger/query";
import { RUN_CORRELATION_ENV, RUN_CORRELATIONS_DIR } from "../run-correlation";
import {
  initRunCorrelation,
  loadRunCorrelation,
} from "../run-correlation-store";
import { claudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { runDoctor } from "./doctor-cli";
import { type ExecDeps, runExec } from "./exec-cli";

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts");
const fake = (provider: string, mode = "ok") => [
  process.execPath,
  FAKE,
  "--fake-provider",
  provider,
  "--fake-mode",
  mode,
];

const ledgers: string[] = [];
/** The scratch directories a test made, removed after it. */
const scratch: string[] = [];
afterEach(() => {
  // A ledger file still open cannot be removed on Windows: close first.
  for (const ledger of ledgers.splice(0)) closeLedger(ledger);
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A new directory under the OS temp directory, removed after the test. */
function scratchDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/**
 * A harness root and a run directory that are each their own checkout (a bare
 * temp directory would resolve to whatever checkout the temp directory sits
 * in), a launch directory with no session mirror, and a ledger file nothing
 * else writes.
 */
function setup() {
  const root = scratchDir("forge exec ");
  mkdirSync(join(root, ".git"));
  const worktree = join(root, "wt dir");
  mkdirSync(join(worktree, ".git"), { recursive: true });
  const ledger = join(root, "forge home", "ledger.db");
  ledgers.push(ledger);
  const deps: ExecDeps = {
    harnessRoot: root,
    home: root,
    cwd: root,
    ledgerPath: ledger,
    env: { PATH: process.env.PATH, DATABASE_URL: "postgres://planted" },
    adapters: {
      claude: claudeAdapter,
      codex: createCodexAdapter({ prepare: () => undefined }),
    },
  };
  return { root, worktree, ledger, deps };
}

describe("forge:exec", () => {
  test("with no ledger path injected, rows go to the ledger of the process environment, not to the home handed to the child", async () => {
    const { root, worktree, deps } = setup();
    const childHome = join(root, "child forge home");
    const { ledgerPath: _injected, ...withoutLedger } = deps;

    // This test writes through the default path, so it names the process's
    // home itself for its own duration: it must not depend on the test preload
    // (absent when the file is run from another directory) to stay off the
    // real ledger.
    const processHome = join(root, "process forge home");
    const processLedger = join(processHome, "ledger.db");
    ledgers.push(processLedger);
    const saved = process.env.AGENT_FORGE_HOME;
    process.env.AGENT_FORGE_HOME = processHome;
    try {
      expect(ledgerPath()).toBe(processLedger);
      const out = await runExec(
        ["--bead", "b-default", "--worktree", worktree, "--prompt", "hi"],
        {
          ...withoutLedger,
          env: { ...deps.env, AGENT_FORGE_HOME: childHome },
          command: fake("claude"),
        },
      );
      expect(out.code).toBe(0);
      expect(
        queryEvents({ beadId: "b-default" }).map((row) => row.kind),
      ).toEqual([
        "session.started",
        "prompt.submitted",
        "tool.called",
        "tool.called",
        "session.ended",
      ]);
      expect(out.body.data).toMatchObject({
        events: 5,
        recorded: 5,
        ledger: processLedger,
      });
      expect(existsSync(processLedger)).toBe(true);
      expect(existsSync(join(childHome, "ledger.db"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AGENT_FORGE_HOME;
      else process.env.AGENT_FORGE_HOME = saved;
    }
  });

  test("run from a linked worktree of the harness, events carry the main checkout as workspace", async () => {
    const { root, worktree, ledger, deps } = setup();
    // A main checkout and a linked worktree of it, laid out the way git does.
    const main = join(root, "main repo");
    const gitDir = join(main, ".git", "worktrees", "feature one");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    const linked = join(root, "linked trees", "feature one");
    mkdirSync(linked, { recursive: true });
    writeFileSync(
      join(linked, ".git"),
      `gitdir: ${gitDir.replaceAll("\\", "/")}\n`,
    );

    const out = await runExec(
      ["--bead", "b-7", "--worktree", worktree, "--prompt", "x"],
      { ...deps, harnessRoot: linked, command: fake("claude") },
    );
    expect(out.code).toBe(0);
    const rows = queryEvents({ beadId: "b-7" }, { path: ledger });
    expect(rows).toHaveLength(5);
    for (const row of rows)
      expect(row.workspace).toBe(comparableCheckout(main));
  });

  test("a session mirrored into the launch directory is recorded as the parent and handed to the child", async () => {
    const { root, worktree, ledger, deps } = setup();
    const dump = join(root, "dump.json");
    writeFileSync(join(root, SESSION_MIRROR_FILE), "launching-session-1\n");
    const out = await runExec(
      ["--bead", "b-8", "--worktree", worktree, "--prompt", "x"],
      { ...deps, command: [...fake("claude"), "--fake-dump", dump] },
    );
    expect(out.code).toBe(0);
    const [started] = queryEvents(
      { beadId: "b-8", kinds: ["session.started"] },
      { path: ledger },
    );
    expect(started?.payload).toMatchObject({
      kind: "headless",
      parentSessionId: "launching-session-1",
    });
    expect(
      JSON.parse(readFileSync(dump, "utf8")).env.AGENT_FORGE_PARENT_SESSION,
    ).toBe("launching-session-1");
  });

  test("with no session mirrored into the launch directory there is no parent, on the event or in the child", async () => {
    const { root, worktree, ledger, deps } = setup();
    const dump = join(root, "dump.json");
    const out = await runExec(
      ["--bead", "b-9", "--worktree", worktree, "--prompt", "x"],
      { ...deps, command: [...fake("claude"), "--fake-dump", dump] },
    );
    expect(out.code).toBe(0);
    const [started] = queryEvents(
      { beadId: "b-9", kinds: ["session.started"] },
      { path: ledger },
    );
    expect(started?.kind).toBe("session.started");
    expect(started?.payload).not.toHaveProperty("parentSessionId");
    expect(JSON.parse(readFileSync(dump, "utf8")).env).not.toHaveProperty(
      "AGENT_FORGE_PARENT_SESSION",
    );
  });

  test("--smith routes to the codex adapter", async () => {
    const { worktree, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b-2",
        "--worktree",
        worktree,
        "--prompt",
        "hi",
        "--smith",
        "codex-journeyman",
      ],
      { ...deps, command: fake("codex") },
    );
    expect(out.code).toBe(0);
    expect(out.body.data).toMatchObject({ provider: "codex", via: "explicit" });
  });

  test("an unknown smith, a missing worktree and missing flags exit 2", async () => {
    const { worktree, deps } = setup();
    const unknown = await runExec(
      [
        "--bead",
        "b",
        "--worktree",
        worktree,
        "--prompt",
        "x",
        "--smith",
        "ghost",
      ],
      deps,
    );
    expect(unknown).toMatchObject({ code: 2 });
    expect(unknown.body.error).toContain("unknown smith");
    const missing = await runExec(
      ["--bead", "b", "--worktree", join(worktree, "nope"), "--prompt", "x"],
      deps,
    );
    expect(missing.body.error).toContain("worktree not found");
    expect((await runExec([], deps)).body.error).toContain("usage");
  });

  test("--smith constructor, a key every object has, exits 2 as an unknown smith", async () => {
    const { worktree, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b",
        "--worktree",
        worktree,
        "--prompt",
        "x",
        "--smith",
        "constructor",
      ],
      deps,
    );
    expect(out).toMatchObject({ code: 2 });
    expect(out.body.error).toBe('unknown smith "constructor"');
  });

  test("a provider failure exits 2 with its exit code", async () => {
    const { worktree, deps } = setup();
    const out = await runExec(
      ["--bead", "b-3", "--worktree", worktree, "--prompt", "x"],
      { ...deps, command: fake("claude", "crash") },
    );
    expect(out.code).toBe(2);
    expect(out.body.error).toBe("provider exited 3");
  });

  test("a provider that fails with its reason on stderr only: the reason is in the output, after the exit code", async () => {
    const { worktree, ledger, deps } = setup();
    const out = await runExec(
      ["--bead", "b-stderr", "--worktree", worktree, "--prompt", "x"],
      { ...deps, command: fake("claude", "stderr") },
    );
    expect(out.code).toBe(2);
    expect(out.body.error).toBe(
      "provider exited 2: the stream could not be started (fake)",
    );
    expect(out.body.data).toMatchObject({ exitCode: 2, providerErrors: [] });
    expect(
      String((out.body.data as Record<string, unknown>).stderr).trim(),
    ).toBe("the stream could not be started (fake)");
    expect(
      JSON.stringify(queryEvents({ beadId: "b-stderr" }, { path: ledger })),
    ).not.toContain("could not be started");
  });

  test("a run that exits 0 and reports no error is a success with no provider errors", async () => {
    const { worktree, deps } = setup();
    const out = await runExec(
      ["--bead", "b-clean", "--worktree", worktree, "--prompt", "x"],
      { ...deps, command: fake("claude") },
    );
    expect(out.code).toBe(0);
    expect(out.body).toMatchObject({ ok: true, error: null });
    expect(out.body.data).toMatchObject({ exitCode: 0, providerErrors: [] });
  });

  test("the child never sees a planted DATABASE_URL, but sees configured pass vars", async () => {
    const { root, worktree, deps } = setup();
    writeFileSync(
      join(root, "agent-forge.toml"),
      '[execution.env]\npass = ["EXTRA_OK"]\n',
    );
    const dump = join(root, "dump.json");
    await runExec(["--bead", "b-4", "--worktree", worktree, "--prompt", "x"], {
      ...deps,
      env: { ...deps.env, EXTRA_OK: "yes" },
      command: [...fake("claude"), "--fake-dump", dump],
    });
    expect(existsSync(dump)).toBe(true);
    const seen = JSON.parse(readFileSync(dump, "utf8")).env;
    expect(seen.DATABASE_URL).toBeUndefined();
    expect(seen.EXTRA_OK).toBe("yes");
  });

  test("a non-numeric --timeout-ms is rejected instead of killing the task at once", async () => {
    const { worktree, deps } = setup();
    const out = await runExec(
      [
        "--bead",
        "b",
        "--worktree",
        worktree,
        "--prompt",
        "x",
        "--timeout-ms",
        "soon",
      ],
      deps,
    );
    expect(out.code).toBe(2);
    expect(out.body.error).toContain("--timeout-ms");
  });

  test("a ledger that cannot be written is reported, and the provider still runs to its end", async () => {
    const { root, worktree, deps } = setup();
    const dump = join(root, "dump.json");
    const out = await runExec(
      ["--bead", "b-6", "--worktree", worktree, "--prompt", "x"],
      {
        ...deps,
        // A directory where the ledger file should be: it cannot be opened.
        ledgerPath: root,
        command: [...fake("claude"), "--fake-dump", dump],
      },
    );
    expect(out.code).toBe(0);
    expect(out.body.ok).toBe(true);
    const data = out.body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      events: 5,
      recorded: 0,
      notRecorded: 5,
      exitCode: 0,
      timedOut: false,
    });
    expect(String(data.ledgerError).length).toBeGreaterThan(0);
    expect(data.ledgerError).not.toBeNull();
    // The provider read its prompt and exited on its own.
    expect(JSON.parse(readFileSync(dump, "utf8")).stdin).toBe("x");
  });

  test("a sink that returns nothing has taken the event: it is counted as recorded", async () => {
    const { worktree, deps } = setup();
    const seen: string[] = [];
    const out = await runExec(
      ["--bead", "b-10", "--worktree", worktree, "--prompt", "x"],
      {
        ...deps,
        command: fake("claude"),
        sink: (event) => {
          seen.push(event.kind);
        },
      },
    );
    expect(out.code).toBe(0);
    expect(seen).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.called",
      "tool.called",
      "session.ended",
    ]);
    expect(out.body.data).toMatchObject({
      events: 5,
      recorded: 5,
      notRecorded: 0,
      ledgerError: null,
      ledger: null,
    });
  });

  test("a sink that throws does not kill the child: the run finishes and the failure is reported", async () => {
    const { worktree, deps } = setup();
    const out = await runExec(
      ["--bead", "b-5", "--worktree", worktree, "--prompt", "x"],
      {
        ...deps,
        command: fake("claude"),
        sink: () => {
          throw new Error("disk full");
        },
      },
    );
    expect(out.code).toBe(0);
    expect(out.body.error).toBeNull();
    expect(out.body.data).toMatchObject({
      events: 5,
      recorded: 0,
      notRecorded: 5,
      ledgerError: "disk full",
      ledger: null,
      exitCode: 0,
    });
  });
});

describe("forge:exec --run when the run correlation is refused (fake binary)", () => {
  test("a run held by another bead: the child still runs, its ledger rows and adapter variables carry --bead and --run, and the correlation file keeps the other bead", async () => {
    const { root, worktree, ledger, deps } = setup();
    const held = initRunCorrelation({
      checkout: worktree,
      topLevel: true,
      beadsIssueId: "bead-a",
      executionRunId: "run-9",
    });
    expect(held.ok).toBe(true);
    const dump = join(root, "dump.json");

    const out = await runExec(
      [
        "--bead",
        "bead-b",
        "--run",
        "run-9",
        "--worktree",
        worktree,
        "--prompt",
        "x",
      ],
      { ...deps, command: [...fake("claude"), "--fake-dump", dump] },
    );
    expect(out.code).toBe(0);
    expect(out.body.data).toMatchObject({
      recorded: 5,
      correlation: null,
      correlationNote:
        "run run-9 is already correlated to bead-a; rebind it with: bun run forge:correlate --bead bead-b --run run-9",
    });

    // Every row of the run names the bead this session was launched for.
    expect(
      queryEvents({ runId: "run-9" }, { path: ledger }).map((row) => [
        row.kind,
        row.beadId,
        row.runId,
      ]),
    ).toEqual([
      ["session.started", "bead-b", "run-9"],
      ["prompt.submitted", "bead-b", "run-9"],
      ["tool.called", "bead-b", "run-9"],
      ["tool.called", "bead-b", "run-9"],
      ["session.ended", "bead-b", "run-9"],
    ]);

    const seen = JSON.parse(readFileSync(dump, "utf8")).env as Record<
      string,
      string
    >;
    expect(seen).toMatchObject({
      AGENT_FORGE_BEAD_ID: "bead-b",
      FORGE_SLUG: "run-9",
    });
    expect(RUN_CORRELATION_ENV in seen).toBe(false);

    const loaded = loadRunCorrelation(
      `${RUN_CORRELATIONS_DIR}/run-9.json`,
      worktree,
    );
    expect(loaded.ok && String(loaded.value.beadsIssueId)).toBe("bead-a");
  });

  test("a --run that is not a Forge run id exits 2 before the provider starts, and nothing is written: no ledger, no correlation", async () => {
    for (const run of ["../run-9", "run 9"]) {
      const { root, worktree, ledger, deps } = setup();
      const dump = join(root, "dump.json");

      const out = await runExec(
        [
          "--bead",
          "bead-b",
          "--run",
          run,
          "--worktree",
          worktree,
          "--prompt",
          "x",
        ],
        { ...deps, command: [...fake("claude"), "--fake-dump", dump] },
      );
      expect(out.code).toBe(2);
      expect(out.body).toMatchObject({ ok: false, data: null });
      expect(out.body.error).toStartWith("--run must be a Forge run id");
      expect(existsSync(dump)).toBe(false);
      expect(existsSync(ledger)).toBe(false);
      expect(existsSync(join(worktree, ".tmp"))).toBe(false);
    }
  });
});

describe("forge:doctor", () => {
  test("reports every adapter and treats a missing CLI as data", async () => {
    const { deps } = setup();
    const report = await runDoctor(deps.adapters, {
      claude: fake("claude"),
      codex: [join(tmpdir(), "no-such-codex-binary")],
    });
    expect(report.map((r) => r.provider)).toEqual(["claude", "codex"]);
    expect(report[0]).toMatchObject({ found: true, ok: true });
    expect(report[1]).toMatchObject({ ok: false });
  });

  test("with no override and nothing on PATH (a child process whose PATH is one empty directory), forge:doctor --json reports every adapter found:false", async () => {
    // Emptying process.env.PATH in this process does not reach Bun.which (on
    // Windows, Bun 1.3.10, it still found an installed claude), so the doctor
    // runs in a child whose PATH and working directory are a directory this
    // test has just made, with nothing in it.
    const empty = scratchDir("forge doctor path ");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key.toUpperCase() !== "PATH") env[key] = value;
    }
    env.PATH = empty;
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "doctor-cli.ts"), "--json"],
      { cwd: empty, env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode: await child.exited, stderr }).toEqual({
      exitCode: 0,
      stderr: expect.any(String),
    });
    const body = JSON.parse(stdout) as {
      ok: boolean;
      data: { adapters: { provider: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.adapters.map((r) => r.provider)).toEqual(
      expect.arrayContaining(["claude", "codex"]),
    );
    for (const report of body.data.adapters) {
      expect(report).toMatchObject({
        found: false,
        ok: false,
        reason: `${report.provider} not found on PATH`,
      });
    }
  }, 30_000);
});
