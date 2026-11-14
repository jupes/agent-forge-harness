import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createOperatorClient,
  type OperatorRead,
} from "../../../docs/js/operator";
import { TOKEN_ROUTE } from "../../../scripts/hearth/paths";
import { projectRunDetailSchema } from "../../../scripts/projects/run-protocol";
import { buildProviderReadiness } from "../../../scripts/providers/readiness";
import { projectCheckpointReviewInventoryJson } from "../../../types/project-checkpoint-review-inventory";
import {
  type ProjectCheckpointReviewOriginal,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalReadSchema,
} from "../../../types/project-checkpoint-reviews";
import type { ProjectsHome } from "../../../types/project-summary";
import {
  type ProviderReadinessPage,
  READINESS_PROVIDERS,
} from "../../../types/provider-readiness";
import {
  createInboxOperatorRead,
  createInboxSourceComposition,
  readInboxHeldOriginal,
} from "./inbox-source-composition";
import { projectInboxUsageSource } from "./inbox-usage-source";
import { projectInbox } from "./inbox-view";

const projectId = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46";
const workspace = "/fixture/workspace";
const at = "2026-11-11T00:00:00.000Z";
function home(): ProjectsHome {
  return {
    catalog: {
      version: 1,
      revision: 3,
      projects: [
        {
          id: projectId,
          slug: "alpha",
          name: "Alpha",
          description: "",
          icon: "hammer",
          workspaces: [
            {
              root: workspace,
              repositories: ["/fixture/checkout"],
              epicIds: ["alpha-epic"],
            },
          ],
          pinned: false,
          archived: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
    },
    summaries: [
      {
        projectId,
        workspace,
        asOf: at,
        complete: true,
        problems: [],
        beads: null,
        queue: null,
        needsYou: [],
        sessions: [],
        sessionsComplete: true,
        runs: [],
        lastActivity: null,
      },
    ],
    asOf: at,
  };
}
function pages() {
  const scope = { projectId, workspace };
  return {
    workbench: {
      ...scope,
      asOf: at,
      complete: true,
      problems: [],
      cards: [],
      host: null,
      smiths: null,
    },
    beads: {
      ...scope,
      asOf: at,
      complete: true,
      problems: [],
      beads: [],
      dependencies: [],
    },
    shifts: { projectId, asOf: at, items: [] },
    runs: {
      version: 1,
      ...scope,
      checkout: "/fixture/checkout",
      asOf: at,
      coverage: "served-checkout-only",
      problems: [],
      runs: [],
    },
    "council/reviews": {
      version: 1,
      ...scope,
      activeRequestId: null,
      total: 0,
      omitted: 0,
      items: [],
    },
    "checkpoint-reviews": {
      schemaVersion: 1,
      available: true,
      scope: { projectId, workspacePath: workspace },
      coverage: "retained-review-records",
      records: [],
      observationRevision: createHash("sha256")
        .update(
          projectCheckpointReviewInventoryJson(
            { projectId, workspacePath: workspace },
            [],
          ),
        )
        .digest("hex"),
    },
  };
}
const reply = (data: unknown) => Response.json({ ok: true, data, error: null });
function fixtureReader(
  change: (path: string, value: unknown) => unknown = (_path, value) => value,
): OperatorRead {
  return async (input) => {
    const path = String(input).split("/" + projectId + "/")[1] ?? "";
    const value = Object.entries(pages()).find(([key]) => key === path)?.[1];
    if (value === undefined) throw Error("Unexpected fixture route: " + path);
    return reply(change(path, value));
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("complete empty source families do not fabricate unavailable usage or a global zero", async () => {
  const owner = createInboxSourceComposition({ reader: fixtureReader() });
  const view = await owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 7,
  });
  expect(view.cards).toEqual([]);
  expect(view.complete).toBe(false);
  expect(
    view.coverage.find((item) => item.sourceKind === "usage-threshold")?.state,
  ).toBe("unavailable");
  expect(
    view.coverage
      .filter((item) => item.sourceKind !== "usage-threshold")
      .every((item) => item.state === "current"),
  ).toBe(true);
  expect(view.sourceGeneration).toBe(7);
  await owner.close();
});

test("a malformed or foreign page makes its full family unavailable, never verified empty", async () => {
  for (const raw of [
    null,
    { ...pages().workbench, projectId: "foreign" },
    { ...pages().workbench, complete: false },
  ]) {
    const owner = createInboxSourceComposition({
      reader: fixtureReader((path, value) =>
        path === "workbench" ? raw : value,
      ),
    });
    const view = await owner.refresh({
      home: home(),
      homeCurrent: true,
      sourceGeneration: 1,
    });
    expect(
      view.coverage.find((item) => item.sourceKind === "bead-approval")?.state,
    ).not.toBe("current");
    expect(
      view.coverage.find((item) => item.sourceKind === "halted-bead")?.state,
    ).not.toBe("current");
    await owner.close();
  }
});

test("missing catalog authority and oversized catalog issue no reads and retain uncertainty", async () => {
  let calls = 0;
  const owner = createInboxSourceComposition({
    reader: async () => {
      calls++;
      throw Error("not admitted");
    },
  });
  await owner.refresh({
    home: home(),
    homeCurrent: false,
    sourceGeneration: 1,
  });
  const many = home();
  many.catalog.projects = Array.from({ length: 33 }, () => ({
    ...many.catalog.projects[0]!,
  }));
  const view = await owner.refresh({
    home: many,
    homeCurrent: true,
    sourceGeneration: 2,
  });
  expect(calls).toBe(0);
  expect(view.complete).toBe(false);
  expect(view.coverage.every((item) => item.state !== "current")).toBe(true);
  await owner.close();
});

test("a scope or epoch change revokes before abort observers and late frames cannot publish", async () => {
  const waiting = deferred<Response>();
  let signal: AbortSignal | null = null;
  let seenFresh = true;
  let blocked = false;
  const owner = createInboxSourceComposition({
    reader: async (path, init, limits) => {
      if (!blocked && String(path).endsWith("/workbench")) {
        blocked = true;
        signal = init?.signal ?? null;
        signal?.addEventListener("abort", () => {
          seenFresh = owner
            .snapshot()
            .cards.some((item) => item.sourceState === "current");
        });
        return waiting.promise;
      }
      return fixtureReader()(path, init, limits);
    },
  });
  const old = owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 1,
  });
  for (let i = 0; i < 20 && !blocked; i++) await Promise.resolve();
  owner.invalidate();
  expect(seenFresh).toBe(false);
  waiting.resolve(reply(pages().workbench));
  await old;
  expect(
    owner.snapshot().coverage.every((item) => item.state !== "current"),
  ).toBe(true);
  await owner.close();
});

