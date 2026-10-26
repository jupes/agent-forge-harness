import { expect, test } from "bun:test";
import {
  createKeeperSessionIdentities,
  KEEPER_SESSION_IDENTITIES,
} from "../../apps/desktop/src/keeper-session-identities";
import {
  createKeeperSessionReviews,
  prefillKeeperSession,
  reviewedStartHash,
} from "../../apps/desktop/src/keeper-session-review";
import { sessionStartBody } from "../../apps/desktop/src/session-composer";
import type { WorktreeEntry } from "../../types/beads";
import type { SmithsView } from "../../types/hearth";
import type { KeeperProposal } from "../../types/keeper-proposal";
import type {
  KeeperSessionStartReceipt,
  KeeperSessionStartRequest,
} from "../../types/keeper-session-start";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
function identityFixture() {
  const values = new Map<string, string>();
  return {
    values,
    identities: createKeeperSessionIdentities({
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
      },
      withLock: async (work) => work(),
    }),
  };
}
const source: KeeperProposal = {
  id: "proposal-1a5832fa-7a21-403b-8184-44892f0d8d86-0",
  projectId,
  sourceRequestId: "1a5832fa-7a21-403b-8184-44892f0d8d86",
  sourceHash: "a".repeat(64),
  createdAt: "2026-10-23T04:00:00.000Z",
  draft: {
    title: "Investigate this bead",
    detail: "Review before starting",
    action: {
      kind: "start-session",
      provider: "claude",
      smith: "proposed",
      beadId: "alpha-1",
      repository: "C:/fixture/repository",
      worktree: "current",
      prompt: "  Exact proposed prompt\n",
    },
  },
};
const smiths: SmithsView = {
  benches: { low: [], medium: [], high: [] },
  defaultSmith: "other",
  smiths: [
    {
      name: "proposed",
      provider: "claude",
      model: "full-model",
      effort: "future-effort",
      enabled: true,
      tags: [],
    },
    {
      name: "other",
      provider: "claude",
      model: "other-model",
      effort: "high",
      enabled: true,
      tags: [],
    },
  ],
};
const main: WorktreeEntry = {
  path: "c:\\fixture\\repository",
  kind: "main",
  branch: "main",
  head: "a".repeat(40),
  detached: false,
  locked: false,
  prunable: false,
  missing: false,
};

test("Keeper prefill retains the exact proposed source and unsupported effort; current resolves only to its own registered main", () => {
  const result = prefillKeeperSession(source, smiths, [main]);
  expect(result.draft).toMatchObject({
    prompt: "  Exact proposed prompt\n",
    smith: "proposed",
    model: "full-model",
    effort: "future-effort",
    beadId: "alpha-1",
    repository: "C:/fixture/repository",
    worktree: main.path,
    mode: "task",
    about: [],
    attachments: [],
  });
  expect(
    prefillKeeperSession(source, smiths, [{ ...main, path: "C:/another" }])
      .draft.worktree,
  ).toBe("");
  expect(
    prefillKeeperSession(source, smiths, [{ ...main, path: "C:/another" }])
      .draft.where,
  ).toBe("existing");
  const unsupported = structuredClone(source);
  if (unsupported.draft.action.kind !== "start-session")
    throw new Error("Wrong fixture");
  unsupported.draft.action.provider = "codex";
  const locked = prefillKeeperSession(unsupported, smiths, [main]);
  expect(locked.draft.smith).toBe("proposed");
  expect(locked.draft.model).toBe("");
  expect(locked.locked).toBe(true);
  expect(locked.reason).toContain("codex");
});

