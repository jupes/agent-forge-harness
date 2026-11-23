import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { createOwnedSessionLedger } from "../hearth/routes/session-ledger";
import * as ownerOnlyToken from "../hearth/token";
import { writeOwnerOnly } from "../hearth/token";
import { createRestartIdentityJournal } from "../identities/restart-index";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import type { SessionRuntime } from "./admission";
import { createOwnedSessionService } from "./admission";
import { serializeClaudeLaunch } from "./claude-launch";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";
import { createOwnedCodingSessionService } from "./owned-coding-service";
import { markReadOnlyCapabilityRefusal } from "./read-only-capability-refusal";
import { createSessionRegistry } from "./registry";
import { readVerifiedOriginalStart } from "./restart-identity-proof";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function closingFixture(
  validateScope: () => Promise<void> = async () => {},
) {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge closing session ")),
  );
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home"),
    root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  const project = (
    await createProjectStore(home).create(
      {
        slug: "alpha",
        name: "Alpha",
        description: "",
        icon: "A",
        workspaces: [{ root, repositories: [root], epicIds: ["alpha-1"] }],
      },
      0,
    )
  ).projects[0]!;
  const counts = { prepared: 0, runs: 0 };
  const runtime: SessionRuntime = {
    provider: "claude",
    async prepare({ smith, cwd, launch }) {
      counts.prepared++;
      return {
        version: 1,
        provider: "claude",
        smith,
        cwd,
        launch,
        capabilities: {
          version: "2.1.296",
          flags: [
            "--print",
            "--input-format",
            "--output-format",
            "--verbose",
            "--include-partial-messages",
            "--model",
            "--permission-mode",
            "--permission-prompts",
            "--allowedTools",
            "--resume",
            "--json-schema",
          ],
        },
      };
    },
    async run(request, persist) {
      counts.runs++;
      await persist({
        kind: "identity",
        provider: "claude",
        sessionId:
          request.resume?.sessionId ?? "e1a3d9df-94fe-41b0-869b-e421f1a3ddca",
        version: "2.1.296",
      });
      return { phase: "completed", reason: null };
    },
  };
  const make = () => {
    const service = createOwnedSessionService({
      home,
      root,
      runtime,
      validateScope,
    });
    cleanup.push(() => service.close());
    return service;
  };
  const request = {
    requestId: randomUUID(),
    smith: "coding",
    repository: root,
    worktree: root,
    launch: {
      mode: "chat" as const,
      model: "sonnet",
      prompt: "Private closing fixture",
    },
  };
  return { project, make, request, counts, home, root, runtime, validateScope };
}

test("common Start facade fences before dispatch and reopens only its verified original", async () => {
  const f = await closingFixture();
  const request = {
    ...f.request,
    about: [],
    launch: { ...f.request.launch, attachments: [] },
  };
  const workspace = workspaceKey(resolveCheckout(f.root).workspace);
  const scope = {
    address: {
      family: "owned-session-start" as const,
      projectId: f.project.id,
    },
    workspace,
  };
  const preparedStates: Array<string | undefined> = [];
  const runtime: SessionRuntime = {
    ...f.runtime,
    async prepare(input) {
      const row = await createRestartIdentityJournal(f.home).lookup(
        scope,
        request.requestId,
      );
      preparedStates.push(row?.state);
      return f.runtime.prepare(input);
    },
  };
  const makeFacade = () => {
    const service = createOwnedCodingSessionService({
      home: f.home,
      root: f.root,
      runtime,
      validateScope: f.validateScope,
    });
    cleanup.push(() => service.close());
    return service;
  };
  const firstService = makeFacade();
  const first = await firstService.start(f.project.id, request);
  const row = await createRestartIdentityJournal(f.home).lookup(
    scope,
    request.requestId,
  );
  expect(row?.state).toBe("admitted");
  expect(preparedStates).toEqual(["attempted"]);
  const countsAfterFirst = { ...f.counts };

  const reopened = makeFacade();
  const duplicate = await reopened.start(f.project.id, request);
  expect(duplicate.session).toEqual(first.session);
  expect(duplicate.receipt.conversationId).toBe(first.receipt.conversationId);
  expect(duplicate.receipt.turn.requestId).toBe(first.receipt.turn.requestId);
  expect(duplicate.receipt.turn.hash).toBe(first.receipt.turn.hash);
  expect(f.counts).toEqual(countsAfterFirst);
});

