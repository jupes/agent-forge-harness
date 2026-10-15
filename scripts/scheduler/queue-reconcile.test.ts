import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import { loadConfig } from "../config/load";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { QUEUE_LIST_ARGS } from "../hearth/routes/operator-reads";
import { type AppendResult, appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { latestEventId, queryEvents } from "../ledger/query";
import { createQueue, type Queue } from "./queue";
import {
  answerQueueList,
  type QueueTracker,
  queueTracker,
  type TrackedBead,
} from "./queue-fixture";
import { reconcileQueue } from "./queue-reconcile";

const home = mkdtempSync(join(tmpdir(), "af-xsqx-reconcile-"));
const ledger = join(home, "ledger.db");
const lockFile = join(home, "queue-lock.db");

afterAll(() => {
  closeLedger(ledger);
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const store = (event: LedgerEventInput): AppendResult =>
  appendEvent(event, { path: ledger });
const lost = (): AppendResult => ({ ok: false, error: "the disk is full" });

let serial = 0;

interface Rig {
  workspace: string;
  tracker: QueueTracker;
  /** The tracker, answering `GET /queue`'s list as well as the queue's own calls. */
  runBd: BdRunner;
  /** A queue over the tracker; its events go to the ledger unless `append` says otherwise. */
  queue(append?: (event: LedgerEventInput) => AppendResult): Queue;
  /** The ledger id of the bead's recorded move at `index`, oldest first. */
  moveId(id: string, index: number): number;
  reconcile(): ReturnType<typeof reconcileQueue>;
}

/** A tracker and a workspace of its own, so that no other case's events are read. */
function rig(beads: TrackedBead[]): Rig {
  const workspace = join(home, `workspace-${++serial}`);
  mkdirSync(workspace);
  const tracker = queueTracker(beads);
  const runBd: BdRunner = async (args) =>
    answerQueueList(args, [...tracker.beads.values()]) ?? tracker.run(args);
  return {
    workspace,
    tracker,
    runBd,
    queue: (append = store) =>
      createQueue({ workspace, runBd, appendEvent: append, lockFile }),
    moveId: (id, index) => {
      const event = queryEvents(
        {
          workspace,
          beadId: id,
          beadExact: true,
          kinds: ["bead.transitioned"],
        },
        { path: ledger },
      ).filter((each) => !("action" in each.payload))[index];
      if (event === undefined) throw new Error(`no recorded move ${index}`);
      return event.id;
    },
    reconcile: () =>
      reconcileQueue({ workspace, runBd, ledgerPath: ledger, lockFile }),
  };
}

/** A bead that is not in the queue. */
const outside = (more: Partial<TrackedBead> = {}): TrackedBead => ({
  id: `recon-${++serial}`,
  labels: ["command-center"],
  ...more,
});

/** A bead the queue wrote `state` on, with no move recorded for it. */
const writtenAs = (state: string): TrackedBead =>
  outside({
    labels: [`queue:${state}`, "command-center"],
    metadata: { queue_state: state },
  });

async function moved(queue: Queue, id: string, ...actions: string[]) {
  for (const action of actions) {
    const result = await queue.move(
      id,
      // justification: the cases name only actions of the table.
      action as Parameters<Queue["move"]>[1],
      action === "propose" ? "scheduler" : "operator",
    );
    expect(result.ok ? action : `${action}: ${result.error}`).toBe(action);
  }
}

async function report(r: Rig) {
  const read = await r.reconcile();
  if (!read.ok) throw new Error(read.error);
  return read.value;
}

/** Store an event the queue did not write; answers its ledger id. */
function stored(event: LedgerEventInput): number {
  const result = store(event);
  if (!result.ok || !("id" in result))
    throw new Error(`not stored: ${JSON.stringify(result)}`);
  return result.id;
}

/** The audit row the operator API stores before it asks the queue for a reassign. */
const askedFor = (r: Rig, id: string, smith: string): number =>
  stored({
    kind: "operator.action",
    workspace: r.workspace,
    beadId: id,
    payload: { action: "queue.reassign", surface: "ui", target: smith },
  });

/** Write the bead's smith metadata the way a hand edit with `bd` does: no queue, no event. */
function smithByHand(r: Rig, id: string, smith: string | undefined): void {
  const bead = r.tracker.beads.get(id);
  if (bead === undefined) throw new Error(`no bead ${id}`);
  const { smith: _old, ...rest } = bead.metadata ?? {};
  bead.metadata = smith === undefined ? rest : { ...rest, smith };
}

/** The ledger id of the bead's recorded reassign at `index`, oldest first. */
function reassignId(r: Rig, id: string, index: number): number {
  const event = queryEvents(
    {
      workspace: r.workspace,
      beadId: id,
      beadExact: true,
      kinds: ["bead.transitioned"],
    },
    { path: ledger },
  ).filter(
    (each) => "action" in each.payload && each.payload.action === "reassign",
  )[index];
  if (event === undefined) throw new Error(`no recorded reassign ${index}`);
  return event.id;
}

describe("reconcileQueue: each bead's smith on Beads against the reassigns the ledger recorded", () => {
  const config = () => loadConfig({ harnessRoot: home, env: {}, home }).config;

  async function reassigned(queue: Queue, id: string, smith: string) {
    const result = await queue.reassign(id, smith, config());
    expect(result.ok ? smith : result.error).toBe(smith);
  }

  test("a reassign whose event the ledger refused: the smith on the bead is reported against the last recorded one, with the operator's request for it", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose", "approve");
    // A request for this smith before the last recorded reassign is not this one's.
    askedFor(r, bead.id, "claude-journeyman");
    await reassigned(r.queue(), bead.id, "claude-master");
    const asked = askedFor(r, bead.id, "claude-journeyman");
    await reassigned(r.queue(lost), bead.id, "claude-journeyman");
    expect(await report(r)).toEqual({
      beads: 1,
      moves: 2,
      drift: [
        {
          kind: "smith",
          beadId: bead.id,
          recorded: "claude-master",
          found: "claude-journeyman",
          afterEvent: reassignId(r, bead.id, 0),
          askedEvent: asked,
        },
      ],
    });
  });

  test("the first reassign's event refused: there is no recorded smith, and the request is found", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose");
    const asked = askedFor(r, bead.id, "claude-master");
    await reassigned(r.queue(lost), bead.id, "claude-master");
    expect((await report(r)).drift).toEqual([
      {
        kind: "smith",
        beadId: bead.id,
        recorded: null,
        found: "claude-master",
        askedEvent: asked,
      },
    ]);
  });

  test("a smith never assigned through the queue is told apart: no request after the last recorded reassign names it; one removed by hand is reported too", async () => {
    const setByHand = outside();
    const removedByHand = outside();
    const otherAsked = outside();
    const askedBefore = outside();
    const r = rig([setByHand, removedByHand, otherAsked, askedBefore]);
    const queue = r.queue();
    for (const bead of [setByHand, removedByHand, otherAsked, askedBefore])
      await moved(queue, bead.id, "propose");
    await reassigned(queue, removedByHand.id, "claude-master");
    // Asked for one smith, which bd never wrote; another was then set by hand.
    askedFor(r, otherAsked.id, "claude-journeyman");
    // Asked for, recorded, then reassigned again: that request is not for the same smith set by hand later.
    askedFor(r, askedBefore.id, "claude-journeyman");
    await reassigned(queue, askedBefore.id, "claude-journeyman");
    await reassigned(queue, askedBefore.id, "claude-master");
    for (const [id, smith] of [
      [setByHand.id, "claude-master"],
      [removedByHand.id, undefined],
      [otherAsked.id, "claude-apprentice"],
      [askedBefore.id, "claude-journeyman"],
    ] as const)
      smithByHand(r, id, smith);
    const drift = (await report(r)).drift;
    expect(drift).toContainEqual({
      kind: "smith",
      beadId: setByHand.id,
      recorded: null,
      found: "claude-master",
    });
    expect(drift).toContainEqual({
      kind: "smith",
      beadId: removedByHand.id,
      recorded: "claude-master",
      found: null,
      afterEvent: reassignId(r, removedByHand.id, 0),
    });
    expect(drift).toContainEqual({
      kind: "smith",
      beadId: otherAsked.id,
      recorded: null,
      found: "claude-apprentice",
    });
    expect(drift).toContainEqual({
      kind: "smith",
      beadId: askedBefore.id,
      recorded: "claude-master",
      found: "claude-journeyman",
      afterEvent: reassignId(r, askedBefore.id, 1),
    });
    expect(drift.length).toBe(4);
  });

  test("a reassign recorded before its event named the smith cannot be compared, and is not reported", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose");
    smithByHand(r, bead.id, "claude-master");
    stored({
      kind: "bead.transitioned",
      workspace: r.workspace,
      beadId: bead.id,
      payload: { action: "reassign" },
    });
    expect(await report(r)).toEqual({ beads: 1, moves: 1, drift: [] });
  });

  test("a bead the list does not print has no smith to compare: its reassigns are passed over", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose");
    await reassigned(r.queue(), bead.id, "claude-master");
    const out = r.tracker.beads.get(bead.id);
    if (out) Object.assign(out, { labels: ["command-center"], metadata: {} });
    expect((await report(r)).drift.map((each) => each.kind)).toEqual(["gap"]);
  });
});