async function savedStart(
  admitted: boolean,
): Promise<KeeperSessionStartReceipt> {
  const original: KeeperSessionStartRequest = {
    sourceHash: source.sourceHash,
    expectedRevision: 4,
    start: {
      requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
      smith: "proposed",
      repository: "C:/fixture/repository",
      worktree: main.path,
      beadId: "alpha-1",
      about: [{ kind: "bead", id: "alpha-1" }],
      launch: {
        mode: "chat",
        model: "full-model",
        prompt: "  Exact reviewed prompt\n",
        permissionMode: "plan",
        attachments: [
          { kind: "text", name: "private.md", text: "Private text\n" },
          {
            kind: "image",
            name: "pixel.png",
            mediaType: "image/png",
            data: "iVBORw0KGgo=",
          },
        ],
        fallbackModels: ["haiku"],
        extraDirectories: ["C:/fixture/repository/docs"],
      },
    },
  };
  const startHash = await reviewedStartHash(original.start),
    sessionId = "session-f19bedb4-5882-44b3-b793-9bbe01f539ab";
  return {
    projectId,
    proposalId: source.id,
    revision: admitted ? 6 : 5,
    original,
    startHash,
    record: {
      ...source,
      requestId: original.start.requestId,
      requestHash: "c".repeat(64),
      operation: "approve",
      auditEventId: 1,
      phase: admitted ? "done" : "unknown",
      pending: false,
      updatedAt: source.createdAt,
      message: admitted ? "Original session admitted" : "Start unconfirmed",
      objects: [],
    },
    session: {
      projectId,
      id: sessionId,
      requestId: original.start.requestId,
      requestHash: startHash,
      createdAt: source.createdAt,
      provider: "claude",
      mode: "chat",
      workspace: original.start.repository,
      repository: original.start.repository,
      worktree: original.start.worktree,
      beadId: "alpha-1",
      smith: "proposed",
      requestedModel: "full-model",
      requestedEffort: null,
    },
    receipt: admitted
      ? {
          conversationId: sessionId,
          revision: 1,
          turn: {
            requestId: original.start.requestId,
            hash: "d".repeat(64),
            phase: "running",
            createdAt: source.createdAt,
            updatedAt: source.createdAt,
            reason: null,
            owner: original.start.requestId,
          },
        }
      : null,
  };
}

test("reload restores the full saved envelope without dispatch, and a registry-only reservation stays unconfirmed until its matching journal turn", async () => {
  let raw: unknown = await savedStart(false),
    posts = 0,
    adoptions = 0;
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => {
      throw new Error("Reads must not mint identities");
    },
    read: async () => raw,
    post: async () => {
      posts++;
      return { state: "unknown", message: "No automatic dispatch" };
    },
    createWorktree: async () => {
      throw new Error("No automatic Git");
    },
    readWorktree: async () => null,
    adopt: () => {
      adoptions++;
      return true;
    },
  });
  const review = client.get(source, 4);
  expect(review.owner.purpose).toBe("keeper-proposal");
  await client.open(review);
  const original = review.original;
  expect(original?.start.launch.attachments).toHaveLength(2);
  expect(review.view.composer).toMatchObject({
    prompt: "  Exact reviewed prompt\n",
    permissionMode: "plan",
    custom: true,
    fallbackModels: "haiku",
    extraDirectories: "C:/fixture/repository/docs",
  });
  expect(review.view.lastStarted).toBeNull();
  expect(review.view.pendingStart).toEqual(original?.start ?? null);
  expect(adoptions).toBe(0);
  raw = await savedStart(true);
  await review.owner.refresh(projectId);
  expect(review.view.lastStarted).toBe(
    "session-f19bedb4-5882-44b3-b793-9bbe01f539ab",
  );
  expect(review.view.pendingStart).toBeNull();
  expect(adoptions).toBe(1);
  expect(posts).toBe(0);
  client.dispose();
});

test("a saved envelope with an altered prompt cannot borrow a matching registry reservation or unlock a new Start", async () => {
  const raw = await savedStart(true);
  raw.original.start.launch.prompt = "Altered private body";
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => crypto.randomUUID(),
    read: async () => raw,
    post: async () => {
      throw new Error("Never dispatch on an invalid read");
    },
    createWorktree: async () => {
      throw new Error("No Git");
    },
    readWorktree: async () => null,
    adopt: () => {
      throw new Error("Never adopt altered input");
    },
  });
  const review = client.get(source, 4);
  await client.open(review);
  expect(review.original).toBeNull();
  expect(review.view.inputLocked).toBe(true);
  expect(review.view.notice).toContain("exact reviewed input");
  client.dispose();
});

test("a recorded proposal request identity survives an absent recovery read after reload and cannot mint a replacement Start", async () => {
  let posts = 0,
    minted = 0;
  const queries: Array<string | undefined> = [];
  const known = "b14cc7eb-3231-4930-a288-d411c5ee0426";
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => {
      minted++;
      return crypto.randomUUID();
    },
    read: async (_project, _proposal, requestId) => {
      queries.push(requestId);
      return null;
    },
    post: async () => {
      posts++;
      return { state: "unknown", message: "Must not dispatch" };
    },
    createWorktree: async () => {
      throw new Error("No Git");
    },
    readWorktree: async () => null,
    adopt: () => true,
  });
  const review = client.get(source, 4, known);
  await client.open(review);
  review.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  review.owner.editComposer(projectId, {
    prompt: "Must remain frozen",
    effort: "",
  });
  await review.owner.start(projectId, {
    smith: "proposed",
    repository: main.path,
    worktree: main.path,
    launch: { mode: "task", model: "full-model", prompt: "Replacement" },
  });
  expect(queries).toEqual([known]);
  expect(review.view.inputLocked).toBe(true);
  expect(review.view.notice).toContain("known original");
  expect(posts).toBe(0);
  expect(minted).toBe(0);
  client.dispose();
});