test("a proven preaccept refusal settles durably and permits only the same Start after reopen", async () => {
  const f = await closingFixture();
  const request = {
    ...f.request,
    about: [],
    launch: { ...f.request.launch, attachments: [] },
  };
  let prepareCalls = 0;
  const runtime: SessionRuntime = {
    ...f.runtime,
    async prepare(input) {
      prepareCalls++;
      if (prepareCalls === 1)
        throw markReadOnlyCapabilityRefusal(
          new Error("read-only capability refusal"),
        );
      return f.runtime.prepare(input);
    },
  };
  const scope = {
    address: {
      family: "owned-session-start" as const,
      projectId: f.project.id,
    },
    workspace: workspaceKey(resolveCheckout(f.root).workspace),
  };
  const makeFacade = () => {
    const service = createOwnedCodingSessionService({
      home: f.home,
      root: f.root,
      runtime,
      validateScope: f.validateScope,
    });
    cleanup.push(() => service.close());
    return service;
  };
  const firstService = makeFacade();
  await expect(firstService.start(f.project.id, request)).rejects.toMatchObject(
    {
      status: 503,
    },
  );
  const journal = createRestartIdentityJournal(f.home);
  expect(await journal.lookup(scope, request.requestId)).toMatchObject({
    state: "not-sent",
  });
  const countsAfterRefusal = { ...f.counts };
  expect(countsAfterRefusal.runs).toBe(0);

  const reopened = makeFacade();
  const retry = await reopened.start(f.project.id, request);
  expect(retry.session.requestId).toBe(request.requestId);
  expect(retry.receipt.turn.requestId).toBe(request.requestId);
  expect(await journal.lookup(scope, request.requestId)).toMatchObject({
    state: "admitted",
  });
  expect(prepareCalls).toBe(2);
  expect(f.counts.runs).toBe(1);
  const countsAfterRetry = { ...f.counts };

  const duplicate = await makeFacade().start(f.project.id, request);
  expect(duplicate.receipt.turn.hash).toBe(retry.receipt.turn.hash);
  expect(f.counts).toEqual(countsAfterRetry);
});

test("a generic preparation error stays attempted and cannot authorize retry", async () => {
  const f = await closingFixture();
  const runtime: SessionRuntime = {
    ...f.runtime,
    async prepare() {
      throw new Error("unclassified local failure");
    },
  };
  const service = createOwnedCodingSessionService({
    home: f.home,
    root: f.root,
    runtime,
    validateScope: f.validateScope,
  });
  cleanup.push(() => service.close());

  await expect(service.start(f.project.id, f.request)).rejects.toMatchObject({
    status: 503,
  });
  const journal = createRestartIdentityJournal(f.home);
  expect(
    await journal.lookup(
      {
        address: {
          family: "owned-session-start",
          projectId: f.project.id,
        },
        workspace: workspaceKey(resolveCheckout(f.root).workspace),
      },
      f.request.requestId,
    ),
  ).toMatchObject({ state: "attempted" });
  expect(f.counts).toEqual({ prepared: 0, runs: 0 });
});

test("a write-then-throw at store.accept remains held and never becomes not-sent", async () => {
  const f = await closingFixture();
  const conversationDirectory = join(f.home, "conversations");
  const write = ownerOnlyToken.writeOwnerOnly;
  const witness: {
    path: string | null;
    partial: string;
    writes: number;
  } = { path: null, partial: "", writes: 0 };
  const intercepted = spyOn(
    ownerOnlyToken,
    "writeOwnerOnly",
  ).mockImplementation((path, content, options) => {
    if (
      dirname(path) === conversationDirectory &&
      /^session-[0-9a-f-]{36}\.json$/.test(basename(path))
    ) {
      witness.path = path;
      witness.partial = content.slice(0, 32);
      witness.writes++;
      write(path, witness.partial, options);
      throw new Error("injected post-write failure");
    }
    write(path, content, options);
  });
  const service = createOwnedCodingSessionService({
    home: f.home,
    root: f.root,
    runtime: f.runtime,
    validateScope: f.validateScope,
  });
  cleanup.push(() => service.close());
  try {
    await expect(service.start(f.project.id, f.request)).rejects.toMatchObject({
      status: 503,
    });
  } finally {
    intercepted.mockRestore();
  }

  expect(witness.writes).toBe(1);
  if (!witness.path)
    throw Error("The session transcript write was not reached.");
  const injectedPath = witness.path;
  expect(readFileSync(injectedPath, "utf8")).toBe(witness.partial);
  const original = createSessionRegistry(f.home).lookupRequestId(
    f.request.requestId,
  );
  if (!original) throw Error("The original Start was not reserved.");
  expect(injectedPath).toBe(
    conversationFile(f.home, f.project.id, {
      kind: "session",
      projectId: f.project.id,
      sessionId: original.id,
    }),
  );

  expect(
    await createRestartIdentityJournal(f.home).lookup(
      {
        address: {
          family: "owned-session-start",
          projectId: f.project.id,
        },
        workspace: workspaceKey(resolveCheckout(f.root).workspace),
      },
      f.request.requestId,
    ),
  ).toMatchObject({ state: "attempted" });
  expect(f.counts).toEqual({ prepared: 1, runs: 0 });
  await expect(service.start(f.project.id, f.request)).rejects.toMatchObject({
    status: 503,
  });
  expect(f.counts).toEqual({ prepared: 1, runs: 0 });
});

