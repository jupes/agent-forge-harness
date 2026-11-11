import { z } from "zod";
import {
  type AppUpdateResult,
  appUpdateResultSchema,
  officialReleaseUrl,
} from "./app-update-protocol";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version";

export const RELEASE_API =
  "https://api.github.com/repos/jupes/agent-forge-harness/releases/latest";
const metadata = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tag_name: z.string().max(128),
  draft: z.literal(false),
  prerelease: z.literal(false),
  html_url: z.string().max(1024),
  published_at: z.string().datetime(),
});
const CAP = 64 * 1024;
/** One explicit, credential-free public read. No files, installers, native opening or automatic requests. */
export function createAppUpdateChecker(options: {
  currentVersion: string;
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  now?: (() => Date) | undefined;
  monotonicNow?: (() => number) | undefined;
  /** Trusted test seam; never exceeds the production five-second budget. */
  timeoutMs?: number | undefined;
}) {
  const currentVersion = options.currentVersion,
    now = options.now ?? (() => new Date()),
    elapsed = options.monotonicNow ?? (() => performance.now());
  const fetchRelease = options.fetch ?? ((url, init) => fetch(url, init));
  let closed = false,
    cancel: (() => void) | null = null;
  let flight: Promise<AppUpdateResult> | null = null;
  let cached: { at: number; result: AppUpdateResult } | null = null;
  const unavailable = (
    reason: Extract<AppUpdateResult, { state: "unavailable" }>["reason"],
  ): AppUpdateResult => ({
    state: "unavailable",
    reason,
    currentVersion,
    checkedAt: now().toISOString(),
  });
  async function run(): Promise<AppUpdateResult> {
    if (!parseReleaseVersion(currentVersion))
      return unavailable("unsupported-version");
    const checkedAt = now().toISOString(),
      controller = new AbortController();
    let timedOut = false,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stop = () => {};
    const deadline = new Promise<never>((_, reject) => {
      stop = () => {
        controller.abort();
        reject(Error("Update read stopped"));
      };
    });
    cancel = stop;
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1, Math.min(5000, options.timeoutMs ?? 5000)),
    );
    timer.unref();
    try {
      const response = await Promise.race([
        fetchRelease(RELEASE_API, {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "Agent-Forge-release-check",
          },
        }).then((response) => {
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw Error("Late update response discarded");
          }
          return response;
        }),
        deadline,
      ]);
      reader = response.body?.getReader();
      if (response.status !== 200)
        return unavailable(
          response.status === 404
            ? "not-found"
            : response.status === 403 || response.status === 429
              ? "rate-limited"
              : "network",
        );
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes("application/json") ||
        !reader
      )
        return unavailable("invalid-response");
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > CAP)
      )
        return unavailable("invalid-response");
      const buffer = new Uint8Array(CAP);
      let size = 0;
      for (;;) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        if (part.value.byteLength > CAP - size)
          return unavailable("invalid-response");
        buffer.set(part.value, size);
        size += part.value.byteLength;
      }
      const parsed = metadata.safeParse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, size),
          ),
        ),
      );
      if (!parsed.success) return unavailable("invalid-response");
      const raw = parsed.data,
        tag = parseReleaseVersion(raw.tag_name),
        url = new URL(raw.html_url);
      if (
        !tag ||
        tag.pre.length ||
        url.origin !== "https://github.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        decodeURIComponent(url.pathname) !==
          "/jupes/agent-forge-harness/releases/tag/" + raw.tag_name
      )
        return unavailable("invalid-response");
      const order = compareReleaseVersions(currentVersion, raw.tag_name);
      if (order === null) return unavailable("unsupported-version");
      return appUpdateResultSchema.parse({
        state: order < 0 ? "newer" : order === 0 ? "equal" : "ahead",
        currentVersion,
        checkedAt,
        release: {
          tag: raw.tag_name,
          url: officialReleaseUrl(raw.tag_name),
          publishedAt: raw.published_at,
        },
      });
    } catch {
      return unavailable(
        closed ? "closed" : timedOut ? "timeout" : "invalid-response",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      cancel = null;
      if (reader) {
        void reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          /* An aborted pending read releases its own lock. */
        }
      }
    }
  }
  return {
    check(): Promise<AppUpdateResult> {
      if (closed) return Promise.resolve(unavailable("closed"));
      if (
        cached &&
        elapsed() - cached.at >= 0 &&
        elapsed() - cached.at < 60_000
      )
        return Promise.resolve(appUpdateResultSchema.parse(cached.result));
      flight ??= run()
        .then((result) => {
          cached = { at: elapsed(), result };
          return result;
        })
        .finally(() => {
          flight = null;
        });
      return flight.then((result) => appUpdateResultSchema.parse(result));
    },
    close() {
      closed = true;
      cancel?.();
    },
  };
}
