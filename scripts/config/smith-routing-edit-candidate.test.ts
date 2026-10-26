import { expect, test } from "bun:test";
import {
  canonicalSmithRoutingEditRequest,
  SMITH_ROUTING_EDIT_LIMITS,
  smithRoutingEditRequestSchema,
} from "./smith-routing-edit-protocol";
import type { ConfigByteSource, ConfigTarget } from "./write";
import { buildSmithRoutingEditCandidate } from "./write";

const paths: Record<ConfigTarget, string> = {
  user: "C:/fixture/home/.agent-forge/config.toml",
  workspace: "C:/fixture/workspace/agent-forge.toml",
};

function sources(
  user: string | null = null,
  workspace: string | null = null,
): Record<ConfigTarget, ConfigByteSource> {
  return {
    user: {
      file: paths.user,
      bytes: user === null ? null : Buffer.from(user, "utf8"),
    },
    workspace: {
      file: paths.workspace,
      bytes: workspace === null ? null : Buffer.from(workspace, "utf8"),
    },
  };
}

test("default candidate shows builtin-to-target provenance and edits one key", () => {
  const result = buildSmithRoutingEditCandidate(
    { target: "user", change: { kind: "default", smith: "claude-master" } },
    sources(),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.review).toEqual({
    change: { kind: "default", smith: "claude-master" },
    targetBefore: null,
    targetAfter: "claude-master",
    effectiveBefore: "claude-journeyman",
    effectiveAfter: "claude-master",
    provenanceBefore: "builtin",
    provenanceAfter: paths.user,
  });
  expect(Buffer.from(result.value.bytes).toString("utf8")).toBe(
    '[workflow]\ndefault_crew = "claude-master"\n',
  );
});

test("bench candidate preserves positive fractions, duplicate rows, and their order", () => {
  const workspace =
    '[benches]\nlow = ["claude-apprentice:7", "claude-apprentice:3"]\n';
  const entries = [
    { smith: "claude-master", weight: 0.5 },
    { smith: "claude-master", weight: 1.25 },
    { smith: "codex-journeyman", weight: 3 },
  ];
  const result = buildSmithRoutingEditCandidate(
    { target: "workspace", change: { kind: "bench", bench: "low", entries } },
    sources(null, workspace),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.review).toEqual({
    change: { kind: "bench", bench: "low", entries },
    targetBefore: [
      { smith: "claude-apprentice", weight: 7 },
      { smith: "claude-apprentice", weight: 3 },
    ],
    targetAfter: entries,
    effectiveBefore: [
      { smith: "claude-apprentice", weight: 7 },
      { smith: "claude-apprentice", weight: 3 },
    ],
    effectiveAfter: entries,
    provenanceBefore: paths.workspace,
    provenanceAfter: paths.workspace,
  });
  expect(Buffer.from(result.value.bytes).toString("utf8")).toContain(
    'low = ["claude-master:0.5", "claude-master:1.25", "codex-journeyman:3"]',
  );
});