test("opening, editing and cancelling preserves a separate proposal draft without any Start, approval or Git write", async () => {
  let writes = 0,
    reads = 0;
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => "b14cc7eb-3231-4930-a288-d411c5ee0426",
    read: async () => {
      reads++;
      return null;
    },
    post: async () => {
      writes++;
      return { state: "unknown", message: "Unexpected write" };
    },
    createWorktree: async () => {
      writes++;
      return { state: "unknown", message: "Unexpected Git write" };
    },
    readWorktree: async () => null,
    adopt: () => true,
  });
  const review = client.get(source, 4);
  await client.open(review);
  review.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  review.owner.editComposer(projectId, {
    prompt: "Reviewed edit",
    about: [{ kind: "bead", id: "another" }],
  });
  client.close(review);
  await client.open(review);
  expect(review.owner.project(projectId).composer.prompt).toBe("Reviewed edit");
  expect(review.owner.project(projectId).composer.about).toEqual([
    { kind: "bead", id: "another" },
  ]);
  expect(reads).toBe(2);
  expect(writes).toBe(0);
  const changed = { ...source, sourceHash: "b".repeat(64) };
  const next = client.get(changed, 5);
  expect(next).not.toBe(review);
  expect(next.owner.project(projectId).composer.prompt).not.toBe(
    "Reviewed edit",
  );
  client.dispose();
});

test("an unknown reviewed Start keeps every original byte and UUID but cannot be retried from its body alone", async () => {
  const sent: KeeperSessionStartRequest[] = [];
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => "b14cc7eb-3231-4930-a288-d411c5ee0426",
    read: async () => null,
    post: async (_project, _proposal, input) => {
      sent.push(input);
      return { state: "unknown", message: "Lost reply" };
    },
    createWorktree: async () => ({ state: "refused", message: "No Git" }),
    readWorktree: async () => null,
    adopt: () => true,
  });
  const review = client.get(source, 4);
  await client.open(review);
  review.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  review.owner.editComposer(projectId, {
    effort: "",
    mode: "chat",
    prompt: "  Reviewed prompt\n",
    permissionMode: "plan",
    attachments: [
      { kind: "text", name: "private.md", text: "Exact private text\n" },
    ],
    about: [{ kind: "bead", id: "alpha-1" }],
    extraDirectories: "C:/fixture/repository/docs",
  });
  const expected = sessionStartBody(review.view.composer);
  await review.owner.start(projectId, expected);
  review.owner.editComposer(projectId, {
    prompt: "Cannot mutate the unknown original",
  });
  await review.owner.refresh(projectId);
  expect(review.view.composer.prompt).toBe("  Reviewed prompt\n");
  expect(review.view.pendingStart?.requestId).toBe(
    "b14cc7eb-3231-4930-a288-d411c5ee0426",
  );
  expect(sent).toHaveLength(1);
  await review.owner.start(projectId, {
    ...expected,
    launch: { ...expected.launch, prompt: "Different" },
  });
  expect(sent).toHaveLength(1);
  await review.owner.retryStart(projectId);
  expect(review.view.retryStartAvailable).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({
    sourceHash: source.sourceHash,
    expectedRevision: 4,
    start: { ...expected, requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426" },
  });
  client.dispose();
});

test("a proven NotSent refusal enables an exact Keeper retry and the original remains checkable", async () => {
  const sent: KeeperSessionStartRequest[] = [];
  let reads = 0;
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => "b14cc7eb-3231-4930-a288-d411c5ee0426",
    read: async () => {
      reads++;
      return null;
    },
    post: async (_project, _proposal, input) => {
      sent.push(input);
      return sent.length === 1
        ? { state: "refused", message: "No operator token", notSent: true }
        : { state: "unknown", message: "Check the exact original again" };
    },
    createWorktree: async () => ({ state: "refused", message: "No Git" }),
    readWorktree: async () => null,
    adopt: () => true,
  });
  const review = client.get(source, 4);
  await client.open(review);
  review.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  review.owner.editComposer(projectId, { effort: "" });
  const expected = sessionStartBody(review.view.composer);

  await review.owner.start(projectId, expected);
  expect(sent).toHaveLength(1);
  expect(review.view.retryStartAvailable).toBe(true);

  await review.owner.refresh(projectId);
  expect(reads).toBe(2);
  expect(review.view.retryStartAvailable).toBe(true);
  await review.owner.retryStart(projectId);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(review.view.retryStartAvailable).toBe(false);
  client.dispose();
});

