import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConversationState } from "../../types/conversation";
import { ConversationError } from "../conversations/error";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { seedKeeperProposalSource } from "../hearth/routes/keeper-proposal-fixture";
import { seedKeeperSessionStartSource } from "../hearth/routes/keeper-session-start-fixture";
import {
  fakeSessionRuntime,
  sessionStartFixture,
  waitOwnedTurn,
} from "../hearth/routes/session-fixture";
import { startTestHearth } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { createOwnedSessionService } from "../sessions/admission";
import { canonicalSessionInput } from "../sessions/preparation";
import { createSessionRegistry } from "../sessions/registry";
import {
  createKeeperProposalStore,
  keeperProposalFile,
} from "./proposal-store";
import { createKeeperSessionStartService } from "./session-start-service";

test("the verified proposal binds the edited full Start to its original owned turn, and restart reads never dispatch", async () => {
  const h = await startTestHearth();
  const fake = fakeSessionRuntime();
  const prepare = fake.runtime.prepare;
  fake.runtime.prepare = async (input) => {
    const snapshot = await prepare(input);
    return {
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        flags: [
          ...snapshot.capabilities.flags,
          "--max-budget-usd",
          "--json-schema",
        ],
      },
    };
  };
  const sessions = createOwnedSessionService({
    home: h.home,
    root: h.root,
    runtime: fake.runtime,
    validateScope: async () => {},
  });
  let prepared = 0;
  const options = {
    home: h.home,
    root: h.root,
    sessions,
    prepare: async () => {
      prepared++;
    },
  };
  const service = createKeeperSessionStartService(options);
  try {
    const [proposal] = await seedKeeperProposalSource(h, [
      {
        title: "Review a session",
        detail: "Only the human starts it",
        action: {
          kind: "start-session",
          provider: "claude",
          smith: "claude-journeyman",
          beadId: "alpha-epic",
          repository: h.workspace,
          worktree: "current",
          prompt: "Source suggestion",
        },
      },
    ]);
    if (!proposal) throw new Error("Missing trusted proposal fixture");
    const start = {
      ...sessionStartFixture(h),
      beadId: "alpha-epic",
      about: [{ kind: "bead" as const, id: "alpha-epic" }],
      launch: {
        ...sessionStartFixture(h).launch,
        mode: "task" as const,
        prompt: "  Human edited prompt\n🌱\n",
        permissionMode: "plan" as const,
        maxBudgetUsd: 2,
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
        attachments: [
          {
            kind: "image" as const,
            name: "pixel.png",
            mediaType: "image/png" as const,
            data: "iVBORw0KGgo=",
          },
        ],
      },
    };
    const body = {
      sourceHash: proposal.sourceHash,
      expectedRevision: 0,
      start,
    };
    const receipt = await service.start(
      FIXTURE_PROJECT_ID,
      proposal.id,
      body,
      1,
    );
    expect(receipt.original).toEqual(body);
    expect(receipt.session?.requestHash).toBe(
      createHash("sha256").update(canonicalSessionInput(start)).digest("hex"),
    );
    expect(receipt.receipt?.turn.requestId).toBe(start.requestId);
    if (!receipt.session) throw new Error("No correlated session");
    await waitOwnedTurn(h, receipt.session, start.requestId);
    const restarted = createKeeperSessionStartService({
      ...options,
      prepare: async () => {
        throw new Error("A recovery read must not prepare or dispatch");
      },
    });
    const observed = await restarted.read(
      FIXTURE_PROJECT_ID,
      proposal.id,
      start.requestId,
    );
    expect(observed.receipt?.turn.phase).toBe("completed");
    expect(observed.original).toEqual(body);
    expect(fake.runs).toHaveLength(1);
    expect(prepared).toBe(1);
    await restarted.close();
  } finally {
    await service.close();
    await sessions.close();
    await h.close();
  }
});

