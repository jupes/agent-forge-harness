import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  KeeperBriefSnapshot,
  KeeperScheduleStatus,
} from "../../../types/keeper-brief";
import { createConversationStore } from "../../conversations/store";
import { fakeConversationTransport } from "../../conversations/testing";
import {
  keeperBriefIntentOriginalSchema,
  keeperScheduleStatusSchema,
} from "../../keeper/brief-protocol";
import { keeperScheduleWindow } from "../../keeper/brief-schedule";
import { keeperReadiness } from "../../keeper/readiness";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import { projectCatalogFixture } from "../../projects/testing";
import type { KeeperScheduleClock } from "../keeper-brief-scheduler";
import { OPERATOR_HEADER } from "../paths";
import { createHearth, type StartedHearth } from "../server";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { fakeSessionRuntime } from "./session-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
async function fixture() {
  let runs = 0;
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        async run() {
          runs++;
          return { phase: "failed", reason: "No automatic model expected" };
        },
      },
    },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const store = createProjectStore(
    h.home,
    () => new Date(Date.now() - 2 * 86_400_000),
  );
  const project = store.read().projects[0];
  if (!project) throw Error("Missing route project");
  const read = (
    suffix = "",
    token: string | null = h.hearth.token,
    id = project.id,
  ) =>
    fetch(h.api + "/projects/" + id + "/keeper/schedule" + suffix, {
      headers: h.headers(token),
    });
  const status = async (): Promise<KeeperScheduleStatus> => {
    const response = await read(),
      raw: unknown = await response.json();
    if (
      !response.ok ||
      !raw ||
      typeof raw !== "object" ||
      !("ok" in raw) ||
      raw.ok !== true ||
      !("error" in raw) ||
      raw.error !== null ||
      !("data" in raw)
    )
      throw Error("Invalid status success envelope");
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(65_536);
    return keeperScheduleStatusSchema.parse(raw.data);
  };
  const seed = async () => {
    const catalog = await store.updateKeeperSchedule(
      project.id,
      store.read().revision,
      { kind: "daily", atUtc: "00:00" },
    );
    const schedule = catalog.projects[0]?.keeperSchedule;
    if (schedule?.kind !== "daily")
      throw Error("Missing real canonical schedule");
    const asOf = new Date().toISOString(),
      dueAt = keeperScheduleWindow(schedule, Date.parse(asOf)).latestDueAt;
    if (!dueAt) throw Error("Missing elapsed native-clock occurrence");
    const snapshot: KeeperBriefSnapshot = {
      version: 1,
      projectId: project.id,
      projectName: project.name,
      workspace: h.workspace,
      catalogRevision: catalog.revision,
      asOf,
      since: asOf,
      scope: {
        label: "project:" + project.slug,
        epicIds: [],
        epicCount: 0,
        repositoryCount: 1,
      },
      observed: { beads: 0, queue: 0, sessions: 0, runs: 0, activity: 0 },
      complete: false,
      limitations: ["Read-only route fixture"],
      facts: [],
    };
    return createConversationStore(h.home).reserveKeeperBrief(project.id, {
      expectedRevision: 0,
      origin: {
        kind: "scheduled",
        projectId: project.id,
        workspace: h.workspace,
        catalogRevision: catalog.revision,
        scheduleGeneration: schedule.generation,
        dueAt,
      },
      selection: {
        name: "fixture",
        provider: "claude",
        model: "fixture",
        effort: "",
        enabled: true,
        tags: [],
      },
      text: "PRIVATE_SCHEDULE_SOURCE_BODY",
      about: [],
      snapshot,
    });
  };
  return { h, store, project, read, status, seed, runs: () => runs };
}

test("Keeper schedule protected status is read-only and preserves exact originals without automatic models", async () => {
  const f = await fixture();
  const initial = await f.status();
  expect(initial).toMatchObject({
    owner: "active",
    phase: "off",
    schedule: null,
    projectId: f.project.id,
    workspace: f.h.workspace,
    conversationId: "keeper-" + f.project.id,
  });
  const original = await f.seed(),
    before = createConversationStore(f.h.home).read(f.project.id),
    calls = f.h.bd.calls.length;
  const current = await f.status();
  expect(current.phase).toBe("ready-for-review");
  expect(current.ticket).toMatchObject({
    requestId: original.requestId,
    intentHash: original.intentHash,
    state: "reserved",
  });
  expect(JSON.stringify(current)).not.toContain("PRIVATE_SCHEDULE_SOURCE_BODY");
  await f.status();
  await f.status();
  expect(createConversationStore(f.h.home).read(f.project.id)).toEqual(before);
  expect(f.h.bd.calls).toHaveLength(calls);
  expect(f.runs()).toBe(0);
  expect((await f.read("", null)).status).toBe(403);
  expect((await f.read("?unexpected=1")).status).toBe(400);
  expect((await f.read("", f.h.hearth.token, "bad-id")).status).toBe(400);
  expect(
    (
      await f.read(
        "",
        f.h.hearth.token,
        "project-00000000-0000-4000-8000-000000000000",
      )
    ).status,
  ).toBe(404);
});

