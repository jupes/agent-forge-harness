import { expect, test } from "bun:test";
import type { ConversationState } from "../../types/conversation";
import { keeperProposals, parseKeeperProposalMessage } from "./proposals";

const intents = [
  { kind: "approve-beads", beadIds: ["alpha-1", "alpha-2"] },
  {
    kind: "start-session",
    provider: "codex",
    smith: "codex-journeyman",
    beadId: "alpha-1",
    repository: "/served",
    worktree: "new",
    prompt: "Implement the scoped bead",
  },
  {
    kind: "start-shift",
    durationMinutes: 30,
    concurrency: 1,
    beadLimit: 2,
    spendLimitUsd: 5,
  },
  {
    kind: "send-to-council",
    beadId: "alpha-1",
    profile: "default",
    question: "Review this change",
  },
  {
    kind: "create-beads",
    beads: [
      {
        title: "A scoped task",
        type: "task",
        priority: 2,
        parentId: "alpha-epic",
        description: "Acceptance evidence",
      },
    ],
  },
  {
    kind: "manage-bead",
    beadId: "alpha-1",
    operation: { kind: "reassign", smith: "codex-journeyman" },
  },
  {
    kind: "record-decision",
    beadId: "alpha-1",
    decision: "Use the existing shared reader.",
  },
] as const;
const envelope = () => ({
  kind: "keeper.proposals.v1",
  message: "These are proposals; nothing has run.",
  proposals: intents.map((action, index) => ({
    title: `Proposal ${index + 1}`,
    detail: "Review before approval.",
    action,
  })),
});
const at = "2026-10-22T12:00:00.000Z",
  requestId = "1a5832fa-7a21-403b-8184-44892f0d8d86";
const binding = {
  provider: "claude" as const,
  sessionId: "actual-session",
  version: "fixture",
};
const state = (): ConversationState => ({
  version: 1,
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  conversationId: "keeper-project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  revision: 5,
  binding,
  turns: [
    {
      requestId,
      hash: "0".repeat(64),
      phase: "completed",
      createdAt: at,
      updatedAt: at,
      reason: null,
      owner: null,
    },
  ],
  frames: [
    { seq: 1, turnId: requestId, at, event: { kind: "identity", ...binding } },
    {
      seq: 2,
      turnId: requestId,
      at,
      event: { kind: "text", text: JSON.stringify(envelope()) },
    },
  ],
});

test("all seven proposal kinds are inert structured data; model status, execution paths and unknown arguments are rejected", () => {
  const parsed = parseKeeperProposalMessage(JSON.stringify(envelope()));
  expect(parsed?.proposals.map((item) => item.action.kind)).toEqual(
    intents.map((item) => item.kind),
  );
  for (const extras of [
    { status: "done" },
    { approved: true },
    { path: "/queue/alpha-1/approve" },
    { command: "bd close alpha-1" },
  ]) {
    const raw = envelope();
    expect(
      parseKeeperProposalMessage(
        JSON.stringify({
          ...raw,
          proposals: [{ ...raw.proposals[0], ...extras }],
        }),
      ),
    ).toBeNull();
  }
  expect(
    parseKeeperProposalMessage(
      JSON.stringify({
        ...envelope(),
        proposals: [
          {
            title: "Unsupported",
            detail: "Review",
            action: { kind: "http", url: "https://example.com" },
          },
        ],
      }),
    ),
  ).toBeNull();
  expect(
    parseKeeperProposalMessage(
      "A quoted example: " + JSON.stringify(envelope()),
    ),
  ).toBeNull();
  expect(
    parseKeeperProposalMessage(
      JSON.stringify({ ...envelope(), message: "x".repeat(30_000) }),
    ),
  ).toBeNull();
});

test("only completed matching identity produces stable server-derived proposal references; source changes cannot keep their hash", () => {
  const original = state(),
    cards = keeperProposals(original);
  expect(cards).toHaveLength(7);
  expect(cards[0]).toMatchObject({
    projectId: original.projectId,
    sourceRequestId: requestId,
    id: `proposal-${requestId}-0`,
  });
  expect(cards[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(keeperProposals(original)).toEqual(cards);
  for (const phase of ["running", "failed", "unknown", "cancelled"] as const)
    expect(
      keeperProposals({
        ...original,
        turns: original.turns.map((turn) => ({ ...turn, phase })),
      }),
    ).toEqual([]);
  expect(
    keeperProposals({
      ...original,
      binding: { ...binding, sessionId: "different" },
    }),
  ).toEqual([]);
  expect(
    keeperProposals({
      ...original,
      frames: original.frames.filter(
        (frame) => frame.event.kind !== "identity",
      ),
    }),
  ).toEqual([]);
  const changed = state();
  changed.frames[1] = {
    seq: 2,
    turnId: requestId,
    at,
    event: {
      kind: "text",
      text: JSON.stringify({ ...envelope(), message: "Edited source" }),
    },
  };
  expect(keeperProposals(changed)[0]?.sourceHash).not.toBe(
    cards[0]?.sourceHash,
  );
});
