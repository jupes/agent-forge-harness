import { describe, expect, test } from "bun:test";
import { stripPayload } from "./payload-allowlist";

describe("stripPayload: the usage on session.ended", () => {
  test("keeps the counts and the cost it names, as numbers; drops any other key, and any value that is not a number, under usage", () => {
    expect(
      stripPayload("session.ended", {
        reason: "completed",
        durationMs: 5,
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          costUsd: 0.5,
          cachedInputTokens: "7",
          prompt: "text that must not be stored",
          nested: { inputTokens: 3 },
        },
      }),
    ).toEqual({
      reason: "completed",
      durationMs: 5,
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
    });
  });

  test("a usage with nothing it names is not stored at all", () => {
    for (const usage of [
      { prompt: "text that must not be stored" },
      {},
      "lots",
    ]) {
      expect(
        stripPayload("session.ended", { reason: "completed", usage }),
      ).toEqual({ reason: "completed" });
    }
  });
});

describe("stripPayload: the shift events", () => {
  test("shift.started keeps the bounds a shift ran under: its bead count and its spend", () => {
    expect(
      stripPayload("shift.started", {
        shiftId: "shift-20261014-120000-abcd",
        concurrency: 2,
        durationMs: 60_000,
        filter: "epic:x1gs",
        maxBeads: 4,
        maxUsd: 10,
        prompt: "text that must not be stored",
      }),
    ).toEqual({
      shiftId: "shift-20261014-120000-abcd",
      concurrency: 2,
      durationMs: 60_000,
      filter: "epic:x1gs",
      maxBeads: 4,
      maxUsd: 10,
    });
  });
});

describe("stripPayload: the findings on council.run.finished", () => {
  const finished = (findings: unknown) =>
    stripPayload("council.run.finished", {
      councilRunId: "c-1",
      outcome: "fail",
      findings,
    });

  test("keeps a count per severity, whole numbers only, and nothing else under findings", () => {
    expect(
      finished({
        blocker: 1,
        high: 2,
        medium: 0,
        low: 4,
        title: "a finding's text that must not be stored",
        nested: { blocker: 9 },
      }),
    ).toEqual({
      councilRunId: "c-1",
      outcome: "fail",
      findings: { blocker: 1, high: 2, medium: 0, low: 4 },
    });
  });

  test("a value that is not a whole, non-negative number is dropped, not stored as text", () => {
    expect(
      finished({
        blocker: "no blockers, all good",
        high: 1.5,
        medium: -1,
        low: 3,
      }),
    ).toEqual({
      councilRunId: "c-1",
      outcome: "fail",
      findings: { low: 3 },
    });
  });

  test("findings with no count left, or that are not an object, are not stored at all", () => {
    for (const findings of [
      { title: "text only" },
      { blocker: "many", high: null },
      {},
      "blocker 1",
      7,
      null,
      ["blocker"],
    ])
      expect(finished(findings)).toEqual({
        councilRunId: "c-1",
        outcome: "fail",
      });
  });

  test("a review round's findings are cut the same way", () => {
    expect(
      stripPayload("review.recorded", {
        phase: "plan",
        round: 1,
        verdict: "FAIL",
        findings: { blocker: 1, high: "two", medium: 0, low: 0, note: "text" },
      }),
    ).toEqual({
      phase: "plan",
      round: 1,
      verdict: "FAIL",
      findings: { blocker: 1, medium: 0, low: 0 },
    });
  });
});

