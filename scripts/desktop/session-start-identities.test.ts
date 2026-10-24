import { expect, test } from "bun:test";
import {
  createSessionStartIdentities,
  SESSION_START_IDENTITIES,
  sessionStartHash,
} from "../../apps/desktop/src/session-start-identities";
import { sessionStartFixture } from "./session-start-fixture";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  requestId = "18da5c95-3218-439c-a33d-e5662465f505";
const input = {
  provider: "codex" as const,
  smith: "codex-journeyman",
  repository: "/repo",
  worktree: "/repo",
  launch: {
    mode: "task" as const,
    model: "gpt-example-exact",
    prompt: "PRIVATE PROMPT",
    sandbox: "read-only" as const,
    approvalPolicy: "never" as const,
    attachments: [
      {
        kind: "text" as const,
        name: "PRIVATE FILENAME",
        text: "PRIVATE ATTACHMENT",
      },
    ],
  },
};

test("two windows reserve one durable original UUID before POST and store bounded metadata only", async () => {
  const fixture = sessionStartFixture();
  let minted = 0;
  const mint = () => {
    minted++;
    return requestId;
  };
  const results = await Promise.all([
    fixture.make().reserve(projectId, input, mint),
    fixture
      .make()
      .reserve(
        projectId,
        { ...input, launch: { ...input.launch, prompt: "Changed draft" } },
        mint,
      ),
  ]);
  expect(results.map((result) => result.created)).toEqual([true, false]);
  expect(minted).toBe(1);
  expect(results[1]?.request).toBeNull();
  const identity = fixture.make().read(projectId);
  expect(identity).toEqual({
    projectId,
    requestId,
    requestHash: await sessionStartHash({ ...input, requestId }),
    provider: "codex",
  });
  const text = fixture.storage.getItem(SESSION_START_IDENTITIES);
  expect(text).not.toContain("PRIVATE");
  expect(text).not.toContain("/repo");
  expect(text).not.toContain("gpt-example");
  if (!identity) throw Error("Missing reserved identity");
  await expect(
    fixture.make().release({ ...identity, requestHash: "f".repeat(64) }),
  ).rejects.toThrow("different original");
  expect(fixture.make().read(projectId)).toEqual(identity);
  await fixture.make().release(identity);
  expect(fixture.make().read(projectId)).toBeNull();
});

test("corrupt, future, conflicting or full histories refuse before minting and preserve all saved bytes", async () => {
  const identity = {
    projectId,
    requestId,
    provider: "codex",
    requestHash: "a".repeat(64),
  };
  const full = Array.from({ length: 256 }, (_, index) => ({
    ...identity,
    projectId: `project-${index.toString(16).padStart(8, "0")}-7a21-403b-8184-44892f0d8d86`,
    requestId: `${index.toString(16).padStart(8, "0")}-3218-439c-a33d-e5662465f505`,
  }));
  for (const text of [
    "{corrupt",
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [identity, identity] }),
    JSON.stringify({ version: 1, records: full }),
  ]) {
    const fixture = sessionStartFixture();
    fixture.storage.setItem(SESSION_START_IDENTITIES, text);
    let minted = 0;
    await expect(
      fixture.make().reserve(projectId, input, () => {
        minted++;
        return requestId;
      }),
    ).rejects.toThrow();
    expect(minted).toBe(0);
    expect(fixture.storage.getItem(SESSION_START_IDENTITIES)).toBe(text);
  }
});

test("unavailable locks/storage, failed saves and unverified readback never authorize an outgoing request", async () => {
  const fixture = sessionStartFixture();
  let minted = 0;
  const mint = () => {
    minted++;
    return requestId;
  };
  const missing = createSessionStartIdentities({
    storage: null,
    withLock: fixture.withLock,
  });
  await expect(missing.reserve(projectId, input, mint)).rejects.toThrow();
  expect(minted).toBe(0);
  const noLock = createSessionStartIdentities({
    storage: fixture.storage,
    withLock: async () => {
      throw Error("No origin lock");
    },
  });
  await expect(noLock.reserve(projectId, input, mint)).rejects.toThrow();
  expect(minted).toBe(0);
  const failed = createSessionStartIdentities({
    storage: {
      getItem: () => null,
      setItem: () => {
        throw Error("Quota");
      },
    },
    withLock: fixture.withLock,
  });
  await expect(failed.reserve(projectId, input, mint)).rejects.toThrow("Quota");
  const unverified = createSessionStartIdentities({
    storage: { getItem: () => null, setItem: () => {} },
    withLock: fixture.withLock,
  });
  await expect(unverified.reserve(projectId, input, mint)).rejects.toThrow(
    "verified",
  );
});
