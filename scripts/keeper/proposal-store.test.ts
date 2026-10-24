import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeeperProposal } from "../../types/keeper-proposal";
import { writeOwnerOnly } from "../hearth/token";
import {
  createKeeperProposalStore,
  keeperProposalFile,
} from "./proposal-store";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  sourceRequestId = "1a5832fa-7a21-403b-8184-44892f0d8d86";
const proposal: KeeperProposal = {
  id: `proposal-${sourceRequestId}-0`,
  projectId,
  sourceRequestId,
  sourceHash: "a".repeat(64),
  createdAt: "2026-10-22T12:00:00.000Z",
  draft: {
    title: "Record a decision",
    detail: "Review it first",
    action: {
      kind: "record-decision",
      beadId: "alpha-1",
      decision: "Reuse the shared scoped reader.",
    },
  },
};
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "keeper proposal review "));
  homes.push(home);
  return { home, store: createKeeperProposalStore(home) };
}
const input = () => ({
  projectId,
  proposal,
  requestId: randomUUID(),
  expectedRevision: 0,
  draft: proposal.draft,
  auditEventId: 12,
});

test("approval is private and durable before its one effect; identical retries observe it while changed content or a new approval cannot repeat it", async () => {
  const { home, store } = fixture(),
    request = input();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const first = store.approve(request, async () => {
    calls++;
    expect((await store.read(projectId)).records[0]).toMatchObject({
      phase: "approved",
      pending: true,
      auditEventId: 12,
      requestId: request.requestId,
    });
    entered();
    await gate;
    return {
      phase: "done" as const,
      message: "Decision recorded.",
      objects: [{ kind: "bead" as const, id: "alpha-1" }],
    };
  });
  await started;
  const second = createKeeperProposalStore(home);
  expect(
    (
      await second.approve(request, async () => {
        calls++;
        throw new Error("Repeated effect");
      })
    ).record.phase,
  ).toBe("approved");
  await expect(
    second.approve({ ...request, requestId: randomUUID() }, async () => {
      calls++;
      throw new Error("Repeated effect");
    }),
  ).rejects.toThrow("already");
  release();
  const done = await first;
  expect(done.record).toMatchObject({
    phase: "done",
    pending: false,
    objects: [{ kind: "bead", id: "alpha-1" }],
  });
  expect(
    (
      await second.approve(request, async () => {
        calls++;
        throw new Error("Repeated effect");
      })
    ).record,
  ).toEqual(done.record);
  await expect(
    second.approve(
      { ...request, draft: { ...proposal.draft, title: "Changed review" } },
      async () => {
        calls++;
        throw new Error("Repeated effect");
      },
    ),
  ).rejects.toThrow("different");
  expect(calls).toBe(1);
});

test("dismissal and refused review inputs start nothing; uncertain execution is retained without echoing the thrown private text", async () => {
  const { store } = fixture();
  let calls = 0;
  const run = async () => {
    calls++;
    throw new Error("Synthetic private provider text");
  };
  const invalid = input();
  await expect(
    store.approve({ ...invalid, auditEventId: 0 }, run),
  ).rejects.toThrow("audit");
  await expect(
    store.approve(
      {
        ...invalid,
        proposal: {
          ...proposal,
          projectId: "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
        },
      },
      run,
    ),
  ).rejects.toThrow("project");
  expect(calls).toBe(0);
  const unknown = await store.approve(invalid, run);
  expect(unknown.record.phase).toBe("unknown");
  expect(JSON.stringify(unknown)).not.toContain("Synthetic private");
  expect((await store.approve(invalid, run)).record.phase).toBe("unknown");
  expect(calls).toBe(1);
  const fresh = fixture(),
    dismiss = input();
  const dismissed = await fresh.store.dismiss(dismiss);
  expect(dismissed.record.phase).toBe("dismissed");
  await expect(
    fresh.store.approve(
      {
        ...dismiss,
        requestId: randomUUID(),
        expectedRevision: dismissed.revision,
      },
      run,
    ),
  ).rejects.toThrow("already");
  expect(calls).toBe(1);
});

test("an abandoned admitted approval reads as unknown and is never dispatched again", async () => {
  const { home, store } = fixture(),
    request = input();
  let calls = 0;
  await store.approve(request, async () => ({
    phase: "done",
    message: "Fixture finished",
    objects: [],
  }));
  const saved = await store.read(projectId);
  writeOwnerOnly(
    keeperProposalFile(home, projectId),
    JSON.stringify({
      ...saved,
      records: saved.records.map((record) => ({
        ...record,
        phase: "approved",
        pending: true,
        objects: [],
        message: "Approval recorded.",
      })),
    }),
  );
  const admittedText = readFileSync(
    keeperProposalFile(home, projectId),
    "utf8",
  );
  const restarted = createKeeperProposalStore(home);
  expect((await restarted.read(projectId)).records[0]).toMatchObject({
    phase: "unknown",
    pending: false,
  });
  expect(
    (
      await restarted.approve(request, async () => {
        calls++;
        return { phase: "done", message: "Repeated", objects: [] };
      })
    ).record.phase,
  ).toBe("unknown");
  expect(calls).toBe(0);
  expect(readFileSync(keeperProposalFile(home, projectId), "utf8")).toBe(
    admittedText,
  );
});