test("an accepted Start with a lost provider answer is never settled not-sent", async () => {
  const f = await closingFixture();
  const runtime: SessionRuntime = {
    ...f.runtime,
    async run() {
      f.counts.runs++;
      throw new Error("provider response was lost after accepted input");
    },
  };
  const service = createOwnedCodingSessionService({
    home: f.home,
    root: f.root,
    runtime,
    validateScope: f.validateScope,
  });
  cleanup.push(() => service.close());

  const first = await service.start(f.project.id, f.request);
  // Start returns the immutable admission receipt while the owned provider
  // job is still running. Wait for that concrete job to settle before
  // asserting the durable answer is unknown after the simulated lost reply.
  await service.settled(f.project.id, first.session.id);
  const identity = {
    address: {
      family: "owned-session-start" as const,
      projectId: f.project.id,
    },
    workspace: workspaceKey(resolveCheckout(f.root).workspace),
  };
  expect(
    await createRestartIdentityJournal(f.home).lookup(
      identity,
      f.request.requestId,
    ),
  ).toMatchObject({ state: "admitted" });
  const original = readVerifiedOriginalStart({
    home: f.home,
    root: f.root,
    identity: {
      version: 1,
      address: identity.address,
      workspace: identity.workspace,
      requestId: f.request.requestId,
      requestHash: first.session.requestHash,
      provider: first.session.provider,
      mode: first.session.mode,
    },
  });
  expect(original.kind).toBe("verified");
  if (original.kind !== "verified")
    throw Error("Expected the accepted Start's durable original receipt");
  expect(original.value.session.id).toBe(first.session.id);
  expect(original.value.session.requestHash).toBe(first.session.requestHash);
  expect(original.value.receipt.turn.phase).toBe("unknown");
  const duplicate = await service.start(f.project.id, f.request);
  expect(duplicate.session.id).toBe(first.session.id);
  expect(duplicate.receipt.turn.hash).toBe(original.value.receipt.turn.hash);
  expect(f.counts.runs).toBe(1);
});

test("an attempted Start without a durable original stays held without owner dispatch", async () => {
  const f = await closingFixture();
  const workspace = workspaceKey(resolveCheckout(f.root).workspace);
  const identity = {
    version: 1 as const,
    address: {
      family: "owned-session-start" as const,
      projectId: f.project.id,
    },
    workspace,
    requestId: f.request.requestId,
    requestHash: createHash("sha256")
      .update(canonicalOwnedSessionStart(f.request))
      .digest("hex"),
    provider: "claude" as const,
    mode: f.request.launch.mode,
  };
  const journal = createRestartIdentityJournal(f.home);
  await journal.reserve(identity);
  await journal.beginAttempt(identity);
  const service = createOwnedCodingSessionService({
    home: f.home,
    root: f.root,
    runtime: f.runtime,
    validateScope: f.validateScope,
  });
  cleanup.push(() => service.close());

  await expect(service.start(f.project.id, f.request)).rejects.toMatchObject({
    status: 503,
  });
  expect(f.counts).toEqual({ prepared: 0, runs: 0 });
  expect(
    await journal.lookup(
      { address: identity.address, workspace },
      identity.requestId,
    ),
  ).toMatchObject({ state: "attempted" });
});

