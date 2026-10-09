/**
 * The quality gate, two ways.
 *
 * In process: `runQualityGate` with a constructed stdin result and recording
 * command runners, so every command line and every `bd` argument list the gate
 * produces can be inspected. The correlation and verdict files are real files
 * in a scratch checkout.
 *
 * As a subprocess: the real `.claude/hooks/quality-gate.ts` with JSON piped on
 * stdin, in a scratch directory with an empty PATH. There its own checks fail
 * fast (no `bun`, no `git`, no `bd`), so it never runs this suite again; what
 * is asserted is the event, the identity it logs and its exit code.
 *
 * Neither proves a live host session calls the hook.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  type GateDeps,
  type GateOutcome,
  runQualityGate,
} from "../.claude/hooks/quality-gate";
import type { HookStdin } from "../.claude/hooks/utils/hook-input";
import { closeLedger } from "./ledger/db";
import { queryEvents } from "./ledger/query";
import { RUN_CORRELATION_ENV } from "./run-correlation";
import { initRunCorrelation } from "./run-correlation-store";

const GATE = join(import.meta.dir, "..", ".claude", "hooks", "quality-gate.ts");

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
  userHome: string;
  emptyPath: string;
  ledger: string;
}

function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "quality gate test "));
  temporary.push(root);
  const box = {
    root,
    cwd: join(root, "check out"),
    home: join(root, "forge home"),
    userHome: join(root, "user home"),
    emptyPath: join(root, "empty path"),
    ledger: join(root, "forge home", "ledger.db"),
  };
  mkdirSync(join(box.cwd, ".git"), { recursive: true });
  mkdirSync(box.userHome, { recursive: true });
  mkdirSync(box.emptyPath, { recursive: true });
  return box;
}

/** The run's correlation, written the way a launcher writes it. */
function correlate(box: Box, bead = "bead-1", run = "run-1"): string {
  const made = initRunCorrelation({
    checkout: box.cwd,
    beadsIssueId: bead,
    executionRunId: run,
  });
  if (!made.ok) throw new Error(made.error);
  return made.path;
}

