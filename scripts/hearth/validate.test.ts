import { describe, expect, test } from "bun:test";
import {
  KNOWN_PROVIDERS,
  LEDGER_EVENT_KINDS,
  type LedgerEventKind,
  type LedgerPayloads,
  QUEUE_STATES,
  type QueueState,
  SESSION_KINDS,
} from "../../types/hearth";
import {
  isQueueState,
  validateExecutor,
  validateLedgerEvent,
  validateLedgerEventInput,
  validateOperatorEnvelope,
  validateReservation,
  validateSessionEnvelope,
  validateSmith,
} from "./validate";

const executor = {
  provider: "claude",
  model: "claude-sonnet-5-5",
  effort: "medium",
};

/** One valid payload and one invalid payload for every event kind. */
const PAYLOADS: {
  [K in LedgerEventKind]: { good: LedgerPayloads[K]; bad: unknown };
} = {
  "session.started": {
    good: {
      source: "startup",
      kind: "subagent",
      worktree: "C:/Users/Erich Staehling/wt",
      parentSessionId: "sess-0",
    },
    bad: { source: 7 },
  },
  "session.ended": {
    good: { reason: "clear", durationMs: 1200 },
    bad: { durationMs: "long" },
  },
  "tool.called": {
    good: {
      tool: "Bash",
      argsHash: "sha256:ab12",
      durationMs: 40,
      exitCode: 0,
    },
    bad: { tool: "Bash" },
  },
  "prompt.submitted": {
    good: { hash: "sha256:cd34", length: 120 },
    bad: { hash: "x", length: -1 },
  },
  "run.phase.entered": { good: { phase: "plan" }, bad: { phase: "deploy" } },
  "run.phase.completed": {
    good: { phase: "ship", artifact: "reports/x-ship.md" },
    bad: { artifact: "reports/x-ship.md" },
  },
  "review.recorded": {
    good: {
      phase: "plan",
      round: 1,
      verdict: "PASS",
      findings: { blocker: 0, high: 0, medium: 1, low: 2 },
      action: "advance",
    },
    bad: { phase: "plan", round: 1, verdict: "MAYBE", findings: {} },
  },
  "gate.ran": {
    good: {
      gate: "typecheck",
      passed: true,
      durationMs: 900,
      exitCode: 0,
      trigger: "Stop",
    },
    bad: { gate: "typecheck", passed: "yes" },
  },
  "verdict.bound": {
    good: { verdict: "pass", builder: executor, evaluator: executor },
    bad: { verdict: "maybe" },
  },
  "bead.transitioned": {
    good: { from: null, to: "proposed", reason: "minted by auto-task" },
    bad: { from: "queued", to: "finished" },
  },
  "reservation.acquired": {
    good: { worktree: "C:/work/wt", globs: ["scripts/hearth/**"] },
    bad: { worktree: "C:/work/wt", globs: "scripts/**" },
  },
  "reservation.released": {
    good: { worktree: "C:/work/wt", globs: ["scripts/hearth/**"] },
    bad: { globs: [] },
  },
  "shift.started": {
    good: {
      shiftId: "01J0SHIFT",
      concurrency: 2,
      durationMs: 7_200_000,
      filter: "epic:x1gs",
    },
    bad: { shiftId: "01J0SHIFT", concurrency: 0 },
  },
  "shift.stopped": {
    good: { shiftId: "01J0SHIFT", reason: "elapsed" },
    bad: { shiftId: "s", reason: "bored" },
  },
  "council.run.started": {
    good: { councilRunId: "run-1", profile: "default", budgetUsd: 1 },
    bad: { councilRunId: "run-1" },
  },
  "council.run.finished": {
    good: {
      councilRunId: "run-1",
      outcome: "cancelled",
      costUsd: 0.4,
      summary: "cancelled by the operator",
    },
    bad: { councilRunId: "run-1", outcome: "great" },
  },
  "friction.recorded": {
    good: {
      frictionBeadId: "agent-forge-harness-abcd",
      causeEventUlid: "01J0EVENT",
    },
    bad: { causeEventUlid: "01J0EVENT" },
  },
  "operator.action": {
    good: {
      action: "queue.approve",
      surface: "ui",
      target: "agent-forge-harness-abcd",
    },
    bad: { action: "queue.approve", surface: "telepathy" },
  },
};