describe("stripPayload: Smith edit action identity", () => {
  test("keeps only the fixed family and bounded UUID/digest metadata", () => {
    expect(
      stripPayload("operator.action", {
        action: "smith.config.edit",
        surface: "api",
        target: "workspace",
        family: "smith-config-edit",
        requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
        inputHash: "a".repeat(64),
        smith: { name: "private smith request" },
        body: "private request body",
        expectedRevision: { user: "revision" },
      }),
    ).toEqual({
      action: "smith.config.edit",
      surface: "api",
      target: "workspace",
      family: "smith-config-edit",
      requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
      inputHash: "a".repeat(64),
    });
  });

  test("drops unrecognized families and malformed correlation values", () => {
    expect(
      stripPayload("operator.action", {
        action: "smith.config.edit",
        surface: "api",
        family: "private request data",
        requestId: "not-a-uuid",
        inputHash: "not-a-digest",
      }),
    ).toEqual({ action: "smith.config.edit", surface: "api" });
  });

  test("routing edit audits retain only fixed family, correlation and selector metadata", () => {
    expect(
      stripPayload("operator.action", {
        action: "smith.config.routing-edit",
        surface: "api",
        target: "workspace",
        family: "smith-routing-edit",
        requestId: "4ba29c22-8414-4bd6-9d4d-2d0591d5d0a0",
        inputHash: "a".repeat(64),
        changeKind: "bench",
        selector: "low",
        entries: [{ smith: "private", weight: 99 }],
        configText: "private config",
      }),
    ).toEqual({
      action: "smith.config.routing-edit",
      surface: "api",
      target: "workspace",
      family: "smith-routing-edit",
      requestId: "4ba29c22-8414-4bd6-9d4d-2d0591d5d0a0",
      inputHash: "a".repeat(64),
      changeKind: "bench",
      selector: "low",
    });
  });

  test("routing audit selector fields reject arbitrary values", () => {
    expect(
      stripPayload("operator.action", {
        action: "smith.config.routing-edit",
        surface: "api",
        family: "smith-routing-edit",
        changeKind: "private config",
        selector: "arbitrary.path",
      }),
    ).toEqual({
      action: "smith.config.routing-edit",
      surface: "api",
      family: "smith-routing-edit",
    });
  });
});

test("Smith create actions retain only their fixed identity metadata", () => {
  expect(
    stripPayload("operator.action", {
      action: "smith.config.create.reserve",
      surface: "api",
      target: "workspace",
      family: "smith-config-create",
      requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
      inputHash: "a".repeat(64),
      original: { smith: { name: "private" } },
    }),
  ).toEqual({
    action: "smith.config.create.reserve",
    surface: "api",
    target: "workspace",
    family: "smith-config-create",
    requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
    inputHash: "a".repeat(64),
  });
  expect(
    stripPayload("operator.action", {
      action: "smith.config.create.reserve",
      family: "smith-config-create-private-data",
      requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
      inputHash: "a".repeat(64),
    }),
  ).toEqual({
    action: "smith.config.create.reserve",
    requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
    inputHash: "a".repeat(64),
  });
});

test("project create actions keep only bounded original correlation metadata", () => {
  expect(
    stripPayload("operator.action", {
      action: "project.create.reserve",
      surface: "api",
      target: "private project slug",
      family: "project-create",
      requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
      inputHash: "a".repeat(64),
      original: { name: "private original" },
      body: "private request body",
      workspace: "C:\\private\\workspace",
    }),
  ).toEqual({
    action: "project.create.reserve",
    surface: "api",
    target: "private project slug",
    family: "project-create",
    requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
    inputHash: "a".repeat(64),
  });
  expect(
    stripPayload("operator.action", {
      action: "project.create.reserve",
      family: "project-create-private-data",
      requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
      inputHash: "a".repeat(64),
      original: { name: "private original" },
    }),
  ).toEqual({
    action: "project.create.reserve",
    requestId: "122d0b56-96f3-4818-8789-6ab562c092e8",
    inputHash: "a".repeat(64),
  });
});

