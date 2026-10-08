import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { comparableCheckout } from "../forge/runs";
import { appendEvent } from "./append";
import { closeLedger } from "./db";
import {
  readSessionMirror,
  removeSessionMirror,
  resolveAttach,
  SESSION_MIRROR_FILE,
  writeSessionMirror,
} from "./identity";
import { queryEvents } from "./query";
import { getSessionModel, setSessionModel } from "./session-models";

const temporary: string[] = [];

/** A fake checkout (a `.git` directory, no git) plus a ledger of its own, under a path with a space. */
function sandbox(): { cwd: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "ledger test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return { cwd, path: join(root, "home dir", "ledger.db") };
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

describe("session mirror", () => {
  test("the session mirror is read back verbatim and ignored when older than 24 hours", () => {
    const { cwd } = sandbox();
    expect(readSessionMirror(cwd)).toBeNull();
    expect(writeSessionMirror(cwd, "0f3c-Session_ID.1")).toBe(true);
    expect(readFileSync(join(cwd, SESSION_MIRROR_FILE), "utf8")).toBe(
      "0f3c-Session_ID.1\n",
    );
    expect(readSessionMirror(cwd)).toBe("0f3c-Session_ID.1");

    const in23h = () => new Date(Date.now() + 23 * HOUR);
    const in25h = () => new Date(Date.now() + 25 * HOUR);
    expect(readSessionMirror(cwd, { now: in23h })).toBe("0f3c-Session_ID.1");
    expect(readSessionMirror(cwd, { now: in25h })).toBeNull();

    const twoDaysAgo = new Date(Date.now() - 48 * HOUR);
    utimesSync(join(cwd, SESSION_MIRROR_FILE), twoDaysAgo, twoDaysAgo);
    expect(readSessionMirror(cwd)).toBeNull();
  });

  test("removing the mirror leaves a newer session's mirror in place", () => {
    const { cwd } = sandbox();
    writeSessionMirror(cwd, "sess-old");
    writeSessionMirror(cwd, "sess-new");
    expect(removeSessionMirror(cwd, "sess-old")).toBe(false);
    expect(readSessionMirror(cwd)).toBe("sess-new");
    expect(removeSessionMirror(cwd, "sess-new")).toBe(true);
    expect(existsSync(join(cwd, SESSION_MIRROR_FILE))).toBe(false);
  });
});

describe("session model cache", () => {
  test("a session's model is stored, read back and replaced; a later write without an effort keeps the known one", () => {
    const { path } = sandbox();
    expect(getSessionModel("sess-1", { path })).toBeNull();
    setSessionModel(
      { sessionId: "sess-1", provider: "claude", model: "model-1" },
      { path },
    );
    expect(getSessionModel("sess-1", { path })).toEqual({
      provider: "claude",
      model: "model-1",
    });
    setSessionModel(
      {
        sessionId: "sess-1",
        provider: "claude",
        model: "model-2",
        effort: "high",
      },
      { path },
    );
    setSessionModel(
      { sessionId: "sess-1", provider: "claude", model: "model-3" },
      { path },
    );
    expect(getSessionModel("sess-1", { path })).toEqual({
      provider: "claude",
      model: "model-3",
      effort: "high",
    });
    expect(getSessionModel("sess-2", { path })).toBeNull();
  });
});

describe("resolveAttach", () => {
  test("resolveAttach tags the executor from the session's cached model", () => {
    const { cwd, path } = sandbox();
    writeSessionMirror(cwd, "sess-1");
    setSessionModel(
      {
        sessionId: "sess-1",
        provider: "claude",
        model: "model-1",
        effort: "medium",
      },
      { path },
    );
    expect(resolveAttach({ cwd, env: {}, path })).toEqual({
      workspace: comparableCheckout(cwd),
      worktree: comparableCheckout(cwd),
      sessionId: "sess-1",
      executor: {
        provider: "claude",
        model: "model-1",
        effort: "medium",
        sessionId: "sess-1",
      },
    });
  });

  test("an explicit bead or run beats the environment, which beats the run state", () => {
    const { cwd, path } = sandbox();
    const env = { AGENT_FORGE_BEAD_ID: "bead-env", FORGE_SLUG: "run-env" };
    const fallback = { beadId: "bead-state", runId: "run-state" };
    const explicit = { beadId: "bead-flag", runId: "run-flag" };

    const all = resolveAttach({ cwd, env, explicit, fallback, path });
    expect([all.beadId, all.runId]).toEqual(["bead-flag", "run-flag"]);

    const noFlags = resolveAttach({ cwd, env, fallback, path });
    expect([noFlags.beadId, noFlags.runId]).toEqual(["bead-env", "run-env"]);

    const stateOnly = resolveAttach({ cwd, env: {}, fallback, path });
    expect([stateOnly.beadId, stateOnly.runId]).toEqual([
      "bead-state",
      "run-state",
    ]);

    const nothing = resolveAttach({ cwd, env: {}, path });
    expect("beadId" in nothing).toBe(false);
    expect("runId" in nothing).toBe(false);
  });

  test("an explicit executor beats the session's cached model", () => {
    const { cwd, path } = sandbox();
    writeSessionMirror(cwd, "sess-1");
    setSessionModel(
      { sessionId: "sess-1", provider: "claude", model: "model-cached" },
      { path },
    );
    const attach = resolveAttach({
      cwd,
      env: {},
      explicit: { executor: { provider: "codex", model: "model-flag" } },
      fallback: { executor: { provider: "claude", model: "model-state" } },
      path,
    });
    expect(attach.executor).toEqual({ provider: "codex", model: "model-flag" });
    expect(attach.sessionId).toBe("sess-1");
  });

  test("the session comes from the worktree mirror only: a session id in the shell environment is not used", () => {
    const { cwd, path } = sandbox();
    const env = { CLAUDE_CODE_SESSION_ID: "sess-env" };
    expect("sessionId" in resolveAttach({ cwd, env, path })).toBe(false);
    writeSessionMirror(cwd, "sess-mirror");
    expect(resolveAttach({ cwd, env, path }).sessionId).toBe("sess-mirror");
    expect(resolveAttach({ cwd, env: {}, path }).sessionId).toBe("sess-mirror");
  });

  test("with no cached model the result has no executor", () => {
    const { cwd, path } = sandbox();
    writeSessionMirror(cwd, "sess-1");
    const attach = resolveAttach({ cwd, env: {}, path });
    expect(attach.sessionId).toBe("sess-1");
    expect("executor" in attach).toBe(false);
  });

  test("with no live session, a run's stored executor is used without its session id", () => {
    const { cwd, path } = sandbox();
    const attach = resolveAttach({
      cwd,
      env: {},
      fallback: {
        executor: {
          provider: "claude",
          model: "model-state",
          sessionId: "sess-long-gone",
        },
      },
      path,
    });
    expect(attach.executor).toEqual({
      provider: "claude",
      model: "model-state",
    });
    expect("sessionId" in attach).toBe(false);

    const appended = appendEvent(
      {
        kind: "run.phase.completed",
        workspace: attach.workspace,
        runId: "run-1",
        ...(attach.executor ? { executor: attach.executor } : {}),
        payload: { phase: "plan" },
      },
      { path },
    );
    expect(appended.ok).toBe(true);
    const [event] = queryEvents({ runId: "run-1" }, { path });
    expect(event?.executor).toEqual({
      provider: "claude",
      model: "model-state",
    });
    expect(event && "sessionId" in event).toBe(false);
  });

  test("the effort in the shell environment fills in only when the session's cached model has none", () => {
    const { cwd, path } = sandbox();
    writeSessionMirror(cwd, "sess-1");
    setSessionModel(
      { sessionId: "sess-1", provider: "claude", model: "model-1" },
      { path },
    );
    const env = { CLAUDE_EFFORT: "high" };
    expect(resolveAttach({ cwd, env, path }).executor?.effort).toBe("high");
    expect(
      "effort" in (resolveAttach({ cwd, env: {}, path }).executor ?? {}),
    ).toBe(false);

    setSessionModel(
      {
        sessionId: "sess-1",
        provider: "claude",
        model: "model-1",
        effort: "low",
      },
      { path },
    );
    expect(resolveAttach({ cwd, env, path }).executor?.effort).toBe("low");
  });

  test("the smith named in the environment is added to an executor that has none", () => {
    const { cwd, path } = sandbox();
    const env = { AGENT_FORGE_SMITH: "claude-journeyman" };
    const explicit = { executor: { provider: "claude", model: "model-1" } };
    expect(resolveAttach({ cwd, env, explicit, path }).executor).toEqual({
      provider: "claude",
      model: "model-1",
      smith: "claude-journeyman",
    });
    const named = {
      executor: {
        provider: "claude",
        model: "model-1",
        smith: "claude-master",
      },
    };
    expect(
      resolveAttach({ cwd, env, explicit: named, path }).executor?.smith,
    ).toBe("claude-master");
    expect("executor" in resolveAttach({ cwd, env, path })).toBe(false);
  });
});
