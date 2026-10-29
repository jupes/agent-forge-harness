import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Smith } from "../../../types/hearth";
import { createConversationService } from "../../conversations/service";
import { createConversationStore } from "../../conversations/store";
import type { ConversationTransport } from "../../conversations/transport";
import {
  briefsSchema,
  keeperBriefIntentMetadataSchema,
  keeperBriefIntentOriginalSchema,
} from "../../keeper/brief-protocol";
import { keeperReadiness } from "../../keeper/readiness";
import type { KeeperRuntime } from "../../keeper/recovery-runtime";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

async function terminal(
  store: ReturnType<typeof createConversationStore>,
  phase: "completed" | "failed" | "unknown",
) {
  const deadline = Date.now() + 3000;
  while (store.read(FIXTURE_PROJECT_ID).turns.at(-1)?.phase !== phase) {
    if (Date.now() >= deadline)
      throw new Error(`Fixture turn did not reach ${phase}`);
    await Bun.sleep(5);
  }
  expect(store.read(FIXTURE_PROJECT_ID).turns.at(-1)?.phase).toBe(phase);
}

test("the legacy no-ticket brief POST is refused before admitting or dispatching", async () => {
  let starts = 0;
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        async run() {
          starts++;
          return { phase: "completed", reason: null };
        },
      },
    },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout:
            JSON.stringify({
              id: "alpha-epic",
              title: "Alpha source evidence",
              issue_type: "epic",
              status: "open",
              labels: ["project:alpha"],
            }) + "\n",
          stderr: "",
        }
      : undefined;

  const response = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/briefs`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 0 }),
    },
  );

  expect(response.status).toBe(400);
  expect(starts).toBe(0);
  expect(
    createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns,
  ).toHaveLength(0);
  expect(
    h
      .events(["operator.action"])
      .some(
        (event) =>
          event.kind === "operator.action" &&
          event.payload.action === "keeper.brief.refresh",
      ),
  ).toBe(false);
});

test("closing waits for brief source preparation and prevents a late reservation", async () => {
  let starts = 0;
  let releaseExport: () => void = () => {};
  let signalExport: () => void = () => {};
  const exportGate = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  const exportEntered = new Promise<void>((resolve) => {
    signalExport = resolve;
  });
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        async run() {
          starts++;
          return { phase: "completed", reason: null };
        },
      },
    },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  h.bd.answer = async (args) => {
    if (args[0] !== "export") return undefined;
    signalExport();
    await exportGate;
    return {
      status: 0,
      stdout:
        JSON.stringify({
          id: "alpha-epic",
          title: "Alpha source evidence",
          issue_type: "epic",
          status: "open",
          labels: ["project:alpha"],
        }) + "\n",
      stderr: "",
    };
  };

  const pendingReserve = fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/brief-intents/reserve`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        expectedRevision: 0,
        origin: { kind: "overview" },
      }),
    },
  );
  await exportEntered;
  let closeFinished = false;
  const closing = h.hearth.close().then(() => {
    closeFinished = true;
  });
  await Bun.sleep(10);
  expect(closeFinished).toBe(false);
  releaseExport();
  await closing;

  const response = await pendingReserve;
  expect(response.status).toBe(503);
  expect(
    createConversationStore(h.home).read(FIXTURE_PROJECT_ID).keeperBriefIntents,
  ).toBeUndefined();
  expect(starts).toBe(0);
});