test("body cancellation retains its physical read slot until cancellation settles", async () => {
  const cancelled = deferred<void>();
  let physical = 0,
    maximum = 0,
    waitingBodies = 0;
  const releases: Array<() => void> = [];
  const reader: OperatorRead = async () => {
    physical++;
    maximum = Math.max(maximum, physical);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        physical--;
      }
    };
    return new Response(
      new ReadableStream<Uint8Array>({
        start() {
          waitingBodies++;
          releases.push(release);
        },
        async cancel() {
          await cancelled.promise;
          release();
        },
      }),
    );
  };
  const owner = createInboxSourceComposition({ reader });
  const other = createInboxSourceComposition({ reader });
  const read = owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 1,
  });
  const secondRead = other.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 1,
  });
  for (let i = 0; i < 100 && waitingBodies < 4; i++) await Promise.resolve();
  expect(physical).toBe(4);
  owner.invalidate();
  let closed = false;
  other.invalidate();
  const closing = Promise.all([owner.close(), other.close()]).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(physical).toBe(4);
  cancelled.resolve();
  await read;
  await secondRead;
  await closing;
  expect(physical).toBe(0);
  expect(maximum).toBe(4);
});

function unknownReview() {
  const original: ProjectCheckpointReviewOriginal = {
    schemaVersion: 1,
    requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
    binding: {
      projectId,
      workspacePath: workspace,
      checkout: "/fixture/checkout",
      runSlug: "missing-run",
      epicId: "alpha-epic",
      beadId: "alpha-task",
      runUpdatedAt: at,
      catalogRevision: 3,
      scopeHash: "a".repeat(64),
    },
    decision: "approve",
    note: "",
    createdAt: at,
    commentText: "",
    intentHash: "0".repeat(64),
  };
  original.commentText = projectCheckpointReviewCommentText(original);
  original.intentHash = createHash("sha256")
    .update(projectCheckpointReviewIntentJson(original))
    .digest("hex");
  const common = {
    schemaVersion: 1,
    requestId: original.requestId,
    intentHash: original.intentHash,
    state: "unknown",
    commentId: null,
    createdAt: at,
    updatedAt: at,
  };
  return projectCheckpointReviewOriginalReadSchema.parse({
    original,
    metadata: {
      ...common,
      scope: {
        projectId,
        workspacePath: workspace,
        runSlug: "missing-run",
        beadId: "alpha-task",
      },
    },
    receipt: {
      ...common,
      reportedCommentId: null,
      readback: "not-checked",
      auditEventId: 1,
    },
  });
}