test("interruption before reservation, after reservation or after acceptance restores the exact original, and only explicit original retry may continue", async () => {
  for (const boundary of ["before", "reserved", "accepted"]) {
    const h = await startTestHearth();
    const fake = fakeSessionRuntime();
    const sessions = createOwnedSessionService({
      home: h.home,
      root: h.root,
      runtime: fake.runtime,
      validateScope: async () => {},
    });
    let calls = 0;
    const wrapped = {
      list: sessions.list,
      read: sessions.read,
      async start(projectId: string, raw: unknown) {
        calls++;
        if (calls > 1) return sessions.start(projectId, raw);
        if (boundary === "accepted") await sessions.start(projectId, raw);
        if (boundary === "reserved") {
          const input = sessionStartFixture(h);
          await createSessionRegistry(h.home).reserve(
            projectId,
            input.requestId,
            createHash("sha256")
              .update(canonicalSessionInput(input))
              .digest("hex"),
            async () => ({
              mode: input.launch.mode,
              provider: "claude",
              workspace: h.workspace,
              repository: input.repository,
              worktree: input.worktree,
              smith: input.smith,
              requestedModel: input.launch.model,
              requestedEffort: null,
            }),
          );
        }
        throw new ConversationError(
          503,
          "Synthetic response loss; no turn was accepted",
        );
      },
    };
    const service = createKeeperSessionStartService({
      home: h.home,
      root: h.root,
      sessions: wrapped,
      prepare: async () => {},
    });
    try {
      const proposal = await seedKeeperSessionStartSource(h);
      const original = {
        sourceHash: proposal.sourceHash,
        expectedRevision: 0,
        start: sessionStartFixture(h),
      };
      const first = await service.start(
        FIXTURE_PROJECT_ID,
        proposal.id,
        original,
        1,
      );
      expect(first.original).toEqual(original);
      expect(first.record.phase).toBe(
        boundary === "accepted" ? "done" : "unknown",
      );
      expect(first.record.message).not.toContain("no turn was accepted");
      expect(first.receipt === null).toBe(boundary !== "accepted");
      expect(first.session === null).toBe(boundary === "before");
      const restarted = createKeeperSessionStartService({
        home: h.home,
        root: h.root,
        sessions: wrapped,
        prepare: async () => {
          throw new Error("Recovery must not revalidate mutable source");
        },
      });
      const bytes = readFileSync(
        keeperProposalFile(h.home, FIXTURE_PROJECT_ID),
        "utf8",
      );
      expect(
        (await restarted.read(FIXTURE_PROJECT_ID, proposal.id)).original,
      ).toEqual(original);
      expect(
        readFileSync(keeperProposalFile(h.home, FIXTURE_PROJECT_ID), "utf8"),
      ).toBe(bytes);
      expect(calls).toBe(1);
      await expect(
        restarted.start(
          FIXTURE_PROJECT_ID,
          proposal.id,
          {
            ...original,
            start: {
              ...original.start,
              launch: { ...original.start.launch, prompt: "Edited after loss" },
            },
          },
          2,
        ),
      ).rejects.toThrow("different");
      expect(calls).toBe(1);
      const retried = await restarted.start(
        FIXTURE_PROJECT_ID,
        proposal.id,
        original,
        3,
      );
      expect(retried.original).toEqual(original);
      expect(retried.record.phase).toBe("done");
      if (!retried.session) throw new Error("No original correlated session");
      await waitOwnedTurn(h, retried.session, original.start.requestId);
      expect(fake.runs).toHaveLength(1);
      await restarted.close();
    } finally {
      await service.close();
      await sessions.close();
      await h.close();
    }
  }
});