test("concurrent commits for one ticket share a single admission and provider run", async () => {
  const smith: Smith = {
    name: "claude-master",
    provider: "claude",
    model: "fixture-model",
    effort: "high",
    enabled: true,
    tags: [],
  };
  let starts = 0;
  let releaseReadiness: () => void = () => {};
  let signalReadiness: () => void = () => {};
  let releaseRun: () => void = () => {};
  let signalRun: () => void = () => {};
  const readinessGate = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  const readinessEntered = new Promise<void>((resolve) => {
    signalReadiness = resolve;
  });
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const runEntered = new Promise<void>((resolve) => {
    signalRun = resolve;
  });
  const transport: ConversationTransport = {
    provider: "claude" as const,
    async run(_request, persist) {
      starts++;
      signalRun();
      await persist({
        kind: "identity",
        provider: "claude",
        sessionId: "concurrent-brief-fixture",
        version: "fixture",
      });
      await runGate;
      return { phase: "completed" as const, reason: null };
    },
  };
  const runtime: KeeperRuntime = {
    catalog: () => ({ defaultSmith: smith.name, smiths: [smith] }),
    transport: () => transport,
    async readiness() {
      signalReadiness();
      await readinessGate;
      return keeperReadiness({ adapter: true, checked: true });
    },
  };
  const h = await startTestHearth({ api: { keeperRuntime: runtime } });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout:
            JSON.stringify({
              id: "alpha-epic",
              title: "Alpha source evidence",
              issue_type: "epic",
              status: "open",
              labels: ["project:alpha"],
            }) + "\n",
          stderr: "",
        }
      : undefined;
  const intentsPath = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/brief-intents`;
  const reserved = await fetch(`${intentsPath}/reserve`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      expectedRevision: 0,
      origin: { kind: "overview" },
    }),
  });
  expect(reserved.status).toBe(202);
  const envelope: unknown = await reserved.json();
  if (!envelope || typeof envelope !== "object" || !("data" in envelope))
    throw new Error("Missing reserved Keeper brief metadata");
  const ticket = keeperBriefIntentMetadataSchema.parse(envelope.data);
  const commit = () =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/briefs`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        requestId: ticket.requestId,
        expectedRevision: ticket.expectedRevision,
        intentHash: ticket.intentHash,
      }),
    });

  const first = commit();
  await readinessEntered;
  const replayService = createConversationService({
    home: h.home,
    root: h.root,
    transport,
    keeperRuntime: runtime,
  });
  let replaySettled = false;
  const inLeaseReplay = replayService
    .commitKeeperBrief(FIXTURE_PROJECT_ID, {
      requestId: ticket.requestId,
      expectedRevision: ticket.expectedRevision,
      intentHash: ticket.intentHash,
    })
    .then((receipt) => {
      replaySettled = true;
      return receipt;
    });
  let secondFinished = false;
  const second = commit().then((response) => {
    secondFinished = true;
    return response;
  });
  await Bun.sleep(10);
  expect(secondFinished).toBe(false);
  expect(replaySettled).toBe(false);
  expect(starts).toBe(0);
  releaseReadiness();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  expect(firstResponse.status).toBe(202);
  expect(secondResponse.status).toBe(202);
  await runEntered;
  expect(starts).toBe(1);
  expect(replaySettled).toBe(false);
  releaseRun();
  await terminal(createConversationStore(h.home), "completed");
  const replayed = await inLeaseReplay;
  expect(replaySettled).toBe(true);
  expect(replayed.turn.requestId).toBe(ticket.requestId);
  expect(starts).toBe(1);
  await replayService.close();
});

test("a project change during explicit readiness keeps the reviewed original unadmitted", async () => {
  let starts = 0;
  const smith: Smith = {
    name: "claude-master",
    provider: "claude",
    model: "fixture-model",
    effort: "high",
    enabled: true,
    tags: [],
  };
  let releaseReadiness: () => void = () => {};
  let reachedReadiness: () => void = () => {};
  const readinessGate = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  const readinessEntered = new Promise<void>((resolve) => {
    reachedReadiness = resolve;
  });
  const transport = {
    provider: "claude" as const,
    async run() {
      starts++;
      return { phase: "completed" as const, reason: null };
    },
  };
  const runtime: KeeperRuntime = {
    catalog: () => ({ defaultSmith: smith.name, smiths: [smith] }),
    transport: () => transport,
    async readiness() {
      reachedReadiness();
      await readinessGate;
      return keeperReadiness({ adapter: true, checked: true });
    },
  };
  const h = await startTestHearth({ api: { keeperRuntime: runtime } });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout:
            JSON.stringify({
              id: "alpha-epic",
              title: "Alpha source evidence",
              issue_type: "epic",
              status: "open",
              labels: ["project:alpha"],
            }) + "\n",
          stderr: "",
        }
      : undefined;
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/brief-intents`;
  const reserve = await fetch(`${path}/reserve`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      expectedRevision: 0,
      origin: { kind: "overview" },
    }),
  });
  expect(reserve.status).toBe(202);
  const reserveEnvelope: unknown = await reserve.json();
  if (
    !reserveEnvelope ||
    typeof reserveEnvelope !== "object" ||
    !("data" in reserveEnvelope)
  )
    throw new Error("Missing reserved Keeper brief metadata");
  const ticket = keeperBriefIntentMetadataSchema.parse(reserveEnvelope.data);
  const pendingCommit = fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/briefs`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        requestId: ticket.requestId,
        expectedRevision: ticket.expectedRevision,
        intentHash: ticket.intentHash,
      }),
    },
  );
  await readinessEntered;
  const catalog = projectCatalogFixture(h.workspace);
  catalog.revision++;
  catalog.projects[0] = { ...catalog.projects[0]!, archived: true };
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  releaseReadiness();
  expect((await pendingCommit).status).toBe(409);
  expect(starts).toBe(0);
  expect(
    createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns,
  ).toEqual([]);
  expect(
    createConversationStore(h.home).readKeeperBriefIntent(
      FIXTURE_PROJECT_ID,
      ticket.requestId,
    )?.state,
  ).toBe("reserved");
});

