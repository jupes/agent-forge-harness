import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type ProjectCouncilBinding,
  projectCouncilHistorySchema,
  projectCouncilMetadata,
  projectCouncilOriginalReadSchema,
} from "../../types/project-council";
import { ConversationError } from "../conversations/error";
import { privateTempDir } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { createProjectBudgetStore } from "../projects/project-budget-store";
import type { ProjectCouncilRetirementProof } from "../projects/project-budgets-protocol";
import { projectCatalogPath } from "../projects/store";
import { projectCatalogFixture } from "../projects/testing";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  buildContextPack,
  buildContextPackFromParts,
  contextListing,
} from "./context";
import {
  createProjectCouncilOriginalStore,
  projectCouncilInputHash,
  projectCouncilIntentHash,
  projectCouncilProfileHash,
  readProjectCouncilRetirementProof,
} from "./project-original-store";
import { providerEndpointSnapshot } from "./providers";
import { parseCouncilProfileJson } from "./types";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

function fixture() {
  const home = privateTempDir("project-council-original-");
  homes.push(home);
  const profilePath = resolve(import.meta.dir, "../../councils/default.json");
  const parsed = parseCouncilProfileJson(readFileSync(profilePath, "utf8"));
  if (!parsed.ok)
    throw new Error("The inert Council profile fixture is invalid.");
  const workspace = resolve(home, "workspace");
  const binding: ProjectCouncilBinding = {
    projectId: "project-2b4f8e0a-76f1-4c29-972e-4aee9c216d12",
    workspace,
    catalogRevision: 1,
    scopeHash: "a".repeat(64),
    profileHash: projectCouncilProfileHash(parsed.value),
  };
  const store = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: binding.projectId,
    withQueueLock,
  });
  const prepared = (source: string) => {
    const context = buildContextPack({
      kind: "stdin",
      text: source,
      maxBytes: 1024,
    });
    return {
      binding,
      inputHash: projectCouncilInputHash({ source }),
      profileChoice: profilePath,
      profile: parsed.value,
      providerEndpoints: providerEndpointSnapshot(parsed.value, {}),
      context,
      listing: contextListing(context),
      options: {
        maxUsd: 0.25,
        maxBytes: 1024,
        redactSecrets: false,
        deepDiscussion: false,
      },
    };
  };
  return { home, workspace, binding, profilePath, store, prepared };
}

test("project Council originals are durable, exact-retry idempotent, single-dispatch, and non-evicting", async () => {
  const { home, workspace, binding, prepared } = fixture();
  const firstStore = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: binding.projectId,
    withQueueLock,
  });
  const input = prepared("Review the inert project fixture exactly once.");
  const first = await firstStore.reservePrepared(input);
  expect(first.created).toBe(true);
  expect(first.original.context.evidence).toHaveLength(1);
  const firstEvidence = first.original.context.evidence[0];
  if (!firstEvidence) throw new Error("The single-pack evidence is missing.");
  expect(first.original.context.contentHash).toBe(firstEvidence.contentHash);
  expect(projectCouncilIntentHash(first.original)).toBe(
    first.original.intentHash,
  );
  expect(
    projectCouncilIntentHash({
      ...first.original,
      state: "running",
      updatedAt: new Date(
        Date.parse(first.original.updatedAt) + 1000,
      ).toISOString(),
      dispatchClaimedAt: new Date(
        Date.parse(first.original.updatedAt) + 1000,
      ).toISOString(),
    }),
  ).toBe(first.original.intentHash);

  const reopened = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: input.binding.projectId,
    withQueueLock,
  });
  const retry = await reopened.reservePrepared(input);
  expect(retry.created).toBe(false);
  expect(retry.original.requestId).toBe(first.original.requestId);
  expect(retry.original.context).toEqual(input.context);
  expect(
    reopened.read(first.original.binding.projectId, first.original.requestId),
  ).toEqual(first.original);

  const exactBinding = {
    ...input.binding,
    scopeHash: "b".repeat(64),
  };
  await expect(
    reopened.findActive(exactBinding.projectId, exactBinding, input.inputHash),
  ).rejects.toBeInstanceOf(ConversationError);
  await expect(
    reopened.reservePrepared({
      ...input,
      inputHash: projectCouncilInputHash({ source: "different" }),
    }),
  ).rejects.toBeInstanceOf(ConversationError);

  let validationCalls = 0;
  const claimed = await reopened.claimDispatch(
    first.original.binding.projectId,
    first.original.requestId,
    first.original.intentHash,
    async () => {
      validationCalls++;
    },
  );
  expect(claimed.created).toBe(true);
  const replay = await reopened.claimDispatch(
    first.original.binding.projectId,
    first.original.requestId,
    first.original.intentHash,
    async () => {
      validationCalls++;
    },
  );
  expect(replay.created).toBe(false);
  expect(validationCalls).toBe(1);

  await reopened.setTerminal(
    first.original.binding.projectId,
    first.original.requestId,
    first.original.intentHash,
    "completed",
  );
  const next = await reopened.reservePrepared(
    prepared("A second explicit review after the first is terminal."),
  );
  expect(next.created).toBe(true);
  expect(next.original.requestId).not.toBe(first.original.requestId);
  expect(
    reopened.read(first.original.binding.projectId, first.original.requestId)
      .state,
  ).toBe("completed");
});