test("a changed source during fresh preparation refuses admission without reserving or starting", async () => {
  const h = await startTestHearth();
  const fake = fakeSessionRuntime();
  const sessions = createOwnedSessionService({
    home: h.home,
    root: h.root,
    runtime: fake.runtime,
    validateScope: async () => {},
  });
  const service = createKeeperSessionStartService({
    home: h.home,
    root: h.root,
    sessions,
    prepare: async () => {
      const store = createConversationStore(h.home);
      const state = store.read(FIXTURE_PROJECT_ID);
      const reply = state.frames.find(
        (frame) => frame.event.kind === "text",
      )?.event;
      if (reply?.kind !== "text") throw new Error("No source reply");
      reply.text += "\n";
      writeOwnerOnly(
        conversationFile(h.home, FIXTURE_PROJECT_ID),
        JSON.stringify(state),
      );
    },
  });
  try {
    const proposal = await seedKeeperSessionStartSource(h);
    await expect(
      service.start(
        FIXTURE_PROJECT_ID,
        proposal.id,
        {
          sourceHash: proposal.sourceHash,
          expectedRevision: 0,
          start: sessionStartFixture(h),
        },
        1,
      ),
    ).rejects.toThrow("source");
    expect(createSessionRegistry(h.home).list(FIXTURE_PROJECT_ID)).toEqual([]);
    expect(fake.runs).toEqual([]);
    expect(
      (await createKeeperProposalStore(h.home).read(FIXTURE_PROJECT_ID))
        .records,
    ).toEqual([]);
  } finally {
    await service.close();
    await sessions.close();
    await h.close();
  }
});

test("closing during preparation admits no intent, registry or turn", async () => {
  const h = await startTestHearth();
  const fake = fakeSessionRuntime();
  const sessions = createOwnedSessionService({
    home: h.home,
    root: h.root,
    runtime: fake.runtime,
    validateScope: async () => {},
  });
  let entered = () => {},
    release = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createKeeperSessionStartService({
    home: h.home,
    root: h.root,
    sessions,
    prepare: async () => {
      entered();
      await gate;
    },
  });
  try {
    const proposal = await seedKeeperSessionStartSource(h);
    const pending = service.start(
      FIXTURE_PROJECT_ID,
      proposal.id,
      {
        sourceHash: proposal.sourceHash,
        expectedRevision: 0,
        start: sessionStartFixture(h),
      },
      1,
    );
    await waiting;
    const closing = service.close();
    release();
    await expect(pending).rejects.toThrow("closed");
    await closing;
    expect(
      (await createKeeperProposalStore(h.home).read(FIXTURE_PROJECT_ID))
        .records,
    ).toEqual([]);
    expect(createSessionRegistry(h.home).list(FIXTURE_PROJECT_ID)).toEqual([]);
    expect(fake.runs).toEqual([]);
  } finally {
    release();
    await service.close();
    await sessions.close();
    await h.close();
  }
});

test("a shared private home does not expose or retry another served workspace's original reviewed input", async () => {
  const h = await startTestHearth();
  const other = await startTestHearth();
  const fake = fakeSessionRuntime();
  const sessions = createOwnedSessionService({
    home: h.home,
    root: h.root,
    runtime: fake.runtime,
    validateScope: async () => {},
  });
  const service = createKeeperSessionStartService({
    home: h.home,
    root: h.root,
    sessions,
    prepare: async () => {},
  });
  const foreign = createKeeperSessionStartService({
    home: h.home,
    root: other.root,
    sessions,
    prepare: async () => {
      throw new Error("Foreign input must never prepare");
    },
  });
  try {
    const proposal = await seedKeeperSessionStartSource(h);
    const body = {
      sourceHash: proposal.sourceHash,
      expectedRevision: 0,
      start: sessionStartFixture(h),
    };
    const accepted = await service.start(
      FIXTURE_PROJECT_ID,
      proposal.id,
      body,
      1,
    );
    if (!accepted.session) throw new Error("No correlated original session");
    await waitOwnedTurn(h, accepted.session, body.start.requestId);
    const catalog = projectCatalogFixture(h.workspace);
    const project = catalog.projects[0];
    const scope = project?.workspaces[0];
    if (!project || !scope) throw new Error("Missing project scope");
    project.workspaces.push({ ...scope, root: other.workspace });
    writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
    const path = keeperProposalFile(h.home, FIXTURE_PROJECT_ID);
    const before = readFileSync(path, "utf8");
    await expect(
      foreign.read(FIXTURE_PROJECT_ID, proposal.id, body.start.requestId),
    ).rejects.toThrow("different workspace");
    await expect(
      foreign.start(FIXTURE_PROJECT_ID, proposal.id, body, 2),
    ).rejects.toThrow("different workspace");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(fake.runs).toHaveLength(1);
    expect(
      (await service.read(FIXTURE_PROJECT_ID, proposal.id)).original,
    ).toEqual(body);
  } finally {
    await foreign.close();
    await service.close();
    await sessions.close();
    await other.close();
    await h.close();
  }
});

