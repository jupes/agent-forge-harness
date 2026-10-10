import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEvent, LedgerEventInput } from "../../types/hearth";
import { closeLedger, openLedger } from "./db";
import {
  effortLevel,
  type HookDeps,
  handlePrompt,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleToolUse,
  hookDeps,
  probeKeys,
  sessionIdentity,
} from "./hook-events";
import {
  readSessionMirror,
  resolveAttach,
  writeSessionMirror,
} from "./identity";
import { queryEvents } from "./query";
import { getSessionModel } from "./session-models";
import type { TranscriptModel } from "./transcript-model";

const temporary: string[] = [];

interface Box {
  cwd: string;
  path: string;
  home: string;
}

/** A scratch checkout and its own ledger, both under a path with a space. */
function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "hook events test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  const home = join(root, "forge home");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return { cwd, home, path: join(home, "ledger.db") };
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  deps: HookDeps;
  /** How many times a transcript was read. */
  transcriptReads: string[];
}

function harness(
  box: Box,
  opts: {
    env?: Record<string, string>;
    transcript?: TranscriptModel | null;
    now?: () => Date;
  } = {},
): Harness {
  const transcriptReads: string[] = [];
  const deps: HookDeps = {
    ...hookDeps({
      env: opts.env ?? {},
      cwd: box.cwd,
      path: box.path,
      ...(opts.now ? { now: opts.now } : {}),
    }),
    readTranscript: (path) => {
      transcriptReads.push(path);
      return opts.transcript ?? null;
    },
  };
  return { deps, transcriptReads };
}

function events(box: Box): LedgerEvent[] {
  return queryEvents({}, { path: box.path });
}

/** Every column of every stored row, as one string: what a reader of the file could see. */
function storedText(box: Box): string {
  return JSON.stringify(
    openLedger(box.path).query("SELECT * FROM events").all(),
  );
}

const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";

describe("session identity from a hook payload", () => {
  test("a payload without a session id has no identity and stores nothing", () => {
    const box = sandbox();
    const { deps } = harness(box);
    expect(sessionIdentity({ hook_event_name: "PostToolUse" })).toBeNull();
    handleToolUse({ hook_event_name: "PostToolUse", tool_name: "Bash" }, deps);
    handlePrompt({ hook_event_name: "UserPromptSubmit", prompt: "hi" }, deps);
    expect(events(box)).toHaveLength(0);
  });

  test("an effort is its level whether stdin sends an object or a string, and anything else is ignored", () => {
    expect(effortLevel({ effort: { level: "high" } })).toBe("high");
    expect(effortLevel({ effort: "low" })).toBe("low");
    expect(effortLevel({ effort: { level: 3 } })).toBeUndefined();
    expect(effortLevel({ effort: ["high"] })).toBeUndefined();
    expect(effortLevel({})).toBeUndefined();
  });
});

