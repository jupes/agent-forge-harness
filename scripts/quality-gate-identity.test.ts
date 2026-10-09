import { describe, expect, test } from "bun:test";
import type { HookStdin } from "../.claude/hooks/utils/hook-input";
import * as identityModule from "./quality-gate-identity";
import { gateIdentity, gateInvocation } from "./quality-gate-identity";
import { createRunCorrelation, type RunCorrelation } from "./run-correlation";

const TREE = "C:/work/harness/trees/dg40";

function correlation(over: { executionRunId?: string } = {}): RunCorrelation {
  const made = createRunCorrelation({
    executionRunId: "agent-forge-harness-dg40",
    beadsIssueId: "agent-forge-harness-dg40.9",
    checkout: TREE,
    now: () => "2026-10-08T12:00:00.000Z",
    ...over,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const BASE = {
  cwd: "C:/work/harness/trees/dg40/scripts",
  gitToplevel: TREE,
  gitBranch: "feat/nocturne",
  correlation: correlation(),
};

const UNLINKED = {
  ...BASE,
  correlation: null,
  unlinkedReason: "no run correlation was given",
};

const payload = (input: Record<string, unknown>): HookStdin => ({
  kind: "payload",
  input,
});
const NO_STDIN: HookStdin = { kind: "none", reason: "terminal" };

describe("gateInvocation", () => {
  test("a TaskCompleted payload names the event and yields the host's fields as metadata", () => {
    expect(
      gateInvocation(
        payload({
          hook_event_name: "TaskCompleted",
          session_id: "host-session-7",
          task_id: "7",
          task_subject: "never recorded",
          team_name: "night-shift",
          teammate_name: "worker-2",
        }),
        [],
      ),
    ).toEqual({
      ok: true,
      event: "TaskCompleted",
      eventSource: "stdin",
      stdin: "payload",
      host: {
        hostTaskScope: { kind: "agent-team", id: "night-shift" },
        hostTaskId: "7",
        completerHostSessionId: "host-session-7",
        completerTeammateName: "worker-2",
      },
    });
  });

  test("a TeammateIdle payload stays TeammateIdle and claims no task and no completer", () => {
    expect(
      gateInvocation(
        payload({
          hook_event_name: "TeammateIdle",
          session_id: "host-session-7",
          task_id: "7",
          team_name: "night-shift",
          teammate_name: "worker-2",
        }),
        // A registration may name the event too; here the two agree.
        ["TeammateIdle"],
      ),
    ).toEqual({
      ok: true,
      event: "TeammateIdle",
      eventSource: "stdin",
      stdin: "payload",
      host: {
        hostTaskScope: { kind: "agent-team", id: "night-shift" },
        idleTeammateName: "worker-2",
      },
    });
  });

  test("a payload and a command line that name different events are refused, either way round", () => {
    expect(
      gateInvocation(payload({ hook_event_name: "TeammateIdle" }), [
        "TaskCompleted",
      ]),
    ).toEqual({
      ok: false,
      error: "stdin says TeammateIdle but the command line says TaskCompleted",
    });
    expect(
      gateInvocation(payload({ hook_event_name: "TaskCompleted" }), [
        "--correlation",
        "x.json",
        "TeammateIdle",
      ]),
    ).toEqual({
      ok: false,
      error: "stdin says TaskCompleted but the command line says TeammateIdle",
    });
  });

  test("a payload with no host fields carries no host object", () => {
    expect(
      gateInvocation(payload({ hook_event_name: "TaskCompleted" }), []),
    ).toEqual({
      ok: true,
      event: "TaskCompleted",
      eventSource: "stdin",
      stdin: "payload",
    });
  });

  test("with no payload the event is the one named on the command line, else TaskCompleted, and what stdin was is kept", () => {
    expect(
      gateInvocation(NO_STDIN, ["--correlation", "x", "TeammateIdle"]),
    ).toEqual({
      ok: true,
      event: "TeammateIdle",
      eventSource: "argv",
      stdin: "terminal",
    });
    expect(gateInvocation({ kind: "none", reason: "empty" }, [])).toEqual({
      ok: true,
      event: "TaskCompleted",
      eventSource: "default",
      stdin: "empty",
    });
    // A payload that never arrived is told apart from a run by hand.
    expect(gateInvocation({ kind: "none", reason: "silent" }, [])).toEqual({
      ok: true,
      event: "TaskCompleted",
      eventSource: "default",
      stdin: "silent",
    });
  });

  test("malformed stdin is refused with its reason, whatever the command line says", () => {
    expect(
      gateInvocation({ kind: "malformed", error: "stdin is not valid JSON" }, [
        "TaskCompleted",
      ]),
    ).toEqual({ ok: false, error: "stdin is not valid JSON" });
  });

  test("a payload for any other event, or for none, is refused without echoing what it said", () => {
    for (const name of [
      "Stop",
      "taskcompleted",
      "",
      7,
      null,
      undefined,
      "\u001b[31mTaskCompleted",
    ]) {
      expect(
        gateInvocation(payload({ hook_event_name: name, task_id: "7" }), [
          "TaskCompleted",
        ]),
      ).toEqual({
        ok: false,
        error: "stdin hook_event_name must be TaskCompleted or TeammateIdle",
      });
    }
  });

  test("host fields that are not short plain strings are left out, never recorded", () => {
    expect(
      gateInvocation(
        payload({
          hook_event_name: "TaskCompleted",
          task_id: 7,
          team_name: "x".repeat(500),
          teammate_name: "worker\u0000two",
          session_id: "   ",
        }),
        [],
      ),
    ).toEqual({
      ok: true,
      event: "TaskCompleted",
      eventSource: "stdin",
      stdin: "payload",
    });
  });

  test("a hostile host id is kept as inert text in the host object and nowhere else", () => {
    const hostile = "7; rm -rf . && $(bd close x) `id` --json";
    expect(
      gateInvocation(
        payload({ hook_event_name: "TaskCompleted", task_id: hostile }),
        [],
      ),
    ).toEqual({
      ok: true,
      event: "TaskCompleted",
      eventSource: "stdin",
      stdin: "payload",
      host: { hostTaskId: hostile },
    });
  });
});

describe("gateIdentity", () => {
  test("a correlated run records schema 2 with the correlation's bead and run", () => {
    expect<unknown>(gateIdentity(BASE)).toEqual({
      schemaVersion: 2,
      checkout: TREE,
      branch: "feat/nocturne",
      beadsIssueId: "agent-forge-harness-dg40.9",
      executionRunId: "agent-forge-harness-dg40",
    });
  });

  test("an uncorrelated run records both ids as null and says why", () => {
    expect<unknown>(gateIdentity(UNLINKED)).toEqual({
      schemaVersion: 2,
      checkout: TREE,
      branch: "feat/nocturne",
      beadsIssueId: null,
      executionRunId: null,
      unlinkedReason: "no run correlation was given",
    });
  });

  test("host fields sit in their own object, apart from the two ids", () => {
    const identity = gateIdentity({
      ...UNLINKED,
      host: { hostTaskId: "agent-forge-harness-zzzz" },
    });
    expect(identity.host).toEqual({ hostTaskId: "agent-forge-harness-zzzz" });
    expect(identity.beadsIssueId).toBeNull();
    expect(identity.executionRunId).toBeNull();
  });

  test("there is one run field: no task id and no inferred run on a new entry", () => {
    for (const identity of [gateIdentity(BASE), gateIdentity(UNLINKED)]) {
      expect("taskId" in identity).toBe(false);
      expect("forgeSlug" in identity).toBe(false);
    }
    // The by-checkout inference is gone from the gate, not just unused.
    expect("forgeSlugFor" in identityModule).toBe(false);
  });

  test("uses the top level, not the directory the hook happened to run in", () => {
    expect(gateIdentity(BASE).checkout).not.toBe(BASE.cwd);
  });

  test("falls back to the working directory outside a git checkout", () => {
    const identity = gateIdentity({
      ...BASE,
      gitToplevel: null,
      gitBranch: null,
    });
    expect(identity.checkout).toBe(BASE.cwd);
    expect(identity.branch).toBeNull();
  });

  test("records no branch for a detached HEAD", () => {
    expect(gateIdentity({ ...BASE, gitBranch: "HEAD" }).branch).toBeNull();
  });

  test("trims the newline git prints", () => {
    const identity = gateIdentity({
      ...BASE,
      gitToplevel: "C:/work/harness\n",
      gitBranch: "main\n",
    });
    expect(identity.checkout).toBe("C:/work/harness");
    expect(identity.branch).toBe("main");
  });
});
