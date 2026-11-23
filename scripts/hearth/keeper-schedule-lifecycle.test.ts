import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createConversationStore } from "../conversations/store";
import { fakeConversationTransport } from "../conversations/testing";
import { keeperReadiness } from "../keeper/readiness";
import { completeFixtureReader } from "../projects/complete-tracker-test-model";
import { createProjectStore, projectCatalogPath } from "../projects/store";
import { projectCatalogFixture } from "../projects/testing";
import { lockPath, tokenPath } from "./home";
import type { KeeperScheduleClock } from "./keeper-brief-scheduler";
import { readLock } from "./lock";
import { fakeSessionRuntime } from "./routes/session-fixture";
import { createHearth, type StartedHearth } from "./server";
import { startTestHearth } from "./testing";
import { writeOwnerOnly } from "./token";

test("Keeper schedule retained old close preserves a healthy same-root successor authority", async () => {
  const h = await startTestHearth();
  let successor: StartedHearth | undefined;
  try {
    await h.hearth.close();
    const next = await createHearth({
      root: h.root,
      home: h.home,
      environment: {},
      councilRunCommand: h.commands.run,
      api: {
        configHome: h.configHome,
        runBd: (args, options) => h.bd.run(args, options),
        completeTracker: completeFixtureReader((args, options) =>
          h.bd.run(args, options),
        ),
        conversationTransport: fakeConversationTransport(),
        sessionRuntime: fakeSessionRuntime().runtime,
      },
    });
    if (next.kind !== "started")
      throw Error("Expected a fresh successor after the first owner closed");
    successor = next;
    const health = await fetch(successor.url + "/__agent-forge/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      data: { pid: process.pid, root: h.root },
      error: null,
    });
    const rootFile = lockPath(h.home, h.root),
      tokenFile = tokenPath(h.home, h.root);
    expect(readLock(rootFile)).toMatchObject({
      pid: process.pid,
      root: h.root,
      port: successor.port,
    });
    const before = {
      lock: readFileSync(rootFile, "utf8"),
      token: readFileSync(tokenFile, "utf8"),
    };
    expect(before.token.trim()).toBe(successor.token);
    expect(successor.token).not.toBe(h.hearth.token);
    await h.hearth.close();
    const after = {
      lock: existsSync(rootFile) ? readFileSync(rootFile, "utf8") : null,
      token: existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") : null,
    };
    expect(after).toEqual(before);
  } finally {
    try {
      await successor?.close();
    } finally {
      await h.close();
    }
  }
});

