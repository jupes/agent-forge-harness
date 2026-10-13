/**
 * One snapshot build at a time, for the dev server.
 *
 * Loaded by Vite under Node: imports nothing.
 */

export interface RebuildOutcome {
  ok: boolean;
  /** What the build printed (or why it could not run). */
  output: string;
}

export interface RebuildQueue {
  /** Resolves when a build that started at or after this call has finished; never rejects. */
  request(): Promise<RebuildOutcome>;
}

/**
 * At most one build runs. A request made while one runs starts no second
 * build: it waits for one more build that starts when the running one ends,
 * because the running build may have read the tracker before the change the
 * request is about. Every request made during the same build shares that
 * next build.
 */
export function createRebuildQueue(
  build: () => Promise<RebuildOutcome>,
): RebuildQueue {
  let running: Promise<RebuildOutcome> | null = null;
  let next: Promise<RebuildOutcome> | null = null;

  const start = (): Promise<RebuildOutcome> => {
    const run: Promise<RebuildOutcome> = new Promise<RebuildOutcome>(
      (resolve) => resolve(build()),
    )
      .catch(
        (error: unknown): RebuildOutcome => ({
          ok: false,
          output: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        if (running === run) running = null;
      });
    running = run;
    return run;
  };

  return {
    request() {
      if (next) return next;
      if (!running) return start();
      next = running.then(() => {
        next = null;
        return start();
      });
      return next;
    },
  };
}
