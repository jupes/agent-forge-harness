/**
 * The real hook scripts, spawned with a hook payload piped on stdin.
 *
 * These prove what the scripts do with a given input. They do not prove that a
 * live session calls them: that is the manual walkthrough's job.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import type { LedgerEvent } from "../../types/hearth";
import { closeLedger } from "./db";
import {
  readSessionMirror,
  removeSessionMirror,
  resolveAttach,
} from "./identity";
import { queryEvents } from "./query";
import { getSessionModel } from "./session-models";

const ROOT = join(import.meta.dir, "..", "..");
const HOOKS = join(ROOT, ".claude", "hooks");
const SESSION = join(HOOKS, "session.ts");
const LEDGER_HOOK = join(HOOKS, "ledger-hook.ts");
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
const SPAWN_TIMEOUT_MS = 60_000;

const temporary: string[] = [];

interface Box {
  cwd: string;
  /** `AGENT_FORGE_HOME` for the children. */
  home: string;
  /** `HOME` / `USERPROFILE` for the children: where the session log lands. */
  userHome: string;
  /** An empty directory used as `PATH`, so neither `bd` nor `git` can run. */
  emptyPath: string;
  path: string;
}

function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "ledger hooks test "));
  temporary.push(root);
  const box = {
    cwd: join(root, "check out"),
    home: join(root, "forge home"),
    userHome: join(root, "user home"),
    emptyPath: join(root, "empty path"),
    path: join(root, "forge home", "ledger.db"),
  };
  mkdirSync(join(box.cwd, ".git"), { recursive: true });
  mkdirSync(box.userHome, { recursive: true });
  mkdirSync(box.emptyPath, { recursive: true });
  return box;
}

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

/**
 * A from-scratch environment: nothing of the parent's is inherited except what
 * a Windows child needs to start, so no live session id, run or ledger leaks
 * in and no real `bd` or `git` is reachable.
 */
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

interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function hook(
  box: Box,
  script: string,
  stdin: unknown,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
): Promise<Ran> {
  const body = typeof stdin === "string" ? stdin : JSON.stringify(stdin);
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    cwd: box.cwd,
    env: childEnv(box, extraEnv),
    stdin: new Blob([body]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

function events(box: Box): LedgerEvent[] {
  return existsSync(box.path) ? queryEvents({}, { path: box.path }) : [];
}

/** The lines the children wrote to their (temp) session log. */
function sessionLog(box: Box): Array<Record<string, unknown>> {
  const base = join(box.userHome, ".claude", "logs", "agent-forge");
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((day) => {
    const file = join(base, day, "session.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  });
}

/**
 * An environment whose whole `PATH` is one directory holding one program: a
 * `bd` that appends its arguments to a file. Which `bd` commands a hook ran can
 * then be read back, and no real `bd` or `git` is reachable.
 */
function recordingBd(box: Box): {
  env: Record<string, string>;
  calls(): string[];
} {
  const dir = join(box.emptyPath, "..", "recording bd");
  const record = join(dir, "bd calls.txt");
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "bd.cmd"),
      '@echo off\r\n>>"%RECORDING_BD_FILE%" echo %*\r\n',
    );
  } else {
    const program = join(dir, "bd");
    writeFileSync(program, '#!/bin/sh\necho "$@" >> "$RECORDING_BD_FILE"\n');
    chmodSync(program, 0o755);
  }
  // The shell a Windows child runs a command line through.
  const shell = process.env.ComSpec;
  return {
    env: {
      PATH: dir,
      RECORDING_BD_FILE: record,
      ...(shell !== undefined ? { ComSpec: shell } : {}),
    },
    calls: () =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        : [],
  };
}

function payload(
  event: string,
  box: Box,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { hook_event_name: event, session_id: "S", cwd: box.cwd, ...extra };
}

interface HookCommand {
  command: string;
  async?: boolean;
  timeout?: number;
}

/** Every command registered for an event in the project's settings file. */
function registered(event: string): HookCommand[] {
  const settings = JSON.parse(
    readFileSync(join(HOOKS, "..", "settings.json"), "utf8"),
  ) as { hooks: Record<string, Array<{ hooks: HookCommand[] }>> };
  return (settings.hooks[event] ?? []).flatMap((entry) => entry.hooks);
}

describe("the hook registration in .claude/settings.json", () => {
  test("the ledger command is registered async for prompts, tool calls and stops", () => {
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
      const ledger = registered(event).filter((hook) =>
        hook.command.includes("ledger-hook.ts"),
      );
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.async).toBe(true);
    }
  });

  test("SessionEnd runs the session script and waits for it, and the hooks that were there before are still registered", () => {
    // Nothing is asserted about the registration's `timeout`: it was sized for
    // a tracker push that the hook no longer makes.
    const end = registered("SessionEnd");
    expect(end).toHaveLength(1);
    expect(end[0]?.command).toContain("session.ts");
    expect(end[0]?.async).toBeUndefined();

    const commands = (event: string) =>
      registered(event).map((hook) => hook.command);
    expect(commands("SessionStart")).toEqual([
      "bd dolt start 2>/dev/null || true",
      "bd prime 2>/dev/null || true",
      "bun run agents-md validate --hook",
      "bun run .claude/hooks/session.ts",
    ]);
    expect(commands("Stop")[0]).toBe(
      "bun run .claude/hooks/forge-phase-gate.ts --stop-hook",
    );
    expect(commands("TaskCompleted")).toEqual([
      "bun run .claude/hooks/quality-gate.ts",
    ]);
    expect(commands("TeammateIdle")).toEqual([
      "bun run .claude/hooks/quality-gate.ts",
    ]);
    expect(commands("PreCompact")).toEqual(["bd prime 2>/dev/null || true"]);
    expect(commands("PreToolUse")).toHaveLength(1);
  });
});