test("project Council store validates the multipart bead evidence hash family", async () => {
  const { prepared, store } = fixture();
  const base = prepared("A multipart bead review.");
  const context = buildContextPackFromParts({
    kind: "bead",
    displayName: "issue-123",
    locator: "issue-123",
    maxBytes: 1024,
    parts: [
      { label: "description", chunks: [{ text: "First evidence chunk." }] },
      { label: "acceptance", chunks: [{ text: "Second evidence chunk." }] },
    ],
  });
  const input = {
    ...base,
    context,
    listing: contextListing(context),
    inputHash: projectCouncilInputHash({ source: "issue-123" }),
  };
  const reserved = await store.reservePrepared(input);
  expect(reserved.created).toBe(true);
  expect(reserved.original.context.evidence.map((item) => item.id)).toEqual([
    "E1",
    "E2",
  ]);
  expect(
    store.read(reserved.original.binding.projectId, reserved.original.requestId)
      .context.contentHash,
  ).toBe(context.contentHash);
});

test("project Council summary labels redact the complete text before truncating", async () => {
  const { prepared, store } = fixture();
  const label = `${"a".repeat(250)}\u200bOPENAI_API_KEY=abcZq9Zq8Zq7Zq6Zq5Zq4`;
  const base = prepared("A protected original for label projection.");
  const context = {
    ...base.context,
    source: { ...base.context.source, displayName: label },
  };
  const profile = { ...base.profile, title: label };
  const reserved = await store.reservePrepared({
    ...base,
    binding: {
      ...base.binding,
      profileHash: projectCouncilProfileHash(profile),
    },
    context,
    listing: contextListing(context),
    profile,
  });
  const original = reserved.original;
  const metadata = projectCouncilMetadata(original);
  expect(
    projectCouncilOriginalReadSchema.parse({ metadata, original }),
  ).toEqual({
    metadata,
    original,
  });
  expect(metadata.sourceName).toHaveLength(256);
  expect(metadata.profileTitle).toHaveLength(256);
  expect(metadata.sourceName).not.toContain("\u200b");
  expect(metadata.profileTitle).not.toContain("\u200b");
  expect(metadata.sourceName).not.toContain("abcZq9Zq8Zq7Zq6Zq5Zq4");
  expect(metadata.profileTitle).not.toContain("abcZq9Zq8Zq7Zq6Zq5Zq4");
  const history = projectCouncilHistorySchema.parse(
    store.history(original.binding.projectId),
  );
  expect(history).toMatchObject({
    version: 1,
    projectId: original.binding.projectId,
    workspace: original.binding.workspace,
  });
  expect(history.items[0]?.sourceName).toBe(metadata.sourceName);
  expect(history.items[0]?.profileTitle).toBe(metadata.profileTitle);
  expect(history.items[0]?.sourceName).not.toContain("abcZq9Zq8Zq7Zq6Zq5Zq4");
  expect(history.items[0]?.profileTitle).not.toContain("abcZq9Zq8Zq7Zq6Zq5Zq4");
});

