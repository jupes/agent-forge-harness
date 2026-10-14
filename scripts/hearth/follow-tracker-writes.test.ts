import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createNetServer } from "node:net";
import { bdAnswers } from "./bd-answers";
import {
  type FollowTrackerWritesOptions,
  followTrackerWrites,
  type TrackerWriteFollower,
} from "./follow-tracker-writes";
import { type Exchange, loopbackExchange } from "./loopback";
import { startTestHearth, type TestHearth } from "./testing";

/**
 * The follower against a hermetic hearth (`startTestHearth`): its own ledger,
 * and a `bd` that records and agrees. Writes go in through the hearth's own
 * Beads routes over HTTP, as the dashboard sends them.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function hearth(): Promise<TestHearth> {
  const h = await startTestHearth();
  cleanup.push(() => h.close());
  return h;
}

interface Following {
  follower: TrackerWriteFollower;
  /** How many times `onWrite` was called. */
  writes(): number;
  /** Every request target the follower sent, in order. */
  targets: string[];
  /** The port each of those requests went to. */
  ports: number[];
}

function follow(
  port: FollowTrackerWritesOptions["port"],
  pollMs = 20,
): Following {
  let writes = 0;
  const targets: string[] = [];
  const ports: number[] = [];
  const exchange: Exchange = (request) => {
    targets.push(request.target);
    ports.push(request.port);
    return loopbackExchange(request);
  };
  const follower = followTrackerWrites({
    port,
    onWrite: () => {
      writes++;
    },
    pollMs,
    exchange,
  });
  cleanup.push(async () => follower.stop());
  return { follower, writes: () => writes, targets, ports };
}

async function waitFor(
  what: string,
  done: () => boolean,
  ms = 5000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Real time passes; whatever the follower does meanwhile is done. */
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Requests that ask for events after a cursor: the follower has one. */
const followingFrom = (targets: string[]): string[] =>
  targets.filter((target) => target.includes("after="));

async function claim(h: TestHearth, id: string): Promise<number> {
  const response = await fetch(`${h.api}/beads/${id}/claim`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: "{}",
  });
  await response.body?.cancel();
  return response.status;
}

/** A loopback port nothing listens on. */
async function deadPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  await new Promise<void>((done) => probe.close(() => done()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("followTrackerWrites", () => {
  test("a claim made through the hearth calls onWrite once; a bead.transitioned stored before following began does not", async () => {
    const h = await hearth();
    h.append({
      kind: "bead.transitioned",
      beadId: "before-1",
      payload: { action: "claim" },
    });
    const { writes, targets } = follow(async () => h.hearth.port);
    await waitFor(
      "polls after a cursor",
      () => followingFrom(targets).length >= 3,
    );
    expect(writes()).toBe(0);

    expect(await claim(h, "demo-task")).toBe(200);
    await waitFor("onWrite", () => writes() === 1);
    const asked = targets.length;
    await waitFor("more polls", () => targets.length >= asked + 3);
    expect(writes()).toBe(1);
    expect(targets[0]).toBe(
      "/__agent-forge/events?kind=bead.transitioned&limit=1",
    );
  });

  test("a write bd refuses stores the audit row and no bead.transitioned, and does not call onWrite", async () => {
    const h = await hearth();
    h.bd.answer = (args) =>
      bdAnswers.refusedOnStdout('no issue found matching "demo-task"', args);
    const { writes, targets } = follow(async () => h.hearth.port);
    await waitFor(
      "polls after a cursor",
      () => followingFrom(targets).length >= 1,
    );

    expect(await claim(h, "demo-task")).toBe(502);
    expect(h.events(["operator.action"])).toHaveLength(1);
    const asked = targets.length;
    await waitFor("more polls", () => targets.length >= asked + 3);
    expect(writes()).toBe(0);
  });

  test("polls that cannot reach the hearth are tried again; a write stored meanwhile calls onWrite once the hearth answers", async () => {
    const h = await hearth();
    const nowhere = await deadPort();
    let reachable = true;
    const { writes, targets, ports } = follow(async () =>
      reachable ? h.hearth.port : nowhere,
    );
    await waitFor(
      "polls after a cursor",
      () => followingFrom(targets).length >= 1,
    );

    reachable = false;
    // Polls run one at a time: once one goes nowhere, none is still asking the hearth.
    await waitFor("a poll that goes nowhere", () => ports.includes(nowhere));
    expect(await claim(h, "demo-task")).toBe(200);
    const failed = (): number => ports.filter((p) => p === nowhere).length;
    const before = failed();
    await waitFor("more polls that go nowhere", () => failed() >= before + 2);
    expect(writes()).toBe(0);

    reachable = true;
    await waitFor("onWrite", () => writes() === 1);
  });

  test("a port that rejects is asked again on the next poll", async () => {
    const h = await hearth();
    let asked = 0;
    const { writes, targets } = follow(async () => {
      asked++;
      if (asked <= 2) throw new Error("no hearth yet");
      return h.hearth.port;
    });
    await waitFor(
      "polls after a cursor",
      () => followingFrom(targets).length >= 1,
    );
    expect(asked).toBeGreaterThanOrEqual(3);

    expect(await claim(h, "demo-task")).toBe(200);
    await waitFor("onWrite", () => writes() === 1);
  });

  test("after stop, no request is sent and onWrite is not called", async () => {
    const h = await hearth();
    const { follower, writes, targets } = follow(async () => h.hearth.port);
    await waitFor(
      "polls after a cursor",
      () => followingFrom(targets).length >= 1,
    );

    follower.stop();
    const sent = targets.length;
    expect(await claim(h, "demo-task")).toBe(200);
    await pause(200);
    expect(targets.length).toBe(sent);
    expect(writes()).toBe(0);
  });
});