test("a protected original read can restore retryability from its durable NotSent identity after reload", async () => {
  const sent: KeeperSessionStartRequest[] = [];
  const durableNotSent = Object.assign(await savedStart(false), {
    session: null,
    retryAvailable: true,
  });
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => {
      throw new Error("Recovery must retain the original UUID");
    },
    read: async () => durableNotSent,
    post: async (_project, _proposal, input) => {
      sent.push(structuredClone(input));
      return { state: "unknown", message: "Check the original again" };
    },
    createWorktree: async () => ({ state: "refused", message: "No Git" }),
    readWorktree: async () => null,
    adopt: () => true,
  });
  const review = client.get(source, 4);
  await client.open(review);
  expect(review.view.retryStartAvailable).toBe(true);
  expect(sent).toEqual([]);
  await review.owner.retryStart(projectId);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual(durableNotSent.original);
  expect(review.view.retryStartAvailable).toBe(false);
  client.dispose();
});

test.each([
  "legacy",
  "attempted",
  "not-found",
  "unavailable",
] as const)("a later %s Keeper read clears stale durable retry eligibility", async (laterRead) => {
  const sent: KeeperSessionStartRequest[] = [];
  const durableNotSent = Object.assign(await savedStart(false), {
    session: null,
    retryAvailable: true,
  });
  let raw: unknown = durableNotSent;
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => {
      throw new Error("Recovery must retain the original UUID");
    },
    read: async () => {
      if (laterRead === "unavailable" && raw !== durableNotSent)
        throw new Error("Identity metadata is unavailable");
      return raw;
    },
    post: async (_project, _proposal, input) => {
      sent.push(structuredClone(input));
      return { state: "unknown", message: "Check the original again" };
    },
    createWorktree: async () => ({ state: "refused", message: "No Git" }),
    readWorktree: async () => null,
    adopt: () => true,
  });
  const review = client.get(source, 4);
  await client.open(review);
  expect(review.view.retryStartAvailable).toBe(true);
  if (laterRead === "legacy") {
    const legacy = { ...durableNotSent } as Record<string, unknown>;
    delete legacy["retryAvailable"];
    raw = legacy;
  } else if (laterRead === "attempted")
    raw = { ...durableNotSent, retryAvailable: false };
  else raw = null;
  await review.owner.refresh(projectId);
  expect(review.view.retryStartAvailable).toBe(false);
  await review.owner.retryStart(projectId);
  expect(sent).toEqual([]);
  client.dispose();
});

