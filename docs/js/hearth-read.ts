/**
 * Reading the hearth from the page: one read, with a time limit, and none on
 * a static copy.
 *
 * Every read the page makes of `/__agent-forge` goes through `readHearth`: the
 * operator API's read routes (`readOperatorRoute` in `use-stream.ts`), the
 * dev-only routes (`fetchDevApi` in `use-dev-api.ts`) and the bead actions'
 * options (`islands/bead-writes.ts`). Two rules hold for all of them:
 *
 * - A read has a time limit (`READ_TIMEOUT_MS`) over its answer and its body.
 *   A hearth that hangs never answers, and a read with no limit would leave its
 *   view loading for ever and keep the refetcher's one read in flight. Past the
 *   limit the request is dropped and the read fails, which a view shows as it
 *   shows any failed read.
 * - A static copy (a `vite build` of the dashboard) asks for nothing: no hearth
 *   is behind it. The read fails at once with `STATIC_COPY_ERROR`.
 *
 * No package import here: `operator.ts`, which is bundled for the browser and
 * held to reaching nothing but the hearth's constants, uses this module too.
 */

/**
 * How long one read of the hearth may take, its body included. Above the 30 s
 * the hearth gives any one `bd` call, so a late answer still arrives in the
 * hearth's own words; the same three keepalives the stream allows.
 */
export const READ_TIMEOUT_MS = 45_000;

/** Why a read on a static copy fails without asking. */
export const STATIC_COPY_ERROR =
  "Live data is not available in a static copy of the dashboard.";

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const REAL_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  // justification: the handle is whatever `set` above returned.
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface HearthReadOptions {
  /** How the request is made; the page's `fetch` by default. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** A static copy: nothing is asked for, and the read fails at once. Off unless the page's wiring says so. */
  staticCopy?: boolean;
  /** The time limit; `READ_TIMEOUT_MS` by default. */
  timeoutMs?: number;
  timers?: Timers;
}

/**
 * Whether this page is a static copy: a `vite build` of the dashboard has no
 * HMR socket (`import.meta.hot` is undefined there) and no hearth behind
 * `/__agent-forge`. The dev server, which proxies the hearth, always gives a
 * page one. Only the page's own wiring asks: under `bun test` it is undefined
 * as well, so the functions a test calls take the answer as an option.
 */
export function servedStatically(): boolean {
  return import.meta.hot === undefined && import.meta.env?.MODE !== "desktop";
}

/**
 * One read of the hearth at `url`, its answer taken by `take`. It fails at
 * once on a static copy, and once the time limit has passed without the
 * answer and its body: the request is aborted then, which drops its
 * connection, and the read fails whether or not `fetch` heeds the abort.
 */
export async function readHearth<T>(
  url: string,
  take: (response: Response) => Promise<T>,
  options: HearthReadOptions = {},
): Promise<T> {
  if (options.staticCopy) throw new Error(STATIC_COPY_ERROR);
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const timers = options.timers ?? REAL_TIMERS;
  const limit = options.timeoutMs ?? READ_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: unknown = null;
  const expired = new Promise<never>((_, fail) => {
    timer = timers.set(() => {
      controller.abort();
      fail(
        new Error(`The control plane did not answer within ${limit / 1000} s.`),
      );
    }, limit);
  });
  const read = (async () =>
    take(await request(url, { signal: controller.signal })))();
  try {
    return await Promise.race([read, expired]);
  } finally {
    timers.clear(timer);
  }
}