describe("prompt and tool events are metadata only", () => {
  test("a prompt is stored as its hash and length, never its text", () => {
    const box = sandbox();
    const { deps } = harness(box);
    const prompt = `please deploy with ${SECRET} right now`;
    handlePrompt(
      { hook_event_name: "UserPromptSubmit", session_id: "S", prompt },
      deps,
    );
    const [event] = events(box);
    expect(event?.kind).toBe("prompt.submitted");
    expect(event?.sessionId).toBe("S");
    expect(event?.payload).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      length: prompt.length,
    });
    const stored = storedText(box);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("please deploy");
  });

  test("a tool call stores the tool name and a hash of its input, never the input or the response", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleToolUse(
      {
        hook_event_name: "PostToolUse",
        session_id: "S",
        tool_name: "Bash",
        tool_input: { command: `curl -H "x-api-key: ${SECRET}" example.test` },
        tool_response: { stdout: "the response body marker" },
      },
      deps,
    );
    const [event] = events(box);
    expect(event?.kind).toBe("tool.called");
    expect(event?.payload).toEqual({
      tool: "Bash",
      argsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const stored = storedText(box);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("example.test");
    expect(stored).not.toContain("the response body marker");
  });

  test("two different tool inputs hash differently and the same input hashes the same", () => {
    const box = sandbox();
    const { deps } = harness(box);
    for (const command of ["ls", "ls", "pwd"])
      handleToolUse(
        {
          hook_event_name: "PostToolUse",
          session_id: "S",
          tool_name: "Bash",
          tool_input: { command },
        },
        deps,
      );
    const hashes = events(box).map((event) =>
      event.kind === "tool.called" ? event.payload.argsHash : "",
    );
    expect(hashes[0]).toBe(hashes[1] ?? "");
    expect(hashes[0]).not.toBe(hashes[2] ?? "");
  });

  test("duration is recorded when stdin supplies it and exit code never is", () => {
    const box = sandbox();
    const { deps } = harness(box);
    const base = {
      hook_event_name: "PostToolUse",
      session_id: "S",
      tool_name: "Read",
      tool_input: {},
    };
    handleToolUse(
      { ...base, duration_ms: 12.4, exit_code: 1, exitCode: 1 },
      deps,
    );
    handleToolUse(base, deps);
    handleToolUse({ ...base, duration_ms: "slow" }, deps);
    const payloads = events(box).map((event) => event.payload);
    expect(payloads[0]).toEqual({
      tool: "Read",
      argsHash: expect.any(String),
      durationMs: 12,
    });
    expect(Object.keys(payloads[1] ?? {}).sort()).toEqual(["argsHash", "tool"]);
    expect(Object.keys(payloads[2] ?? {}).sort()).toEqual(["argsHash", "tool"]);
  });

  test("the bead and run named in the environment are carried on hook events", () => {
    const box = sandbox();
    const { deps } = harness(box, {
      env: { AGENT_FORGE_BEAD_ID: "bead-7", FORGE_SLUG: "run-7" },
    });
    handlePrompt(
      { hook_event_name: "UserPromptSubmit", session_id: "S", prompt: "go" },
      deps,
    );
    const [event] = events(box);
    expect(event?.beadId).toBe("bead-7");
    expect(event?.runId).toBe("run-7");
  });
});

