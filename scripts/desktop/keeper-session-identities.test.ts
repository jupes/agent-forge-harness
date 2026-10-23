import { expect, test } from "bun:test";
import {
  createKeeperSessionIdentities,
  KEEPER_SESSION_IDENTITIES,
} from "../../apps/desktop/src/keeper-session-identities";
import type { KeeperProposal } from "../../types/keeper-proposal";

const source: KeeperProposal = {
  id: "proposal-1a5832fa-7a21-403b-8184-44892f0d8d86-0",
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  sourceRequestId: "1a5832fa-7a21-403b-8184-44892f0d8d86",
  sourceHash: "a".repeat(64),
  createdAt: "2026-10-23T04:00:00.000Z",
  draft: {
    title: "Private title",
    detail: "Private detail",
    action: {
      kind: "start-session",
      provider: "claude",
      smith: "private-smith",
      beadId: "private-bead",
      repository: "C:/fixture/repository",
      worktree: "current",
      prompt: "Private prompt and attachment text",
    },
  },
};
const requestId = "b14cc7eb-3231-4930-a288-d411c5ee0426";
function fixture(initial: string | null = null) {
  let text = initial,
    tail = Promise.resolve();
  const storage = {
    getItem: () => text,
    setItem: (_key: string, value: string) => {
      text = value;
    },
  };
  const withLock = <T>(work: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  return {
    storage,
    withLock,
    text: () => text,
    create: () => createKeeperSessionIdentities({ storage, withLock }),
  };
}

test("two windows reserve one verified metadata-only identity before either may dispatch", async () => {
  const held = fixture(),
    one = held.create(),
    two = held.create();
  let minted = 0;
  const results = await Promise.all([
    one.reserve(source, () => {
      minted++;
      return requestId;
    }),
    two.reserve(source, () => {
      minted++;
      return crypto.randomUUID();
    }),
  ]);
  expect(results).toEqual([
    { requestId, created: true },
    { requestId, created: false },
  ]);
  expect(minted).toBe(1);
  expect(two.read(source)).toBe(requestId);
  expect(JSON.parse(held.text() ?? "null")).toEqual({
    version: 1,
    records: [
      {
        projectId: source.projectId,
        proposalId: source.id,
        sourceHash: source.sourceHash,
        repository: "c:/fixture/repository",
        requestId,
      },
    ],
  });
  expect(held.text()).not.toContain("Private");
  expect(held.text()).not.toContain("private-smith");
  expect(held.text()).not.toContain("private-bead");
});

test("malformed, duplicate and wrong-repository metadata cannot authorize or overwrite a Start", async () => {
  for (const text of ["{", '{"version":1,"records":[{"requestId":"bad"}]}']) {
    const held = fixture(text),
      client = held.create();
    expect(() => client.read(source)).toThrow();
    await expect(client.reserve(source, () => requestId)).rejects.toThrow();
    expect(held.text()).toBe(text);
  }
  const held = fixture(),
    client = held.create();
  await client.reserve(source, () => requestId);
  const wrong = structuredClone(source);
  if (wrong.draft.action.kind !== "start-session") throw Error("Wrong fixture");
  wrong.draft.action.repository = "C:/different";
  expect(() => client.read(wrong)).toThrow("another repository");
  await expect(
    client.reserve(wrong, () => crypto.randomUUID()),
  ).rejects.toThrow("another repository");
  const raw: { version: number; records: unknown[] } = JSON.parse(
    held.text() ?? "null",
  );
  raw.records.push(raw.records[0]);
  held.storage.setItem(KEEPER_SESSION_IDENTITIES, JSON.stringify(raw));
  expect(() => client.read(source)).toThrow("conflicting");
});

test("full identity storage refuses a new proposal and retains every uncertain original", async () => {
  const held = fixture(),
    client = held.create();
  for (let index = 0; index < 256; index++)
    await client.reserve(
      { ...source, id: `${source.id}-${index}` },
      () => requestId,
    );
  const text = held.text();
  await expect(
    client.reserve(source, () => crypto.randomUUID()),
  ).rejects.toThrow("full");
  expect(held.text()).toBe(text);
  expect(client.read({ ...source, id: `${source.id}-0` })).toBe(requestId);
});

test("unavailable storage, unavailable lock and failed readback refuse reservation", async () => {
  const lock = async <T>(work: () => T | Promise<T>) => work();
  await expect(
    createKeeperSessionIdentities({ storage: null, withLock: lock }).reserve(
      source,
      () => requestId,
    ),
  ).rejects.toThrow("unavailable");
  const held = fixture();
  await expect(
    createKeeperSessionIdentities({
      storage: held.storage,
      withLock: async () => {
        throw Error("No lock");
      },
    }).reserve(source, () => requestId),
  ).rejects.toThrow("No lock");
  expect(held.text()).toBeNull();
  await expect(
    createKeeperSessionIdentities({
      storage: { getItem: () => null, setItem: () => {} },
      withLock: lock,
    }).reserve(source, () => requestId),
  ).rejects.toThrow("saved and verified");
});

test("JSON expansion cannot write an unreadable journal or poison earlier identities", async () => {
  const held = fixture(),
    client = held.create();
  await client.reserve(source, () => requestId);
  let refused = false;
  for (let index = 0; index < 255; index++) {
    const next = structuredClone(source);
    next.id += `-${index}`;
    if (next.draft.action.kind !== "start-session")
      throw Error("Wrong fixture");
    next.draft.action.repository = `C:/fixture/${"\u0001".repeat(1000)}/${index}`;
    const before = held.text();
    try {
      await client.reserve(next, () => crypto.randomUUID());
    } catch {
      refused = true;
      expect(held.text()).toBe(before);
      expect(client.read(source)).toBe(requestId);
      break;
    }
  }
  expect(refused).toBe(true);
});