test("Keeper schedule receiving contract rejects impossible cross-bound status without changing originals", async () => {
  const f = await fixture(),
    original = await f.seed(),
    current = await f.status(),
    ticket = current.ticket;
  if (
    !ticket ||
    ticket.origin.kind !== "scheduled" ||
    current.schedule?.kind !== "daily"
  )
    throw Error("Missing bound status fixture");
  for (const value of [
    { ...current, ticket: null },
    { ...current, phase: "off" },
    { ...current, owner: "closed" },
    { ...current, phase: "preparing", attempt: null },
    { ...current, conversationId: "keeper-foreign" },
    { ...current, ticket: { ...ticket, projectId: "foreign" } },
    { ...current, ticket: { ...ticket, conversationId: "keeper-foreign" } },
    {
      ...current,
      ticket: { ...ticket, origin: { ...ticket.origin, projectId: "foreign" } },
    },
    {
      ...current,
      ticket: {
        ...ticket,
        origin: { ...ticket.origin, workspace: "/foreign" },
      },
    },
    { ...current, ticket: { ...ticket, state: "retired" } },
    {
      ...current,
      ticket: {
        ...ticket,
        origin: { ...ticket.origin, scheduleGeneration: randomUUID() },
      },
    },
    {
      ...current,
      ticket: {
        ...ticket,
        origin: { ...ticket.origin, dueAt: "2026-11-08T09:30:01.000Z" },
      },
    },
  ])
    expect(keeperScheduleStatusSchema.safeParse(value).success).toBe(false);
  for (const phase of [
    "waiting",
    "preparing",
    "ready-for-review",
    "policy-paused",
    "capacity-paused",
  ])
    expect(
      keeperScheduleStatusSchema.safeParse({
        ...current,
        phase,
        schedule: null,
        latestDueAt: null,
        nextDueAt: null,
        ticket: null,
      }).success,
    ).toBe(false);
  await f.store.preferences(f.project.id, f.store.read().revision, {
    pinned: true,
  });
  expect((await f.status()).ticket?.origin.catalogRevision).toBe(
    ticket.origin.catalogRevision,
  );
  const before = Date.parse(ticket.origin.dueAt) - 3 * 86_400_000;
  const rolled = {
    ...current,
    owner: "active" as const,
    asOf: new Date(before).toISOString(),
    latestDueAt: keeperScheduleWindow(current.schedule, before).latestDueAt,
    nextDueAt: keeperScheduleWindow(
      current.schedule,
      Date.parse(ticket.origin.dueAt),
    ).nextDueAt,
    attempt: {
      dueAt: ticket.origin.dueAt,
      startedAt: current.asOf,
      problem: null,
    },
  };
  expect(keeperScheduleStatusSchema.parse(rolled)).toEqual(rolled);
  expect(
    keeperScheduleStatusSchema.safeParse({
      ...rolled,
      nextDueAt: ticket.origin.dueAt,
    }).success,
  ).toBe(false);
  const alias = {
    ...current,
    workspace: "C:/Work/Repo",
    ticket: {
      ...ticket,
      origin: { ...ticket.origin, workspace: "c:\\WORK\\repo\\" },
    },
  };
  expect(keeperScheduleStatusSchema.parse(alias).ticket?.origin.workspace).toBe(
    alias.ticket.origin.workspace,
  );
  const huge = "/" + "界".repeat(4095);
  expect(
    keeperScheduleStatusSchema.safeParse({
      ...current,
      workspace: huge,
      ticket: {
        ...ticket,
        origin: { ...ticket.origin, workspace: huge },
        selection: {
          ...ticket.selection,
          tags: Array.from({ length: 100 }, () => "界".repeat(200)),
        },
      },
    }).success,
  ).toBe(false);
  expect(
    createConversationStore(f.h.home).readKeeperBriefIntent(
      f.project.id,
      original.requestId,
    ),
  ).toEqual(original);
  expect(f.runs()).toBe(0);
});

