/**
 * Invariants of `eligibility` over random queues, from a fixed seed so a
 * failure can be replayed: whatever the maps, readiness, statuses, deps
 * (cycles included), reservations and host, no two eligible beads overlap,
 * no eligible bead overlaps another bead's live reservation, no two beads
 * wait on each other, and only ready, non-epic beads on a quiet host are
 * eligible. Some reservations are put in shifts' worktrees (from a second
 * seed, so the queues themselves are the same as without them): no eligible
 * bead holds one whose shift has not stopped, and every other bead is
 * answered exactly as it is without the shifts.
 */

import { expect, test } from "bun:test";
import type { Reservation } from "../../types/hearth";
import {
  type Eligibility,
  eligibility,
  type QueuedBead,
  type ShiftWorktree,
  type StaleWhy,
} from "./eligibility";
import { mapsOverlap } from "./reservations";
import type { ShiftStanding } from "./shift-store";

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GLOBS = [
  "src/**",
  "src/a.ts",
  "src/b/*.ts",
  "docs/**",
  "docs/x.md",
  "lib",
  "lib/c.ts",
  "**/*.md",
  "tests/**",
  "**",
];

const STANDINGS: readonly ShiftStanding[] = [
  "live",
  "dead",
  "stopped",
  "unknown",
];

/** Each bead's answer, in the walk's order within eligible and within waiting. */
function answers(answer: Eligibility): Array<[string, string]> {
  return [
    ...answer.eligible.map(
      (e) => [e.id, JSON.stringify(e)] as [string, string],
    ),
    ...answer.waiting.map((w) => [w.id, JSON.stringify(w)] as [string, string]),
  ];
}