test("a matching registry and turn cannot confirm a missing, changed or unbound original private user snapshot", async () => {
  const h = await startTestHearth();
  const fake = fakeSessionRuntime();
  const sessions = createOwnedSessionService({
    home: h.home,
    root: h.root,
    runtime: fake.runtime,
    validateScope: async () => {},
  });
  const service = createKeeperSessionStartService({
    home: h.home,
    root: h.root,
    sessions,
    prepare: async () => {},
  });
  try {
    const [proposal] = await seedKeeperProposalSource(h, [
      {
        title: "Review a session",
        detail: "Only the human starts it",
        action: {
          kind: "start-session",
          provider: "claude",
          smith: "claude-journeyman",
          beadId: "alpha-epic",
          repository: h.workspace,
          worktree: "current",
          prompt: "Source suggestion",
        },
      },
    ]);
    if (!proposal) throw new Error("Missing trusted proposal fixture");
    const start = sessionStartFixture(h);
    const accepted = await service.start(
      FIXTURE_PROJECT_ID,
      proposal.id,
      {
        sourceHash: proposal.sourceHash,
        expectedRevision: 0,
        start,
      },
      1,
    );
    if (!accepted.session) throw new Error("No correlated session");
    await waitOwnedTurn(h, accepted.session, start.requestId);
    const address = {
      kind: "session" as const,
      projectId: FIXTURE_PROJECT_ID,
      sessionId: accepted.session.id,
    };
    const original = createConversationStore(h.home, undefined, address).read(
      FIXTURE_PROJECT_ID,
    );
    const path = conversationFile(h.home, FIXTURE_PROJECT_ID, address);
    const corruptions: Array<(state: ConversationState) => void> = [
      (state) => {
        state.frames = state.frames
          .filter((frame) => frame.event.kind !== "user")
          .map((frame, index) => ({ ...frame, seq: index + 1 }));
      },
      (state) => {
        const event = state.frames[0]?.event;
        if (event?.kind === "user") event.text = "Changed original";
      },
      (state) => {
        const event = state.frames[0]?.event;
        if (event?.kind === "user") delete event.session;
      },
      (state) => {
        const event = state.frames[0]?.event;
        if (event?.kind === "user" && event.session)
          event.session.launch.permissionMode = "plan";
      },
      (state) => {
        const event = state.frames[0]?.event;
        if (event?.kind === "user" && event.session?.launch.context)
          event.session.launch.context.worktree = "C:/foreign";
      },
      (state) => {
        const turn = state.turns[0];
        if (turn) turn.hash = "a".repeat(64);
      },
      (state) => {
        const event = state.frames[0]?.event;
        const turn = state.turns[0];
        if (event?.kind === "user" && event.session && turn) {
          event.session.launch.permissionMode = "plan";
          turn.hash = createHash("sha256")
            .update(
              JSON.stringify({
                text: event.text,
                about: event.about,
                session: event.session,
              }),
            )
            .digest("hex");
        }
      },
    ];
    for (const corrupt of corruptions) {
      const state = structuredClone(original);
      corrupt(state);
      writeOwnerOnly(path, JSON.stringify(state));
      const bytes = readFileSync(path, "utf8");
      await expect(
        service.read(FIXTURE_PROJECT_ID, proposal.id, start.requestId),
      ).rejects.toThrow("private input");
      expect(readFileSync(path, "utf8")).toBe(bytes);
    }
    writeOwnerOnly(path, JSON.stringify(original));
    expect(
      (await service.read(FIXTURE_PROJECT_ID, proposal.id, start.requestId))
        .receipt?.turn.phase,
    ).toBe("completed");
    expect(fake.runs).toHaveLength(1);
  } finally {
    await service.close();
    await sessions.close();
    await h.close();
  }
});
