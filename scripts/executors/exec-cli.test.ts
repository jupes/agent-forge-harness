import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { comparableCheckout } from "../forge/runs";
import { closeLedger } from "../ledger/db";
import { SESSION_MIRROR_FILE } from "../ledger/identity";
import { ledgerPath } from "../ledger/paths";
import { queryEvents } from "../ledger/query";
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
afterAll(() => {
  for (const ledger of ledgers) closeLedger(ledger);
});

/**
 * A harness root and a run directory that are each their own checkout (a bare
 * temp directory would resolve to whatever checkout the temp directory sits
 * in), a launch directory with no session mirror, and a ledger file nothing
 * else writes.
 */
function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "forge exec ")));
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
        "tool.called",
        "tool.called",
        "session.ended",
      ]);
      expect(out.body.data).toMatchObject({
        events: 4,
        recorded: 4,
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
    expect(rows).toHaveLength(4);
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

  test("a provider failure exits 2 with its exit code", async () => {
    const { worktree, deps } = setup();
    const out = await runExec(
      ["--bead", "b-3", "--worktree", worktree, "--prompt", "x"],
      { ...deps, command: fake("claude", "crash") },
    );
    expect(out.code).toBe(2);
    expect(out.body.error).toBe("provider exited 3");
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
      events: 4,
      recorded: 0,
      notRecorded: 4,
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
      "tool.called",
      "tool.called",
      "session.ended",
    ]);
    expect(out.body.data).toMatchObject({
      events: 4,
      recorded: 4,
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
      events: 4,
      recorded: 0,
      notRecorded: 4,
      ledgerError: "disk full",
      ledger: null,
      exitCode: 0,
    });
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

  test("with no override and nothing on PATH the adapter is found:false", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      const report = await claudeAdapter.doctor();
      expect(report).toMatchObject({
        provider: "claude",
        found: false,
        ok: false,
      });
    } finally {
      process.env.PATH = saved;
    }
  });
});
