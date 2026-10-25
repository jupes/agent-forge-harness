import { expect, test } from "bun:test";
import {
  createKeeperShiftIdentities,
  KEEPER_SHIFT_IDENTITIES,
} from "../../apps/desktop/src/keeper-shift-identities";
import type { KeeperProposal } from "../../types/keeper-proposal";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const workspace = "C:/fixture/repository";
const source: KeeperProposal = {
  id: "proposal-1a5832fa-7a21-403b-8184-44892f0d8d86-0",
  projectId,
  sourceRequestId: "1a5832fa-7a21-403b-8184-44892f0d8d86",
  sourceHash: "a".repeat(64),
  createdAt: "2026-10-25T12:00:00.000Z",
  draft: {
    title: "Review a project Shift",
    detail: "Do not persist reviewed private input",
    action: {
      kind: "start-shift",
      durationMinutes: 45,
      concurrency: 2,
      beadLimit: 5,
      spendLimitUsd: 8,
    },
  },
};

function fixture(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(KEEPER_SHIFT_IDENTITIES, initial);
  let tail = Promise.resolve();
  return {
    values,
    identities: createKeeperShiftIdentities({
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      withLock: async <T>(work: () => T | Promise<T>) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await work();
        } finally {
          release();
        }
      },
    }),
  };
}

test("concurrent reservations share one durable UUID and store only source-bound metadata", async () => {
  const { identities, values } = fixture();
  let minted = 0;
  const mint = () => {
    minted++;
    return "913c01ee-e854-4d0e-8d6c-a246304d74a1";
  };
  const [first, second] = await Promise.all([
    identities.reserve(source, workspace, mint),
    identities.reserve(source, workspace, mint),
  ]);
  expect(first.identity).toEqual(second.identity);
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(minted).toBe(1);
  expect(identities.read(source, workspace)).toEqual(first.identity);
  const stored = values.get(KEEPER_SHIFT_IDENTITIES) ?? "";
  expect(stored).toContain(source.sourceHash);
  expect(stored).toContain(first.identity.requestId);
  expect(stored).not.toContain("options");
  expect(stored).not.toContain("private reviewed input");
});

test("changed source or workspace cannot replace a held UUID", async () => {
  const { identities, values } = fixture();
  const held = await identities.reserve(
    source,
    workspace,
    () => "913c01ee-e854-4d0e-8d6c-a246304d74a1",
  );
  const bytes = values.get(KEEPER_SHIFT_IDENTITIES);
  const changedSource = { ...source, sourceHash: "b".repeat(64) };
  expect(() => identities.read(changedSource, workspace)).toThrow(
    "changed proposal source or workspace",
  );
  await expect(
    identities.reserve(changedSource, workspace, () => {
      throw Error("Must not mint a replacement");
    }),
  ).rejects.toThrow("changed proposal source or workspace");
  expect(() => identities.read(source, "C:/retargeted")).toThrow(
    "changed proposal source or workspace",
  );
  expect(values.get(KEEPER_SHIFT_IDENTITIES)).toBe(bytes);
  expect(identities.read(source, workspace)).toEqual(held.identity);
});

test("corrupt, future-version, oversized and cross-record-conflicting bytes are preserved", async () => {
  for (const bytes of [
    "{",
    JSON.stringify({ version: 2, records: [] }),
    "x".repeat(100_001),
    JSON.stringify({
      version: 1,
      records: [
        {
          projectId,
          proposalId: source.id,
          sourceHash: source.sourceHash,
          workspace,
          requestId: "913c01ee-e854-4d0e-8d6c-a246304d74a1",
        },
        {
          projectId,
          proposalId: source.id,
          sourceHash: source.sourceHash,
          workspace,
          requestId: "a13c01ee-e854-4d0e-8d6c-a246304d74a2",
        },
      ],
    }),
  ]) {
    const { identities, values } = fixture(bytes);
    expect(() => identities.read(source, workspace)).toThrow();
    expect(values.get(KEEPER_SHIFT_IDENTITIES)).toBe(bytes);
    await expect(
      identities.reserve(source, workspace, () => {
        throw Error("Must not mint from invalid storage");
      }),
    ).rejects.toThrow();
    expect(values.get(KEEPER_SHIFT_IDENTITIES)).toBe(bytes);
  }
});

test("non-Shift proposal cannot reserve an identity", async () => {
  const { identities, values } = fixture();
  const nonShift: KeeperProposal = {
    ...source,
    draft: {
      ...source.draft,
      action: { kind: "approve-beads", beadIds: ["alpha-1"] },
    },
  };
  await expect(
    identities.reserve(
      nonShift,
      workspace,
      () => "913c01ee-e854-4d0e-8d6c-a246304d74a1",
    ),
  ).rejects.toThrow("does not request a Shift");
  expect(values.has(KEEPER_SHIFT_IDENTITIES)).toBe(false);
});