test("confirmed original admission wins over a delayed malformed POST and foreign projects cannot edit or dispatch its draft", async () => {
  let finish:
    | ((value: import("../../docs/js/action-outcome").ActionOutcome) => void)
    | undefined;
  let raw: unknown = null,
    adoptions = 0,
    posts = 0;
  const client = createKeeperSessionReviews({
    identities: identityFixture().identities,
    canWrite: () => true,
    requestId: () => "b14cc7eb-3231-4930-a288-d411c5ee0426",
    read: async () => raw,
    post: async () => {
      posts++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    createWorktree: async () => {
      throw new Error("No Git");
    },
    readWorktree: async () => null,
    adopt: () => {
      adoptions++;
      return true;
    },
  });
  const review = client.get(source, 4);
  await client.open(review);
  review.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  const admitted = await savedStart(true);
  const input = admitted.original.start;
  review.owner.editComposer(projectId, {
    prompt: input.launch.prompt,
    mode: "chat",
    effort: "",
    attachments: input.launch.attachments ?? [],
    about: input.about ?? [],
    permissionMode: "plan",
    fallbackModels: "haiku",
    extraDirectories: "C:/fixture/repository/docs",
  });
  const starting = review.owner.start(
    projectId,
    sessionStartBody(review.view.composer),
  );
  while (!finish) await Bun.sleep(1);
  raw = admitted;
  await review.owner.refresh(projectId);
  expect(review.view.lastStarted).toBe(admitted.session?.id ?? null);
  const notice = review.view.notice;
  finish?.({ state: "done", data: { malformed: true } });
  await starting;
  expect(review.view.notice).toBe(notice);
  expect(review.view.pendingStart).toBeNull();
  expect(adoptions).toBe(1);
  expect(posts).toBe(1);
  expect(() => review.owner.project("another-project")).toThrow(
    "another project",
  );
  review.owner.editComposer("another-project", { prompt: "Wrong project" });
  expect(review.view.composer.prompt).toBe(input.launch.prompt);
  await review.owner.retryStart("another-project");
  expect(posts).toBe(1);
  client.dispose();
});

test("a reload before durable server admission keeps the pre-POST UUID through404 and recovers only the protected original", async () => {
  const held = identityFixture(),
    saved = await savedStart(false);
  let raw: unknown = null,
    posts = 0,
    minted = 0;
  const queries: Array<string | undefined> = [];
  const make = () =>
    createKeeperSessionReviews({
      identities: held.identities,
      canWrite: () => true,
      requestId: () => {
        minted++;
        return saved.original.start.requestId;
      },
      read: async (_project, _proposal, requestId) => {
        queries.push(requestId);
        return raw;
      },
      post: async () => {
        posts++;
        return { state: "unknown", message: "Not yet recorded" };
      },
      createWorktree: async () => {
        throw Error("No Git");
      },
      readWorktree: async () => null,
      adopt: () => {
        throw Error("Reservation is unconfirmed");
      },
    });
  const one = make(),
    review = one.get(source, 4);
  await one.open(review);
  review.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  review.owner.editComposer(projectId, {
    effort: "",
    prompt: "Private pending input",
    attachments: [{ kind: "text", name: "private.txt", text: "Private file" }],
  });
  await review.owner.start(projectId, sessionStartBody(review.view.composer));
  expect(posts).toBe(1);
  expect(held.values.get(KEEPER_SESSION_IDENTITIES)).not.toContain("Private");
  one.dispose();
  const two = make(),
    reopened = two.get(source, 4);
  await two.open(reopened);
  reopened.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  expect(reopened.expectedRequestId).toBe(saved.original.start.requestId);
  expect(reopened.view.inputLocked).toBe(true);
  expect(reopened.view.notice).toContain("known original");
  await reopened.owner.start(projectId, saved.original.start);
  await reopened.owner.retryStart(projectId);
  expect(posts).toBe(1);
  expect(minted).toBe(1);
  raw = saved;
  await reopened.owner.refresh(projectId);
  expect(reopened.original).toEqual(saved.original);
  expect(reopened.view.composer.attachments).toHaveLength(2);
  expect(reopened.view.pendingStart?.requestId).toBe(
    saved.original.start.requestId,
  );
  expect(queries).toEqual([
    undefined,
    saved.original.start.requestId,
    saved.original.start.requestId,
  ]);
  expect(posts).toBe(1);
  two.dispose();
});

test("a storage failure after opening refuses dispatch and keeps the review held", async () => {
  const held = identityFixture();
  let posts = 0;
  const client = createKeeperSessionReviews({
    identities: held.identities,
    canWrite: () => true,
    requestId: () => crypto.randomUUID(),
    read: async () => null,
    post: async () => {
      posts++;
      return { state: "unknown", message: "Must not send" };
    },
    createWorktree: async () => {
      throw Error("No Git");
    },
    readWorktree: async () => null,
    adopt: () => true,
  });
  const review = client.get(source, 4);
  await client.open(review);
  review.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  review.owner.editComposer(projectId, { effort: "" });
  held.values.set(KEEPER_SESSION_IDENTITIES, "{");
  await review.owner.start(projectId, sessionStartBody(review.view.composer));
  expect(posts).toBe(0);
  expect(review.view.inputLocked).toBe(true);
  expect(review.view.notice).toContain("identity storage");
  client.dispose();
});

test("another window's pre-POST identity wins after this window already opened an editable draft", async () => {
  const held = identityFixture(),
    known = "b14cc7eb-3231-4930-a288-d411c5ee0426";
  let posts = 0,
    minted = 0;
  const client = createKeeperSessionReviews({
    identities: held.identities,
    canWrite: () => true,
    requestId: () => {
      minted++;
      return crypto.randomUUID();
    },
    read: async () => null,
    post: async () => {
      posts++;
      return { state: "unknown", message: "Must not send" };
    },
    createWorktree: async () => {
      throw Error("No Git");
    },
    readWorktree: async () => null,
    adopt: () => true,
  });
  const review = client.get(source, 4);
  await client.open(review);
  review.owner.initializeComposer?.({ id: projectId }, smiths, [main]);
  review.owner.editComposer(projectId, { effort: "" });
  await held.identities.reserve(source, () => known);
  await review.owner.start(projectId, sessionStartBody(review.view.composer));
  expect(posts).toBe(0);
  expect(minted).toBe(0);
  expect(review.expectedRequestId).toBe(known);
  expect(review.original).toBeNull();
  expect(review.view.inputLocked).toBe(true);
  client.dispose();
});
