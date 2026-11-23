import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  KeeperBriefOriginBindingWithSchedule,
  KeeperBriefSelection,
} from "../../types/keeper-brief";
import { createConversationService } from "../conversations/service";
import { createConversationStore } from "../conversations/store";
import type { ConversationTransport } from "../conversations/transport";
import { MAX_KEEPER_BRIEF_INTENT_HISTORY } from "../keeper/brief-protocol";
import { buildKeeperBriefSnapshot } from "../keeper/brief-snapshot";
import { keeperReadiness } from "../keeper/readiness";
import type { KeeperRuntime } from "../keeper/recovery-runtime";
import { resolveCheckout } from "../ledger/workspace";
import { createProjectStore, projectCatalogPath } from "../projects/store";
import type { ProjectSources } from "../projects/summary";
import { projectFixture } from "../projects/testing";
import {
  createKeeperBriefScheduler,
  type KeeperScheduleClock,
} from "./keeper-brief-scheduler";
import { writeOwnerOnly } from "./token";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const directory = () => {
  const value = mkdtempSync(join(tmpdir(), "keeper-schedule-"));
  homes.push(value);
  return value;
};
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlledClock() {
  let wall = Date.parse("2026-11-08T09:31:00.000Z"),
    elapsed = 0;
  const timers = new Set<{ at: number; run(): void }>(),
    retained: Array<() => void> = [];
  const clock: KeeperScheduleClock = {
    now: () => wall,
    setTimer(run, delay) {
      const row = { at: elapsed + delay, run };
      timers.add(row);
      retained.push(run);
      return () => {
        timers.delete(row);
      };
    },
  };
  return {
    clock,
    timers,
    wall: (value: string) => {
      wall = Date.parse(value);
    },
    advance: (ms = 60_000) => {
      wall += ms;
      elapsed += ms;
      for (const row of [...timers])
        if (row.at <= elapsed) {
          timers.delete(row);
          row.run();
        }
    },
    fireRetained: () => {
      for (const run of retained) run();
    },
  };
}
async function fixture(
  count = 1,
  separate = false,
  prepare?: (id: string) => Promise<void>,
) {
  const home = directory(),
    root = directory();
  mkdirSync(join(root, ".git"));
  const roots = [root];
  for (let index = 1; index < count; index++) {
    const next = separate ? directory() : root;
    if (separate) mkdirSync(join(next, ".git"));
    roots.push(next);
  }
  const workspaces = roots.map((value) => resolveCheckout(value).workspace);
  const projects = workspaces.map((value, index) => ({
    ...projectFixture(value),
    id: "project-" + randomUUID(),
    slug: "schedule-" + index,
  }));
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify({ version: 1, revision: 1, projects }),
  );
  const catalog = createProjectStore(
    home,
    () => new Date("2026-11-08T09:00:00.000Z"),
  );
  for (const project of projects)
    await catalog.updateKeeperSchedule(project.id, catalog.read().revision, {
      kind: "daily",
      atUtc: "09:30",
    });
  const clock = controlledClock(),
    store = createConversationStore(home);
  const calls: { loads: string[]; probes: number; runs: number } = {
    loads: [],
    probes: 0,
    runs: 0,
  };
  const smith: KeeperBriefSelection = {
    name: "fixture",
    provider: "claude",
    model: "fixture",
    effort: "",
    enabled: true,
    tags: [],
  };
  const source = (workspace: string): ProjectSources => ({
    workspace,
    asOf: new Date(clock.clock.now()).toISOString(),
    issues: [],
    queue: [],
    sessions: [],
    sessionsComplete: true,
    problems: [],
    runs: [],
  });
  const owners: Array<ReturnType<typeof createKeeperBriefScheduler>> = [],
    services: Array<ReturnType<typeof createConversationService>> = [];
  const owner = (index = 0) => {
    const workspace = workspaces[index],
      servedRoot = roots[index];
    if (!workspace || !servedRoot) throw Error("Missing served root fixture");
    const transport: ConversationTransport = {
      provider: "claude",
      async run() {
        calls.runs++;
        return { phase: "failed", reason: "No automatic model run expected" };
      },
    };
    const runtime: KeeperRuntime = {
      catalog: () => ({ defaultSmith: smith.name, smiths: [smith] }),
      transport: () => transport,
      async readiness() {
        calls.probes++;
        return keeperReadiness({ checked: true, adapter: true });
      },
    };
    const service = createConversationService({
      home,
      root: servedRoot,
      transport,
      keeperRuntime: runtime,
      async prepareBrief(id) {
        calls.loads.push(id);
        const current = catalog.read(),
          project = current.projects.find((row) => row.id === id);
        if (!project) throw Error("Missing source project");
        const facts = source(workspace);
        await prepare?.(id);
        return buildKeeperBriefSnapshot(project, current.revision, facts, {
          events: [],
          more: false,
        });
      },
    });
    services.push(service);
    const value = createKeeperBriefScheduler({
      home,
      workspace,
      clock: clock.clock,
      reserveScheduledKeeperBrief: service.reserveScheduledKeeperBrief,
    });
    owners.push(value);
    return value;
  };
  const input = (index = 0) => {
    const project = projects[index],
      workspace = workspaces[index];
    if (!project || !workspace) throw Error("Missing retained source fixture");
    const current = catalog.read();
    const origin: KeeperBriefOriginBindingWithSchedule = {
      kind: "overview",
      projectId: project.id,
      workspace,
      catalogRevision: current.revision,
    };
    return {
      expectedRevision: store.read(project.id).revision,
      origin,
      selection: smith,
      text: "Retained original source",
      about: [],
      snapshot: buildKeeperBriefSnapshot(
        project,
        current.revision,
        source(workspace),
        { events: [], more: false },
      ),
    };
  };
  return {
    home,
    roots,
    projects,
    workspaces,
    catalog,
    store,
    calls,
    clock,
    owner,
    input,
    close: async () => {
      for (const value of owners) value.deactivate();
      await Promise.all(owners.map((value) => value.close()));
      await Promise.all(services.map((value) => value.close()));
    },
  };
}

