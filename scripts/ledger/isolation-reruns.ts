/** The timed durable-append file needs its own disk phase in the home-safety rerun. */
const EXCLUSIVE = new Set(["scripts/ledger/append.test.ts"]);
const diagnosticName = (file: string) => {
  const clean = file.replace(/[\p{Cc}\p{Cs}]/gu, "?");
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
};

/** Diagnostic metadata only; child output/results never enter progress. */
export interface IsolationRerunProgress {
  event: "started" | "finished" | "complete";
  phase: "exclusive" | "parallel" | "complete";
  file: string | null;
  total: number;
  completed: number;
  elapsedMs: number;
  activeCount: number;
  /** First four active names; counts always describe the complete workload. */
  active: ReadonlyArray<{ file: string; elapsedMs: number }>;
  pendingCount: number;
  /** First eight pending names. All diagnostic names are capped at 160 characters. */
  pending: readonly string[];
}

export async function settleIsolationReruns<T>(
  files: readonly string[],
  workers: number,
  run: (file: string) => Promise<T>,
  onProgress?: (progress: IsolationRerunProgress) => void,
): Promise<PromiseSettledResult<T>[]> {
  if (!Number.isInteger(workers) || workers < 1)
    throw new Error("Expected a positive isolation worker count");
  const entries = files.map((file, index) => ({ file, index }));
  const results = new Array<PromiseSettledResult<T>>(files.length);
  const started = performance.now();
  const pending = new Set(entries.map((entry) => entry.index));
  const active = new Map<number, { file: string; started: number }>();
  let completed = 0;
  const report = (
    event: IsolationRerunProgress["event"],
    phase: IsolationRerunProgress["phase"],
    file: string | null,
  ) => {
    if (!onProgress) return;
    const now = performance.now();
    try {
      onProgress({
        event,
        phase,
        file: file === null ? null : diagnosticName(file),
        total: files.length,
        completed,
        elapsedMs: Math.max(0, Math.round(now - started)),
        activeCount: active.size,
        active: [...active.values()].slice(0, 4).map((entry) => ({
          file: diagnosticName(entry.file),
          elapsedMs: Math.max(0, Math.round(now - entry.started)),
        })),
        pendingCount: pending.size,
        pending: entries
          .filter((entry) => pending.has(entry.index))
          .slice(0, 8)
          .map((entry) => diagnosticName(entry.file)),
      });
    } catch {
      // Diagnostics must never skip a file or change its settled result.
    }
  };
  const visit = async (
    { file, index }: { file: string; index: number },
    phase: "exclusive" | "parallel",
  ) => {
    pending.delete(index);
    active.set(index, { file, started: performance.now() });
    report("started", phase, file);
    try {
      results[index] = { status: "fulfilled", value: await run(file) };
    } catch (reason) {
      results[index] = { status: "rejected", reason };
    } finally {
      active.delete(index);
      completed++;
      report("finished", phase, file);
    }
  };
  for (const entry of entries.filter((item) => EXCLUSIVE.has(item.file)))
    await visit(entry, "exclusive");
  const queue = entries.filter((item) => !EXCLUSIVE.has(item.file));
  const worker = async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift())
      await visit(entry, "parallel");
  };
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, worker),
  );
  report("complete", "complete", null);
  return results;
}