test("a retained unknown Review stays an unfiltered non-snoozable original notice without a current Run", async () => {
  const records = [unknownReview()];
  const owner = createInboxSourceComposition({
    reader: fixtureReader((path, value) =>
      path === "checkpoint-reviews"
        ? {
            ...pages()["checkpoint-reviews"],
            records,
            observationRevision: createHash("sha256")
              .update(
                projectCheckpointReviewInventoryJson(
                  { projectId, workspacePath: workspace },
                  records,
                ),
              )
              .digest("hex"),
          }
        : value,
    ),
  });
  const frame = await owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 2,
  });
  expect(frame.cards).toHaveLength(1);
  const notice = frame.cards[0]!;
  expect(notice.notice).toBe(true);
  expect(notice.canSnooze).toBe(false);
  expect(notice.resolved).toBe(false);
  expect(owner.currentCard(notice, 2, 3)).toBeNull();
  const filtered = projectInbox({
    cards: frame.cards,
    dispositions: [],
    coverage: frame.coverage,
    filters: {
      projectId: "other-project",
      sourceKind: "permission",
      bucket: "snoozed",
    },
    now: at,
  });
  expect(filtered.notices).toHaveLength(1);
  expect(filtered.cards).toHaveLength(0);
  await owner.close();
});

test("held-original reads use the canonical shared storage decoder and never replace corrupt data with absence", () => {
  const keys: string[] = [];
  for (const provider of ["codex", "gemini"] as const) {
    expect(
      readInboxHeldOriginal(provider, projectId, "session", (key) => {
        keys.push(key);
        return JSON.stringify({ version: 1, records: [] });
      }),
    ).toBeNull();
    expect(() =>
      readInboxHeldOriginal(
        provider,
        projectId,
        "session",
        () => "broken-json",
      ),
    ).toThrow();
    expect(() =>
      readInboxHeldOriginal(provider, projectId, "session", () =>
        JSON.stringify({ version: 2, records: [] }),
      ),
    ).toThrow();
  }
  expect(keys).toEqual([
    "agent-forge.codex-chat-decision-identities.v1",
    "agent-forge.gemini-chat-decision-identities.v1",
  ]);
});

