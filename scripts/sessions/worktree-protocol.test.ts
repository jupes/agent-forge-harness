import { expect, test } from "bun:test";
import {
  sessionWorktreeReceiptSchema,
  sessionWorktreeRequestSchema,
} from "./worktree-protocol";

const request = {
  requestId: "7429508e-2321-472a-9c3a-eef27a91d0d3",
  repository: "C:/fixture/repo",
  baseRef: "main",
  branch: "feat/reviewed",
};
test("worktree requests are bounded browser-safe explicit values, never shell flags or a Start payload", () => {
  const buffer = globalThis.Buffer;
  try {
    Reflect.set(globalThis, "Buffer", undefined);
    expect(sessionWorktreeRequestSchema.safeParse(request).success).toBe(true);
    for (const input of [
      { ...request, force: true },
      { ...request, prompt: "Do work" },
      { ...request, repository: "../repo" },
      { ...request, baseRef: "--all" },
      { ...request, branch: "refs/heads/feature" },
      { ...request, branch: "feat/../escape" },
      { ...request, branch: "x".repeat(201) },
    ])
      expect(sessionWorktreeRequestSchema.safeParse(input).success).toBe(false);
  } finally {
    Reflect.set(globalThis, "Buffer", buffer);
  }
});
test("only a created receipt with its confirmed worktree and no problem can advertise creation", () => {
  const receipt = {
    projectId: "project-1c6cfa8c-d876-4270-b067-e209c18c2034",
    ...request,
    resolvedCommit: "a".repeat(40),
    worktree: {
      id: `sw-${"a".repeat(28)}`,
      path: `C:/fixture/repo/trees/sw-${"a".repeat(28)}`,
      branch: request.branch,
      createdAt: "2026-10-23T00:00:00.000Z",
    },
    state: "created",
    reason: null,
  };
  expect(sessionWorktreeReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(
    sessionWorktreeReceiptSchema.safeParse({ ...receipt, worktree: null })
      .success,
  ).toBe(false);
  expect(
    sessionWorktreeReceiptSchema.safeParse({
      ...receipt,
      reason: "Unconfirmed",
    }).success,
  ).toBe(false);
  expect(
    sessionWorktreeReceiptSchema.safeParse({
      ...receipt,
      state: "unknown",
      reason: "Inspect the planned worktree",
    }).success,
  ).toBe(true);
});