test("deterministic scope rejection happens before reserving the project address", async () => {
  const f = await closingFixture(async () => {
    throw new Error("invalid worktree scope");
  });
  const service = createOwnedCodingSessionService({
    home: f.home,
    root: f.root,
    runtime: f.runtime,
    validateScope: f.validateScope,
  });
  cleanup.push(() => service.close());
  const workspace = workspaceKey(resolveCheckout(f.root).workspace);

  await expect(service.start(f.project.id, f.request)).rejects.toThrow(
    "invalid worktree scope",
  );
  expect(f.counts).toEqual({ prepared: 0, runs: 0 });
  expect(
    await createRestartIdentityJournal(f.home).lookup(
      {
        address: {
          family: "owned-session-start",
          projectId: f.project.id,
        },
        workspace,
      },
      f.request.requestId,
    ),
  ).toBeNull();
});

test("a verified pre-index original is reconciled despite changed scope without owner calls", async () => {
  const f = await closingFixture();
  const producer = f.make();
  const original = await producer.start(f.project.id, f.request);
  await producer.settled(f.project.id, original.session.id);
  const originalProof = readVerifiedOriginalStart({
    home: f.home,
    root: f.root,
    identity: {
      version: 1,
      address: {
        family: "owned-session-start",
        projectId: f.project.id,
      },
      workspace: workspaceKey(original.session.workspace),
      requestId: original.session.requestId,
      requestHash: original.session.requestHash,
      provider: original.session.provider,
      mode: original.session.mode,
    },
  });
  if (originalProof.kind !== "verified")
    throw Error("Expected the pre-index source to prove its original Start");
  const scopeCalls = { count: 0 };
  const service = createOwnedCodingSessionService({
    home: f.home,
    root: f.root,
    runtime: f.runtime,
    async validateScope() {
      scopeCalls.count++;
      throw Error("current worktree scope changed");
    },
  });
  cleanup.push(() => service.close());
  const countsAfterOriginal = { ...f.counts };

  const recovered = await service.start(f.project.id, f.request);
  expect(recovered.session).toEqual(original.session);
  expect(recovered.receipt).toEqual(originalProof.value.receipt);
  expect(scopeCalls.count).toBe(0);
  expect(f.counts).toEqual(countsAfterOriginal);
  expect(
    await createRestartIdentityJournal(f.home).lookup(
      {
        address: {
          family: "owned-session-start",
          projectId: f.project.id,
        },
        workspace: workspaceKey(resolveCheckout(f.root).workspace),
      },
      f.request.requestId,
    ),
  ).toMatchObject({ state: "admitted" });
});

test("trusted proof matches the persisted original request across empty optional inputs", async () => {
  const f = await closingFixture();
  const service = f.make();
  const request = {
    ...f.request,
    about: [],
    launch: { ...f.request.launch, attachments: [] },
  };
  const started = await service.start(f.project.id, request);
  const identity = {
    version: 1 as const,
    address: {
      family: "owned-session-start" as const,
      projectId: f.project.id,
    },
    workspace: workspaceKey(started.session.workspace),
    requestId: started.session.requestId,
    requestHash: started.session.requestHash,
    provider: started.session.provider,
    mode: started.session.mode,
  };

  const proof = readVerifiedOriginalStart({
    home: f.home,
    root: f.root,
    identity,
  });
  expect(proof.kind).toBe("verified");
  if (proof.kind === "verified") {
    expect(proof.value.session).toEqual(started.session);
    expect(proof.value.receipt).toEqual(started.receipt);
  }
  expect(
    readVerifiedOriginalStart({
      home: f.home,
      root: f.root,
      identity: { ...identity, requestHash: "f".repeat(64) },
    }).kind,
  ).toBe("invalid");

  const address = {
    kind: "session" as const,
    projectId: started.session.projectId,
    sessionId: started.session.id,
  };
  const state = createConversationStore(f.home, undefined, address).read(
    started.session.projectId,
  );
  const userFrame = state.frames[0];
  if (userFrame?.event.kind !== "user" || !userFrame.event.session)
    throw Error("Missing original private Start snapshot");
  const changedText = structuredClone(state);
  const changedTextUser = changedText.frames[0]?.event;
  if (changedTextUser?.kind !== "user" || !changedTextUser.session)
    throw Error("Missing mutable private Start snapshot");
  changedTextUser.text = "different text with a valid private turn hash";
  const rehashUser = changedText.frames[0]?.event;
  const turn = changedText.turns[0];
  if (rehashUser?.kind !== "user" || !turn)
    throw Error("Missing first turn for private hash fixture");
  turn.hash = createHash("sha256")
    .update(
      JSON.stringify({
        text: rehashUser.text,
        about: rehashUser.about,
        ...(rehashUser.session ? { session: rehashUser.session } : {}),
      }),
    )
    .digest("hex");
  writeOwnerOnly(
    conversationFile(f.home, started.session.projectId, address),
    JSON.stringify(changedText),
  );
  expect(
    readVerifiedOriginalStart({ home: f.home, root: f.root, identity }).kind,
  ).toBe("invalid");

  const omittedAttachments = structuredClone(state);
  const omittedUser = omittedAttachments.frames[0]?.event;
  const omittedTurn = omittedAttachments.turns[0];
  if (omittedUser?.kind !== "user" || !omittedUser.session || !omittedTurn)
    throw Error("Missing original attachment fixture");
  omittedUser.session = {
    ...omittedUser.session,
    launch: { ...omittedUser.session.launch, attachments: undefined },
  };
  omittedTurn.hash = createHash("sha256")
    .update(
      JSON.stringify({
        text: omittedUser.text,
        about: omittedUser.about,
        ...(omittedUser.session ? { session: omittedUser.session } : {}),
      }),
    )
    .digest("hex");
  writeOwnerOnly(
    conversationFile(f.home, started.session.projectId, address),
    JSON.stringify(omittedAttachments),
  );
  expect(
    readVerifiedOriginalStart({ home: f.home, root: f.root, identity }).kind,
  ).toBe("invalid");
});