function verdict(
  box: Box,
  fileId: string,
  body: Record<string, unknown>,
): string {
  const file = join(box.cwd, ".tmp", "work", `${fileId}-verdict.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      taskId: fileId,
      verdict: "PASS",
      findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      ...body,
    }),
  );
  return file;
}

const payload = (input: Record<string, unknown>): HookStdin => ({
  kind: "payload",
  input,
});
const BY_HAND: HookStdin = { kind: "none", reason: "terminal" };

const GIT_LOG = "git log --oneline --name-only -5";

interface Recorded {
  outcome: GateOutcome;
  /** Every command line handed to a shell. */
  commands: string[];
  /** Every program run with an argument array. */
  execs: Array<{ file: string; args: string[] }>;
}

/** Run the gate in process: every base check passes unless `answers` says otherwise. */
function gate(
  box: Box,
  input: {
    stdin?: HookStdin;
    argv?: string[];
    env?: Record<string, string>;
    answers?: Record<string, { ok: boolean; output: string }>;
    bd?: Record<string, { ok: boolean; output: string }>;
  } = {},
): Recorded {
  const commands: string[] = [];
  const execs: Array<{ file: string; args: string[] }> = [];
  const answers: Record<string, { ok: boolean; output: string }> = {
    [GIT_LOG]: { ok: true, output: "abc1234 a change\nscripts/a.test.ts" },
    "git rev-parse --show-toplevel": { ok: false, output: "" },
    "git rev-parse --abbrev-ref HEAD": { ok: true, output: "feat/x" },
    ...input.answers,
  };
  const deps: GateDeps = {
    cwd: box.cwd,
    env: input.env ?? {},
    run: (cmd) => {
      commands.push(cmd);
      return answers[cmd] ?? { ok: true, output: "" };
    },
    execFile: (file, args) => {
      execs.push({ file, args: [...args] });
      return input.bd?.[args.join(" ")] ?? { ok: false, output: "" };
    },
    hasScript: () => true,
    hasTestFiles: () => true,
  };
  const outcome = runQualityGate({
    stdin: input.stdin ?? BY_HAND,
    argv: input.argv ?? [],
    deps,
  });
  return { outcome, commands, execs };
}

function ran(recorded: Recorded): Extract<GateOutcome, { kind: "ran" }> {
  if (recorded.outcome.kind !== "ran") {
    throw new Error(`gate refused: ${recorded.outcome.error}`);
  }
  return recorded.outcome;
}

function check(recorded: Recorded, name: string) {
  return ran(recorded).result.checks.find((entry) => entry.name === name);
}

const BASE_COMMANDS = [
  "bun run typecheck",
  "bun run lint",
  "bun run test",
  "git status --porcelain",
];

describe("an unbound host event", () => {
  test("TaskCompleted on stdin with no correlation runs the base gates and is logged unlinked", () => {
    const box = sandbox();
    const recorded = gate(box, {
      stdin: payload({
        hook_event_name: "TaskCompleted",
        session_id: "host-session",
        task_id: "7",
        team_name: "night-shift",
      }),
    });
    const { result } = ran(recorded);

    expect(result).toMatchObject({
      schemaVersion: 2,
      event: "TaskCompleted",
      eventSource: "stdin",
      stdin: "payload",
      beadsIssueId: null,
      executionRunId: null,
      host: {
        hostTaskScope: { kind: "agent-team", id: "night-shift" },
        hostTaskId: "7",
        completerHostSessionId: "host-session",
      },
      passed: true,
    });
    expect(result.unlinkedReason).toContain("no run correlation");
    expect("taskId" in result).toBe(false);
    expect("forgeSlug" in result).toBe(false);
    for (const command of BASE_COMMANDS) {
      expect(recorded.commands).toContain(command);
    }
    // Nothing about the issue is asked of Beads: there is no Beads id to ask with.
    expect(recorded.execs).toEqual([]);
    for (const name of ["ac-verify", "close-testing-attestation"]) {
      expect(check(recorded, name)).toMatchObject({
        skipped: true,
        skipReason: "no run correlation",
      });
    }
  });

  test("cannot satisfy strict completion, even with a passing verdict filed under the host's task id", () => {
    const box = sandbox();
    verdict(box, "host-task", {});
    const recorded = gate(box, {
      stdin: payload({
        hook_event_name: "TaskCompleted",
        task_id: "host-task",
      }),
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });
    const { result } = ran(recorded);

    expect(result.passed).toBe(false);
    expect(result.blockingFailures).toEqual(["eval-verdict"]);
    expect(check(recorded, "eval-verdict")).toMatchObject({ passed: false });
    expect(check(recorded, "eval-verdict")?.output).toContain(
      "requires a run correlation",
    );
    expect(ran(recorded).strictVerdict).toBeNull();
  });

  test("the variables that used to carry identity carry none", () => {
    const box = sandbox();
    verdict(box, "bead-1", {});
    const recorded = gate(box, {
      env: {
        CLAUDE_TASK_ID: "bead-1",
        CLAUDE_HOOK_EVENT: "TeammateIdle",
        AGENT_FORGE_BEAD_ID: "bead-1",
        FORGE_SLUG: "run-1",
        AGENT_FORGE_EVAL_VERDICT: "strict",
      },
    });
    const { result } = ran(recorded);

    expect(result.event).toBe("TaskCompleted");
    expect(result.eventSource).toBe("default");
    expect(result.beadsIssueId).toBeNull();
    expect(result.executionRunId).toBeNull();
    expect("forgeSlug" in result).toBe(false);
    expect(recorded.execs).toEqual([]);
    expect(result.blockingFailures).toEqual(["eval-verdict"]);
  });

  test("an environment pointer that does not validate leaves the run unlinked, says why, and does not block", () => {
    const box = sandbox();
    const outside = join(box.root, "elsewhere", "run-1.json");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, readFileSync(correlate(box)));
    const recorded = gate(box, { env: { [RUN_CORRELATION_ENV]: outside } });
    const { result } = ran(recorded);

    expect(result.beadsIssueId).toBeNull();
    expect(result.unlinkedReason).toBe(
      "run correlation refused: the file is outside this checkout",
    );
    expect(ran(recorded).notice).toBe(
      "run correlation refused: the file is outside this checkout",
    );
    expect(result.passed).toBe(true);
    expect(recorded.execs).toEqual([]);
  });

  test("a --correlation flag that does not validate is refused before any check runs", () => {
    const box = sandbox();
    const outside = join(box.root, "elsewhere", "run-1.json");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, readFileSync(correlate(box)));
    for (const argv of [["--correlation", outside], ["--correlation"]]) {
      const recorded = gate(box, { argv });
      expect(recorded.outcome.kind).toBe("refused");
      for (const command of BASE_COMMANDS) {
        expect(recorded.commands).not.toContain(command);
      }
      expect(recorded.execs).toEqual([]);
    }
    expect(gate(box, { argv: ["--correlation", outside] }).outcome).toEqual({
      kind: "refused",
      error: "run correlation refused: the file is outside this checkout",
    });
  });
});

describe("a correlated run", () => {
  test("takes its bead and run from the file the --correlation flag points at", () => {
    const box = sandbox();
    const recorded = gate(box, {
      argv: ["--correlation", correlate(box)],
      bd: {
        "show bead-1 --json": {
          ok: true,
          output: JSON.stringify([{ issue_type: "task" }]),
        },
        "show bead-1": { ok: true, output: "ac: it works" },
      },
    });
    const { result, correlation } = ran(recorded);

    expect<unknown>(result).toMatchObject({
      schemaVersion: 2,
      beadsIssueId: "bead-1",
      executionRunId: "run-1",
      passed: true,
    });
    expect("unlinkedReason" in result).toBe(false);
    expect(String(correlation?.beadsIssueId)).toBe("bead-1");
    expect(recorded.execs).toEqual([
      { file: "bd", args: ["show", "bead-1", "--json"] },
      { file: "bd", args: ["show", "bead-1"] },
      { file: "bd", args: ["comments", "bead-1", "--json"] },
    ]);
    expect(check(recorded, "ac-verify")).toMatchObject({
      passed: true,
      output: "AC found — verify before closing task",
    });
  });

  test("takes them from the environment pointer too, and the flag wins over it", () => {
    const box = sandbox();
    const first = correlate(box, "bead-1", "run-1");
    const second = correlate(box, "bead-2", "run-2");

    const viaEnv = ran(gate(box, { env: { [RUN_CORRELATION_ENV]: first } }));
    expect<unknown>(viaEnv.result.beadsIssueId).toBe("bead-1");

    const both = ran(
      gate(box, {
        argv: [`--correlation=${second}`],
        env: { [RUN_CORRELATION_ENV]: first },
      }),
    );
    expect<unknown>(both.result.beadsIssueId).toBe("bead-2");
    expect(both.result.executionRunId).toBe("run-2");
  });

  test("when bd cannot show the correlated issue, both issue checks say so", () => {
    const box = sandbox();
    const recorded = gate(box, { argv: ["--correlation", correlate(box)] });
    for (const name of ["ac-verify", "close-testing-attestation"]) {
      expect(check(recorded, name)).toMatchObject({
        passed: true,
        skipped: true,
        skipReason: "bd could not show the correlated issue",
      });
    }
    expect(ran(recorded).result.passed).toBe(true);
  });

  test("a feature with no testing attestation still blocks, read through the correlated bead", () => {
    const box = sandbox();
    const recorded = gate(box, {
      argv: ["--correlation", correlate(box)],
      bd: {
        "show bead-1 --json": {
          ok: true,
          output: JSON.stringify([{ issue_type: "feature" }]),
        },
        "comments bead-1 --json": { ok: true, output: "[]" },
      },
    });
    expect(ran(recorded).result.blockingFailures).toEqual([
      "close-testing-attestation",
    ]);
  });

  test("strict mode reads the verdict filed under the correlated bead and binds it", () => {
    const box = sandbox();
    verdict(box, "bead-1", { summary: "looks right" });
    const passing = gate(box, {
      argv: ["--correlation", correlate(box)],
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });
    expect(check(passing, "eval-verdict")).toMatchObject({ passed: true });
    expect(ran(passing).strictVerdict).toMatchObject({
      taskId: "bead-1",
      verdict: "PASS",
    });

    // A verdict that names another issue is not this run's verdict.
    verdict(box, "bead-1", { taskId: "bead-9" });
    const mismatched = gate(box, {
      argv: ["--correlation", correlate(box)],
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });
    expect(check(mismatched, "eval-verdict")).toMatchObject({
      passed: false,
      output: 'verdict taskId "bead-9" !== correlation beadsIssueId "bead-1"',
    });
    expect(ran(mismatched).strictVerdict).toBeNull();
  });
});

describe("hostile stdin", () => {
  const MARK = "PWNED";
  const hostile = (label: string): string =>
    `${label}-${MARK}"; echo ${MARK} > pwned.txt; $(echo ${MARK}) \`echo ${MARK}\` & echo ${MARK} | --json ../../x`;

  const everyField = (taskId: string): HookStdin =>
    payload({
      hook_event_name: "TaskCompleted",
      session_id: hostile("session"),
      transcript_path: hostile("transcript"),
      cwd: hostile("cwd"),
      task_id: taskId,
      task_subject: hostile("subject"),
      task_description: hostile("description"),
      team_name: hostile("team"),
      teammate_name: hostile("teammate"),
      [hostile("key")]: hostile("value"),
    });

  test("reaches no command line and no bd argument, linked or not", () => {
    const box = sandbox();
    const unlinked = gate(box, { stdin: everyField(hostile("task")) });
    const linked = gate(box, {
      stdin: everyField(hostile("task")),
      argv: ["--correlation", correlate(box)],
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });

    for (const recorded of [unlinked, linked]) {
      expect(recorded.commands.length).toBeGreaterThan(0);
      for (const command of recorded.commands) {
        expect(command).not.toContain(MARK);
      }
      for (const call of recorded.execs) {
        expect(call.file).toBe("bd");
        expect(call.args.join(" ")).not.toContain(MARK);
      }
    }
    expect(unlinked.execs).toEqual([]);
    expect(linked.execs.map((call) => call.args)).toEqual([
      ["show", "bead-1", "--json"],
      ["show", "bead-1"],
      ["comments", "bead-1", "--json"],
    ]);
  });

  test("appears in the result only inside the host object", () => {
    const box = sandbox();
    const { result } = ran(gate(box, { stdin: everyField(hostile("task")) }));
    const { host, ...rest } = result;
    expect(JSON.stringify(rest)).not.toContain(MARK);
    expect(JSON.stringify(host)).toContain(MARK);
    expect(Object.keys(host ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "completerHostSessionId",
      "completerTeammateName",
      "hostTaskId",
      "hostTaskScope",
    ]);
  });

  test("a host task id that is itself a plausible Beads id selects neither the bead nor the verdict", () => {
    const box = sandbox();
    // The host's id has a passing verdict on file; the correlated bead's fails.
    verdict(box, "other-bead", {});
    verdict(box, "bead-1", {
      verdict: "FAIL",
      findings: { blocker: 1, high: 0, medium: 0, low: 0 },
    });
    const recorded = gate(box, {
      stdin: payload({
        hook_event_name: "TaskCompleted",
        task_id: "other-bead",
      }),
      argv: ["--correlation", correlate(box)],
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });

    expect(recorded.execs.flatMap((call) => call.args)).not.toContain(
      "other-bead",
    );
    expect(check(recorded, "eval-verdict")).toMatchObject({ passed: false });
    expect(check(recorded, "eval-verdict")?.output).toContain(
      "verdict FAIL with blocker/high",
    );
    expect<unknown>(ran(recorded).result.beadsIssueId).toBe("bead-1");
    expect(ran(recorded).result.host).toEqual({ hostTaskId: "other-bead" });
  });
});

