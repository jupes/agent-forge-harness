import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { KeeperSessionStartRequest } from "../../types/keeper-session-start";
import {
  keeperSessionStartReceiptSchema,
  keeperSessionStartRequestSchema,
} from "./session-start-protocol";

const reviewed: KeeperSessionStartRequest = {
  sourceHash: "a".repeat(64),
  expectedRevision: 0,
  start: {
    requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
    smith: "claude-journeyman",
    repository: "C:/fixture/repository",
    worktree: "C:/fixture/repository",
    beadId: "alpha-1",
    about: [{ kind: "bead", id: "alpha-1" }],
    launch: {
      mode: "task",
      model: "claude-sonnet-4-6",
      prompt: "  Exact reviewed prompt\n🌱\n",
      permissionMode: "plan",
      attachments: [
        { kind: "text", name: "notes.txt", text: "Private attachment\n" },
        {
          kind: "image",
          name: "pixel.png",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
        },
      ],
      extraDirectories: ["C:/fixture/repository/docs"],
      maxBudgetUsd: 2,
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    },
  },
};

test("the reviewed Keeper Start preserves the full strict launch independently of the small source proposal", () => {
  const parsed = keeperSessionStartRequestSchema.parse(reviewed);
  expect(parsed).toEqual(reviewed);
  expect(
    keeperSessionStartRequestSchema.safeParse({ ...reviewed, extra: true })
      .success,
  ).toBe(false);
  for (const change of [
    { context: {} },
    { resumeSessionId: "native-provider-id" },
    { arbitraryFlags: ["--dangerously-skip-permissions"] },
  ])
    expect(
      keeperSessionStartRequestSchema.safeParse({
        ...reviewed,
        start: {
          ...reviewed.start,
          launch: { ...reviewed.start.launch, ...change },
        },
      }).success,
    ).toBe(false);
});

test("a recovery receipt verifies source/original identity and leaves a registry-only reservation unconfirmed", () => {
  const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
  const sourceRequestId = "1a5832fa-7a21-403b-8184-44892f0d8d86";
  const proposalId = `proposal-${sourceRequestId}-0`;
  const at = "2026-10-23T04:00:00.000Z";
  const session = {
    projectId,
    id: "session-f19bedb4-5882-44b3-b793-9bbe01f539ab",
    requestId: reviewed.start.requestId,
    requestHash: "b".repeat(64),
    createdAt: at,
    provider: "claude",
    mode: "task",
    workspace: reviewed.start.repository,
    repository: reviewed.start.repository,
    worktree: reviewed.start.worktree,
    beadId: reviewed.start.beadId,
    smith: reviewed.start.smith,
    requestedModel: reviewed.start.launch.model,
    requestedEffort: null,
  };
  const value = {
    projectId,
    proposalId,
    revision: 1,
    record: {
      id: proposalId,
      projectId,
      sourceRequestId,
      sourceHash: reviewed.sourceHash,
      createdAt: at,
      draft: {
        title: "Review a session",
        detail: "Review first",
        action: {
          kind: "start-session",
          provider: "claude",
          smith: reviewed.start.smith,
          beadId: "alpha-1",
          repository: reviewed.start.repository,
          worktree: "current",
          prompt: "Source suggestion",
        },
      },
      requestId: reviewed.start.requestId,
      requestHash: "c".repeat(64),
      operation: "approve",
      auditEventId: 1,
      phase: "unknown",
      pending: false,
      updatedAt: at,
      message: "Original Start is unconfirmed.",
      objects: [],
    },
    original: reviewed,
    startHash: session.requestHash,
    session,
    receipt: null,
  };
  expect(keeperSessionStartReceiptSchema.parse(value).receipt).toBe(null);
  expect(
    keeperSessionStartReceiptSchema.safeParse({
      ...value,
      session: { ...session, requestId: sourceRequestId },
    }).success,
  ).toBe(false);
  expect(
    keeperSessionStartReceiptSchema.safeParse({
      ...value,
      original: { ...reviewed, sourceHash: "f".repeat(64) },
    }).success,
  ).toBe(false);
});

test("the shared Keeper Start codec bundles for the browser without server or native imports", async () => {
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./session-start-protocol.ts", import.meta.url)),
    ],
    target: "browser",
  });
  expect(built.success).toBe(true);
  const content = await built.outputs[0]?.text();
  expect(content).not.toContain("bun:sqlite");
  expect(content).not.toContain("node:fs");
});