test("3000 random queues keep every invariant", () => {
  const next = random(20261012);
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)] as T;
  // A second generator decides the shifts: the first one's sequence, and so
  // every queue, is the same as before shifts were added.
  const nextShift = random(20261015);
  const problems: string[] = [];
  /** Beads that waited on a shift, over all rounds: the shift invariants are not vacuous. */
  let shiftWaits = 0;

  for (let round = 0; round < 3000; round++) {
    const count = 1 + Math.floor(next() * 6);
    const ids = Array.from({ length: count }, (_, i) => `t-${i}`);
    const candidates: QueuedBead[] = ids.map((id) => {
      const globs = Array.from({ length: 1 + Math.floor(next() * 2) }, () =>
        pick(GLOBS),
      );
      const deps =
        next() < 0.3
          ? [
              {
                issue_id: id,
                depends_on_id: pick(ids),
                type: pick(["blocks", "requires", "parent-child", "relates"]),
              },
            ]
          : [];
      return {
        id,
        title: id,
        issue_type: next() < 0.05 ? "epic" : "task",
        status: next() < 0.15 ? "in_progress" : "open",
        priority: Math.floor(next() * 4),
        description:
          next() < 0.1 ? "no map" : `## Files\n${globs.join("\n")}\n`,
        dependencies: deps,
      };
    });
    const readyIds = new Set(
      ids.filter(
        (id) =>
          next() < 0.8 &&
          candidates.find((c) => c.id === id)?.status === "open",
      ),
    );
    const owners = [...ids, "x-running", "x-closed"];
    const active: Reservation[] = Array.from(
      { length: Math.floor(next() * 3) },
      () => ({
        beadId: pick(owners),
        worktree: `c:/repo/trees/${Math.floor(next() * 3)}`,
        workspace: "c:/repo",
        globs: [pick(GLOBS)],
        acquiredAt: "2026-10-12T00:00:00.000Z",
      }),
    );
    const staleIds = new Map<string, StaleWhy>([["x-closed", "closed"]]);
    const host =
      next() < 0.1 ? { busy: true, reason: "load" } : { busy: false };

    // Some reservations sit in one of three shifts' worktrees, each shift in
    // a standing of its own this round.
    const standingOf = [0, 1, 2].map(
      () =>
        STANDINGS[Math.floor(nextShift() * STANDINGS.length)] as ShiftStanding,
    );
    const shiftWorktrees = new Map<string, ShiftWorktree>();
    const placed = active.map((reservation) => {
      if (nextShift() >= 0.4) return reservation;
      const k = Math.floor(nextShift() * 3);
      const shiftId = `shift-20261015-120000-000${k}`;
      const worktree = `c:/repo/trees/${shiftId}-${1 + Math.floor(nextShift() * 2)}`;
      shiftWorktrees.set(worktree, {
        shiftId,
        standing: standingOf[k] as ShiftStanding,
      });
      return { ...reservation, worktree };
    });

    const answer = eligibility({
      candidates,
      readyIds,
      active: placed,
      staleIds,
      host,
      shiftWorktrees,
    });
    const without = eligibility({
      candidates,
      readyIds,
      active: placed,
      staleIds,
      host,
    });
    const where = `round ${round}`;
    const live = placed.filter((r) => !staleIds.has(r.beadId));

    // A reservation in the worktree of a shift that has not stopped holds its bead.
    const inShift = (id: string, shiftId?: string) =>
      live.some((r) => {
        const shift = shiftWorktrees.get(r.worktree);
        return (
          r.beadId === id &&
          shift !== undefined &&
          shift.standing !== "stopped" &&
          (shiftId === undefined || shift.shiftId === shiftId)
        );
      });
    for (const e of answer.eligible)
      if (inShift(e.id))
        problems.push(
          `${where}: ${e.id} eligible while a shift's worktree holds its reservation`,
        );
    const onShift = new Set<string>();
    for (const w of answer.waiting) {
      if (w.waitsOnShift === undefined) continue;
      onShift.add(w.id);
      shiftWaits++;
      if (w.waitsOn !== undefined)
        problems.push(`${where}: ${w.id} waits on a shift and on a bead`);
      if (!inShift(w.id, w.waitsOnShift))
        problems.push(
          `${where}: ${w.id} waits on ${w.waitsOnShift}, whose worktree holds nothing of it`,
        );
    }
    // Every other bead is answered as it is without the shifts, in the same order.
    const rest = (list: Array<[string, string]>) =>
      JSON.stringify(list.filter(([id]) => !onShift.has(id)));
    if (rest(answers(answer)) !== rest(answers(without)))
      problems.push(
        `${where}: a bead that waits on no shift is answered otherwise than without the shifts`,
      );

    for (let i = 0; i < answer.eligible.length; i++)
      for (let j = i + 1; j < answer.eligible.length; j++) {
        const a = answer.eligible[i];
        const b = answer.eligible[j];
        if (a && b && mapsOverlap(a.globs, b.globs))
          problems.push(
            `${where}: ${a.id} and ${b.id} both eligible and overlap`,
          );
      }
    for (const e of answer.eligible) {
      const bead = candidates.find((c) => c.id === e.id);
      if (host.busy) problems.push(`${where}: ${e.id} eligible on a busy host`);
      if (!readyIds.has(e.id))
        problems.push(`${where}: ${e.id} eligible, not ready`);
      if (bead?.issue_type === "epic")
        problems.push(`${where}: epic ${e.id} eligible`);
      for (const r of live)
        if (r.beadId !== e.id && mapsOverlap(e.globs, r.globs))
          problems.push(`${where}: ${e.id} overlaps ${r.beadId}'s reservation`);
    }
    // A bead in progress is running: nothing eligible may overlap it.
    for (const running of candidates.filter(
      (c) => c.status === "in_progress" && c.issue_type !== "epic",
    )) {
      const runningGlobs =
        answer.waiting.find((w) => w.id === running.id)?.globs ?? [];
      for (const e of answer.eligible)
        if (mapsOverlap(e.globs, runningGlobs))
          problems.push(
            `${where}: ${e.id} eligible beside ${running.id} in progress`,
          );
    }
    const on = new Map(answer.waiting.map((w) => [w.id, w.waitsOn]));
    for (const w of answer.waiting)
      if (w.waitsOn !== undefined && on.get(w.waitsOn) === w.id)
        problems.push(`${where}: ${w.id} and ${w.waitsOn} wait on each other`);
    const seen = [...answer.eligible, ...answer.waiting]
      .map((x) => x.id)
      .sort();
    if (seen.join() !== [...ids].sort().join())
      problems.push(`${where}: not every candidate was answered`);
  }
  expect(problems.slice(0, 10)).toEqual([]);
  expect(shiftWaits).toBeGreaterThan(100);
});
