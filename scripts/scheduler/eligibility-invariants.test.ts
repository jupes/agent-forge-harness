/**
 * Invariants of `eligibility` over random queues, from a fixed seed so a
 * failure can be replayed: whatever the maps, readiness, statuses, deps
 * (cycles included), reservations and host, no two eligible beads overlap,
 * no eligible bead overlaps another bead's live reservation, no two beads
 * wait on each other, and only ready, non-epic beads on a quiet host are
 * eligible.
 */

import { expect, test } from "bun:test";
import type { Reservation } from "../../types/hearth";
import { eligibility, type QueuedBead, type StaleWhy } from "./eligibility";
import { mapsOverlap } from "./reservations";

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

test("3000 random queues keep every invariant", () => {
  const next = random(20261012);
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)] as T;
  const problems: string[] = [];

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

    const answer = eligibility({
      candidates,
      readyIds,
      active,
      staleIds,
      host,
    });
    const where = `round ${round}`;
    const live = active.filter((r) => !staleIds.has(r.beadId));

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
});
