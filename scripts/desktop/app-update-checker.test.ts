import { expect, test } from "bun:test";
import { createAppUpdateChecker, RELEASE_API } from "./app-update-checker";
import { officialReleaseUrl } from "./app-update-protocol";

const good = (tag = "v1.0.0", extra = {}) =>
  Response.json({
    id: 1,
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: officialReleaseUrl(tag),
    published_at: "2026-10-10T00:00:00Z",
    ...extra,
  });
test.each([
  ["1.0.0-rc.1", "v1.0.0", "newer"],
  ["1.0.0+local", "v1.0.0+vendor", "equal"],
  ["2.0.0", "v1.0.0", "ahead"],
])("compares %s with stable %s as %s", async (currentVersion, tag, state) => {
  const checker = createAppUpdateChecker({
    currentVersion,
    fetch: async (url, init) => {
      expect(url).toBe(RELEASE_API);
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return good(tag);
    },
  });
  expect(await checker.check()).toMatchObject({
    state,
    currentVersion,
    release: { tag, url: officialReleaseUrl(tag) },
  });
  checker.close();
});
test.each([
  404, 403, 429, 500, 302,
])("HTTP %s never becomes an up-to-date result", async (status) => {
  const checker = createAppUpdateChecker({
    currentVersion: "1.0.0",
    fetch: async () => new Response(null, { status }),
  });
  expect((await checker.check()).state).toBe("unavailable");
  checker.close();
});
test("strict stable metadata refuses foreign destinations, prereleases, malformed/oversized content and unsupported local versions", async () => {
  for (const response of [
    good("v1.0.0", { draft: true }),
    good("v1.0.0", { prerelease: true }),
    good("v1.0.0-rc.1"),
    good("v1.0.0", { html_url: "https://evil.example/releases/tag/v1.0.0" }),
    good("v1.0.0", { published_at: null }),
    new Response("x".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{broken", {
      headers: { "content-type": "application/json" },
    }),
    new Response(new Uint8Array([255]), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", { headers: { "content-type": "text/plain" } }),
  ]) {
    const checker = createAppUpdateChecker({
      currentVersion: "1.0.0",
      fetch: async () => response,
    });
    expect(await checker.check()).toMatchObject({
      state: "unavailable",
      reason: "invalid-response",
    });
    checker.close();
  }
  let reads = 0;
  const unsupported = createAppUpdateChecker({
    currentVersion: "development",
    fetch: async () => {
      reads++;
      return good();
    },
  });
  expect(await unsupported.check()).toMatchObject({
    state: "unavailable",
    reason: "unsupported-version",
  });
  expect(reads).toBe(0);
  unsupported.close();
});
test("concurrent explicit checks share one request and reuse its actual timestamp for sixty monotonic seconds", async () => {
  let reads = 0,
    elapsed = 0,
    release = (_response: Response) => {};
  const checker = createAppUpdateChecker({
    currentVersion: "1.0.0",
    monotonicNow: () => elapsed,
    fetch: async () => {
      reads++;
      return new Promise<Response>((done) => {
        release = done;
      });
    },
  });
  expect(reads).toBe(0);
  const first = checker.check(),
    second = checker.check();
  expect(reads).toBe(1);
  release(good());
  const results = await Promise.all([first, second]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).not.toBe(results[1]);
  expect(await checker.check()).toEqual(results[0]);
  expect(reads).toBe(1);
  elapsed = 60001;
  const next = checker.check();
  expect(reads).toBe(2);
  release(good());
  await next;
  checker.close();
});
test("header/body deadlines and Hearth close abort outstanding reads without exposing raw errors", async () => {
  for (const body of [false, true]) {
    const signals: AbortSignal[] = [];
    let cancelled = false;
    const checker = createAppUpdateChecker({
      currentVersion: "1.0.0",
      timeoutMs: 15,
      fetch: async (_url, init) => {
        signals.push(init.signal as AbortSignal);
        return body
          ? new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : await new Promise<Response>(() => {});
      },
    });
    expect(await checker.check()).toMatchObject({
      state: "unavailable",
      reason: "timeout",
    });
    expect(signals.at(-1)?.aborted).toBe(true);
    if (body) expect(cancelled).toBe(true);
    checker.close();
  }
  const closed = createAppUpdateChecker({
    currentVersion: "1.0.0",
    fetch: async () => await new Promise<Response>(() => {}),
  });
  const pending = closed.check();
  closed.close();
  expect(await pending).toMatchObject({
    state: "unavailable",
    reason: "closed",
  });
  expect((await closed.check()).state).toBe("unavailable");
});

test("a response returned after the deadline is cancelled even when its adapter ignored abort", async () => {
  let finish = (_response: Response) => {},
    cancelled = false,
    reportCancellation = () => {};
  const cancelledRead = new Promise<void>((done) => {
    reportCancellation = done;
  });
  const checker = createAppUpdateChecker({
    currentVersion: "1.0.0",
    timeoutMs: 10,
    fetch: async () =>
      await new Promise<Response>((done) => {
        finish = done;
      }),
  });
  expect(await checker.check()).toMatchObject({
    state: "unavailable",
    reason: "timeout",
  });
  finish(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          reportCancellation();
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await cancelledRead;
  expect(cancelled).toBe(true);
  checker.close();
});