test("Keeper schedule producer is inert, fair, exact and terminal without automatic provider work", async () => {
  const f = await fixture(2),
    owner = f.owner(),
    a = f.projects[0],
    b = f.projects[1];
  if (!a || !b) throw Error("Missing fair projects");
  try {
    expect(owner.status(a.id).owner).toBe("idle");
    expect(f.clock.timers.size).toBe(0);
    expect(f.calls.loads).toEqual([]);
    owner.start();
    owner.start();
    await owner.settled();
    const first = owner.status(a.id);
    expect(first.phase).toBe("ready-for-review");
    expect(first.ticket?.origin.kind).toBe("scheduled");
    expect(f.calls.loads).toEqual([a.id]);
    f.clock.advance();
    await owner.settled();
    expect(owner.status(b.id).phase).toBe("ready-for-review");
    expect(f.calls.loads).toEqual([a.id, b.id]);
    f.clock.advance();
    await owner.settled();
    expect(f.calls.loads).toEqual([a.id, b.id]);
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    await closing;
    owner.start();
    f.clock.fireRetained();
    await owner.settled();
    expect(f.calls.loads).toEqual([a.id, b.id]);
    const restarted = f.owner();
    restarted.start();
    await restarted.settled();
    expect(restarted.status(a.id).ticket).toEqual(first.ticket);
    expect(f.calls).toMatchObject({ probes: 0, runs: 0 });
    expect(f.calls.loads).toEqual([a.id, b.id]);
  } finally {
    await f.close();
  }
});

test("Keeper schedule attempted high-watermarks survive clock rollback without a failed-slot set", async () => {
  const f = await fixture(1, false, async () => {
      throw Error("Bounded source unavailable");
    }),
    owner = f.owner(),
    project = f.projects[0];
  if (!project) throw Error("Missing failed source project");
  try {
    owner.start();
    await owner.settled();
    expect(owner.status(project.id).phase).toBe("unavailable");
    f.clock.advance();
    await owner.settled();
    expect(f.calls.loads).toHaveLength(1);
    f.clock.wall("2026-11-07T09:31:00.000Z");
    f.clock.advance();
    await owner.settled();
    expect(f.calls.loads).toHaveLength(1);
    expect(owner.status(project.id).attempt?.startedAt).toBe(
      "2026-11-08T09:31:00.000Z",
    );
    f.clock.wall("2026-11-10T09:31:00.000Z");
    f.clock.advance();
    await owner.settled();
    expect(f.calls.loads).toHaveLength(2);
    f.clock.wall("2026-11-08T09:31:00.000Z");
    f.clock.advance();
    await owner.settled();
    expect(f.calls.loads).toHaveLength(2);
    expect(owner.status(project.id).nextDueAt).toBe("2026-11-11T09:30:00.000Z");
    await owner.close();
    const restarted = f.owner();
    expect(restarted.status(project.id).attempt).toBeNull();
    restarted.start();
    await restarted.settled();
    expect(f.calls.loads).toHaveLength(3);
    expect(f.store.discoverKeeperBrief(project.id)).toBeNull();
    expect(f.calls).toMatchObject({ probes: 0, runs: 0 });
  } finally {
    await f.close();
  }
});