test("closing an owner revokes before subscribers can admit new reads", async () => {
  let calls = 0;
  const owner = createInboxSourceComposition({
    reader: async () => {
      calls++;
      return reply(null);
    },
  });
  let attempted = false;
  owner.subscribe(() => {
    if (attempted) return;
    attempted = true;
    void owner.refresh({
      home: home(),
      homeCurrent: true,
      sourceGeneration: 4,
    });
  });
  await owner.close();
  expect(calls).toBe(0);
});

test("a cold partial checkpoint frame retains its uncertain original through invalidation", async () => {
  const records = [unknownReview()];
  const owner = createInboxSourceComposition({
    reader: fixtureReader((path, value) =>
      path === "runs"
        ? null
        : path === "checkpoint-reviews"
          ? {
              ...pages()["checkpoint-reviews"],
              records,
              observationRevision: createHash("sha256")
                .update(
                  projectCheckpointReviewInventoryJson(
                    { projectId, workspacePath: workspace },
                    records,
                  ),
                )
                .digest("hex"),
            }
          : value,
    ),
  });
  const frame = await owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 2,
  });
  expect(
    frame.coverage.find((item) => item.sourceKind === "checkpoint-review")
      ?.state,
  ).not.toBe("current");
  expect(frame.cards).toHaveLength(1);
  owner.invalidate();
  expect(owner.snapshot().cards).toHaveLength(1);
  expect(owner.snapshot().cards[0]?.notice).toBe(true);
  expect(owner.snapshot().cards[0]?.sourceState).toBe("unavailable");
  await owner.close();
});

test("the actual SDK result race cannot release Inbox physical ownership before cancellation", async () => {
  for (const mode of ["overflow", "timeout"] as const) {
    for (const owned of [false, true]) {
      const held = deferred<void>();
      const clocks: Array<() => void> = [];
      let receiving = false,
        cancelling = false,
        settled = false;
      const fetcher = async (path: string) => {
        if (!path.includes("/projects/"))
          return Response.json({
            ok: true,
            data: { token: "fixture" },
            error: null,
          });
        receiving = true;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(output) {
              if (mode === "overflow") output.enqueue(new Uint8Array(5));
            },
            async cancel() {
              cancelling = true;
              await held.promise;
            },
          }),
        );
      };
      const options = {
        staticCopy: false,
        sessionKeys: {
          get: () => null,
          set() {
            throw Error("no session write");
          },
        },
        timers: {
          set(run: () => void, ms: number) {
            expect(ms).toBe(45000);
            clocks.push(run);
            return run;
          },
          clear() {},
        },
      };
      const read = owned
        ? createInboxOperatorRead(fetcher, options)
        : createOperatorClient(fetcher, options).read;
      const task = read(
        "/__agent-forge/projects/fixture",
        {},
        { maxBodyBytes: 4 },
      ).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 100 && !receiving; i++) await Promise.resolve();
      if (mode === "timeout") clocks.at(-1)?.();
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(cancelling).toBe(true);
      expect(settled).toBe(!owned);
      held.resolve();
      await task;
      expect(settled).toBe(true);
    }
  }
});

function compositionGateDetail() {
  const scope = { projectId, workspace };
  return projectRunDetailSchema.parse({
    version: 1,
    ...scope,
    checkout: "/fixture/checkout",
    asOf: at,
    coverage: "served-checkout-only",
    problems: [],
    run: {
      slug: "alpha-run",
      feature: "Alpha",
      epic: "alpha-epic",
      mode: "gated",
      health: "attention",
      phases: ["research", "plan", "implement", "ship"].map((id) => ({
        id,
        state: "locked",
        artifact: null,
        artifactMissing: false,
      })),
      status: { kind: "halted", phase: "implement", reason: "Gate failed" },
      completedCount: 0,
      totalPhases: 4,
      gatePassed: false,
      reviewRounds: 0,
      latestVerdict: null,
      updatedAt: at,
      complete: false,
    },
    reviews: [],
    gateHistory: [
      {
        event: "quality-gate",
        timestamp: at,
        passed: false,
        checks: [
          {
            name: "typecheck",
            passed: false,
            skipped: false,
            detail: "Failed",
          },
        ],
        checkout: "/fixture/checkout",
        branch: "feat/alpha",
        link: "linked",
        beadsIssueId: "alpha-task",
        executionRunId: "alpha-run",
        forgeSlug: null,
        evaluatorEvidence: "schema-2",
      },
    ],
    gateHistoryDays: 30,
    earlierGateLimit: 10,
  });
}

