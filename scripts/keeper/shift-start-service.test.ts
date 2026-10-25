import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProjectShiftReceipt } from "../../types/project-shifts";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { projectShiftRequestHash } from "../shifts/registry";
import { keeperProposalFile } from "./proposal-store";
import { keeperProposals } from "./proposals";
import { createKeeperShiftStartService } from "./shift-start-service";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      dirname(root) !== realpathSync.native(tmpdir()) ||
      !basename(root).startsWith("agent-forge keeper shift start ") ||
      lstatSync(root).isSymbolicLink()
    )
      throw Error("Unsafe Keeper Shift service cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

const shiftId = "shift-20261025-063000-0001";
const request = {
  sourceHash: "",
  expectedRevision: 0,
  start: {
    requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
    expectedCatalogRevision: 1,
    options: {
      for: "1h",
      concurrency: 3,
      maxBeads: 7,
      maxUsd: 20,
      repairs: 4,
      base: "master",
    },
  },
};

async function fixture() {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "agent-forge keeper shift start ")),
  );
  roots.push(root);
  const home = join(root, "home"),
    workspace = join(root, "workspace");
  ensurePrivateHome(home);
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const catalog = projectCatalogFixture(workspace);
  writeOwnerOnly(projectCatalogPath(home), JSON.stringify(catalog));
  const proposals = [
    {
      title: "Review a Keeper Shift",
      detail: "The human reviews the complete bounds.",
      action: {
        kind: "start-shift" as const,
        durationMinutes: 45,
        concurrency: 2,
        beadLimit: 5,
        spendLimitUsd: 8,
      },
    },
  ];
  const conversations = createConversationStore(home),
    state = conversations.read(FIXTURE_PROJECT_ID),
    sourceRequestId = randomUUID(),
    owner = randomUUID();
  await conversations.accept(FIXTURE_PROJECT_ID, {
    requestId: sourceRequestId,
    expectedRevision: state.revision,
    text: "Propose a Shift",
    about: [],
  });
  await conversations.start(FIXTURE_PROJECT_ID, sourceRequestId, owner);
  await conversations.append(FIXTURE_PROJECT_ID, sourceRequestId, owner, {
    kind: "identity",
    provider: "claude",
    sessionId: randomUUID(),
    version: "fixture",
  });
  await conversations.append(FIXTURE_PROJECT_ID, sourceRequestId, owner, {
    kind: "text",
    text: JSON.stringify({
      kind: "keeper.proposals.v1",
      message: "Review this suggestion.",
      proposals,
    }),
  });
  await conversations.finish(
    FIXTURE_PROJECT_ID,
    sourceRequestId,
    owner,
    "completed",
    null,
  );
  const proposal = keeperProposals(conversations.read(FIXTURE_PROJECT_ID))[0];
  if (!proposal) throw Error("Missing Keeper Shift fixture proposal");
  const body = { ...request, sourceHash: proposal.sourceHash };
  return { home, workspace, proposal, body, conversations, catalog };
}

function receipt(
  projectId: string,
  workspace: string,
  start: typeof request.start,
): ProjectShiftReceipt {
  const at = "2026-10-25T06:30:00.000Z";
  return {
    intent: {
      projectId,
      workspace,
      shiftId,
      request: start,
      requestHash: projectShiftRequestHash(projectId, workspace, start),
      createdAt: at,
      attemptedAt: at,
    },
    observation: {
      shiftId,
      requestId: start.requestId,
      phase: "unknown",
      reason: "The fake Shift result is unconfirmed.",
      actual: null,
    },
  };
}

