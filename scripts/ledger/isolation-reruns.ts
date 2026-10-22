/** The timed durable-append file needs its own disk phase in the home-safety rerun. */
const EXCLUSIVE = new Set(["scripts/ledger/append.test.ts"]);

export async function settleIsolationReruns<T>(
  files: readonly string[],
  workers: number,
  run: (file: string) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  if (!Number.isInteger(workers) || workers < 1)
    throw new Error("Expected a positive isolation worker count");
  const entries = files.map((file, index) => ({ file, index }));
  const results = new Array<PromiseSettledResult<T>>(files.length);
  const visit = async ({ file, index }: { file: string; index: number }) => {
    try {
      results[index] = { status: "fulfilled", value: await run(file) };
    } catch (reason) {
      results[index] = { status: "rejected", reason };
    }
  };
  for (const entry of entries.filter((item) => EXCLUSIVE.has(item.file)))
    await visit(entry);
  const queue = entries.filter((item) => !EXCLUSIVE.has(item.file));
  const worker = async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift())
      await visit(entry);
  };
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, worker),
  );
  return results;
}
