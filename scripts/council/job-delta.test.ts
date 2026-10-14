import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyCouncilJobDelta, councilJobDelta } from "./job-delta";
import { type CouncilServiceJob, createCouncilService } from "./service";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * Every job the service hands a listener that subscribes as the run starts,
 * for one run of the default council (simulated seats), oldest first.
 */
async function publishedJobs(): Promise<CouncilServiceJob[]> {
  const root = mkdtempSync(join(tmpdir(), "council-delta-"));
  roots.push(root);
  const service = createCouncilService({
    workspaceRoot: root,
    harnessRoot: resolve(import.meta.dir, "../.."),
    runsRoot: join(root, "runs"),
  });
  const seen: CouncilServiceJob[] = [];
  service.start({
    sourceType: "text",
    source: "Evaluate this plan and record any missing evidence.",
    runId: "delta-run",
  });
  service.subscribe("delta-run", (job) => seen.push(job));
  await service.wait("delta-run");
  await service.close();
  return seen;
}

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

describe("councilJobDelta and applyCouncilJobDelta", () => {
  test("over every update of a simulated default-council run: each job is the one before with its delta applied, and no event or round is carried twice", async () => {
    const jobs = await publishedJobs();
    expect(jobs.length).toBeGreaterThan(10);
    const final = jobs.at(-1);
    expect(final?.status).toBe("completed");

    let folded = jobs[0] as CouncilServiceJob;
    let eventsCarried = folded.events.length;
    let roundsCarried = folded.discussion?.length ?? 0;
    let deltaBytes = bytes(folded);
    for (const [index, job] of jobs.entries()) {
      if (index === 0) continue;
      const delta = councilJobDelta(jobs[index - 1] as CouncilServiceJob, job);
      if (delta === null) throw new Error(`no delta for update ${index}`);
      eventsCarried += delta.events.length;
      roundsCarried += delta.discussion.length;
      deltaBytes += bytes(delta);
      // The profile is set when the run starts and never changes.
      expect(Object.keys(delta.set)).not.toContain("profile");
      folded = applyCouncilJobDelta(folded, delta);
      expect(folded).toEqual(job);
    }
    expect(eventsCarried).toBe(final?.events.length ?? -1);
    expect(roundsCarried).toBe(final?.discussion?.length ?? -1);
    // The whole job every time costs more than the first job and the deltas after it.
    const wholeBytes = jobs.reduce((sum, job) => sum + bytes(job), 0);
    expect(deltaBytes).toBeLessThan(wholeBytes / 2);
  }, 30_000);

  test("a job that is not the one before plus what was appended has no delta: another run, fewer events or rounds, or a kept event that changed", async () => {
    const jobs = await publishedJobs();
    const before = jobs.find(
      (job) => job.events.length > 1 && (job.discussion?.length ?? 0) > 0,
    );
    if (before === undefined) throw new Error("no job with events and rounds");
    const after = structuredClone(before);
    expect(councilJobDelta(before, after)).not.toBeNull();
    expect(councilJobDelta(before, { ...after, runId: "another-run" })).toBe(
      null,
    );
    expect(
      councilJobDelta(before, { ...after, events: after.events.slice(1) }),
    ).toBeNull();
    expect(
      councilJobDelta(before, {
        ...after,
        discussion: (after.discussion ?? []).slice(1),
      }),
    ).toBeNull();
    const rewritten = structuredClone(after);
    const last = rewritten.events.at(-1);
    if (last) last.seq += 100;
    expect(councilJobDelta(before, rewritten)).toBeNull();
  }, 30_000);

  test("a field the job no longer has is unset, a changed one is set, and an unchanged one is left out", () => {
    const before: CouncilServiceJob = {
      runId: "r",
      status: "running",
      startedAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:01.000Z",
      events: [],
      discussion: [],
      error: "a transient error",
      persistenceStatus: "pending",
    };
    const after: CouncilServiceJob = {
      runId: "r",
      status: "failed",
      startedAt: before.startedAt,
      updatedAt: "2026-10-14T00:00:02.000Z",
      events: [],
      discussion: [],
      persistenceStatus: "pending",
    };
    const delta = councilJobDelta(before, after);
    expect(delta).toEqual({
      runId: "r",
      events: [],
      discussion: [],
      set: { status: "failed", updatedAt: "2026-10-14T00:00:02.000Z" },
      unset: ["error"],
    });
    if (delta) expect(applyCouncilJobDelta(before, delta)).toEqual(after);
  });
});