describe("stripPayload: Codex Chat Fork action identity", () => {
  test("keeps only the approved Fork family and bounded original correlation", () => {
    expect(
      stripPayload("operator.action", {
        action: "session.fork",
        surface: "api",
        target:
          "codex-chat-fork:project-a5832fa0-7a21-403b-8184-44892f0d8d86:session-e2772860-2001-4ac0-88ca-56d81f7c518a",
        family: "codex-chat-fork",
        requestId: "80e40be9-e811-47c3-a71d-b988e67178a0",
        inputHash: "b".repeat(64),
        throughTurnRequestId: "private turn id",
        sourceSeal: { parentTurnHash: "private seal" },
        prompt: "private Chat prompt",
      }),
    ).toEqual({
      action: "session.fork",
      surface: "api",
      target:
        "codex-chat-fork:project-a5832fa0-7a21-403b-8184-44892f0d8d86:session-e2772860-2001-4ac0-88ca-56d81f7c518a",
      family: "codex-chat-fork",
      requestId: "80e40be9-e811-47c3-a71d-b988e67178a0",
      inputHash: "b".repeat(64),
    });
  });

  test("still drops unrecognized families and malformed Fork correlation", () => {
    expect(
      stripPayload("operator.action", {
        action: "session.fork",
        surface: "api",
        family: "private request data",
        requestId: "not-a-uuid",
        inputHash: "not-a-digest",
        prompt: "private Chat prompt",
      }),
    ).toEqual({ action: "session.fork", surface: "api" });
  });
});

describe("stripPayload: dedicated Fork child control identity", () => {
  test("keeps only each fixed control family and bounded audit correlation", () => {
    for (const [action, family, requestId] of [
      [
        "session.fork.approval.decide",
        "codex-chat-fork-approval",
        "80e40be9-e811-47c3-a71d-b988e6717803",
      ],
      [
        "session.fork.stop",
        "codex-chat-fork-stop",
        "80e40be9-e811-47c3-a71d-b988e6717804",
      ],
    ] as const) {
      expect(
        stripPayload("operator.action", {
          action,
          surface: "api",
          target:
            "codex-chat-fork-child:project-a5832fa0-7a21-403b-8184-44892f0d8d86:session-80e40be9-e811-47c3-a71d-b988e6717801",
          family,
          requestId,
          inputHash: "c".repeat(64),
          approvalId: "private approval",
          turnRequestId: "private turn",
          transcript: "private child transcript",
        }),
      ).toEqual({
        action,
        surface: "api",
        target:
          "codex-chat-fork-child:project-a5832fa0-7a21-403b-8184-44892f0d8d86:session-80e40be9-e811-47c3-a71d-b988e6717801",
        family,
        requestId,
        inputHash: "c".repeat(64),
      });
    }
  });

  test("drops unknown or malformed family values instead of accepting a prefix", () => {
    for (const family of [
      "codex-chat-fork-approval-private",
      "codex-chat-fork-stop:extra",
      "private request data",
    ]) {
      expect(
        stripPayload("operator.action", {
          action: "session.fork.approval.decide",
          surface: "api",
          family,
          requestId: "80e40be9-e811-47c3-a71d-b988e6717803",
          inputHash: "c".repeat(64),
        }),
      ).toEqual({
        action: "session.fork.approval.decide",
        surface: "api",
        requestId: "80e40be9-e811-47c3-a71d-b988e6717803",
        inputHash: "c".repeat(64),
      });
    }
  });
});

test("repository onboarding actions retain only fixed families and UUIDs", () => {
  const requestId = "d134a802-6d1c-47c4-a001-3f5f83d38d31";
  for (const [action, family] of [
    ["project.repository.pick", "project-repository-selection"],
    ["project.repository.clone", "project-repository-clone"],
  ]) {
    expect(
      stripPayload("operator.action", {
        action,
        surface: "api",
        family,
        requestId,
        path: "C:\\private\\repository",
        url: "https://private.invalid/repo.git",
        body: "private repository data",
      }),
    ).toEqual({ action, surface: "api", family, requestId });
    expect(
      stripPayload("operator.action", {
        action,
        surface: "api",
        family: `${family}-private-data`,
        requestId,
        body: "private repository data",
      }),
    ).toEqual({ action, surface: "api", requestId });
  }
});
