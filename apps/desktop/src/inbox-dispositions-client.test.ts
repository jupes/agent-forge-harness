import { expect, test } from "bun:test";
import {
  inboxDispositionOriginalSchema,
  inboxDispositionReceiptSchema,
  inboxDispositionStoredOriginalSchema,
} from "../../../types/inbox";
import type { OperatorPost } from "../../../docs/js/operator";
import { createInboxDispositionsClient } from "./inbox-dispositions-client";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const requestId = "77c37127-1c22-4a2a-8e7d-69cc74ff1201";
const scope = { projectId, workspace: "c:/work/alpha" };
const original = inboxDispositionOriginalSchema.parse({
  requestId,
  expectedCatalogRevision: 1,
  workspace: scope.workspace,
  item: {
    sourceKind: "unknown-bead-write",
    stableItemId: "bead-write:reserve-red",
    sourceRevision: "notice-1",
  },
  expectedRevision: 0,
  operation: "done",
});
const storedOriginal = inboxDispositionStoredOriginalSchema.parse({
  ...original,
  projectId,
});
const receipt = inboxDispositionReceiptSchema.parse({
  original: storedOriginal,
  phase: "reserved",
  reservedAt: "2026-10-31T18:00:00.000Z",
});

test("reserve posts the exact immutable original to the protected route first", async () => {
  const calls: Array<{
    url: string;
    body: unknown;
    limits: { maxBodyBytes: number } | undefined;
  }> = [];
  const post: OperatorPost = async (url, body, limits) => {
    calls.push({ url, body, limits });
    return new Response(
      JSON.stringify({
        ok: true,
        data: { entry: null, receipt },
        error: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const client = createInboxDispositionsClient({ post });

  const outcome = await client.reserve(scope, original);

  expect(calls).toEqual([
    {
      url: `/__agent-forge/projects/${encodeURIComponent(projectId)}/inbox-dispositions/requests`,
      body: original,
      limits: { maxBodyBytes: 4 * 1024 * 1024 + 64 * 1024 },
    },
  ]);
  expect(outcome).toMatchObject({ state: "confirmed", value: { entry: null } });
});