describe("executor identity on hook events", () => {
  test("a model on SessionStart tags the session's start and every later event", () => {
    const box = sandbox();
    const { deps, transcriptReads } = harness(box);
    handleSessionStart(
      {
        hook_event_name: "SessionStart",
        session_id: "S",
        source: "startup",
        model: "m-1",
      },
      deps,
    );
    handleToolUse(
      { hook_event_name: "PostToolUse", session_id: "S", tool_name: "Bash" },
      deps,
    );
    const stored = events(box);
    expect(stored.map((event) => event.kind)).toEqual([
      "session.started",
      "tool.called",
    ]);
    for (const event of stored)
      expect(event.executor).toEqual({
        provider: "claude",
        model: "m-1",
        sessionId: "S",
      });
    expect(stored[0]?.payload).toEqual({
      source: "startup",
      kind: "interactive",
      worktree: expect.stringContaining("check out"),
    });
    expect(transcriptReads).toHaveLength(0);
  });

  test("an effort object on stdin is stored as its level", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleSessionStart(
      { hook_event_name: "SessionStart", session_id: "S", model: "m-1" },
      deps,
    );
    const tool = {
      hook_event_name: "PostToolUse",
      session_id: "S",
      tool_name: "Bash",
    };
    handleToolUse({ ...tool, effort: { level: "high" } }, deps);
    handleToolUse({ ...tool, effort: { depth: 9 } }, deps);
    const [, withLevel, oddShape] = events(box);
    expect(withLevel?.executor?.effort).toBe("high");
    // The level seen on the earlier call is remembered for the session; the
    // odd shape itself contributes nothing and the event is still stored.
    expect(oddShape?.kind).toBe("tool.called");
    expect(oddShape?.executor?.effort).toBe("high");
    expect(getSessionModel("S", { path: box.path })?.effort).toBe("high");
  });

  test("an unexpected effort shape leaves the event stored with a model and no effort", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleSessionStart(
      { hook_event_name: "SessionStart", session_id: "S", model: "m-1" },
      deps,
    );
    handleToolUse(
      {
        hook_event_name: "PostToolUse",
        session_id: "S",
        tool_name: "Bash",
        effort: { depth: 9 },
      },
      deps,
    );
    const [, event] = events(box);
    expect(event?.executor).toEqual({
      provider: "claude",
      model: "m-1",
      sessionId: "S",
    });
  });

  test("with no model on SessionStart the first tool call reads the transcript once and later events are tagged", () => {
    const box = sandbox();
    const { deps, transcriptReads } = harness(box, {
      transcript: { model: "m-transcript", effort: "medium" },
    });
    handleSessionStart(
      { hook_event_name: "SessionStart", session_id: "S", source: "clear" },
      deps,
    );
    handlePrompt(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "S",
        prompt: "go",
        transcript_path: "t.jsonl",
      },
      deps,
    );
    const tool = {
      hook_event_name: "PostToolUse",
      session_id: "S",
      tool_name: "Bash",
      transcript_path: "t.jsonl",
    };
    handleToolUse(tool, deps);
    handleToolUse(tool, deps);
    handlePrompt(
      { hook_event_name: "UserPromptSubmit", session_id: "S", prompt: "more" },
      deps,
    );

    const stored = events(box);
    expect(stored.map((event) => event.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.called",
      "tool.called",
      "prompt.submitted",
    ]);
    // Before any assistant turn there is nothing to read the model from.
    expect("executor" in (stored[0] ?? {})).toBe(false);
    expect("executor" in (stored[1] ?? {})).toBe(false);
    for (const event of stored.slice(2))
      expect(event.executor).toEqual({
        provider: "claude",
        model: "m-transcript",
        effort: "medium",
        sessionId: "S",
      });
    expect(transcriptReads).toEqual(["t.jsonl"]);
  });

  test("with no model anywhere the events carry no executor", () => {
    const box = sandbox();
    const { deps } = harness(box, { transcript: null });
    handleSessionStart(
      { hook_event_name: "SessionStart", session_id: "S" },
      deps,
    );
    handleToolUse(
      {
        hook_event_name: "PostToolUse",
        session_id: "S",
        tool_name: "Bash",
        transcript_path: "t.jsonl",
        effort: { level: "high" },
      },
      deps,
    );
    const stored = events(box);
    expect(stored).toHaveLength(2);
    for (const event of stored) expect("executor" in event).toBe(false);
  });

  test("a stop refreshes the session's cached model from the transcript and stores no event", () => {
    const box = sandbox();
    const { deps } = harness(box, {
      transcript: { model: "m-switched", effort: "low" },
    });
    handleSessionStart(
      { hook_event_name: "SessionStart", session_id: "S", model: "m-1" },
      deps,
    );
    handleStop(
      {
        hook_event_name: "Stop",
        session_id: "S",
        transcript_path: "t.jsonl",
        effort: { level: "max" },
      },
      deps,
    );
    expect(getSessionModel("S", { path: box.path })).toEqual({
      provider: "claude",
      model: "m-switched",
      effort: "max",
    });
    expect(events(box).map((event) => event.kind)).toEqual(["session.started"]);
    handleToolUse(
      { hook_event_name: "PostToolUse", session_id: "S", tool_name: "Bash" },
      deps,
    );
    expect(events(box)[1]?.executor?.model).toBe("m-switched");
  });
});