test("a changed saved original is refused rather than repaired or replaced", async () => {
  const { home, workspace, binding, store, prepared } = fixture();
  const reserved = await store.reservePrepared(
    prepared("A protected original."),
  );
  const file = resolve(
    home,
    "council-reviews",
    `${createHash("sha256").update(`${workspace}\0${binding.projectId}`, "utf8").digest("hex")}.json`,
  );
  const changed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof changed !== "object" ||
    changed === null ||
    Array.isArray(changed) ||
    !("records" in changed) ||
    !Array.isArray(changed.records) ||
    typeof changed.records[0] !== "object" ||
    changed.records[0] === null ||
    Array.isArray(changed.records[0]) ||
    !("context" in changed.records[0]) ||
    typeof changed.records[0].context !== "object" ||
    changed.records[0].context === null ||
    Array.isArray(changed.records[0].context) ||
    !("evidence" in changed.records[0].context) ||
    !Array.isArray(changed.records[0].context.evidence) ||
    typeof changed.records[0].context.evidence[0] !== "object" ||
    changed.records[0].context.evidence[0] === null ||
    Array.isArray(changed.records[0].context.evidence[0]) ||
    !("content" in changed.records[0].context.evidence[0])
  )
    throw new Error("The stored Council original fixture is malformed.");
  changed.records[0].context.evidence[0].content = "tampered";
  writeOwnerOnly(file, JSON.stringify(changed));

  expect(() =>
    store.read(binding.projectId, reserved.original.requestId),
  ).toThrow(ConversationError);
  expect(() => store.discover(binding.projectId)).toThrow(ConversationError);
});

test("different projects in one workspace have independent retained journals", async () => {
  const { home, workspace, binding, prepared } = fixture();
  const firstStore = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: binding.projectId,
    withQueueLock,
  });
  const firstInput = prepared("Same workspace, first project.");
  const first = await firstStore.reservePrepared(firstInput);
  const secondProjectId = "project-3c5f9a1b-85b3-4d71-8e3a-6c9140275f20";
  const secondBinding = { ...binding, projectId: secondProjectId };
  const secondStore = createProjectCouncilOriginalStore({
    home,
    workspace,
    projectId: secondProjectId,
    withQueueLock,
  });
  const secondInput = {
    ...prepared("Same workspace, first project."),
    binding: secondBinding,
    inputHash: projectCouncilInputHash({
      projectId: secondProjectId,
      source: "Same workspace, first project.",
    }),
  };
  const second = await secondStore.reservePrepared(secondInput);
  expect(second.created).toBe(true);
  expect(second.original.requestId).not.toBe(first.original.requestId);
  expect(firstStore.read(binding.projectId, first.original.requestId)).toEqual(
    first.original,
  );
  expect(secondStore.read(secondProjectId, second.original.requestId)).toEqual(
    second.original,
  );
});