test("a Start whose registry validation finishes after close cannot create a provider-owning service", async () => {
  let entered = () => {},
    release = () => {};
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const f = await closingFixture(async () => {
      entered();
      await gate;
    }),
    service = f.make();
  const pending = service.start(f.project.id, f.request);
  await started;
  await service.close();
  release();
  await expect(pending).rejects.toThrow("closing");
  expect(f.counts).toEqual({ prepared: 0, runs: 0 });
});

test("a closed wrapper cannot send through a session it has not loaded, while existing receipts remain readable", async () => {
  const f = await closingFixture(),
    owner = f.make();
  const started = await owner.start(f.project.id, f.request);
  await owner.settled(f.project.id, started.session.id);
  const page = await owner.read(f.project.id, started.session.id);
  await owner.close();
  expect((await owner.read(f.project.id, started.session.id)).turns).toEqual(
    page.turns,
  );
  const observer = f.make();
  await observer.close();
  await expect(
    observer.send(f.project.id, started.session.id, {
      requestId: randomUUID(),
      expectedRevision: page.revision,
      text: "Do not dispatch after close",
      about: [],
    }),
  ).rejects.toThrow("closing");
  expect(f.counts).toEqual({ prepared: 1, runs: 1 });
});

test("a durable Start retry hashes object keys independently of locale collation", async () => {
  const f = await closingFixture(),
    service = f.make();
  const request = {
    ...f.request,
    launch: {
      ...f.request.launch,
      mode: "task" as const,
      outputSchema: {
        type: "object",
        properties: { Z: { type: "string" }, a: { type: "number" } },
      },
    },
  };
  const first = await service.start(f.project.id, request);
  await service.settled(f.project.id, first.session.id);
  const compare = String.prototype.localeCompare;
  const changedCollation = spyOn(
    String.prototype,
    "localeCompare",
  ).mockImplementation(function (this: string, other: string) {
    return -compare.call(this, other);
  });
  try {
    const retry = await service.start(f.project.id, request);
    expect(retry.session.id).toBe(first.session.id);
    expect(f.counts).toEqual({ prepared: 1, runs: 1 });
  } finally {
    changedCollation.mockRestore();
  }
});