test("a current unshipped gate keeps its own scoped proof when another project is unavailable", async () => {
  const context = home();
  const otherId = "project-12345678-1234-4234-8234-123456789abc";
  context.catalog.projects.push({
    ...context.catalog.projects[0]!,
    id: otherId,
  });
  const unavailable = false;
  const owner = createInboxSourceComposition({
    reader: async (url, init, limits) => {
      if (url.includes(otherId)) return reply(null);
      if (url.endsWith("/runs/alpha-run"))
        return reply(compositionGateDetail());
      if (url.endsWith("/runs"))
        return reply(
          unavailable
            ? null
            : {
                ...pages().runs,
                runs: [compositionGateDetail().run],
              },
        );
      return fixtureReader()(url, init, limits);
    },
  });
  const frame = await owner.refresh({
    home: context,
    homeCurrent: true,
    sourceGeneration: 7,
  });
  const gate = frame.cards.find((item) => item.sourceKind === "failed-gate");
  if (!gate) throw Error("Missing current fixture gate");
  expect(gate.canSnooze).toBe(true);
  expect(gate.checkHref).toContain("selectionId=alpha-run");
  expect(gate.resolved).toBe(false);
  expect(frame.complete).toBe(false);
  expect(owner.currentCard(gate, 7, 3)).toEqual(gate);
  expect(owner.currentCard(gate, 8, 3)).toBeNull();
  await owner.close();
});

function usageFixture() {
  const now = Date.parse(at),
    resetAt = new Date(now + 3600000).toISOString();
  const document = {
    projectId,
    workspace,
    revision: 1,
    rules: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        provider: "claude" as const,
        enabled: true,
        selector: {
          kind: "subscription-window" as const,
          unit: "percent" as const,
          source: "provider-cli" as const,
          label: "five-hour window",
          basis: "used" as const,
        },
        comparison: "at-least" as const,
        threshold: 80,
      },
    ],
  };
  const page: ProviderReadinessPage = {
    workspace,
    asOf: at,
    problems: [],
    providers: READINESS_PROVIDERS.map((provider) =>
      buildProviderReadiness(
        {
          provider,
          name: provider,
          installation: {
            found: true,
            versionOk: true,
            version: "1.0.0",
            path: null,
            checkedAt: at,
            compatibility: "supported",
            reason: null,
          },
          authentication: {
            mode: "signed-in",
            source: "provider-cli",
            observedAt: at,
            reason: null,
          },
          adapter: { supported: true, reason: null },
          signIn: { command: null, reason: null, nativeAvailable: false },
          smiths: [],
          reports:
            provider === "claude"
              ? [
                  {
                    id: "positional-0",
                    label: "five-hour window",
                    kind: "subscription-window",
                    unit: "percent",
                    basis: "used",
                    value: 85,
                    total: 100,
                    observedAt: at,
                    resetAt,
                    durationMs: null,
                    source: "provider-cli",
                    reason: null,
                  },
                ]
              : [],
        },
        now,
      ),
    ),
    localUsage: {
      since: at,
      through: at,
      source: "local-ledger",
      reason: "Local counts are separate from provider reports.",
      projects: [],
    },
  };
  return {
    now,
    document,
    page,
    capture: { data: page, loading: false, failed: false, stale: false, now },
  };
}
test("actual configured reported crossing composes into current Inbox source and Settings navigation", async () => {
  const fixture = usageFixture();
  const coverage = {
    started: true,
    settled: true,
    complete: true,
    fresh: true,
    error: null,
  };
  const control = await projectInboxUsageSource({
    scope: { projectId, workspace },
    sourceGeneration: 7,
    catalogRevision: 3,
    now: fixture.now,
    configuration: { raw: fixture.document, lastVerified: null, coverage },
    providers: { raw: fixture.page, lastVerified: null, coverage },
  });
  expect(control.facts).toHaveLength(1);
  const owner = createInboxSourceComposition({
    reader: async (url, init, limits) =>
      url.endsWith("/settings/usage-thresholds")
        ? reply(fixture.document)
        : fixtureReader()(url, init, limits),
    usage: () => fixture.capture,
    now: () => fixture.now,
  });
  const view = await owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 7,
  });
  const card = view.cards.find((item) => item.sourceKind === "usage-threshold");
  expect(card).toBeDefined();
  expect(card?.checkHref).toContain("project-settings");
  expect(card?.detail).toContain("85 percent used");
  expect(card?.detail).toContain("continuity");
  expect(card?.canSnooze).toBe(true);
  expect(card?.resolved).toBe(false);
  expect(view.complete).toBe(true);
  await owner.close();
});