function budgetFor(f: ReturnType<typeof fixture>, cap: number | null = 1) {
  const catalog = projectCatalogFixture(f.workspace);
  catalog.projects[0]!.id = f.binding.projectId;
  catalog.projects[0]!.budgets = {
    shiftSpendCapUsd: null,
    dailyApiKeyCapUsd: cap,
  };
  writeOwnerOnly(projectCatalogPath(f.home), JSON.stringify(catalog));
  return createProjectBudgetStore(f.home);
}
async function reservedBudget(
  holdHash?: string,
  amount = 0.25,
  cap: number | null = 1,
) {
  const f = fixture(),
    budget = budgetFor(f, cap);
  const original = (
    await f.store.reservePrepared(f.prepared("Unsent budget fixture"))
  ).original;
  const id = f.binding.projectId,
    { requestId, intentHash: hash } = original;
  await budget.reserve(id, requestId, holdHash ?? hash, amount);
  const retire = (
    account?: (proof: ProjectCouncilRetirementProof) => Promise<void>,
  ) => f.store.retire(id, requestId, hash, account);
  return { ...f, budget, original, retire, id, requestId, hash };
}
async function captureRetirement(
  f: Awaited<ReturnType<typeof reservedBudget>>,
) {
  let proof: ProjectCouncilRetirementProof | undefined;
  await f.retire(async (value) => {
    proof = value;
  });
  if (!proof) throw Error("Expected the durable owner's retirement capability");
  return proof;
}

test("retirement capabilities bind home and preserve terminal budget history", async () => {
  const f = await reservedBudget(),
    proof = await captureRetirement(f);
  expect(Object.isFrozen(proof)).toBe(true);
  for (const invalid of [
    {},
    { ...proof },
    structuredClone(proof),
    JSON.stringify(proof),
    new Proxy(proof, {}),
  ])
    await expect(
      Reflect.apply(f.budget.retireUnsent, f.budget, [invalid]),
    ).rejects.toThrow("proof");
  const other = fixture(),
    foreign = budgetFor(other);
  await foreign.reserve(f.id, f.requestId, f.hash, 0.25);
  await expect(foreign.retireUnsent(proof)).rejects.toThrow("home");
  expect(foreign.status(f.id).reservedUsd).toBe(0.25);
  expect(f.budget.status(f.id).reservedUsd).toBe(0.25);
  await f.budget.retireUnsent(proof);
  const file = join(f.home, "project-budgets", "allocations.json"),
    bytes = readFileSync(file, "utf8");
  const retired = f.store.read(f.id, f.requestId);
  await f.retire(f.budget.retireUnsent);
  expect(f.store.read(f.id, f.requestId)).toEqual(retired);
  await expect(
    f.budget.reserve(f.id, f.requestId, f.hash, 0.25),
  ).rejects.toThrow("retired");
  await f.budget.settle(f.id, f.requestId, f.hash, {
    actualCostUsd: 1,
    usageEstimatedCostUsd: null,
    costIsEstimate: false,
  });
  expect(readFileSync(file, "utf8")).toBe(bytes);
  const tomorrow = createProjectBudgetStore(
    f.home,
    () => new Date(Date.now() + 86_400_000),
  );
  expect(tomorrow.status(f.id)).toMatchObject({
    reservedUsd: 0,
    reportedUsd: 0,
    unknownCount: 0,
  });
  await tomorrow.reserve(
    f.id,
    "00000000-0000-4000-8000-000000000099",
    "f".repeat(64),
    1,
  );
  expect(tomorrow.status(f.id).reservedUsd).toBe(1);
});

