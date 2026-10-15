import { describe, expect, test } from "bun:test";
import type { QueueEntry, QueueState } from "../../types/hearth";
import {
  legalMoves,
  type OperatorMove,
  operatorMoves,
  resumeTarget,
} from "./queue-table";

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

const STATES = [
  "proposed",
  "approved",
  "queued",
  "running",
  "review",
  "done",
  "paused",
  "halted",
] as const;

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

  test("a bead paused while running offers resume, and that resume leads to queued", () => {
    expect(operatorMoves(entry("paused", { resume: "running" }))).toEqual([
      "resume",
      "reassign",
    ]);
    expect(
      legalMoves("paused", "running").map((rule) => [rule.action, rule.to]),
    ).toEqual([["resume", "queued"]]);
  });

  test("a label the queue did not write offers propose and nothing else; a bead with two queue labels offers nothing", () => {
    for (const state of STATES)
      expect({
        state,
        moves: operatorMoves(entry(state, { backed: false })),
      }).toEqual({ state, moves: ["propose"] });
    expect(operatorMoves(entry("approved"), { twoLabels: true })).toEqual([]);
    expect(
      operatorMoves(entry("approved", { backed: false }), { twoLabels: true }),
    ).toEqual([]);
  });

  test("start, submit, complete, rework, release and halt are never offered (the operator API has no route for them), and propose never for a label the queue wrote", () => {
    const all = STATES.flatMap((state) =>
      operatorMoves(entry(state, { resume: "queued" })),
    );
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

describe("resumeTarget: where resume takes a paused bead", () => {
  test("back to the state it was paused from, except running, which goes to queued", () => {
    expect(
      (["proposed", "approved", "queued", "running", "review"] as const).map(
        (pausedFrom) => [pausedFrom, resumeTarget(pausedFrom)],
      ),
    ).toEqual([
      ["proposed", "proposed"],
      ["approved", "approved"],
      ["queued", "queued"],
      ["running", "queued"],
      ["review", "review"],
    ]);
  });
});