describe("TeammateIdle", () => {
  test("is logged as TeammateIdle and runs the base gates only, strict mode or not", () => {
    const box = sandbox();
    const recorded = gate(box, {
      stdin: payload({
        hook_event_name: "TeammateIdle",
        team_name: "night-shift",
        teammate_name: "worker-2",
      }),
      env: { AGENT_FORGE_EVAL_VERDICT: "strict" },
    });
    const { result } = ran(recorded);

    expect(result.event).toBe("TeammateIdle");
    expect(result.eventSource).toBe("stdin");
    expect(result.host).toEqual({
      hostTaskScope: { kind: "agent-team", id: "night-shift" },
      idleTeammateName: "worker-2",
    });
    expect(result.checks.map((entry) => entry.name)).toEqual([
      "typecheck",
      "lint",
      "tests",
      "clean-tree",
    ]);
    expect(recorded.commands).not.toContain(GIT_LOG);
    expect(result.passed).toBe(true);
    expect(ran(recorded).trigger).toBe("TeammateIdle");
  });

  test("a run by hand can still ask for it by name, and has no trigger", () => {
    const box = sandbox();
    const recorded = gate(box, { argv: ["TeammateIdle"] });
    expect(ran(recorded).result.event).toBe("TeammateIdle");
    expect(ran(recorded).result.eventSource).toBe("argv");
    expect(ran(recorded).trigger).toBeUndefined();
  });
});