test("usage acknowledgment rejects clock rollback, expiry and a replaced provider capture", async () => {
  const fixture = usageFixture();
  let now = fixture.now,
    capture = fixture.capture;
  const owner = createInboxSourceComposition({
    reader: async (url, init, limits) =>
      url.endsWith("/settings/usage-thresholds")
        ? reply(fixture.document)
        : fixtureReader()(url, init, limits),
    usage: () => capture,
    now: () => now,
  });
  await owner.refresh({ home: home(), homeCurrent: true, sourceGeneration: 7 });
  const card = owner
    .snapshot()
    .cards.find((item) => item.sourceKind === "usage-threshold");
  if (!card) throw Error("Missing valid crossing");
  expect(owner.currentCard(card, 7, 3)).toEqual(card);
  now = fixture.now - 1;
  expect(owner.currentCard(card, 7, 3)).toBeNull();
  now = fixture.now + 30001;
  expect(owner.currentCard(card, 7, 3)).toBeNull();
  expect(owner.snapshot().complete).toBe(false);
  now = fixture.now;
  capture = { ...capture, loading: true };
  expect(owner.currentCard(card, 7, 3)).toBeNull();
  expect(
    owner.snapshot().cards.find((item) => item.sourceKind === "usage-threshold")
      ?.canSnooze,
  ).toBe(false);
  await owner.close();
});