describe("the hook scripts, given a hook payload on stdin", () => {
  test(
    "the four hook payloads produce four events with one session id and an executor",
    async () => {
      const box = sandbox();
      const runs = [
        await hook(
          box,
          SESSION,
          payload("SessionStart", box, { source: "startup", model: "m-1" }),
        ),
        await hook(
          box,
          LEDGER_HOOK,
          payload("UserPromptSubmit", box, { prompt: "run git status" }),
        ),
        await hook(
          box,
          LEDGER_HOOK,
          payload("PostToolUse", box, {
            tool_name: "Bash",
            tool_input: { command: "git status" },
            effort: { level: "high" },
            duration_ms: 12,
          }),
        ),
        await hook(
          box,
          SESSION,
          payload("SessionEnd", box, { reason: "logout" }),
        ),
      ];
      expect(runs.map((ran) => ran.exitCode)).toEqual([0, 0, 0, 0]);
      // Only SessionStart has anything to say to the host.
      expect(runs.slice(1).map((ran) => ran.stdout)).toEqual(["", "", ""]);

      const stored = events(box);
      expect(stored.map((event) => event.kind)).toEqual([
        "session.started",
        "prompt.submitted",
        "tool.called",
        "session.ended",
      ]);
      for (const event of stored) {
        expect(event.sessionId).toBe("S");
        expect(event.executor?.provider).toBe("claude");
        expect(event.executor?.model).toBe("m-1");
      }
      expect(stored[2]?.payload).toMatchObject({
        tool: "Bash",
        durationMs: 12,
      });
      expect(stored[2]?.executor?.effort).toBe("high");
      expect(stored[3]?.payload).toEqual({ reason: "logout" });

      const log = sessionLog(box);
      expect(log.some((line) => line.event === "SessionStart")).toBe(true);
      // A session end is one log line, and it says nothing of a push.
      const endLines = log.filter((line) => line.event === "SessionEnd");
      expect(endLines).toHaveLength(1);
      expect(log.some((line) => "push" in line)).toBe(false);
      // The end of the session is recorded before the slower work of the hook:
      // the git calls behind the log line.
      const [endLine] = endLines;
      expect("git" in (endLine ?? {})).toBe(true);
      expect(typeof endLine?.timestamp).toBe("string");
      expect((stored[3]?.ts ?? "") <= String(endLine?.timestamp)).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a script launched after SessionStart is tagged with that session",
    async () => {
      const box = sandbox();
      const ran = await hook(
        box,
        SESSION,
        payload("SessionStart", box, { source: "startup", model: "m-1" }),
      );
      expect(ran.exitCode).toBe(0);

      expect(readSessionMirror(box.cwd)).toBe("S");
      const viaMirror = resolveAttach({
        cwd: box.cwd,
        env: {},
        path: box.path,
      });
      expect(viaMirror.sessionId).toBe("S");
      expect(viaMirror.executor).toEqual({
        provider: "claude",
        model: "m-1",
        sessionId: "S",
      });

      // Once the mirror is gone nothing ties a script to the session.
      expect(removeSessionMirror(box.cwd, "S")).toBe(true);
      const after = resolveAttach({ cwd: box.cwd, env: {}, path: box.path });
      expect("sessionId" in after).toBe(false);
      expect("executor" in after).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a Stop payload updates the session's cached model from its transcript file and stores no event",
    async () => {
      const box = sandbox();
      const transcript = join(box.cwd, "transcript file.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "assistant", effort: "low", message: { model: "m-from-transcript" } })}\n`,
      );
      const ran = await hook(
        box,
        LEDGER_HOOK,
        payload("Stop", box, { transcript_path: transcript }),
      );
      expect(ran).toMatchObject({ exitCode: 0, stdout: "" });
      expect(getSessionModel("S", { path: box.path })).toEqual({
        provider: "claude",
        model: "m-from-transcript",
        effort: "low",
      });
      expect(events(box)).toHaveLength(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a hook given empty, non-JSON or unknown-event stdin exits 0 and stores nothing",
    async () => {
      const box = sandbox();
      const inputs: unknown[] = [
        "",
        "not json {",
        "[1, 2, 3]",
        payload("SomethingElse", box, { tool_name: "Bash", prompt: "hi" }),
        { session_id: "S", tool_name: "Bash" },
      ];
      for (const stdin of inputs) {
        const ran = await hook(box, LEDGER_HOOK, stdin);
        expect(ran).toMatchObject({ exitCode: 0, stdout: "" });
      }
      expect(events(box)).toHaveLength(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "the session script run by hand, with no payload, logs a session start and stores no event",
    async () => {
      const box = sandbox();
      for (const stdin of ["", "not json {"]) {
        const ran = await hook(box, SESSION, stdin);
        expect(ran.exitCode).toBe(0);
        expect(ran.stdout).toContain("[session] SessionStart logged.");
      }
      expect(events(box)).toHaveLength(0);
      expect(readSessionMirror(box.cwd)).toBeNull();
      expect(sessionLog(box).map((line) => line.event)).toEqual([
        "SessionStart",
        "SessionStart",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "the session script named SessionEnd on its command line, with no usable payload, ends the session quietly instead of starting one",
    async () => {
      const box = sandbox();
      for (const stdin of ["", "not json {"]) {
        const ran = await hook(box, SESSION, stdin, {}, ["SessionEnd"]);
        expect(ran).toMatchObject({ exitCode: 0, stdout: "" });
      }
      // No session id arrived, so there is no session to end in the ledger.
      expect(events(box)).toHaveLength(0);
      // Each run wrote its one log line, saying where the event name came from and nothing of a push.
      const log = sessionLog(box);
      expect(log.map((line) => [line.event, line.eventSource])).toEqual([
        ["SessionEnd", "argv"],
        ["SessionEnd", "argv"],
      ]);
      expect(log.every((line) => "git" in line && !("push" in line))).toBe(
        true,
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "the session script named SessionEnd on its command line, whose stdin stays open and silent, still ends rather than starts",
    async () => {
      const box = sandbox();
      const child = Bun.spawn(
        [process.execPath, "run", SESSION, "SessionEnd"],
        {
          cwd: box.cwd,
          env: childEnv(box),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      child.stdin.end();
      expect(stdout).toBe("");
      expect(sessionLog(box).map((line) => line.event)).toEqual(["SessionEnd"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a payload on stdin outranks the command line, and SessionStart on the command line alone starts a session log entry",
    async () => {
      const box = sandbox();
      const fromStdin = await hook(
        box,
        SESSION,
        payload("SessionStart", box, { source: "startup", model: "m-1" }),
        {},
        ["SessionEnd"],
      );
      expect(fromStdin.stdout).toContain("[session] SessionStart logged.");
      expect(events(box).map((event) => event.kind)).toEqual([
        "session.started",
      ]);

      const fromArgv = await hook(box, SESSION, "", {}, ["SessionStart"]);
      expect(fromArgv.stdout).toContain("[session] SessionStart logged.");
      expect(
        sessionLog(box)
          .filter((line) => "git" in line)
          .map((line) => [line.event, line.eventSource]),
      ).toEqual([
        ["SessionStart", "stdin"],
        ["SessionStart", "argv"],
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a session end runs no bd command: a recording bd on the PATH sees the session start's pull and nothing from a session end, with a payload or without one",
    async () => {
      const box = sandbox();
      const bd = recordingBd(box);
      const started = await hook(
        box,
        SESSION,
        payload("SessionStart", box, { source: "startup", model: "m-1" }),
        bd.env,
      );
      expect(started.exitCode).toBe(0);
      // The control: the hook reaches the recording `bd`, so a record that
      // does not grow below means no call was made, not that `bd` was missing.
      const atStart = bd.calls();
      expect(atStart).toContain("dolt pull");

      const ended = [
        await hook(
          box,
          SESSION,
          payload("SessionEnd", box, { reason: "logout" }),
          bd.env,
        ),
        await hook(box, SESSION, "", bd.env, ["SessionEnd"]),
      ];
      expect(ended.map((ran) => ran.exitCode)).toEqual([0, 0]);
      expect(events(box).map((event) => event.kind)).toEqual([
        "session.started",
        "session.ended",
      ]);
      expect(bd.calls()).toEqual(atStart);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a hook inside an adapter child stores nothing",
    async () => {
      const box = sandbox();
      const adapter = { AGENT_FORGE_ADAPTER: "1" };
      const runs = [
        await hook(
          box,
          SESSION,
          payload("SessionStart", box, { model: "m-1" }),
          adapter,
        ),
        await hook(
          box,
          LEDGER_HOOK,
          payload("UserPromptSubmit", box, { prompt: "hi" }),
          adapter,
        ),
        await hook(
          box,
          LEDGER_HOOK,
          payload("PostToolUse", box, { tool_name: "Bash" }),
          adapter,
        ),
        await hook(box, SESSION, payload("SessionEnd", box), adapter),
      ];
      expect(runs.map((ran) => ran.exitCode)).toEqual([0, 0, 0, 0]);
      expect(events(box)).toHaveLength(0);
      expect(readSessionMirror(box.cwd)).toBeNull();
      // The child still logs its start and its end, one line each.
      expect(sessionLog(box).map((line) => line.event)).toEqual([
        "SessionStart",
        "SessionEnd",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  for (const ledger of ["an already created", "an empty"] as const) {
    test(
      `eight concurrent tool-call hooks for a new subagent against ${ledger} ledger all exit 0, never leave a second session.started and lose at most one tool.called`,
      async () => {
        const box = sandbox();
        if (ledger === "an already created") {
          const first = await hook(
            box,
            LEDGER_HOOK,
            payload("UserPromptSubmit", box, { prompt: "warm up" }),
          );
          expect(first.exitCode).toBe(0);
          expect(events(box)).toHaveLength(1);
          closeLedger();
        }
        const runs = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            hook(
              box,
              LEDGER_HOOK,
              payload("PostToolUse", box, {
                agent_id: "A",
                tool_name: "Grep",
                tool_input: { pattern: `p-${index}` },
              }),
            ),
          ),
        );
        expect(runs.map((ran) => ran.exitCode)).toEqual(Array(8).fill(0));

        const child = events(box).filter((event) => event.sessionId === "S:A");
        const started = child.filter(
          (event) => event.kind === "session.started",
        );
        const tools = child.filter((event) => event.kind === "tool.called");
        // A writer that stays locked out past its retry drops its event by
        // design, so the count is bounded rather than exact.
        expect(started.length).toBeLessThanOrEqual(1);
        expect(tools.length).toBeGreaterThanOrEqual(7);
        expect(tools.length).toBeLessThanOrEqual(8);
        expect(started.length + tools.length).toBeGreaterThanOrEqual(8);
        for (const event of started)
          expect(event.payload).toMatchObject({
            kind: "subagent",
            parentSessionId: "S",
          });
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  test(
    "the probe writes key names only",
    async () => {
      const box = sandbox();
      const ran = await hook(
        box,
        LEDGER_HOOK,
        payload("PostToolUse", box, {
          tool_name: "Bash",
          tool_input: { command: `echo ${SECRET}` },
          effort: { level: "high" },
        }),
        {
          AGENT_FORGE_HOOK_PROBE: "1",
          CLAUDE_CODE_SESSION_ID: "S",
          CLAUDE_CODE_HOST_SESSION_ID: "host-session-value",
          CLAUDE_SECRET_THING: SECRET,
        },
      );
      expect(ran.exitCode).toBe(0);
      const file = join(box.home, "hook-probe.jsonl");
      const text = readFileSync(file, "utf8");
      const [line] = text.trim().split("\n");
      expect(JSON.parse(line ?? "{}")).toMatchObject({
        event: "PostToolUse",
        keys: expect.arrayContaining(["session_id", "tool_input", "effort"]),
        effortKeys: ["level"],
        env: expect.arrayContaining(["CLAUDE_CODE_SESSION_ID"]),
        sessionIdEquals: {
          CLAUDE_CODE_SESSION_ID: true,
          CLAUDE_CODE_HOST_SESSION_ID: false,
          CLAUDE_CODE_CHILD_SESSION: null,
        },
      });
      for (const value of [SECRET, "host-session-value", "git status", "high"])
        expect(text).not.toContain(value);
      // Without the switch nothing is probed.
      rmSync(file);
      await hook(
        box,
        LEDGER_HOOK,
        payload("PostToolUse", box, { tool_name: "Bash" }),
      );
      expect(existsSync(file)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );
});

/**
 * `dolt` then `push` with nothing between them but quotes, commas, brackets,
 * plus signs and white space: the tracker push typed out as a command, or its
 * arguments as neighbouring array elements. It reads text, so it cannot see a
 * command put together while running, and it also flags a comment that types
 * the command out.
 */
const TRACKER_PUSH = /\bdolt\b["'`\s,+[\]]*\bpush\b/gi;

/** The line numbers on which the tracker push is typed out in `text`. */
function trackerPushLines(text: string): number[] {
  return [...text.matchAll(TRACKER_PUSH)].map(
    (match) => text.slice(0, match.index ?? 0).split("\n").length,
  );
}

/** Every file under `dir` except Markdown (prose is not a code path) and installed packages. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".md") ? [] : [path];
  });
}

describe("nothing in the repository's hooks or scripts pushes the tracker", () => {
  // Spelled apart from the rest so this file does not type the command out itself.
  const verb = "push";

  test("the pattern finds the tracker push typed as a command or as arguments, and not a pull or another push", () => {
    for (const text of [
      `bd dolt ${verb}`,
      `execFileSync("bd", ["dolt", "${verb}"], { stdio: "ignore" })`,
      `spawn("bd", ['dolt','${verb}'])`,
      `run(\`bd  dolt\n  ${verb} 2>&1\`)`,
      `"bd dolt " + "${verb}"`,
      `BD DOLT ${verb.toUpperCase()}`,
    ])
      expect(trackerPushLines(text)).toHaveLength(1);
    for (const text of [
      "bd dolt pull",
      "bd dolt start 2>/dev/null || true",
      "bd dolt status && git push origin",
      "temporary.push(root)",
      "args.push('dolt')",
    ])
      expect(trackerPushLines(text)).toHaveLength(0);
    expect(trackerPushLines(`one\ntwo bd dolt ${verb}\nthree`)).toEqual([2]);
  });

  test("no file under .claude/hooks or scripts types out the tracker push", () => {
    const files = [HOOKS, join(ROOT, "scripts")].flatMap(sourceFiles);
    // The walk reached both trees, the session hook and this file among them.
    expect(files).toContain(SESSION);
    expect(files).toContain(join(import.meta.dir, "hooks.test.ts"));
    const found = files.flatMap((file) =>
      trackerPushLines(readFileSync(file, "utf8")).map(
        (line) => `${relative(ROOT, file).replaceAll("\\", "/")}:${line}`,
      ),
    );
    expect(found).toEqual([]);
  });

  test("no hook command registered in .claude/settings.json and no package.json script is the tracker push", () => {
    const settings = JSON.parse(
      readFileSync(join(HOOKS, "..", "settings.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ hooks: HookCommand[] }>> };
    const commands = Object.entries(settings.hooks).flatMap(
      ([event, entries]) =>
        entries.flatMap((entry) =>
          entry.hooks.map((hook) => ({ where: event, text: hook.command })),
        ),
    );
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const scripts = Object.entries(manifest.scripts).map(([name, text]) => ({
      where: `package.json ${name}`,
      text,
    }));
    // Both lists were read: the session script is registered, and `test` exists.
    expect(commands.map((entry) => entry.where)).toContain("SessionEnd");
    expect(scripts.map((entry) => entry.where)).toContain("package.json test");
    expect(
      [...commands, ...scripts]
        .filter((entry) => trackerPushLines(entry.text).length > 0)
        .map((entry) => entry.where),
    ).toEqual([]);
  });
});