test("audited brief review commits the frozen original once and preserves a good brief across failed, malformed and unknown outcomes", async () => {
  let starts = 0;
  let checks = 0;
  let frozenText: string | null = null;
  let frozenSnapshot: unknown = null;
  let mode: "normal" | "failed" | "malformed" | "unknown" = "normal";
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        async check() {
          checks++;
        },
        async run(request, sink) {
          starts++;
          expect(
            h
              .events(["operator.action"])
              .some(
                (event) =>
                  event.kind === "operator.action" &&
                  event.payload.action === "keeper.brief.refresh",
              ),
          ).toBe(true);
          expect(request.input.text).toContain("Snapshot:");
          expect(request.input.text).toBe(frozenText);
          expect(request.input.brief).toEqual(frozenSnapshot);
          expect(request.input.about).toEqual([]);
          if (mode === "unknown")
            throw new Error("Fixture lost the provider outcome");
          await sink({
            kind: "identity",
            provider: "claude",
            sessionId: "actual-brief-fixture",
            version: "fixture",
          });
          await sink({
            kind: "text",
            text:
              mode === "malformed"
                ? "Not a structured brief"
                : JSON.stringify({
                    summary:
                      "No recorded movement in the available project read.",
                    moving: [],
                    waiting: [],
                    stuck: [],
                  }),
          });
          return {
            phase: mode === "failed" ? "failed" : "completed",
            reason: mode === "failed" ? "Fixture failure" : null,
          };
        },
      },
    },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout:
            JSON.stringify({
              id: "alpha-epic",
              title: "Alpha source evidence",
              issue_type: "epic",
              status: "open",
              labels: ["project:alpha"],
            }) + "\n",
          stderr: "",
        }
      : undefined;
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/briefs`;
  const intentsPath = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/brief-intents`;
  expect((await fetch(path, { headers: h.headers(null) })).status).toBe(403);
  const projection = async () => {
    const response = await fetch(path, { headers: h.headers(h.hearth.token) });
    expect(response.status).toBe(200);
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== "object" || !("data" in envelope))
      throw new Error("Missing brief projection");
    const parsed = briefsSchema.safeParse(envelope.data);
    if (!parsed.success) throw new Error("Invalid brief projection");
    return parsed.data;
  };
  expect((await projection()).latest).toBeNull();
  expect(starts).toBe(0);
  expect(checks).toBe(0);
  expect((await fetch(intentsPath, { headers: h.headers(null) })).status).toBe(
    403,
  );
  const input = { requestId: randomUUID(), expectedRevision: 0 };
  const post = (body: unknown) =>
    fetch(path, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(body),
    });
  expect((await post({ ...input, snapshot: { forged: true } })).status).toBe(
    400,
  );
  expect(starts).toBe(0);
  expect(checks).toBe(0);
  expect((await post(input)).status).toBe(400);
  expect(starts).toBe(0);
  const reserve = async (expectedRevision: number) => {
    const startsBefore = starts;
    const checksBefore = checks;
    const reserved = await fetch(`${intentsPath}/reserve`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        expectedRevision,
        origin: { kind: "overview" },
      }),
    });
    expect(reserved.status).toBe(202);
    const metadataEnvelope: unknown = await reserved.json();
    if (
      !metadataEnvelope ||
      typeof metadataEnvelope !== "object" ||
      !("data" in metadataEnvelope)
    )
      throw new Error("Missing Keeper brief intent metadata");
    const metadata = keeperBriefIntentMetadataSchema.parse(
      metadataEnvelope.data,
    );
    expect(metadataEnvelope.data).not.toHaveProperty("text");
    expect(metadataEnvelope.data).not.toHaveProperty("about");
    expect(metadataEnvelope.data).not.toHaveProperty("snapshot");
    expect(starts).toBe(startsBefore);
    expect(
      (
        await fetch(`${intentsPath}/${metadata.requestId}`, {
          headers: h.headers(null),
        })
      ).status,
    ).toBe(403);
    const read = await fetch(`${intentsPath}/${metadata.requestId}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(read.status).toBe(200);
    const originalEnvelope: unknown = await read.json();
    if (
      !originalEnvelope ||
      typeof originalEnvelope !== "object" ||
      !("data" in originalEnvelope)
    )
      throw new Error("Missing exact Keeper brief original");
    const original = keeperBriefIntentOriginalSchema.parse(
      originalEnvelope.data,
    );
    expect(original.text).toContain("Snapshot:");
    expect(original.about).toEqual([]);
    expect(original.snapshot.projectId).toBe(FIXTURE_PROJECT_ID);
    frozenText = original.text;
    frozenSnapshot = original.snapshot;
    const discovered = await fetch(intentsPath, {
      headers: h.headers(h.hearth.token),
    });
    expect(discovered.status).toBe(200);
    const discoveryEnvelope: unknown = await discovered.json();
    if (
      !discoveryEnvelope ||
      typeof discoveryEnvelope !== "object" ||
      !("data" in discoveryEnvelope)
    )
      throw new Error("Missing Keeper brief intent discovery");
    expect(
      keeperBriefIntentMetadataSchema.parse(discoveryEnvelope.data),
    ).toEqual(metadata);
    expect(starts).toBe(startsBefore);
    expect(checks).toBe(checksBefore);
    return metadata;
  };
  const commit = (
    ticket: ReturnType<typeof keeperBriefIntentMetadataSchema.parse>,
  ) =>
    post({
      requestId: ticket.requestId,
      expectedRevision: ticket.expectedRevision,
      intentHash: ticket.intentHash,
    });
  const firstTicket = await reserve(0);
  const startsBeforeFirstCommit = starts;
  const checksBeforeFirstCommit = checks;
  const store = createConversationStore(h.home);
  const frozenOriginal = store.readKeeperBriefIntent(
    FIXTURE_PROJECT_ID,
    firstTicket.requestId,
  );
  if (!frozenOriginal) throw new Error("The first frozen original was lost");
  let replayPreparations = 0;
  const replayService = createConversationService({
    home: h.home,
    root: h.root,
    transport: {
      provider: "claude",
      async run() {
        throw new Error("A reservation replay must not dispatch");
      },
    },
    prepareBrief: async () => {
      replayPreparations++;
      return frozenOriginal.snapshot;
    },
    keeperRuntime: {
      catalog: () => ({
        defaultSmith: firstTicket.selection.name,
        smiths: [firstTicket.selection],
      }),
      transport: () => null,
      async readiness() {
        throw new Error("A reservation replay must not check readiness");
      },
    },
  });
  const replayedTicket = await replayService.reserveKeeperBrief(
    FIXTURE_PROJECT_ID,
    { expectedRevision: 0, origin: { kind: "overview" } },
  );
  expect(replayedTicket.requestId).toBe(firstTicket.requestId);
  expect(replayedTicket.intentHash).toBe(firstTicket.intentHash);
  expect(
    replayService.readKeeperBriefIntent(
      FIXTURE_PROJECT_ID,
      firstTicket.requestId,
    ),
  ).toEqual(frozenOriginal);
  expect(replayPreparations).toBe(0);
  expect(starts).toBe(0);
  expect(checks).toBe(0);
  await replayService.close();
  expect((await commit(firstTicket)).status).toBe(202);
  expect(starts).toBe(startsBeforeFirstCommit + 1);
  expect(checks).toBe(checksBeforeFirstCommit + 1);
  expect(checks).toBe(1);
  await terminal(store, "completed");
  const original = (await projection()).latest;
  expect(original?.snapshot.observed.beads).toBe(1);
  expect(original?.snapshot.scope.label).toBe("project:alpha");
  expect((await commit(firstTicket)).status).toBe(202);
  expect(starts).toBe(1);
  expect(checks).toBe(1);
  for (const next of ["failed", "malformed", "unknown"] as const) {
    mode = next;
    const ticket = await reserve(store.read(FIXTURE_PROJECT_ID).revision);
    const startsBeforeCommit = starts;
    const checksBeforeCommit = checks;
    expect((await commit(ticket)).status).toBe(202);
    expect(starts).toBe(startsBeforeCommit + 1);
    expect(checks).toBe(checksBeforeCommit + 1);
    await terminal(
      store,
      next === "failed" || next === "unknown" ? next : "completed",
    );
    const after = await projection();
    expect(after.latest).toEqual(original);
    expect(after.refresh?.problem).toContain("previous brief has been kept");
    if (next === "unknown") {
      const startsBeforeReplay = starts;
      const checksBeforeReplay = checks;
      expect((await commit(ticket)).status).toBe(202);
      expect(starts).toBe(startsBeforeReplay);
      expect(checks).toBe(checksBeforeReplay);
      expect(store.read(FIXTURE_PROJECT_ID).turns.at(-1)?.phase).toBe(
        "unknown",
      );
    }
  }
  expect(JSON.stringify(h.events())).not.toContain("Alpha source evidence");
  expect(JSON.stringify(h.events())).not.toContain("No recorded movement");
  expect(
    h
      .events(["operator.action"])
      .some(
        (event) =>
          event.kind === "operator.action" &&
          event.payload.action === "keeper.brief.refresh",
      ),
  ).toBe(true);
});