test("Keeper schedule policy and pending work pause before sources and preserve foreign originals", async () => {
  for (const mode of ["off", "archive", "visibility", "manual", "foreign"]) {
    const f = await fixture(2, true),
      project = f.projects[0],
      owner = f.owner();
    if (!project) throw Error("Missing policy project");
    try {
      if (mode === "off")
        await f.catalog.updateKeeperSchedule(
          project.id,
          f.catalog.read().revision,
          { kind: "off" },
        );
      if (mode === "archive")
        await f.catalog.preferences(project.id, f.catalog.read().revision, {
          archived: true,
        });
      if (mode === "visibility")
        await f.catalog.updateKeeperVisibility(
          project.id,
          f.catalog.read().revision,
          "conversation-only",
        );
      if (mode === "manual" || mode === "foreign") {
        const input = f.input(),
          foreign = f.workspaces[1];
        if (!foreign) throw Error("Missing foreign workspace");
        if (mode === "foreign") {
          input.origin.workspace = foreign;
          input.snapshot.workspace = foreign;
        }
        await f.store.reserveKeeperBrief(project.id, input);
      }
      const original = f.store.discoverKeeperBrief(project.id);
      owner.start();
      await owner.settled();
      const status = owner.status(project.id);
      expect(status.phase).toBe(
        mode === "off"
          ? "off"
          : mode === "manual" || mode === "foreign"
            ? "blocked-existing-work"
            : "policy-paused",
      );
      if (mode === "foreign") expect(status.ticket).toBeNull();
      expect(f.calls.loads).toEqual([]);
      expect(f.store.discoverKeeperBrief(project.id)).toEqual(original);
      expect(f.calls).toMatchObject({ probes: 0, runs: 0 });
    } finally {
      await f.close();
    }
  }
});

test("Keeper schedule home lock excludes different-root preparations and canceled queued owners", async () => {
  for (const cancelQueued of [false, true]) {
    const entered = gate(),
      release = gate();
    let firstId = "";
    const f = await fixture(2, true, async (id) => {
      if (id === firstId) {
        entered.release();
        await release.wait;
      }
    });
    const a = f.projects[0],
      b = f.projects[1];
    if (!a || !b) throw Error("Missing resource projects");
    firstId = a.id;
    const first = f.owner(),
      second = f.owner(1);
    try {
      first.start();
      await entered.wait;
      second.start();
      if (cancelQueued) second.deactivate();
      await second.settled();
      expect(f.calls.loads).toEqual([a.id]);
      expect(second.status(b.id).attempt).toBeNull();
      release.release();
      await first.settled();
      f.clock.advance();
      await Promise.all([first.settled(), second.settled()]);
      expect(f.calls.loads).toEqual(cancelQueued ? [a.id] : [a.id, b.id]);
      expect(f.calls).toMatchObject({ probes: 0, runs: 0 });
    } finally {
      release.release();
      await f.close();
    }
  }
});

test("Keeper schedule close joins held source and forbids late original publication", async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture(1, false, async () => {
      entered.release();
      await release.wait;
    }),
    owner = f.owner(),
    project = f.projects[0];
  if (!project) throw Error("Missing held source project");
  try {
    owner.start();
    await entered.wait;
    expect(owner.status(project.id).phase).toBe("preparing");
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    expect(owner.status(project.id).owner).toBe("closed");
    release.release();
    await closing;
    expect(f.store.discoverKeeperBrief(project.id)).toBeNull();
    f.clock.fireRetained();
    owner.start();
    await owner.settled();
    expect(f.calls.loads).toHaveLength(1);
    expect(f.calls).toMatchObject({ probes: 0, runs: 0 });
  } finally {
    release.release();
    await f.close();
  }
});