test("concurrent explicit Start and a lost-response retry resolve to one private session and one provider turn", async () => {
  const base = mkdtempSync(join(tmpdir(), "forge session admission "));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo"),
    home = join(base, "home");
  mkdirSync(join(root, ".git"), { recursive: true });
  const project = (
    await createProjectStore(home).create(
      {
        slug: "alpha",
        name: "Alpha",
        description: "",
        icon: "A",
        workspaces: [{ root, repositories: [root], epicIds: ["alpha-1"] }],
      },
      0,
    )
  ).projects[0]!;
  let runs = 0,
    checks = 0,
    valid = true,
    mutatePreparation = false;
  const events: LedgerEventInput[] = [];
  const recordMetadata = createOwnedSessionLedger(home, {
    appendEvent(event) {
      events.push(event);
      return { ok: true, id: events.length, ulid: "fixture" };
    },
  });
  const flags = [
    "--print",
    "--input-format",
    "--output-format",
    "--verbose",
    "--include-partial-messages",
    "--model",
    "--permission-mode",
    "--permission-prompts",
    "--allowedTools",
    "--resume",
  ];
  const service = createOwnedSessionService({
    root,
    home,
    onChange: recordMetadata,
    async validateScope() {
      checks++;
      if (!valid) throw Error("Current scope unavailable");
    },
    runtime: {
      provider: "claude",
      async prepare({ smith, cwd, launch }) {
        return {
          version: 1,
          provider: "claude",
          smith,
          cwd,
          launch: mutatePreparation
            ? { ...launch, model: "unreviewed" }
            : launch,
          capabilities: { version: "2.1.296", flags },
        };
      },
      async run(request, persist) {
        runs++;
        await persist({
          kind: "process",
          pid: 4242,
          smith: "coding",
          requestedModel: "sonnet",
          requestedEffort: "default",
        });
        await persist({
          kind: "model",
          model: "actual-observed-model",
        });
        await persist({
          kind: "identity",
          provider: "claude",
          sessionId: "6427faae-19c8-454d-84ce-c4ea55288cc9",
          version: "2.1.296",
        });
        await persist({ kind: "text", text: `Reply ${request.input.text}` });
        return { phase: "completed", reason: null };
      },
    },
  });
  cleanup.push(() => service.close());
  const request = {
    requestId: randomUUID(),
    smith: "coding",
    repository: root,
    worktree: root,
    about: [{ kind: "bead" as const, id: "alpha-1" }],
    launch: {
      mode: "chat" as const,
      model: "sonnet",
      prompt: "  Private first turn\n",
      attachments: [
        {
          kind: "text" as const,
          name: "context.txt",
          text: "Private attachment body",
        },
      ],
    },
  };
  const [a, b] = await Promise.all([
    service.start(project.id, request),
    service.start(project.id, request),
  ]);
  expect(a.session.id).toBe(b.session.id);
  await service.settled(project.id, a.session.id);
  expect(runs).toBe(1);
  valid = false;
  const before = checks;
  const retry = await service.start(project.id, request);
  expect(retry.receipt.turn.phase).toBe("completed");
  expect(checks).toBe(before);
  expect(runs).toBe(1);
  await expect(
    service.start(project.id, {
      ...request,
      launch: { ...request.launch, prompt: "changed" },
    }),
  ).rejects.toThrow("different content");
  const page = await service.read(project.id, a.session.id);
  expect(page.frames[0]?.event).toMatchObject({
    kind: "user",
    text: request.launch.prompt,
    session: { launch: { prompt: request.launch.prompt } },
  });
  const user = page.frames[0]?.event;
  if (user?.kind !== "user" || !user.session)
    throw Error("Missing private launch");
  const stdin = serializeClaudeLaunch(
    user.session.launch,
    user.session.capabilities,
  ).stdin;
  const promptEvent = events.find((event) => event.kind === "prompt.submitted");
  expect(promptEvent?.payload).toEqual({
    hash: createHash("sha256").update(stdin).digest("hex"),
    length: stdin.length,
  });
  expect(events.map((event) => event.kind)).toEqual([
    "session.started",
    "prompt.submitted",
    "session.ended",
  ]);
  expect(events.every((event) => event.sessionId === a.session.id)).toBe(true);
  expect(events.at(-1)?.executor?.sessionId).toBe(
    "6427faae-19c8-454d-84ce-c4ea55288cc9",
  );
  expect(JSON.stringify(events)).not.toContain("Private first turn");
  expect(JSON.stringify(events)).not.toContain("Private attachment body");
  valid = true;
  mutatePreparation = true;
  await expect(
    service.start(project.id, { ...request, requestId: randomUUID() }),
  ).rejects.toThrow("reviewed session options");
  expect(runs).toBe(1);
  const foreignRoot = join(base, "foreign-repo");
  const foreign = await createSessionRegistry(home).reserve(
    project.id,
    randomUUID(),
    "f".repeat(64),
    () => ({
      mode: "chat",
      provider: "claude",
      workspace: foreignRoot,
      repository: foreignRoot,
      worktree: foreignRoot,
      smith: "coding",
      requestedModel: "sonnet",
      requestedEffort: null,
    }),
  );
  expect(
    service.list(project.id).some((session) => session.id === foreign.id),
  ).toBe(false);
  expect(() => service.read(project.id, foreign.id)).toThrow("workspace");
});