test("a reviewed Keeper Shift binds the edited original to one canonical start and exact retries only inspect", async () => {
  const f = await fixture();
  let starts = 0,
    saved: ProjectShiftReceipt | null = null;
  const shifts = {
    async start(projectId: string, start: typeof request.start) {
      starts++;
      saved = receipt(projectId, f.workspace, start);
      return saved;
    },
    read(projectId: string, requestId: string) {
      if (
        saved?.intent.projectId === projectId &&
        saved.intent.request.requestId === requestId
      )
        return saved;
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  };
  const service = createKeeperShiftStartService({
    home: f.home,
    root: f.workspace,
    shifts,
  });
  try {
    const started = await service.start(
      FIXTURE_PROJECT_ID,
      f.proposal.id,
      f.body,
      12,
    );
    expect(started.original).toEqual(f.body);
    expect(started.record.phase).toBe("done");
    expect(started.shift?.intent.request).toEqual(f.body.start);
    expect(starts).toBe(1);
    const savedBytes = readFileSync(
      keeperProposalFile(f.home, FIXTURE_PROJECT_ID),
    );
    const inspected = await service.read(
      FIXTURE_PROJECT_ID,
      f.proposal.id,
      f.body.start.requestId,
    );
    expect(inspected.original).toEqual(f.body);
    expect(
      readFileSync(keeperProposalFile(f.home, FIXTURE_PROJECT_ID)),
    ).toEqual(savedBytes);
    await expect(
      service.start(
        FIXTURE_PROJECT_ID,
        f.proposal.id,
        {
          ...f.body,
          start: {
            ...f.body.start,
            options: { ...f.body.start.options, maxBeads: 8 },
          },
        },
        13,
      ),
    ).rejects.toMatchObject({ status: 409 });
    writeOwnerOnly(conversationFile(f.home, FIXTURE_PROJECT_ID), "{invalid");
    const restarted = createKeeperShiftStartService({
      home: f.home,
      root: f.workspace,
      shifts,
    });
    const retry = await restarted.start(
      FIXTURE_PROJECT_ID,
      f.proposal.id,
      f.body,
      13,
    );
    expect(retry.original).toEqual(f.body);
    expect(retry.record.auditEventId).toBe(12);
    expect(starts).toBe(1);
    await restarted.close();
  } finally {
    await service.close();
  }
});

test.each([
  "removed",
  "retargeted",
  "archived",
] as const)("invalid input and a %s scope change across the awaited journal read never call canonical Shift start", async (change) => {
  const f = await fixture();
  let starts = 0;
  const service = createKeeperShiftStartService({
    home: f.home,
    root: f.workspace,
    shifts: {
      async start() {
        starts++;
        return receipt(FIXTURE_PROJECT_ID, f.workspace, f.body.start);
      },
      read() {
        throw Object.assign(new Error("not found"), { status: 404 });
      },
    },
  });
  try {
    await expect(
      service.start(
        FIXTURE_PROJECT_ID,
        f.proposal.id,
        { ...f.body, sourceHash: "bad" },
        13,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const pending = service.start(
      FIXTURE_PROJECT_ID,
      f.proposal.id,
      f.body,
      14,
    );
    writeOwnerOnly(
      projectCatalogPath(f.home),
      JSON.stringify({
        ...f.catalog,
        revision: f.catalog.revision + 1,
        projects:
          change === "removed"
            ? []
            : f.catalog.projects.map((project) => ({
                ...project,
                ...(change === "archived"
                  ? { archived: true }
                  : {
                      workspaces: [
                        {
                          ...project.workspaces[0]!,
                          root: join(f.workspace, "foreign"),
                        },
                      ],
                    }),
              })),
      }),
    );
    await expect(pending).rejects.toMatchObject({
      status: change === "removed" ? 404 : 409,
    });
    expect(starts).toBe(0);
  } finally {
    await service.close();
  }
});

test("malformed canonical receipt is unknown and an original lost result is never replayed", async () => {
  const f = await fixture();
  let starts = 0;
  const service = createKeeperShiftStartService({
    home: f.home,
    root: f.workspace,
    shifts: {
      async start(projectId: string, start: typeof request.start) {
        starts++;
        return {
          ...receipt(projectId, f.workspace, start),
          observation: {
            ...receipt(projectId, f.workspace, start).observation,
            requestId: randomUUID(),
          },
        };
      },
      read() {
        throw Object.assign(new Error("not found"), { status: 404 });
      },
    },
  });
  try {
    const first = await service.start(
      FIXTURE_PROJECT_ID,
      f.proposal.id,
      f.body,
      15,
    );
    expect(first.record.phase).toBe("unknown");
    const retry = await service.start(
      FIXTURE_PROJECT_ID,
      f.proposal.id,
      f.body,
      16,
    );
    expect(retry.record.phase).toBe("unknown");
    expect(retry.original).toEqual(f.body);
    expect(starts).toBe(1);
  } finally {
    await service.close();
  }
});