function input(
  kind: LedgerEventKind,
  payload: unknown,
  extra: Record<string, unknown> = {},
) {
  return { kind, workspace: "agent-forge-harness", payload, ...extra };
}

function stored(
  kind: LedgerEventKind,
  payload: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    id: 1,
    ulid: "01J0AAAAAAAAAAAAAAAAAAAAAA",
    ts: "2026-10-06T12:00:00.000Z",
    ...input(kind, payload),
    ...extra,
  };
}

describe("event kinds", () => {
  test("every kind in the shared tuple has a fixture, so a new kind cannot ship unvalidated", () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual(
      [...LEDGER_EVENT_KINDS].sort(),
    );
  });
});

describe("validateLedgerEventInput — what emitters append", () => {
  for (const kind of LEDGER_EVENT_KINDS) {
    test(`accepts a well-formed ${kind}`, () => {
      const result = validateLedgerEventInput(input(kind, PAYLOADS[kind].good));
      expect(result.ok).toBe(true);
    });

    test(`rejects a ${kind} with a malformed payload`, () => {
      const result = validateLedgerEventInput(input(kind, PAYLOADS[kind].bad));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(kind);
    });
  }

  test("rejects an unknown kind", () => {
    const result = validateLedgerEventInput(
      input("tool.exploded" as LedgerEventKind, {}),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects non-objects and missing workspace", () => {
    expect(validateLedgerEventInput(null).ok).toBe(false);
    expect(validateLedgerEventInput("session.started").ok).toBe(false);
    const { workspace: _workspace, ...noWorkspace } = input(
      "session.started",
      {},
    );
    expect(validateLedgerEventInput(noWorkspace).ok).toBe(false);
  });

  test("accepts correlation fields and an embedded executor", () => {
    const result = validateLedgerEventInput(
      input("tool.called", PAYLOADS["tool.called"].good, {
        beadId: "agent-forge-harness-x1gs.1.4",
        runId: "cc-f0-hearth-types",
        sessionId: "sess-1",
        executor,
        ts: "2026-10-06T12:00:00.000Z",
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a correlation field of the wrong type or an invalid timestamp", () => {
    expect(
      validateLedgerEventInput(input("session.started", {}, { beadId: 42 })).ok,
    ).toBe(false);
    expect(
      validateLedgerEventInput(
        input("session.started", {}, { ts: "yesterday" }),
      ).ok,
    ).toBe(false);
    expect(
      validateLedgerEventInput(
        input("session.started", {}, { executor: { provider: "claude" } }),
      ).ok,
    ).toBe(false);
  });

  test("accepts a verdict.bound without an evaluator, and with a summary", () => {
    expect(
      validateLedgerEventInput(input("verdict.bound", { verdict: "pass" })).ok,
    ).toBe(true);
    expect(
      validateLedgerEventInput(
        input("verdict.bound", { verdict: "fail", summary: "two highs" }),
      ).ok,
    ).toBe(true);
  });

  test("rejects a verdict.bound whose evaluator is present but malformed", () => {
    expect(
      validateLedgerEventInput(
        input("verdict.bound", {
          verdict: "pass",
          evaluator: { provider: "" },
        }),
      ).ok,
    ).toBe(false);
  });

  test("accepts a session.started carrying kind, worktree and parentSessionId; rejects an unknown kind", () => {
    expect(
      validateLedgerEventInput(
        input("session.started", {
          kind: "teammate",
          worktree: "C:/Users/Erich Staehling/wt",
          parentSessionId: "sess-0",
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateLedgerEventInput(input("session.started", { kind: "robot" })).ok,
    ).toBe(false);
  });

  test("accepts review.recorded with an action and rejects an action outside advance|revise|halt", () => {
    const review = PAYLOADS["review.recorded"].good;
    for (const action of ["advance", "revise", "halt"]) {
      expect(
        validateLedgerEventInput(
          input("review.recorded", { ...review, action }),
        ).ok,
      ).toBe(true);
    }
    expect(
      validateLedgerEventInput(
        input("review.recorded", { ...review, action: "retry" }),
      ).ok,
    ).toBe(false);
  });

  test("hands back the validated event typed by kind", () => {
    const result = validateLedgerEventInput(
      input("gate.ran", PAYLOADS["gate.ran"].good),
    );
    expect(result.ok && result.value.kind).toBe("gate.ran");
  });
});

describe("validateLedgerEvent — what the ledger stores and streams", () => {
  for (const kind of LEDGER_EVENT_KINDS) {
    test(`accepts a stored ${kind}`, () => {
      expect(validateLedgerEvent(stored(kind, PAYLOADS[kind].good)).ok).toBe(
        true,
      );
    });
  }

  test("requires the identity the ledger assigns", () => {
    const base = stored("session.started", {});
    const { id: _id, ...noId } = base;
    const { ulid: _ulid, ...noUlid } = base;
    const { ts: _ts, ...noTs } = base;
    expect(validateLedgerEvent(noId).ok).toBe(false);
    expect(validateLedgerEvent(noUlid).ok).toBe(false);
    expect(validateLedgerEvent(noTs).ok).toBe(false);
    expect(
      validateLedgerEvent(stored("session.started", {}, { id: 1.5 })).ok,
    ).toBe(false);
    expect(
      validateLedgerEvent(stored("session.started", {}, { id: 0 })).ok,
    ).toBe(false);
  });

  test("rejects a stored event with a malformed payload", () => {
    expect(
      validateLedgerEvent(stored("gate.ran", PAYLOADS["gate.ran"].bad)).ok,
    ).toBe(false);
  });
});

describe("validateExecutor", () => {
  test("accepts known and unknown providers, with effort optional", () => {
    for (const provider of KNOWN_PROVIDERS) {
      expect(validateExecutor({ provider, model: "m" }).ok).toBe(true);
    }
    expect(
      validateExecutor({
        provider: "openhands-remote",
        model: "m",
        smith: "s",
        sessionId: "x",
      }).ok,
    ).toBe(true);
  });

  test("rejects a missing or empty provider/model and non-object input", () => {
    expect(validateExecutor({ model: "m" }).ok).toBe(false);
    expect(validateExecutor({ provider: "", model: "m" }).ok).toBe(false);
    expect(validateExecutor({ provider: "claude" }).ok).toBe(false);
    expect(validateExecutor([]).ok).toBe(false);
    expect(validateExecutor(undefined).ok).toBe(false);
  });
});

describe("validateSmith", () => {
  const smith = {
    name: "claude-journeyman",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "medium",
    enabled: true,
    tags: ["default"],
  };

  test("accepts a complete smith", () => {
    expect(validateSmith(smith).ok).toBe(true);
  });

  test("rejects an incomplete smith or non-string tags", () => {
    const { enabled: _enabled, ...noEnabled } = smith;
    expect(validateSmith(noEnabled).ok).toBe(false);
    expect(validateSmith({ ...smith, tags: [1] }).ok).toBe(false);
    expect(validateSmith({ ...smith, name: "" }).ok).toBe(false);
  });
});

describe("validateSessionEnvelope", () => {
  const envelope = {
    sessionId: "sess-1",
    provider: "claude",
    workspace: "agent-forge-harness",
  };

  test("accepts the minimal envelope and a full one", () => {
    expect(validateSessionEnvelope(envelope).ok).toBe(true);
    expect(
      validateSessionEnvelope({
        ...envelope,
        model: "m",
        effort: "high",
        worktree: "C:/work/wt",
        beadId: "agent-forge-harness-x1gs.1.4",
        parentSessionId: "sess-0",
      }).ok,
    ).toBe(true);
  });

  test("validateSessionEnvelope accepts every declared session kind and rejects another", () => {
    for (const kind of SESSION_KINDS) {
      expect(validateSessionEnvelope({ ...envelope, kind }).ok).toBe(true);
    }
    expect(validateSessionEnvelope({ ...envelope, kind: "robot" }).ok).toBe(
      false,
    );
  });

  test("rejects a missing identity or a wrong-typed optional", () => {
    expect(
      validateSessionEnvelope({ provider: "claude", workspace: "w" }).ok,
    ).toBe(false);
    expect(
      validateSessionEnvelope({ ...envelope, parentSessionId: 3 }).ok,
    ).toBe(false);
  });
});

describe("queue state and reservation", () => {
  test("isQueueState accepts every declared state and nothing else", () => {
    for (const state of QUEUE_STATES) expect(isQueueState(state)).toBe(true);
    expect(isQueueState("finished")).toBe(false);
    expect(isQueueState(undefined)).toBe(false);
  });

  const reservation = {
    beadId: "agent-forge-harness-x1gs.1.4",
    worktree: "C:/Users/Erich Staehling/wt",
    workspace: "agent-forge-harness",
    globs: ["types/hearth.ts", "scripts/hearth/**"],
    acquiredAt: "2026-10-06T12:00:00.000Z",
  };

  test("accepts a reservation, including a worktree path with spaces", () => {
    expect(validateReservation(reservation).ok).toBe(true);
  });

  test("rejects non-string globs and a bad timestamp", () => {
    expect(validateReservation({ ...reservation, globs: [1] }).ok).toBe(false);
    expect(validateReservation({ ...reservation, acquiredAt: "soon" }).ok).toBe(
      false,
    );
  });
});

describe("validateOperatorEnvelope", () => {
  test("accepts a success and a failure envelope", () => {
    expect(
      validateOperatorEnvelope({ ok: true, data: { count: 1 }, error: null })
        .ok,
    ).toBe(true);
    expect(
      validateOperatorEnvelope({
        ok: false,
        data: null,
        error: "queue is paused",
      }).ok,
    ).toBe(true);
  });

  test("rejects an envelope whose ok disagrees with data/error", () => {
    expect(
      validateOperatorEnvelope({ ok: true, data: 1, error: "oops" }).ok,
    ).toBe(false);
    expect(
      validateOperatorEnvelope({
        ok: false,
        data: { leaked: true },
        error: "x",
      }).ok,
    ).toBe(false);
    expect(
      validateOperatorEnvelope({ ok: false, data: null, error: null }).ok,
    ).toBe(false);
  });

  test("rejects a malformed envelope", () => {
    expect(validateOperatorEnvelope({ data: 1 }).ok).toBe(false);
    expect(
      validateOperatorEnvelope({ ok: "yes", data: 1, error: null }).ok,
    ).toBe(false);
    expect(validateOperatorEnvelope("ok").ok).toBe(false);
    expect(validateOperatorEnvelope(null).ok).toBe(false);
  });
});

describe("bead.transitioned — a queue transition, or a tracker write", () => {
  const HASH =
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const checked = (payload: unknown) =>
    validateLedgerEventInput(input("bead.transitioned", payload));
  const refusal = (payload: unknown): string => {
    const result = checked(payload);
    return result.ok ? "accepted" : result.error;
  };

  test("a tracker write is accepted: its action, with or without a hash and a length", () => {
    for (const payload of [
      { action: "create", hash: HASH, length: 4 },
      { action: "claim" },
      { action: "comment", hash: HASH, length: 0 },
      { action: "close", hash: HASH, length: 1000 },
    ]) {
      expect({ payload, refusal: refusal(payload) }).toEqual({
        payload,
        refusal: "accepted",
      });
      expect(validateLedgerEvent(stored("bead.transitioned", payload)).ok).toBe(
        true,
      );
    }
  });

  test("a tracker write is refused for an action it does not know, a hash that is not a SHA-256, or a length that is not a count", () => {
    const refused: Array<[unknown, string]> = [
      [{ action: "delete" }, "payload.action"],
      [{ action: "" }, "payload.action"],
      [{ action: "create", hash: "sha256:ab12" }, "payload.hash"],
      [{ action: "create", hash: HASH.toUpperCase() }, "payload.hash"],
      [{ action: "create", hash: HASH.slice(1) }, "payload.hash"],
      [{ action: "create", hash: `${HASH}0` }, "payload.hash"],
      [{ action: "create", hash: 7 }, "payload.hash"],
      [{ action: "comment", hash: HASH, length: -1 }, "payload.length"],
      [{ action: "comment", hash: HASH, length: 1.5 }, "payload.length"],
      [{ action: "comment", hash: HASH, length: "12" }, "payload.length"],
    ];
    for (const [payload, where] of refused)
      expect({ payload, refusal: refusal(payload) }).toEqual({
        payload,
        refusal: expect.stringContaining(where),
      });
  });

  test("a tracker write may not carry a queue key: from, to and reason must be absent, so no text travels under reason", () => {
    for (const [key, value] of [
      ["reason", "a close reason typed by the operator"],
      ["from", null],
      ["from", "queued"],
      ["to", "proposed"],
      ["to", null],
    ] as const) {
      const payload = { action: "close", hash: HASH, length: 4, [key]: value };
      expect({ payload, refusal: refusal(payload) }).toEqual({
        payload,
        refusal: expect.stringContaining(
          `payload.${key}: must be absent from a tracker write`,
        ),
      });
    }
  });

  test("a queue transition is what it was: from and to are both needed", () => {
    expect(refusal({ from: null, to: "proposed" })).toBe("accepted");
    expect(refusal({ from: "queued", to: "running", reason: "picked" })).toBe(
      "accepted",
    );
    expect(refusal({ to: "proposed" })).toContain("payload.from");
    expect(refusal({ from: null })).toContain("payload.to");
    expect(refusal({ from: null, to: null })).toContain("payload.to");
    expect(refusal({})).toContain("payload.from");
    expect(refusal(null)).toContain("expected object");
  });

  test("a queue transition may not carry a write's keys: hash and length must be absent", () => {
    for (const [key, value] of [
      ["hash", "free text under a key the ledger stores"],
      ["hash", HASH],
      ["length", 12],
      ["length", "also text"],
    ] as const) {
      const payload = { from: null, to: "proposed", [key]: value };
      expect({ payload, refusal: refusal(payload) }).toEqual({
        payload,
        refusal: expect.stringContaining(
          `payload.${key}: must be absent from a queue transition`,
        ),
      });
    }
  });

  test("to, read without narrowing, is a queue state or nothing", () => {
    type Payload = LedgerPayloads["bead.transitioned"];
    const toOf = (payload: Payload): QueueState | undefined => payload.to;
    const always = (payload: Payload): QueueState =>
      // @ts-expect-error a tracker write has no `to`, so `to` is not always a queue state
      payload.to;
    const awaitsApproval = (payload: Payload): boolean =>
      payload.to === "proposed";

    expect(toOf({ from: null, to: "proposed" })).toBe("proposed");
    expect(toOf({ action: "claim" })).toBeUndefined();
    expect(always({ action: "claim" })).toBeUndefined();
    expect(awaitsApproval({ from: null, to: "proposed" })).toBe(true);
    expect(awaitsApproval({ action: "create" })).toBe(false);
  });
});
