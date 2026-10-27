import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { workspaceKey } from "../projects/scope";
import {
  readSessionOperationIdentityPage,
  SESSION_OPERATION_IDENTITY_LIMITS,
  sessionOperationIdentityPageSchema,
} from "./session-operation-identities-protocol";

const scope = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: workspaceKey(resolve("fixture-workspace")),
};

function startRow(requestId = randomUUID()) {
  return {
    version: 1 as const,
    requestId,
    requestHash: "a".repeat(64),
    provider: "codex" as const,
    mode: "chat" as const,
    state: "reserved" as const,
  };
}

function forkRow(requestId = randomUUID()) {
  return {
    family: "codex-chat-fork" as const,
    requestId,
    requestHash: "b".repeat(64),
    parentSessionId: `session-${randomUUID()}`,
    throughTurnRequestId: randomUUID(),
    state: "attempted" as const,
  };
}

describe("complete session operation identity pages", () => {
  test("combines both families in stable strict metadata-only order", async () => {
    const page = await readSessionOperationIdentityPage({
      ...scope,
      readStarts: async () => [
        startRow("f0000000-0000-4000-8000-000000000000"),
      ],
      readForks: async () => [forkRow("10000000-0000-4000-8000-000000000000")],
    });

    expect(sessionOperationIdentityPageSchema.parse(page)).toEqual(page);
    expect(page.operations.map((row) => row.family)).toEqual([
      "codex-chat-fork",
      "owned-session-start",
    ]);
    expect(JSON.stringify(page)).not.toContain("sourceSeal");
  });

  test("either synchronous or asynchronous source failure rejects the whole page", async () => {
    const failure = new Error("source unavailable");
    const asynchronousStartFailure = () =>
      readSessionOperationIdentityPage({
        ...scope,
        readStarts: async () => {
          throw failure;
        },
        readForks: async () => [forkRow()],
      });
    const asynchronousForkFailure = () =>
      readSessionOperationIdentityPage({
        ...scope,
        readStarts: async () => [startRow()],
        readForks: async () => {
          throw failure;
        },
      });
    const synchronousForkFailure = () =>
      readSessionOperationIdentityPage({
        ...scope,
        readStarts: async () => {
          await Promise.resolve();
          throw failure;
        },
        readForks: () => {
          throw failure;
        },
      });

    await expect(asynchronousStartFailure()).rejects.toBe(failure);
    await expect(asynchronousForkFailure()).rejects.toBe(failure);
    await expect(synchronousForkFailure()).rejects.toBe(failure);
  });

  test("refuses row and complete-envelope overflow without truncating", async () => {
    const rowOverflow = Array.from(
      { length: SESSION_OPERATION_IDENTITY_LIMITS.operations + 1 },
      () => startRow(),
    );
    await expect(
      readSessionOperationIdentityPage({
        ...scope,
        readStarts: async () => rowOverflow,
        readForks: async () => [],
      }),
    ).rejects.toThrow("row limit");

    const envelopeOverflow = Array.from({ length: 700 }, () => startRow());
    await expect(
      readSessionOperationIdentityPage({
        ...scope,
        readStarts: async () => envelopeOverflow,
        readForks: async () => [],
      }),
    ).rejects.toThrow("response bound");
  });
});
