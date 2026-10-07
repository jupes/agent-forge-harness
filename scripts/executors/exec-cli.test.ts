import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "forge exec "));
  const worktree = join(root, "wt dir");
  mkdirSync(worktree);
  const deps: ExecDeps = {
    harnessRoot: root,
    home: root,
    env: { PATH: process.env.PATH, DATABASE_URL: "postgres://planted" },
    adapters: {
      claude: claudeAdapter,
      codex: createCodexAdapter({ prepare: () => undefined }),
    },
  };
  return { root, worktree, deps };
}

describe("forge:exec", () => {
  test("runs the default smith and writes validated events to NDJSON", async () => {
    const { root, worktree, deps } = setup();
    const out = await runExec(
      ["--bead", "b-1", "--worktree", worktree, "--prompt", "hi"],
      { ...deps, command: fake("claude") },
    );
    expect(out.code).toBe(0);
    const data = out.body.data as {
      smith: string;
      via: string;
      events: number;
    };
    expect(data).toMatchObject({
      smith: "claude-journeyman",
      via: "default",
      events: 4,
    });
    const file = join(root, ".tmp", "work", "exec-events", "b-1.ndjson");
    const kinds = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as LedgerEventInput).kind);
    expect(kinds).toEqual([
      "session.started",
      "tool.called",
      "tool.called",
      "session.ended",
    ]);
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

  test("a failing sink stops the child and exits 2", async () => {
    const { worktree, deps } = setup();
    const out = await runExec(
      ["--bead", "b-5", "--worktree", worktree, "--prompt", "x"],
      {
        ...deps,
        command: fake("claude", "hang"),
        sink: () => {
          throw new Error("disk full");
        },
      },
    );
    expect(out.code).toBe(2);
    expect(out.body.error).toBe("disk full");
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