describe("reconcileQueue: each bead's queue state on Beads against the moves the ledger recorded", () => {
  test("moves made and recorded by the queue leave no drift, whatever the path; a label the queue never wrote is not drift", async () => {
    const walked = outside();
    const halted = outside();
    const inherited = outside({ labels: ["queue:queued"] });
    const twoLabels = outside({ labels: ["queue:queued", "queue:halted"] });
    const r = rig([walked, halted, inherited, twoLabels]);
    const queue = r.queue();
    await moved(queue, walked.id, "propose", "approve", "queue", "start");
    // A bead paused while running resumes to queued, and is started again.
    await moved(queue, walked.id, "pause", "resume", "start");
    await moved(queue, walked.id, "submit", "complete");
    await moved(queue, halted.id, "propose", "approve", "halt");
    expect(await report(r)).toEqual({ beads: 4, moves: 12, drift: [] });
  });

  test("the last move made and its event not stored: a gap after the last recorded move, up to the state on the bead", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose");
    await moved(r.queue(lost), bead.id, "approve");
    const proposed = r.moveId(bead.id, 0);
    expect((await report(r)).drift).toEqual([
      {
        kind: "gap",
        beadId: bead.id,
        recorded: "proposed",
        found: "approved",
        afterEvent: proposed,
        labels: ["queue:approved"],
      },
    ]);
  });

  test("a move not recorded and later ones recorded: the gap is found between the two recorded moves around it", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose");
    await moved(r.queue(lost), bead.id, "approve");
    await moved(r.queue(), bead.id, "queue", "start");
    const proposed = r.moveId(bead.id, 0);
    const queued = r.moveId(bead.id, 1);
    expect((await report(r)).drift).toEqual([
      {
        kind: "gap",
        beadId: bead.id,
        recorded: "proposed",
        found: "approved",
        afterEvent: proposed,
        beforeEvent: queued,
      },
    ]);
  });

  test("the first move not recorded: a gap before the first recorded move, which starts from a state", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(lost), bead.id, "propose");
    await moved(r.queue(), bead.id, "approve");
    const approved = r.moveId(bead.id, 0);
    expect((await report(r)).drift).toEqual([
      {
        kind: "gap",
        beadId: bead.id,
        recorded: null,
        found: "proposed",
        beforeEvent: approved,
      },
    ]);
  });

  test("two queues with two lock files make the same move at the same time: both record it, and the second is reported as a duplicate", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose");
    const other = createQueue({
      workspace: r.workspace,
      runBd: r.runBd,
      appendEvent: store,
      lockFile: join(home, "another-lock.db"),
    });
    // The first reads the bead, then the other makes the whole move before the first writes.
    let raced = false;
    const first = createQueue({
      workspace: r.workspace,
      runBd: async (args, options) => {
        const answer = await r.runBd(args, options);
        if (args[0] === "show" && !raced) {
          raced = true;
          await moved(other, bead.id, "approve");
        }
        return answer;
      },
      appendEvent: store,
      lockFile,
    });
    await moved(first, bead.id, "approve");
    const once = r.moveId(bead.id, 1);
    const twice = r.moveId(bead.id, 2);
    expect((await report(r)).drift).toEqual([
      {
        kind: "duplicate",
        beadId: bead.id,
        from: "proposed",
        to: "approved",
        events: [once, twice],
      },
    ]);
  });

  test("changes made by hand: taken out of the queue, given a second label, or written as a state with no move", async () => {
    const takenOut = outside();
    const secondLabel = outside();
    const handWritten = writtenAs("queued");
    const r = rig([takenOut, secondLabel, handWritten]);
    const queue = r.queue();
    await moved(queue, takenOut.id, "propose", "approve");
    await moved(queue, secondLabel.id, "propose", "approve", "queue");
    // The repair a refusal prints: every queue label and both keys removed.
    const out = r.tracker.beads.get(takenOut.id);
    if (out) Object.assign(out, { labels: ["command-center"], metadata: {} });
    r.tracker.beads.get(secondLabel.id)?.labels?.push("queue:halted");
    const approved = r.moveId(takenOut.id, 1);
    const queued = r.moveId(secondLabel.id, 2);
    const drift = (await report(r)).drift;
    expect(drift).toContainEqual({
      kind: "gap",
      beadId: takenOut.id,
      recorded: "approved",
      found: null,
      afterEvent: approved,
      labels: [],
    });
    expect(drift).toContainEqual({
      kind: "gap",
      beadId: secondLabel.id,
      recorded: "queued",
      found: null,
      afterEvent: queued,
      labels: ["queue:halted", "queue:queued"],
    });
    expect(drift).toContainEqual({
      kind: "gap",
      beadId: handWritten.id,
      recorded: null,
      found: "queued",
      labels: ["queue:queued"],
    });
    expect(drift.length).toBe(3);
  });

  test("a bead taken out by hand and proposed again: the ledger never saw it leave, so the gap is before the new propose", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose", "approve");
    const stored = r.tracker.beads.get(bead.id);
    if (stored) Object.assign(stored, { labels: [], metadata: {} });
    await moved(r.queue(), bead.id, "propose");
    const approved = r.moveId(bead.id, 1);
    const proposedAgain = r.moveId(bead.id, 2);
    expect((await report(r)).drift).toEqual([
      {
        kind: "gap",
        beadId: bead.id,
        recorded: "approved",
        found: null,
        afterEvent: approved,
        beforeEvent: proposedAgain,
      },
    ]);
  });

  test("tracker writes are not moves: a reassign, and a claim recorded for a bead, are passed over", async () => {
    const bead = outside();
    const r = rig([bead]);
    const queue = r.queue();
    await moved(queue, bead.id, "propose", "approve");
    const { config } = loadConfig({ harnessRoot: r.workspace, env: {}, home });
    const reassigned = await queue.reassign(bead.id, "claude-master", config);
    expect(reassigned.ok && reassigned.value.recorded).toBe(true);
    const claim = store({
      kind: "bead.transitioned",
      workspace: r.workspace,
      beadId: bead.id,
      payload: { action: "claim" },
    });
    expect(claim.ok).toBe(true);
    expect(await report(r)).toEqual({ beads: 1, moves: 2, drift: [] });
  });

  test("only the workspace's own moves are read", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(), bead.id, "propose");
    const elsewhere = join(home, `elsewhere-${++serial}`);
    mkdirSync(elsewhere);
    expect(
      store({
        kind: "bead.transitioned",
        workspace: elsewhere,
        beadId: bead.id,
        payload: { from: "approved", to: "running", reason: "start:operator" },
      }).ok,
    ).toBe(true);
    expect(await report(r)).toEqual({ beads: 1, moves: 1, drift: [] });
  });

  test("it writes nothing: one bd call, the list GET /queue makes, and no ledger row", async () => {
    const bead = outside();
    const r = rig([bead]);
    await moved(r.queue(lost), bead.id, "propose");
    const calls = r.tracker.calls.length;
    const asked: string[][] = [];
    const before = latestEventId({}, { path: ledger });
    const read = await reconcileQueue({
      workspace: r.workspace,
      runBd: async (args, options) => {
        asked.push(args);
        return r.runBd(args, options);
      },
      ledgerPath: ledger,
      lockFile,
    });
    expect(read.ok && read.value.drift.length).toBe(1);
    expect(asked).toEqual([[...QUEUE_LIST_ARGS]]);
    expect(r.tracker.calls.length).toBe(calls);
    expect(latestEventId({}, { path: ledger })).toBe(before);
  });

  test("it reads under the queue lock: while another holds it the answer is busy, and bd is not called", async () => {
    const asked: string[][] = [];
    const held = join(home, "held-lock.db");
    const { Database } = await import("bun:sqlite");
    const holder = new Database(held, { create: true });
    holder.exec("BEGIN EXCLUSIVE");
    const read = await reconcileQueue({
      workspace: join(home, "unused"),
      runBd: (args) => {
        asked.push(args);
        return { status: 0, stdout: "[]", stderr: "" };
      },
      ledgerPath: ledger,
      lockFile: held,
      lockWaitMs: 150,
    });
    holder.exec("COMMIT");
    holder.close();
    expect(read.ok ? "ok" : read.error).toContain("another queue action");
    expect(asked).toEqual([]);
  });

  test("a list that cannot be read is an error, never an empty report: refused, stopped, not started, not JSON, not issues", async () => {
    const answers: Array<[BdResult, string]> = [
      [
        { status: 1, stdout: "", stderr: "Error: no beads database found\n" },
        "bd list failed: no beads database found",
      ],
      [
        { status: null, stdout: "", stderr: "" },
        "bd list did not finish: it was stopped before it answered, or it never started",
      ],
      [
        { status: null, stdout: "", stderr: "spawn bd ENOENT" },
        "bd could not be started",
      ],
      [{ status: 0, stdout: "not json", stderr: "" }, "did not print JSON"],
      [
        { status: 0, stdout: '[{"title":"no id"}]', stderr: "" },
        "not an issue",
      ],
    ];
    for (const [answer, why] of answers) {
      const read = await reconcileQueue({
        workspace: join(home, "unused"),
        runBd: () => answer,
        ledgerPath: ledger,
        lockFile,
      });
      expect(read.ok ? "ok" : read.error).toContain(why);
    }
    const thrown = await reconcileQueue({
      workspace: join(home, "unused"),
      runBd: () => {
        throw new Error("bd list --readonly exploded");
      },
      ledgerPath: ledger,
      lockFile,
    });
    expect(thrown.ok ? "ok" : thrown.error).toBe("bd list could not be run.");
  });
});