function barrier() {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function ownedFixture() {
  const h = await startTestHearth();
  await h.hearth.close();
  const catalog = createProjectStore(
    h.home,
    () => new Date("2026-11-08T09:00:00.000Z"),
  );
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const project = catalog.read().projects[0];
  if (!project) throw Error("Missing lifecycle project");
  await catalog.updateKeeperSchedule(project.id, catalog.read().revision, {
    kind: "daily",
    atUtc: "09:30",
  });
  const timers = new Set<() => void>(),
    retained: Array<() => void> = [];
  const cancelledWithAuthority: boolean[] = [];
  const idleWaiters: Array<() => void> = [];
  const clock: KeeperScheduleClock = {
    now: () => Date.parse("2026-11-08T09:31:00.000Z"),
    setTimer(run) {
      timers.add(run);
      retained.push(run);
      for (const done of idleWaiters.splice(0)) done();
      return () => {
        cancelledWithAuthority.push(
          existsSync(lockPath(h.home, h.root)) &&
            existsSync(tokenPath(h.home, h.root)),
        );
        timers.delete(run);
      };
    },
  };
  let loads = 0,
    probes = 0,
    runs = 0;
  let source: (() => Promise<void>) | undefined;
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
  const selection = {
    name: "fixture",
    provider: "claude" as const,
    model: "fixture",
    effort: "",
    enabled: true,
    tags: [],
  };
  const started: StartedHearth[] = [];
  const launch = async (
    options: { onListening?: (port: number) => Promise<void> } = {},
  ) => {
    const value = await createHearth({
      root: h.root,
      home: h.home,
      environment: {},
      councilRunCommand: h.commands.run,
      ...options,
      api: {
        configHome: h.configHome,
        ledgerPath: h.ledger,
        keeperScheduleClock: clock,
        runBd: (args, settings) => h.bd.run(args, settings),
        completeTracker: completeFixtureReader(
          (args, settings) => h.bd.run(args, settings),
          async () => {
            loads++;
            await source?.();
          },
        ),
        conversationTransport: transport,
        sessionRuntime: fakeSessionRuntime().runtime,
        keeperRuntime: {
          catalog: () => ({
            defaultSmith: selection.name,
            smiths: [selection],
          }),
          transport: () => transport,
          async readiness() {
            probes++;
            return keeperReadiness({ checked: true, adapter: true });
          },
        },
      },
    });
    if (value.kind === "started") started.push(value);
    return value;
  };
  return {
    h,
    project,
    timers,
    cancelledWithAuthority,
    launch,
    holdSource: (run: () => Promise<void>) => {
      source = run;
    },
    calls: () => ({ loads, probes, runs }),
    idle: () =>
      timers.size
        ? Promise.resolve()
        : new Promise<void>((done) => idleWaiters.push(done)),
    fireRetained: () => {
      for (const run of retained) run();
    },
    close: async () => {
      try {
        for (const value of [...started].reverse()) await value.close();
      } finally {
        await h.close();
      }
    },
  };
}

test("Keeper schedule starts only after claim, losing starters stay inert and close cancels before authority release", async () => {
  const f = await ownedFixture(),
    entered = barrier(),
    release = barrier();
  const starting = f.launch({
    onListening: async () => {
      entered.release();
      await release.wait;
    },
  });
  try {
    await entered.wait;
    expect(f.timers.size).toBe(0);
    expect(f.calls()).toEqual({ loads: 0, probes: 0, runs: 0 });
    expect(readLock(lockPath(f.h.home, f.h.root))).toBeNull();
    expect(existsSync(tokenPath(f.h.home, f.h.root))).toBe(false);
    release.release();
    const winner = await starting;
    if (winner.kind !== "started")
      throw Error("Expected acquired lifecycle owner");
    await f.idle();
    expect(f.timers.size).toBe(1);
    expect(f.calls()).toEqual({ loads: 1, probes: 0, runs: 0 });
    const before = {
      lock: readFileSync(lockPath(f.h.home, f.h.root), "utf8"),
      token: readFileSync(tokenPath(f.h.home, f.h.root), "utf8"),
    };
    const loser = await f.launch();
    expect(loser.kind).toBe("reused");
    expect(f.timers.size).toBe(1);
    expect(f.calls()).toEqual({ loads: 1, probes: 0, runs: 0 });
    expect({
      lock: readFileSync(lockPath(f.h.home, f.h.root), "utf8"),
      token: readFileSync(tokenPath(f.h.home, f.h.root), "utf8"),
    }).toEqual(before);
    const closing = winner.close();
    expect(winner.close()).toBe(closing);
    expect(f.cancelledWithAuthority).toEqual([true]);
    expect(readLock(lockPath(f.h.home, f.h.root))).toBeNull();
    expect(existsSync(tokenPath(f.h.home, f.h.root))).toBe(false);
    await closing;
    f.fireRetained();
    expect(f.timers.size).toBe(0);
    expect(f.calls()).toEqual({ loads: 1, probes: 0, runs: 0 });
  } finally {
    release.release();
    await starting.catch(() => {});
    await f.close();
  }
});

test("Keeper schedule token publication failure never starts a producer and releases only its acquired root", async () => {
  const f = await ownedFixture(),
    token = tokenPath(f.h.home, f.h.root);
  try {
    mkdirSync(dirname(token), { recursive: true });
    mkdirSync(token);
    let failure: unknown;
    try {
      await f.launch();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(f.timers.size).toBe(0);
    expect(f.calls()).toEqual({ loads: 0, probes: 0, runs: 0 });
    expect(readLock(lockPath(f.h.home, f.h.root))).toBeNull();
    f.fireRetained();
    expect(f.calls().loads).toBe(0);
  } finally {
    await f.close();
  }
});

test("Keeper schedule acquired Hearth close releases authority synchronously then joins held complete fixture read without publication", async () => {
  const f = await ownedFixture(),
    entered = barrier(),
    release = barrier();
  f.holdSource(async () => {
    entered.release();
    await release.wait;
  });
  let closing: Promise<void> | undefined;
  try {
    const owner = await f.launch();
    if (owner.kind !== "started") throw Error("Expected held-source owner");
    await entered.wait;
    expect(f.calls()).toEqual({ loads: 1, probes: 0, runs: 0 });
    let joined = false;
    closing = owner.close();
    void closing.then(() => {
      joined = true;
    });
    expect(owner.close()).toBe(closing);
    expect(readLock(lockPath(f.h.home, f.h.root))).toBeNull();
    expect(existsSync(tokenPath(f.h.home, f.h.root))).toBe(false);
    expect(joined).toBe(false);
    release.release();
    await closing;
    expect(joined).toBe(true);
    expect(
      createConversationStore(f.h.home).discoverKeeperBrief(f.project.id),
    ).toBeNull();
    f.fireRetained();
    expect(f.timers.size).toBe(0);
    expect(f.calls()).toEqual({ loads: 1, probes: 0, runs: 0 });
  } finally {
    release.release();
    await closing;
    await f.close();
  }
});