describe("subagents and teammates", () => {
  const child = {
    hook_event_name: "PostToolUse",
    session_id: "S",
    agent_id: "A",
    agent_type: "Explore",
    tool_name: "Grep",
  };

  test("a payload with agent_id is a child subagent session with its parent recorded", () => {
    const box = sandbox();
    const { deps } = harness(box);
    expect(sessionIdentity(child)).toEqual({
      sessionId: "S:A",
      hostSessionId: "S",
      parentSessionId: "S",
      kind: "subagent",
    });
    handleToolUse(child, deps);
    handleToolUse(child, deps);
    const stored = events(box);
    expect(stored.map((event) => `${event.kind} ${event.sessionId}`)).toEqual([
      "session.started S:A",
      "tool.called S:A",
      "tool.called S:A",
    ]);
    expect(stored[0]?.payload).toEqual({
      kind: "subagent",
      parentSessionId: "S",
      worktree: expect.stringContaining("check out"),
    });
  });

  test("a payload with agent_id and teammate_name is a teammate", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleToolUse({ ...child, teammate_name: "builder-1" }, deps);
    const [started] = events(box);
    expect(started?.kind).toBe("session.started");
    expect(started?.payload).toEqual({
      kind: "teammate",
      parentSessionId: "S",
      worktree: expect.any(String),
    });
    expect(JSON.stringify(started)).not.toContain("builder-1");
  });

  test("a session launched with a parent in its environment is a teammate of that parent", () => {
    expect(
      sessionIdentity(
        { session_id: "T" },
        { AGENT_FORGE_PARENT_SESSION: "LEAD" },
      ),
    ).toEqual({
      sessionId: "T",
      hostSessionId: "T",
      parentSessionId: "LEAD",
      kind: "teammate",
    });
    expect(sessionIdentity({ session_id: "T" })).toEqual({
      sessionId: "T",
      hostSessionId: "T",
      kind: "interactive",
    });
  });

  test("a child falls back to its parent's cached model", () => {
    const box = sandbox();
    const { deps, transcriptReads } = harness(box);
    handleSessionStart(
      { hook_event_name: "SessionStart", session_id: "S", model: "m-parent" },
      deps,
    );
    handleToolUse(child, deps);
    const stored = events(box).filter((event) => event.sessionId === "S:A");
    expect(stored).toHaveLength(2);
    for (const event of stored)
      expect(event.executor).toEqual({
        provider: "claude",
        model: "m-parent",
        sessionId: "S:A",
      });
    expect(transcriptReads).toHaveLength(0);
  });
});