test("Keeper schedule actual acquired Hearth prepares bounded sources on its trusted clock and restarts with the exact original", async () => {
  let wall = Date.parse("2026-11-08T09:00:00.000Z");
  let timer: (() => void) | undefined,
    armed = deferred();
  const readTimer = (): (() => void) | undefined => timer;
  const clock: KeeperScheduleClock = {
    now: () => wall,
    setTimer(run) {
      timer = run;
      armed.release();
      return () => {
        timer = undefined;
      };
    },
  };
  let probes = 0,
    runs = 0;
  const selection = {
    name: "fixture",
    provider: "claude" as const,
    model: "fixture",
    effort: "",
    enabled: true,
    tags: [],
  };
  const transport = {
    ...fakeConversationTransport(),
    async run() {
      runs++;
      return {
        phase: "failed" as const,
        reason: "No automatic model expected",
      };
    },
  };
  const runtime = {
    catalog: () => ({ defaultSmith: selection.name, smiths: [selection] }),
    transport: () => transport,
    async readiness() {
      probes++;
      return keeperReadiness({ checked: true, adapter: true });
    },
  };
  const h = await startTestHearth({
    api: {
      keeperScheduleClock: clock,
      keeperRuntime: runtime,
      conversationTransport: transport,
    },
  });
  let successor: StartedHearth | undefined;
  try {
    await armed.wait;
    writeOwnerOnly(
      projectCatalogPath(h.home),
      JSON.stringify(projectCatalogFixture(h.workspace)),
    );
    const catalog = createProjectStore(h.home),
      project = catalog.read().projects[0];
    if (!project) throw Error("Missing clock composition project");
    const response = await fetch(
      h.api + "/projects/" + project.id + "/settings/keeper",
      {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: JSON.stringify({
          expectedRevision: catalog.read().revision,
          kind: "schedule",
          keeperSchedule: { kind: "daily", atUtc: "09:30" },
        }),
      },
    );
    const receipt: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(receipt).toMatchObject({ ok: true, error: null });
    const saved = catalog.read().projects[0]?.keeperSchedule;
    expect(saved).toMatchObject({
      kind: "daily",
      activatedAt: "2026-11-08T09:00:00.000Z",
    });
    const read = async (origin: string, token: string) => {
      const result = await fetch(
        origin + "/__agent-forge/projects/" + project.id + "/keeper/schedule",
        {
          headers: { Origin: origin, [OPERATOR_HEADER]: token },
        },
      );
      const raw: unknown = await result.json();
      if (
        !result.ok ||
        !raw ||
        typeof raw !== "object" ||
        !("ok" in raw) ||
        raw.ok !== true ||
        !("data" in raw) ||
        !("error" in raw) ||
        raw.error !== null
      )
        throw Error("Expected real status success");
      return keeperScheduleStatusSchema.parse(raw.data);
    };
    expect((await read(h.hearth.url, h.hearth.token)).phase).toBe("waiting");
    wall = Date.parse("2026-11-08T09:31:00.000Z");
    const fire = readTimer();
    if (!fire) throw Error("Missing acquired owner's bounded wakeup");
    timer = undefined;
    armed = deferred();
    fire();
    await armed.wait;
    const current = await read(h.hearth.url, h.hearth.token),
      ticket = current.ticket;
    expect(current.phase).toBe("ready-for-review");
    if (!ticket) throw Error("Missing actual prepared original");
    const originalResponse = await fetch(
      h.api +
        "/projects/" +
        project.id +
        "/keeper/brief-intents/" +
        ticket.requestId,
      { headers: h.headers(h.hearth.token) },
    );
    const rawOriginal: unknown = await originalResponse.json();
    if (
      !originalResponse.ok ||
      !rawOriginal ||
      typeof rawOriginal !== "object" ||
      !("ok" in rawOriginal) ||
      rawOriginal.ok !== true ||
      !("data" in rawOriginal) ||
      !("error" in rawOriginal) ||
      rawOriginal.error !== null
    )
      throw Error("Expected exact original success");
    const original = keeperBriefIntentOriginalSchema.parse(rawOriginal.data);
    expect(original).toMatchObject({
      requestId: ticket.requestId,
      intentHash: ticket.intentHash,
      snapshot: { asOf: "2026-11-08T09:31:00.000Z" },
      origin: { kind: "scheduled", dueAt: "2026-11-08T09:30:00.000Z" },
    });
    expect(h.bd.calls.some((args) => args[0] === "export")).toBe(true);
    const count = h.bd.calls.length;
    const again = readTimer();
    if (!again) throw Error("Missing next bounded tick");
    armed = deferred();
    wall += 60_000;
    again();
    await armed.wait;
    expect((await read(h.hearth.url, h.hearth.token)).ticket).toEqual(ticket);
    expect(h.bd.calls).toHaveLength(count);
    await h.hearth.close();
    armed = deferred();
    const next = await createHearth({
      root: h.root,
      home: h.home,
      environment: {},
      councilRunCommand: h.commands.run,
      api: {
        configHome: h.configHome,
        ledgerPath: h.ledger,
        runBd: (args, options) => h.bd.run(args, options),
        keeperScheduleClock: clock,
        keeperRuntime: runtime,
        conversationTransport: transport,
        sessionRuntime: fakeSessionRuntime().runtime,
      },
    });
    if (next.kind !== "started")
      throw Error("Expected restarted acquired owner");
    successor = next;
    await armed.wait;
    expect((await read(successor.url, successor.token)).ticket).toEqual(ticket);
    expect(
      createConversationStore(h.home).readKeeperBriefIntent(
        project.id,
        ticket.requestId,
      ),
    ).toEqual(original);
    expect(h.bd.calls).toHaveLength(count);
    expect({ probes, runs }).toEqual({ probes: 0, runs: 0 });
  } finally {
    try {
      await successor?.close();
    } finally {
      await h.close();
    }
  }
});

function deferred() {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