describe("malformed stdin", () => {
  test("is refused before any check runs", () => {
    const box = sandbox();
    for (const stdin of [
      { kind: "malformed", error: "stdin is not valid JSON" } as const,
      payload({ hook_event_name: "Stop" }),
      payload({ task_id: "7" }),
      // A payload that disagrees with the command line about the event.
      payload({ hook_event_name: "TeammateIdle" }),
    ]) {
      const recorded = gate(box, { stdin, argv: ["TaskCompleted"] });
      expect(recorded.outcome.kind).toBe("refused");
      expect(recorded.commands).toEqual([]);
      expect(recorded.execs).toEqual([]);
    }
  });
});

// ── The real entrypoint, spawned ────────────────────────────────────────────

/** Nothing of the parent's is inherited except what a Windows child needs to start. */
function childEnv(
  box: Box,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_FORGE_HOME: box.home,
    HOME: box.userHome,
    USERPROFILE: box.userHome,
    PATH: box.emptyPath,
  };
  for (const name of ["SystemRoot", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

interface Spawned {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

async function spawnGate(
  box: Box,
  stdin: string | "never-closed",
  extraEnv: Record<string, string> = {},
  args: string[] = [],
): Promise<Spawned> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "run", GATE, ...args], {
    cwd: box.cwd,
    env: childEnv(box, extraEnv),
    stdin: stdin === "never-closed" ? "pipe" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  const pipe = child.stdin;
  if (typeof pipe === "object" && pipe !== null) {
    try {
      pipe.end();
    } catch {
      // The child is gone; so is its end of the pipe.
    }
  }
  return { exitCode, stdout, stderr, ms: performance.now() - started };
}

/** The lines the child appended to its (temp) gate log. */
function gateLog(box: Box): Array<Record<string, unknown>> {
  const base = join(box.userHome, ".claude", "logs", "agent-forge");
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((day) => {
    const file = join(base, day, "quality-gate.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  });
}

const SPAWN_TIMEOUT_MS = 60_000;

/**
 * A PATH on which the gate's command runner finds a shell and nothing the
 * gate asks for by name (`bun` and `bd` are not installed in system
 * directories; where `git` is, the scratch checkout is not a repository).
 */
const SHELL_ONLY_PATH =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
    : "/bin:/usr/bin";

describe("the gate entrypoint, spawned with stdin piped", () => {
  test(
    "malformed JSON fails explicitly with the blocking exit code and checks nothing",
    async () => {
      const box = sandbox();
      const out = await spawnGate(box, '{"hook_event_name": "TaskComp');
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain("quality-gate: stdin is not valid JSON");
      expect(out.stderr).toContain("Nothing was checked");
      expect(out.stdout).toBe("");
      expect(gateLog(box)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a payload for another event is refused the same way",
    async () => {
      const box = sandbox();
      const out = await spawnGate(
        box,
        JSON.stringify({ hook_event_name: "Stop", session_id: "S" }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(
        "stdin hook_event_name must be TaskCompleted or TeammateIdle",
      );
      expect(gateLog(box)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a payload over the gate's size bound is refused, however well formed",
    async () => {
      const box = sandbox();
      const out = await spawnGate(
        box,
        JSON.stringify({
          hook_event_name: "TaskCompleted",
          task_description: "x".repeat(1_200_000),
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(
        "quality-gate: stdin is larger than 1048576 bytes. Nothing was checked.",
      );
      expect(out.stdout).toBe("");
      expect(gateLog(box)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "TeammateIdle JSON with no identity variables is logged as TeammateIdle, unlinked",
    async () => {
      const box = sandbox();
      const out = await spawnGate(
        box,
        JSON.stringify({
          hook_event_name: "TeammateIdle",
          session_id: "host-session",
          cwd: box.cwd,
          team_name: "night-shift",
          teammate_name: "worker-2",
        }),
      );
      const printed = JSON.parse(out.stdout) as Record<string, unknown>;
      const [logged, ...others] = gateLog(box);

      expect(others).toEqual([]);
      expect(logged).toEqual(printed);
      expect(logged).toMatchObject({
        schemaVersion: 2,
        event: "TeammateIdle",
        eventSource: "stdin",
        stdin: "payload",
        beadsIssueId: null,
        executionRunId: null,
        host: {
          hostTaskScope: { kind: "agent-team", id: "night-shift" },
          idleTeammateName: "worker-2",
        },
      });
      expect(
        (logged?.checks as Array<{ name: string }>).map((entry) => entry.name),
      ).toEqual(["typecheck", "lint", "tests", "clean-tree"]);
      // In this sandbox `bun` and `git` are not on PATH, so the gate itself fails.
      expect(out.exitCode).toBe(2);

      const [event] = queryEvents(
        { kinds: ["gate.ran"] },
        { path: box.ledger },
      );
      expect(event?.payload).toMatchObject({
        gate: "quality-gate",
        passed: false,
        exitCode: 2,
        trigger: "TeammateIdle",
      });
      expect(event?.beadId).toBeUndefined();
      expect(event?.runId).toBeUndefined();
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "TaskCompleted JSON with a launcher's pointer in the environment is logged with the correlation's ids, not the host's",
    async () => {
      const box = sandbox();
      const pointer = correlate(box, "bead-1", "run-1");
      verdict(box, "bead-1", { summary: "looks right" });
      // Unlike the other spawned cases this one can reach a shell (and nothing
      // else), so a host id spliced into a command line would run: under
      // cmd.exe and under sh alike, this one writes the canary file.
      const hostileTaskId =
        "x & echo PWNED > pwned.txt & rem ; echo PWNED > pwned.txt #";
      const out = await spawnGate(
        box,
        JSON.stringify({
          hook_event_name: "TaskCompleted",
          session_id: "host-session",
          cwd: box.cwd,
          task_id: hostileTaskId,
        }),
        {
          [RUN_CORRELATION_ENV]: pointer,
          AGENT_FORGE_EVAL_VERDICT: "strict",
          PATH: SHELL_ONLY_PATH,
        },
      );
      const [logged] = gateLog(box);

      expect(logged).toMatchObject({
        schemaVersion: 2,
        event: "TaskCompleted",
        eventSource: "stdin",
        beadsIssueId: "bead-1",
        executionRunId: "run-1",
        host: {
          hostTaskId: hostileTaskId,
          completerHostSessionId: "host-session",
        },
      });
      expect(logged && "unlinkedReason" in logged).toBe(false);
      expect(logged && "taskId" in logged).toBe(false);
      const strict = (
        logged?.checks as Array<{
          name: string;
          passed: boolean;
          output?: string;
        }>
      ).find((entry) => entry.name === "eval-verdict");
      // The verdict read is the one filed under the correlated bead.
      expect(strict).toMatchObject({ passed: true, output: "PASS B=0 H=0" });
      expect(existsSync(join(box.cwd, "pwned.txt"))).toBe(false);
      // The base checks still fail here: no bun and no usable git.
      expect(out.exitCode).toBe(2);

      // Both ledger rows carry the correlation's bead and run.
      const events = queryEvents(
        { kinds: ["gate.ran", "verdict.bound"] },
        { path: box.ledger },
      );
      expect(events.map((event) => event.kind)).toEqual([
        "verdict.bound",
        "gate.ran",
      ]);
      for (const event of events) {
        expect(event.beadId).toBe("bead-1");
        expect(event.runId).toBe("run-1");
      }
      expect(events[0]?.payload).toMatchObject({
        verdict: "pass",
        summary: "looks right",
      });
      expect(events[1]?.payload).toMatchObject({ trigger: "TaskCompleted" });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a --correlation flag that points at nothing fails explicitly; an environment pointer that does is reported and logged unlinked",
    async () => {
      const box = sandbox();
      const missing = join(
        box.cwd,
        ".tmp",
        "work",
        "run-correlations",
        "x.json",
      );

      const flagged = await spawnGate(box, "", {}, ["--correlation", missing]);
      expect(flagged.exitCode).toBe(2);
      expect(flagged.stderr).toContain(
        "quality-gate: run correlation refused: the pointer names no readable file. Nothing was checked.",
      );
      expect(flagged.stdout).toBe("");
      expect(gateLog(box)).toEqual([]);

      const viaEnv = await spawnGate(box, "", {
        [RUN_CORRELATION_ENV]: missing,
      });
      expect(viaEnv.stderr).toContain(
        "quality-gate: run correlation refused: the pointer names no readable file",
      );
      expect(viaEnv.stderr).not.toContain("Nothing was checked");
      const [logged] = gateLog(box);
      expect(logged).toMatchObject({
        beadsIssueId: null,
        executionRunId: null,
        unlinkedReason:
          "run correlation refused: the pointer names no readable file",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "empty piped input is a run with no payload: the default event, no trigger",
    async () => {
      const box = sandbox();
      await spawnGate(box, "");
      const [logged] = gateLog(box);
      expect(logged).toMatchObject({
        event: "TaskCompleted",
        eventSource: "default",
        stdin: "empty",
        beadsIssueId: null,
      });
      expect(logged && "host" in logged).toBe(false);
      const [event] = queryEvents(
        { kinds: ["gate.ran"] },
        { path: box.ledger },
      );
      expect(event?.payload && "trigger" in event.payload).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a pipe nobody closes cannot hang the hook",
    async () => {
      const box = sandbox();
      const out = await spawnGate(box, "never-closed");
      const [logged] = gateLog(box);
      // Recorded as a payload that never came, not as a run by hand.
      expect(logged).toMatchObject({
        event: "TaskCompleted",
        eventSource: "default",
        stdin: "silent",
      });
      expect(out.exitCode).toBe(2);
      expect(out.ms).toBeLessThan(30_000);
    },
    SPAWN_TIMEOUT_MS,
  );
});