describe("session start and end", () => {
  const start = {
    hook_event_name: "SessionStart",
    session_id: "S",
    model: "m-1",
  };

  test("a resumed, cleared or compacted session does not start twice", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleSessionStart({ ...start, source: "startup" }, deps);
    for (const source of ["resume", "clear", "compact"])
      handleSessionStart({ ...start, source }, deps);
    const stored = events(box);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload).toMatchObject({ source: "startup" });
  });

  test("ending a session ends its open children first, then the session, then drops the mirror, and appends nothing else", () => {
    const box = sandbox();
    const { deps } = harness(box);
    const order: string[] = [];
    const recording: HookDeps = {
      ...deps,
      append: (event: LedgerEventInput) => {
        order.push(`${event.kind} ${event.sessionId}`);
        return deps.append(event);
      },
      removeMirror: (worktree, ifHolds) => {
        order.push(`mirror removed ${ifHolds}`);
        return deps.removeMirror(worktree, ifHolds);
      },
    };
    handleSessionStart(start, recording);
    const tool = {
      hook_event_name: "PostToolUse",
      session_id: "S",
      tool_name: "Grep",
    };
    handleToolUse({ ...tool, agent_id: "A" }, recording);
    handleToolUse({ ...tool, agent_id: "B" }, recording);
    order.length = 0;

    handleSessionEnd(
      { hook_event_name: "SessionEnd", session_id: "S", reason: "logout" },
      recording,
    );

    expect(order).toEqual([
      "session.ended S:A",
      "session.ended S:B",
      "session.ended S",
      "mirror removed S",
    ]);
    const ended = events(box).filter((event) => event.kind === "session.ended");
    expect(ended.map((event) => event.payload)).toEqual([
      { reason: "parent-ended" },
      { reason: "parent-ended" },
      { reason: "logout" },
    ]);
    expect(ended[2]?.executor?.model).toBe("m-1");
  });

  test("a session end whose payload names no session ends nothing and leaves the mirror alone", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleSessionStart(start, deps);
    for (const input of [{}, { hook_event_name: "SessionEnd", reason: "x" }])
      handleSessionEnd(input, deps);
    expect(events(box).map((event) => event.kind)).toEqual(["session.started"]);
    expect(readSessionMirror(box.cwd)).toBe("S");
  });

  test("a child that already ended is not ended again", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleSessionStart(start, deps);
    handleToolUse(
      {
        hook_event_name: "PostToolUse",
        session_id: "S",
        agent_id: "A",
        tool_name: "Grep",
      },
      deps,
    );
    const end = {
      hook_event_name: "SessionEnd",
      session_id: "S",
      reason: "other",
    };
    handleSessionEnd(end, deps);
    const afterFirst = events(box).filter(
      (event) => event.kind === "session.ended" && event.sessionId === "S:A",
    );
    expect(afterFirst).toHaveLength(1);
    handleSessionEnd(end, deps);
    const afterSecond = events(box).filter(
      (event) => event.kind === "session.ended" && event.sessionId === "S:A",
    );
    expect(afterSecond).toHaveLength(1);
  });

  test("the session mirror is written at start and removed at end only when it still holds this session", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleSessionStart(start, deps);
    expect(readSessionMirror(box.cwd)).toBe("S");
    // A script launched from this checkout now attaches to the session.
    expect(
      resolveAttach({ cwd: box.cwd, env: {}, path: box.path }),
    ).toMatchObject({
      sessionId: "S",
      executor: { provider: "claude", model: "m-1" },
    });

    handleSessionEnd({ hook_event_name: "SessionEnd", session_id: "S" }, deps);
    expect(readSessionMirror(box.cwd)).toBeNull();

    handleSessionStart(start, deps);
    writeSessionMirror(box.cwd, "S-newer");
    handleSessionEnd({ hook_event_name: "SessionEnd", session_id: "S" }, deps);
    expect(readSessionMirror(box.cwd)).toBe("S-newer");
  });

  test("a subagent payload never takes over the worktree's session mirror", () => {
    const box = sandbox();
    const { deps } = harness(box);
    handleSessionStart({ ...start, agent_id: "A" }, deps);
    expect(readSessionMirror(box.cwd)).toBeNull();
  });

  test("the first session start of a day takes a ledger backup and a later one that day does not", () => {
    const box = sandbox();
    const now = () => new Date("2026-10-07T10:00:00.000Z");
    const { deps } = harness(box, { now });
    const backups = join(box.home, "backups");
    handleSessionStart(start, deps);
    expect(readdirSync(backups)).toEqual(["ledger-2026-10-07.db"]);
    // Age today's snapshot: a second backup would replace it with a fresh file.
    const snapshot = join(backups, "ledger-2026-10-07.db");
    const old = new Date("2026-10-07T01:00:00.000Z");
    utimesSync(snapshot, old, old);
    handleSessionStart({ ...start, session_id: "S2" }, deps);
    expect(readdirSync(backups)).toEqual(["ledger-2026-10-07.db"]);
    expect(statSync(snapshot).mtimeMs).toBe(old.getTime());
    expect(events(box)).toHaveLength(2);
  });
});

describe("the hook probe", () => {
  test("it lists key names and says which exported ids equal the hook session id, without any value", () => {
    const probe = probeKeys(
      {
        hook_event_name: "PostToolUse",
        session_id: "the-session-id",
        tool_input: { command: SECRET },
        effort: { level: "high" },
        agent_id: "agent-xyz",
      },
      {
        CLAUDE_CODE_SESSION_ID: "the-session-id",
        CLAUDE_CODE_HOST_SESSION_ID: "another-id",
        CLAUDE_EFFORT: "high",
        CLAUDE_SECRET_THING: SECRET,
        PATH: "/usr/bin",
      },
    );
    expect(probe).toEqual({
      event: "PostToolUse",
      keys: [
        "agent_id",
        "effort",
        "hook_event_name",
        "session_id",
        "tool_input",
      ],
      effortKeys: ["level"],
      env: [
        "CLAUDE_CODE_HOST_SESSION_ID",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_EFFORT",
        "CLAUDE_SECRET_THING",
      ],
      sessionIdEquals: {
        CLAUDE_CODE_SESSION_ID: true,
        CLAUDE_CODE_HOST_SESSION_ID: false,
        CLAUDE_CODE_CHILD_SESSION: null,
      },
    });
    const text = JSON.stringify(probe);
    for (const value of [SECRET, "the-session-id", "another-id", "agent-xyz"])
      expect(text).not.toContain(value);
  });
});