test("target provenance reports the effective before value and refuses a shadowed user edit", () => {
  const result = buildSmithRoutingEditCandidate(
    { target: "user", change: { kind: "default", smith: "claude-master" } },
    sources(
      '[workflow]\ndefault_crew = "claude-apprentice"\n',
      '[workflow]\ndefault_crew = "claude-journeyman"\n',
    ),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(
    "would not make the requested value effective",
  );
});

test("user target refuses a write hidden by a workspace value even when values match", () => {
  const result = buildSmithRoutingEditCandidate(
    { target: "user", change: { kind: "default", smith: "claude-journeyman" } },
    sources(
      '[workflow]\ndefault_crew = "claude-master"\n',
      '[workflow]\ndefault_crew = "claude-journeyman"\n',
    ),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("shadowed");
});

test("creating a workspace config preserves the never-inherit execution allowlist rule", () => {
  const result = buildSmithRoutingEditCandidate(
    {
      target: "workspace",
      change: { kind: "default", smith: "claude-master" },
    },
    sources('[execution.env]\npass = ["PATH"]\n'),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("never inherits it");
});

test("candidate preserves BOM, CRLF, comments, and unrelated config bytes", () => {
  const user =
    '\uFEFF# keep this comment\r\n[workflow]\r\ndefault_crew = "claude-master"\r\n\r\n[benches]\r\nlow = ["claude-apprentice:2"] # preserve inline comment\r\nmedium = ["codex-journeyman:3"]\r\n';
  const result = buildSmithRoutingEditCandidate(
    {
      target: "user",
      change: {
        kind: "bench",
        bench: "low",
        entries: [{ smith: "claude-master", weight: 0.75 }],
      },
    },
    sources(user),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const next = Buffer.from(result.value.bytes).toString("utf8");
  expect(next.startsWith("\uFEFF# keep this comment\r\n")).toBe(true);
  expect(next).toContain(
    'low = ["claude-master:0.75"] # preserve inline comment',
  );
  expect(next).toContain('medium = ["codex-journeyman:3"]');
  expect(next).toContain('default_crew = "claude-master"');
  expect(
    next.includes("\n") && next.replaceAll("\r\n", "").includes("\n"),
  ).toBe(false);
});

test("candidate refuses invalid names and weights under existing loader semantics", () => {
  for (const change of [
    { kind: "default", smith: "__proto__" },
    { kind: "bench", bench: "low", entries: [] },
    { kind: "bench", bench: "low", entries: [{ smith: "missing", weight: 1 }] },
    {
      kind: "bench",
      bench: "low",
      entries: [{ smith: "claude-master", weight: 0 }],
    },
    {
      kind: "bench",
      bench: "low",
      entries: [{ smith: "claude-master", weight: Number.POSITIVE_INFINITY }],
    },
  ]) {
    const result = buildSmithRoutingEditCandidate(
      { target: "workspace", change },
      sources(),
    );
    expect(result.ok).toBe(false);
  }
});

test("candidate refuses unsupported TOML rather than rewriting it", () => {
  const result = buildSmithRoutingEditCandidate(
    { target: "user", change: { kind: "default", smith: "claude-master" } },
    sources(
      '[workflow]\ndefault_crew = "claude-journeyman"\nextra = { value = 1 }\n',
    ),
  );
  expect(result.ok).toBe(false);
});

test("candidate snapshots input and returns independent byte and review copies", () => {
  const request = {
    target: "workspace" as const,
    change: {
      kind: "bench" as const,
      bench: "low" as const,
      entries: [{ smith: "claude-master", weight: 0.5 }],
    },
  };
  const initialSources = sources();
  const result = buildSmithRoutingEditCandidate(request, initialSources);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  request.change.entries[0]!.weight = 99;
  initialSources.workspace.bytes = Buffer.from("changed");
  result.value.change.kind === "bench" &&
    (result.value.change.entries[0]!.weight = 77);
  expect(result.value.review.change).toEqual({
    kind: "bench",
    bench: "low",
    entries: [{ smith: "claude-master", weight: 0.5 }],
  });
  expect(Buffer.from(result.value.bytes).toString("utf8")).toContain(
    'low = ["claude-master:0.5"]',
  );
});

test("oversized source and oversized before-review refuse without truncation", () => {
  const oversizedBytes = new Uint8Array(
    SMITH_ROUTING_EDIT_LIMITS.sourceBytes + 1,
  );
  const oversizedSource = buildSmithRoutingEditCandidate(
    { target: "user", change: { kind: "default", smith: "claude-master" } },
    {
      ...sources(),
      user: { file: paths.user, bytes: oversizedBytes },
    },
  );
  expect(oversizedSource.ok).toBe(false);
  if (!oversizedSource.ok)
    expect(oversizedSource.error).toContain("was not truncated");

  const manyRows = Array.from(
    { length: 4_000 },
    () => '"claude-apprentice:1"',
  ).join(", ");
  const largePriorBench = `[benches]\nlow = [${manyRows}]\n`;
  const oversizedReview = buildSmithRoutingEditCandidate(
    {
      target: "workspace",
      change: {
        kind: "bench",
        bench: "low",
        entries: [{ smith: "claude-master", weight: 1 }],
      },
    },
    sources(null, largePriorBench),
  );
  expect(oversizedReview.ok).toBe(false);
  if (!oversizedReview.ok) expect(oversizedReview.error).toContain("response");
});

test("original hash bytes bind UUID, target, paired revision, and ordered duplicate rows", () => {
  const base = {
    requestId: "a14dcb1c-3098-4a70-80cb-08644bb0af78",
    target: "workspace" as const,
    change: {
      kind: "bench" as const,
      bench: "low" as const,
      entries: [
        { smith: "claude-master", weight: 0.5 },
        { smith: "claude-master", weight: 0.5 },
      ],
    },
    expectedRevision: {
      version: 1 as const,
      user: "a".repeat(64),
      workspace: "b".repeat(64),
    },
  };
  const canonical = canonicalSmithRoutingEditRequest(base);
  expect(
    canonicalSmithRoutingEditRequest({
      ...base,
      requestId: "e61b84bb-c732-4881-903d-e3b21f5c941f",
    }),
  ).not.toBe(canonical);
  expect(
    canonicalSmithRoutingEditRequest({ ...base, target: "user" }),
  ).not.toBe(canonical);
  expect(
    canonicalSmithRoutingEditRequest({
      ...base,
      expectedRevision: { ...base.expectedRevision, workspace: "c".repeat(64) },
    }),
  ).not.toBe(canonical);
  expect(
    canonicalSmithRoutingEditRequest({
      ...base,
      change: { ...base.change, entries: [...base.change.entries].reverse() },
    }),
  ).not.toBe(canonical);
  expect(
    smithRoutingEditRequestSchema.safeParse({ ...base, unexpected: true })
      .success,
  ).toBe(false);
});