const usageOtherId = "project-12345678-1234-4234-8234-123456789abc";
function usageOtherHome() {
  const result = home();
  result.catalog.projects[0]!.id = usageOtherId;
  result.catalog.projects[0]!.slug = "beta";
  result.summaries[0]!.projectId = usageOtherId;
  return result;
}
function usageScopeReader(config: (id: string) => unknown): OperatorRead {
  return async (url, init, limits) => {
    const id = url.includes(usageOtherId) ? usageOtherId : projectId;
    if (url.endsWith("/settings/usage-thresholds")) return reply(config(id));
    const response = await fixtureReader()(
      url.replaceAll(usageOtherId, projectId),
      init,
      limits,
    );
    try {
      return Response.json(
        JSON.parse(
          JSON.stringify(await response.json()).replaceAll(projectId, id),
        ),
      );
    } catch {
      throw Error("Invalid scoped fixture response");
    }
  };
}
test("an expired removed empty-rules witness cannot make another project's current crossing stale", async () => {
  const fixture = usageFixture();
  let now = fixture.now;
  const owner = createInboxSourceComposition({
    reader: usageScopeReader((id) => ({
      ...fixture.document,
      projectId: id,
      rules: id === projectId ? [] : fixture.document.rules,
    })),
    usage: () => fixture.capture,
    now: () => now,
  });
  await owner.refresh({ home: home(), homeCurrent: true, sourceGeneration: 1 });
  now += 31000;
  fixture.capture.data = { ...fixture.page, asOf: new Date(now).toISOString() };
  await owner.refresh({
    home: usageOtherHome(),
    homeCurrent: true,
    sourceGeneration: 2,
  });
  const current = owner
    .snapshot()
    .cards.find(
      (item) =>
        item.sourceKind === "usage-threshold" &&
        item.projectId === usageOtherId,
    );
  expect(current?.canSnooze).toBe(true);
  if (!current) throw Error("Missing current Beta crossing");
  expect(owner.currentCard(current, 2, 3)).toEqual(current);
  await owner.close();
});
test("a frame returned after a later project read agrees with scoped expiry in the published snapshot", async () => {
  const fixture = usageFixture();
  let now = fixture.now;
  fixture.page.providers[0]!.usage[0]!.resetAt = new Date(
    now + 1000,
  ).toISOString();
  fixture.page.providers[0]!.usage.push({
    ...fixture.page.providers[0]!.usage[0]!,
    id: "positional-1",
    label: "long window",
    resetAt: new Date(now + 3600000).toISOString(),
  });
  const both = home();
  both.catalog.projects.push(usageOtherHome().catalog.projects[0]!);
  both.summaries.push(usageOtherHome().summaries[0]!);
  const reader = usageScopeReader((id) => ({
    ...fixture.document,
    projectId: id,
    rules:
      id === projectId
        ? fixture.document.rules
        : [
            {
              ...fixture.document.rules[0]!,
              selector: {
                ...fixture.document.rules[0]!.selector,
                label: "long window",
              },
            },
          ],
  }));
  const owner = createInboxSourceComposition({
    reader: async (url, init, limits) => {
      if (
        url.includes(usageOtherId) &&
        url.endsWith("/settings/usage-thresholds")
      )
        now += 1001;
      return reader(url, init, limits);
    },
    usage: () => fixture.capture,
    now: () => now,
  });
  const frame = await owner.refresh({
    home: both,
    homeCurrent: true,
    sourceGeneration: 3,
  });
  const a = frame.cards.find(
      (item) =>
        item.sourceKind === "usage-threshold" && item.projectId === projectId,
    ),
    b = frame.cards.find(
      (item) =>
        item.sourceKind === "usage-threshold" &&
        item.projectId === usageOtherId,
    );
  expect(a?.canSnooze).toBe(false);
  expect(b?.canSnooze).toBe(true);
  expect(frame.complete).toBe(false);
  expect(owner.snapshot().cards).toEqual(frame.cards);
  if (!b) throw Error("Missing independently current Beta");
  expect(owner.currentCard(b, 3, 3)).toEqual(b);
  await owner.close();
});

