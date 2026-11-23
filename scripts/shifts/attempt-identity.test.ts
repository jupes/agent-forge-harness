import { expect, test } from "bun:test";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import type { PrivateExecInput } from "../executors/private-capture";
import {
  prepareShiftTurnSnapshot,
  shiftAttemptHash,
  shiftAttemptRequestId,
} from "./attempt-identity";
import { projectShiftRequestHash } from "./registry";

const request = {
  requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
  expectedCatalogRevision: 3,
  options: {
    for: "2h",
    concurrency: 2,
    maxBeads: 4,
    maxUsd: 5,
    repairs: 1,
    base: "main",
  },
};
const intent: ProjectShiftIntent = {
  projectId: "project-05f27fd0-011b-4e0c-bb01-0da9104b1439",
  workspace: "/fixture",
  shiftId: "shift-20261023-080000-1234",
  request,
  requestHash: projectShiftRequestHash(
    "project-05f27fd0-011b-4e0c-bb01-0da9104b1439",
    "/fixture",
    request,
  ),
  createdAt: "2026-10-23T08:00:00.000Z",
  attemptedAt: "2026-10-23T08:00:01.000Z",
  executionStartedAt: "2026-10-23T08:00:02.000Z",
};
const input: PrivateExecInput = {
  provider: "claude",
  beadId: "bounded-task-1",
  runId: "bounded-run-1",
  workspace: "/fixture",
  cwd: "/fixture/worktree",
  smith: {
    name: "claude-journeyman",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "medium",
    enabled: true,
    tags: [],
  },
  command: [
    "/fixture/claude",
    "-p",
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "medium",
  ],
  stdin: "  exact input\n",
  timeoutMs: 60000,
};

test("attempt UUIDs use one fixed version5 namespace and cannot change with new mutable execution input", () => {
  const id = shiftAttemptRequestId(intent, input, 1);
  expect(id).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(id).toBe("0538441c-01fa-5ae5-a7ec-42da70eb47c2");
  expect(
    shiftAttemptRequestId(
      intent,
      { ...input, stdin: "changed", command: ["/different/claude"] },
      1,
    ),
  ).toBe(id);
  for (const changed of [
    { ...input, beadId: "other-task" },
    { ...input, runId: "other-run" },
  ])
    expect(shiftAttemptRequestId(intent, changed, 1)).not.toBe(id);
  expect(shiftAttemptRequestId(intent, input, 2)).not.toBe(id);
});

test("attempt content hash covers exact original bounds and every actual execution field", () => {
  const hash = shiftAttemptHash(intent, input, 1, "2.1.293");
  for (const changed of [
    { ...input, stdin: `${input.stdin} ` },
    { ...input, cwd: "/fixture/other-worktree" },
    { ...input, command: [...input.command, "--verbose"] },
    { ...input, timeoutMs: 50000 },
    { ...input, smith: { ...input.smith, model: "claude-other" } },
    { ...input, smith: { ...input.smith, effort: "high" } },
  ])
    expect(shiftAttemptHash(intent, changed, 1, "2.1.293")).not.toBe(hash);
  expect(shiftAttemptHash(intent, input, 1, "2.1.296")).not.toBe(hash);
  const editedRequest = {
    ...request,
    options: { ...request.options, maxBeads: 3 },
  };
  const edited = {
    ...intent,
    request: editedRequest,
    requestHash: projectShiftRequestHash(
      intent.projectId,
      intent.workspace,
      editedRequest,
    ),
  };
  expect(shiftAttemptRequestId(edited, input, 1)).toBe(
    shiftAttemptRequestId(intent, input, 1),
  );
  expect(shiftAttemptHash(edited, input, 1, "2.1.293")).not.toBe(hash);
});

test("private snapshots refuse foreign scope, impossible attempts, credential argv and changed original hashes", () => {
  const address = "session-75126685-270f-49b9-8262-d74b49b0b94e";
  expect(
    prepareShiftTurnSnapshot(intent, input, 1, "2.1.293", address),
  ).toMatchObject({
    conversationId: address,
    stdin: input.stdin,
    requestedModel: input.smith.model,
  });
  for (const changed of [
    { ...input, workspace: "/foreign" },
    { ...input, command: [...input.command, "--api-key=never-save"] },
    { ...input, provider: "codex" as const },
  ])
    expect(() =>
      prepareShiftTurnSnapshot(intent, changed, 1, "2.1.293", address),
    ).toThrow();
  expect(() => shiftAttemptRequestId(intent, input, 3)).toThrow();
  expect(() =>
    shiftAttemptRequestId({ ...intent, requestHash: "a".repeat(64) }, input, 1),
  ).toThrow();
});
