import { describe, expect, test } from "bun:test";
import type { QueueEntry, QueueState } from "../../types/hearth";
import { type OperatorMove, operatorMoves } from "./queue-table";

const entry = (
  state: QueueState,
  more: Partial<QueueEntry> = {},
): QueueEntry => ({
  beadId: "t-1",
  title: "t-1",
  state,
  status: "open",
  backed: true,
  ...more,
});

describe("operatorMoves: what the page may offer an operator", () => {
  test("from each state, the operator moves the table allows, and reassign where a smith may be changed", () => {
    const expected: Record<QueueState, OperatorMove[]> = {
      proposed: ["approve", "pause", "reassign"],
      approved: ["queue", "pause", "reassign"],
      queued: ["pause", "reassign"],
      running: ["pause"],
      review: ["pause"],
      done: [],
      paused: ["reassign"],
      halted: ["queue", "reassign"],
    };
    for (const [state, moves] of Object.entries(expected))
      expect({
        state,
        moves: operatorMoves(entry(state as QueueState)),
      }).toEqual({ state, moves });
  });

  test("a paused bead offers resume only when it knows the state to return to", () => {
    expect(operatorMoves(entry("paused", { resume: "queued" }))).toEqual([
      "resume",
      "reassign",
    ]);
    expect(operatorMoves(entry("paused"))).toEqual(["reassign"]);
  });

  test("a label the queue did not write, or a bead with two queue labels, offers nothing", () => {
    expect(operatorMoves(entry("approved", { backed: false }))).toEqual([]);
    expect(operatorMoves(entry("approved"), { twoLabels: true })).toEqual([]);
  });

  test("start, submit, complete, rework, release, halt and propose are never offered: the operator API has no route for them", () => {
    const all = (
      [
        "proposed",
        "approved",
        "queued",
        "running",
        "review",
        "done",
        "paused",
        "halted",
      ] as const
    ).flatMap((state) => operatorMoves(entry(state, { resume: "queued" })));
    for (const move of [
      "start",
      "submit",
      "complete",
      "rework",
      "release",
      "halt",
      "propose",
    ])
      expect(all).not.toContain(move);
  });
});