test("usage retains stale crossings on unknown reads and distinguishes explicit empty rules from unavailable reports", async () => {
  const fixture = usageFixture();
  let configuration: unknown = fixture.document,
    capture = fixture.capture;
  const owner = createInboxSourceComposition({
    reader: async (url, init, limits) =>
      url.endsWith("/settings/usage-thresholds")
        ? reply(configuration)
        : fixtureReader()(url, init, limits),
    usage: () => capture,
    now: () => fixture.now,
  });
  await owner.refresh({ home: home(), homeCurrent: true, sourceGeneration: 1 });
  const original = owner
    .snapshot()
    .cards.find((item) => item.sourceKind === "usage-threshold");
  if (!original) throw Error("Missing crossing");
  configuration = null;
  const unknown = await owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 2,
  });
  expect(
    unknown.cards.find((item) => item.sourceKind === "usage-threshold"),
  ).toMatchObject({
    sourceRevision: original.sourceRevision,
    sourceState: "unavailable",
    resolved: false,
    canSnooze: false,
  });
  expect(unknown.complete).toBe(false);
  expect(owner.currentCard(original, 2, 3)).toBeNull();
  configuration = { ...fixture.document, rules: [] };
  const empty = await owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 3,
  });
  expect(empty.cards).toEqual([]);
  expect(
    empty.coverage.find((item) => item.sourceKind === "usage-threshold")?.state,
  ).toBe("current");
  capture = { ...capture, data: { ...fixture.page, workspace: "/foreign" } };
  const foreign = await owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 4,
  });
  expect(foreign.complete).toBe(false);
  expect(
    foreign.coverage.find((item) => item.sourceKind === "usage-threshold")
      ?.state,
  ).toBe("unavailable");
  capture = { ...capture, data: fixture.page };
  configuration = {
    ...fixture.document,
    rules: [{ ...fixture.document.rules[0]!, threshold: 99 }],
  };
  const below = await owner.refresh({
    home: home(),
    homeCurrent: true,
    sourceGeneration: 5,
  });
  expect(below.cards).toEqual([]);
  expect(owner.currentCard(original, 5, 3)).toBeNull();
  await owner.close();
});
test("usage reads share four physical SDK body owners until actual cancellation settlement", async () => {
  const fixture = usageFixture(),
    cancellation = deferred<void>(),
    four = deferred<void>(),
    cancellingFour = deferred<void>();
  let physical = 0,
    maximum = 0,
    admitted = 0,
    cancelling = 0,
    closed = false;
  const reader = createInboxOperatorRead(
    async (url, init) => {
      if (url === TOKEN_ROUTE) return reply({ token: "fixture-token" });
      if (url.endsWith("/settings/usage-thresholds")) {
        admitted++;
        physical++;
        maximum = Math.max(maximum, physical);
        if (admitted === 4) four.resolve();
        return new Response(
          new ReadableStream<Uint8Array>({
            async cancel() {
              cancelling++;
              if (cancelling === 4) cancellingFour.resolve();
              await cancellation.promise;
              physical--;
            },
          }),
        );
      }
      return fixtureReader()(url, init);
    },
    {
      staticCopy: false,
      ready: async () => {},
      sessionKeys: { get: () => null, set() {} },
    },
  );
  const owners = Array.from({ length: 5 }, () =>
    createInboxSourceComposition({
      reader,
      usage: () => fixture.capture,
      now: () => fixture.now,
    }),
  );
  const refreshes = owners.map((owner) =>
    owner.refresh({ home: home(), homeCurrent: true, sourceGeneration: 1 }),
  );
  await four.promise;
  expect(physical).toBe(4);
  expect(admitted).toBe(4);
  owners.forEach((owner) => {
    owner.invalidate();
  });
  const closing = Promise.all(owners.map((owner) => owner.close())).then(() => {
    closed = true;
  });
  await cancellingFour.promise;
  expect(physical).toBe(4);
  expect(closed).toBe(false);
  expect(admitted).toBe(4);
  cancellation.resolve();
  await Promise.all(refreshes);
  await closing;
  expect(physical).toBe(0);
  expect(maximum).toBe(4);
  expect(admitted).toBe(4);
});

test("a verified empty current catalog needs no configured usage policy reads", async () => {
  const empty = home();
  empty.catalog.projects = [];
  empty.summaries = [];
  let reads = 0;
  const owner = createInboxSourceComposition({
    reader: async () => {
      reads++;
      return reply(null);
    },
  });
  const frame = await owner.refresh({
    home: empty,
    homeCurrent: true,
    sourceGeneration: 1,
  });
  expect(reads).toBe(0);
  expect(frame.cards).toEqual([]);
  expect(frame.complete).toBe(true);
  expect(
    frame.coverage.find((item) => item.sourceKind === "usage-threshold")
      ?.reason,
  ).toContain("No catalog projects");
  await owner.close();
});