test("Keeper schedule capacity pauses at existing immutable-history bounds without another source", async () => {
  const f = await fixture(),
    owner = f.owner(),
    project = f.projects[0];
  if (!project) throw Error("Missing capacity project");
  try {
    for (let index = 0; index <= MAX_KEEPER_BRIEF_INTENT_HISTORY; index++) {
      const saved = await f.store.reserveKeeperBrief(project.id, f.input());
      if (index < MAX_KEEPER_BRIEF_INTENT_HISTORY)
        await f.store.retireKeeperBrief(project.id, {
          requestId: saved.requestId,
          intentHash: saved.intentHash,
        });
      else {
        const token = randomUUID();
        await f.store.acceptKeeperBrief(project.id, {
          requestId: saved.requestId,
          expectedRevision: saved.expectedRevision,
          intentHash: saved.intentHash,
        });
        await f.store.start(project.id, saved.requestId, token);
        await f.store.finish(
          project.id,
          saved.requestId,
          token,
          "failed",
          "Retained fixture",
        );
      }
    }
    const before = f.store.read(project.id);
    expect(owner.status(project.id).phase).toBe("capacity-paused");
    owner.start();
    await owner.settled();
    expect(f.calls.loads).toEqual([]);
    expect(f.store.read(project.id)).toEqual(before);
    expect(f.calls).toMatchObject({ probes: 0, runs: 0 });
  } finally {
    await f.close();
  }
});

test("Keeper schedule missing Smith is visible before source and recovers without consuming the slot", async () => {
  const f = await fixture(),
    owner = f.owner(),
    project = f.projects[0];
  if (!project) throw Error("Missing selection recovery project");
  try {
    await f.catalog.updateKeeper(
      project.id,
      f.catalog.read().revision,
      { keeperSmith: "missing" },
      () => {},
    );
    owner.start();
    await owner.settled();
    const blocked = owner.status(project.id);
    expect(blocked.phase).toBe("unavailable");
    expect(blocked.reason).toBeTruthy();
    expect(blocked.attempt).toBeNull();
    expect(f.calls).toEqual({ loads: [], probes: 0, runs: 0 });
    expect(f.store.discoverKeeperBrief(project.id)).toBeNull();
    await f.catalog.updateKeeper(
      project.id,
      f.catalog.read().revision,
      { keeperSmith: "fixture" },
      () => {},
    );
    f.clock.advance();
    await owner.settled();
    const recovered = owner.status(project.id);
    expect(recovered.phase).toBe("ready-for-review");
    expect(recovered.attempt).toMatchObject({
      dueAt: "2026-11-08T09:30:00.000Z",
      problem: null,
    });
    expect(f.calls).toEqual({ loads: [project.id], probes: 0, runs: 0 });
  } finally {
    await f.close();
  }
});

test("Keeper schedule later preflight failure preserves the prior actual attempt and recovers the new slot", async () => {
  const f = await fixture(),
    owner = f.owner(),
    project = f.projects[0];
  if (!project) throw Error("Missing prior-attempt project");
  try {
    owner.start();
    await owner.settled();
    const first = owner.status(project.id),
      ticket = first.ticket;
    if (!ticket || !first.attempt)
      throw Error("Missing first real source attempt");
    await f.store.retireKeeperBrief(project.id, {
      requestId: ticket.requestId,
      intentHash: ticket.intentHash,
    });
    await f.catalog.updateKeeper(
      project.id,
      f.catalog.read().revision,
      { keeperSmith: "missing" },
      () => {},
    );
    f.clock.wall("2026-11-09T09:31:00.000Z");
    f.clock.advance();
    await owner.settled();
    const blocked = owner.status(project.id);
    expect(blocked.phase).toBe("unavailable");
    expect(blocked.reason).toBeTruthy();
    expect(blocked.attempt).toEqual(first.attempt);
    expect(f.calls).toEqual({ loads: [project.id], probes: 0, runs: 0 });
    expect(
      f.store.readKeeperBriefIntent(project.id, ticket.requestId),
    ).toMatchObject({
      intentHash: ticket.intentHash,
      state: "retired",
    });
    await f.catalog.updateKeeper(
      project.id,
      f.catalog.read().revision,
      { keeperSmith: "fixture" },
      () => {},
    );
    f.clock.advance();
    await owner.settled();
    const recovered = owner.status(project.id);
    expect(recovered.phase).toBe("ready-for-review");
    expect(recovered.attempt).toMatchObject({
      dueAt: "2026-11-09T09:30:00.000Z",
      problem: null,
    });
    expect(recovered.ticket?.requestId).not.toBe(ticket.requestId);
    expect(f.calls).toEqual({
      loads: [project.id, project.id],
      probes: 0,
      runs: 0,
    });
  } finally {
    await f.close();
  }
});