test("retirement checks exact liability and preserves unknown, settled and no-cap rows", async () => {
  for (const mismatch of ["hash", "allocation"] as const) {
    const f = await reservedBudget(
      mismatch === "hash" ? "f".repeat(64) : undefined,
      mismatch === "allocation" ? 0.125 : 0.25,
    );
    const proof = await captureRetirement(f);
    await expect(f.budget.retireUnsent(proof)).rejects.toThrow("identity");
    expect(f.budget.status(f.id).reservedUsd).toBe(
      mismatch === "allocation" ? 0.125 : 0.25,
    );
  }
  for (const state of ["unknown", "settled"] as const) {
    const f = await reservedBudget();
    await f.budget.settle(
      f.id,
      f.requestId,
      f.hash,
      state === "unknown"
        ? null
        : {
            actualCostUsd: 0.1,
            usageEstimatedCostUsd: null,
            costIsEstimate: false,
          },
    );
    const before = f.budget.status(f.id),
      proof = await captureRetirement(f);
    await expect(f.budget.retireUnsent(proof)).rejects.toThrow("costs");
    expect(f.budget.status(f.id)).toMatchObject({
      reservedUsd: before.reservedUsd,
      reportedUsd: before.reportedUsd,
      unknownCount: before.unknownCount,
    });
  }
  const f = await reservedBudget(undefined, 0.25, null);
  await f.budget.retireUnsent(await captureRetirement(f));
  expect(f.budget.status(f.id)).toMatchObject({
    dailyCapUsd: null,
    reservedUsd: 0,
    reportedUsd: 0,
    unknownCount: 0,
  });
});

test("accounting failure replays only retirement and dispatch claims stay held", async () => {
  const f = await reservedBudget();
  await expect(
    f.retire(async () => {
      throw Error("Accounting unavailable");
    }),
  ).rejects.toThrow("Accounting unavailable");
  const terminal = f.store.read(f.id, f.requestId);
  expect(terminal.state).toBe("retired");
  expect(f.budget.status(f.id).reservedUsd).toBe(0.25);
  await f.retire(f.budget.retireUnsent);
  expect(f.store.read(f.id, f.requestId)).toEqual(terminal);
  expect(f.budget.status(f.id).reservedUsd).toBe(0);
  const claimed = await reservedBudget();
  await claimed.store.claimDispatch(
    claimed.id,
    claimed.requestId,
    claimed.hash,
    async () => {},
  );
  let callbacks = 0;
  await expect(
    claimed.retire(async () => {
      callbacks++;
    }),
  ).rejects.toThrow("uncommitted");
  expect(callbacks).toBe(0);
  expect(claimed.budget.status(claimed.id).reservedUsd).toBe(0.25);
});

test("failed durable retirement keeps the original and full budget hold", async () => {
  const f = await reservedBudget();
  const failing = createProjectCouncilOriginalStore({
    home: f.home,
    workspace: f.workspace,
    projectId: f.id,
    withQueueLock,
    persist: () => {
      throw Error("Durable write unavailable");
    },
  });
  let callbacks = 0;
  await expect(
    failing.retire(f.id, f.requestId, f.hash, async () => {
      callbacks++;
    }),
  ).rejects.toMatchObject({ status: 503 });
  expect(callbacks).toBe(0);
  expect(f.store.read(f.id, f.requestId)).toEqual(f.original);
  expect(f.budget.status(f.id).reservedUsd).toBe(0.25);
});

test.skipIf(process.platform === "win32")(
  "retirement authority distinguishes a literal POSIX home from its slash sibling",
  async () => {
    const f = fixture();
    const literal = join(f.home, "a\\b"),
      nested = join(f.home, "a", "b");
    mkdirSync(literal, { mode: 0o700 });
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    const left = lstatSync(literal, { bigint: true }),
      right = lstatSync(nested, { bigint: true });
    expect(left.dev === right.dev && left.ino === right.ino).toBe(false);
    const store = createProjectCouncilOriginalStore({
      home: literal,
      workspace: f.workspace,
      projectId: f.binding.projectId,
      withQueueLock,
    });
    const original = (
      await store.reservePrepared(f.prepared("Literal home authority"))
    ).original;
    let proof: ProjectCouncilRetirementProof | undefined;
    await store.retire(
      f.binding.projectId,
      original.requestId,
      original.intentHash,
      async (value) => {
        proof = value;
      },
    );
    if (!proof) throw Error("Expected an exact retired home capability");
    expect(readProjectCouncilRetirementProof(proof, literal)).not.toBeNull();
    expect(readProjectCouncilRetirementProof(proof, nested)).toBeNull();
  },
);
