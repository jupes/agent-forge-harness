import type { Page } from "@playwright/test";

const CAPTURE_BINDING = "__agentForgeCaptureForkResponse";
const CAPTURE_STATE = "__agentForgeForkResponseState";
const CAPTURE_LIMIT = 1024 * 1024;
const MAX_GROUP_CAPTURES = 2;

const installations = new WeakMap<Page, Promise<void>>();
type CapturedTextResponse = { status: number; text: string };
type CaptureSpec = { method: "GET" | "POST"; origin: string; path: string };
type PendingCapture = {
  id: string;
  origin: string;
  response: Promise<CapturedTextResponse>;
  resolve(value: CapturedTextResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
const activeCaptures = new WeakMap<Page, Map<string, PendingCapture>>();
let nextCaptureId = 0;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function installBrowserFetchObserver(options: {
  bindingName: string;
  stateName: string;
  maxBytes: number;
}) {
  type ArmedCapture = {
    id: string;
    method: string;
    origin: string;
    path: string;
  };
  type CaptureState = {
    originalFetch: typeof window.fetch;
    wrapper: typeof window.fetch;
    armed: ArmedCapture[];
  };
  const globals = window as unknown as Record<string, unknown>;
  if (globals[options.stateName]) return;

  const originalFetch = window.fetch;
  const state: CaptureState = {
    originalFetch,
    wrapper: originalFetch,
    armed: [],
  };
  const readClone = async (response: Response): Promise<string> => {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > options.maxBytes) {
        void reader.cancel().catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          // The clone may still be settling while the original response proceeds.
        }
        throw new Error("response-size-limit");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  };
  const wrapper = async function (
    this: Window,
    ...args: Parameters<typeof fetch>
  ) {
    const [input, init] = args;
    let url: URL;
    let method: string;
    try {
      url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
    } catch {
      return originalFetch.apply(this, args);
    }
    const armedIndex = state.armed.findIndex(
      (candidate) =>
        method.toUpperCase() === candidate.method &&
        url.origin === candidate.origin &&
        url.pathname === candidate.path &&
        url.search === "",
    );
    if (armedIndex < 0) return originalFetch.apply(this, args);

    const [armed] = state.armed.splice(armedIndex, 1);
    if (!armed) return originalFetch.apply(this, args);
    let response: Response;
    try {
      response = await originalFetch.apply(this, args);
    } catch (error) {
      const binding = globals[options.bindingName];
      if (typeof binding === "function")
        await (binding as (payload: unknown) => Promise<void>)({
          captureId: armed.id,
          ok: false,
        }).catch(() => undefined);
      throw error;
    }

    let payload: Record<string, unknown>;
    try {
      const responseUrl = new URL(response.url);
      if (
        responseUrl.origin !== armed.origin ||
        responseUrl.pathname !== armed.path ||
        responseUrl.search !== ""
      )
        throw new Error("response-url-mismatch");
      payload = {
        captureId: armed.id,
        ok: true,
        status: response.status,
        text: await readClone(response.clone()),
      };
    } catch {
      payload = { captureId: armed.id, ok: false };
    }
    const binding = globals[options.bindingName];
    if (typeof binding === "function")
      await (binding as (value: unknown) => Promise<void>)(payload).catch(
        () => undefined,
      );
    return response;
  } as typeof window.fetch;
  state.wrapper = wrapper;
  globals[options.stateName] = state;
  window.fetch = wrapper;
}

async function installBrowserCapture(page: Page): Promise<void> {
  let installation = installations.get(page);
  if (!installation) {
    installation = (async () => {
      await page.exposeBinding(CAPTURE_BINDING, (source, value: unknown) => {
        const captures = activeCaptures.get(page);
        if (source.frame !== page.mainFrame()) return;
        const payload = record(value);
        const captureId = payload?.["captureId"];
        if (typeof captureId !== "string") return;
        const active = captures?.get(captureId);
        if (!active) return;
        const reject = (error: Error) => {
          clearTimeout(active.timer);
          captures?.delete(captureId);
          active.reject(error);
        };
        let sourceOrigin: string;
        try {
          sourceOrigin = new URL(source.frame.url()).origin;
        } catch {
          reject(
            new Error("The browser response capture source was unavailable."),
          );
          return;
        }
        if (sourceOrigin !== active.origin) {
          reject(
            new Error("The browser response capture source origin changed."),
          );
          return;
        }
        if (
          !payload ||
          payload["ok"] !== true ||
          typeof payload["status"] !== "number" ||
          !Number.isInteger(payload["status"]) ||
          typeof payload["text"] !== "string" ||
          Buffer.byteLength(payload["text"], "utf8") > CAPTURE_LIMIT
        ) {
          reject(new Error("The browser response capture was invalid."));
          return;
        }
        clearTimeout(active.timer);
        captures?.delete(captureId);
        active.resolve({ status: payload["status"], text: payload["text"] });
      });
      await page.addInitScript(installBrowserFetchObserver, {
        bindingName: CAPTURE_BINDING,
        stateName: CAPTURE_STATE,
        maxBytes: CAPTURE_LIMIT,
      });
    })();
    installations.set(page, installation);
  }
  await installation;
  await page.evaluate(installBrowserFetchObserver, {
    bindingName: CAPTURE_BINDING,
    stateName: CAPTURE_STATE,
    maxBytes: CAPTURE_LIMIT,
  });
}

export async function captureTextResponseThroughBrowserFetch(
  page: Page,
  expected: CaptureSpec,
): Promise<{
  response: Promise<CapturedTextResponse>;
  dispose(): Promise<void>;
}> {
  const group = await captureTextResponsesThroughBrowserFetch(page, [expected]);
  const capture = group.captures[0];
  if (!capture)
    throw new Error("The browser response capture was unavailable.");
  return { response: capture.response, dispose: group.dispose };
}

export async function captureTextResponsesThroughBrowserFetch(
  page: Page,
  expected: readonly CaptureSpec[],
): Promise<{
  captures: Array<{ response: Promise<CapturedTextResponse> }>;
  dispose(): Promise<void>;
}> {
  if (
    expected.length < 1 ||
    expected.length > MAX_GROUP_CAPTURES ||
    activeCaptures.has(page)
  )
    throw new Error("The browser response capture group is invalid or active.");
  for (const capture of expected) {
    let origin: URL;
    try {
      origin = new URL(capture.origin);
    } catch {
      throw new Error("The browser response capture origin is invalid.");
    }
    if (
      origin.origin !== capture.origin ||
      !capture.path.startsWith("/") ||
      capture.path.includes("?") ||
      capture.path.includes("#")
    )
      throw new Error("The browser response capture target is invalid.");
  }
  await installBrowserCapture(page);

  const group = new Map<string, PendingCapture>();
  const captureSpecs = expected.map((spec) => {
    const id = `browser-response-${++nextCaptureId}`;
    let resolveResponse!: (value: CapturedTextResponse) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<CapturedTextResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    void response.catch(() => undefined);
    const timer = setTimeout(() => {
      const pending = group.get(id);
      if (!pending) return;
      group.delete(id);
      pending.reject(new Error("The browser response capture timed out."));
    }, 30_000);
    timer.unref?.();
    group.set(id, {
      id,
      origin: spec.origin,
      response,
      resolve: resolveResponse,
      reject: rejectResponse,
      timer,
    });
    return { id, ...spec };
  });
  activeCaptures.set(page, group);
  try {
    await page.evaluate(
      ({ stateName, captures }) => {
        const state = (window as unknown as Record<string, unknown>)[
          stateName
        ] as { armed: unknown } | undefined;
        if (!state || !Array.isArray(state.armed) || state.armed.length > 0)
          throw new Error("The browser response capture is unavailable.");
        state.armed = captures;
      },
      { stateName: CAPTURE_STATE, captures: captureSpecs },
    );
  } catch (error) {
    for (const pending of group.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error("The browser response capture could not be armed."),
      );
    }
    group.clear();
    activeCaptures.delete(page);
    throw error;
  }
  let disposed = false;
  return {
    captures: captureSpecs.map(({ id }) => {
      const pending = group.get(id);
      if (!pending)
        throw new Error("The browser response capture was unavailable.");
      return { response: pending.response };
    }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      const captures = activeCaptures.get(page);
      if (captures === group) activeCaptures.delete(page);
      for (const pending of group.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The browser response capture was disposed."));
      }
      group.clear();
      try {
        await page.evaluate(
          ({ stateName, ids }) => {
            const globals = window as unknown as Record<string, unknown>;
            const state = globals[stateName] as
              | {
                  originalFetch: typeof window.fetch;
                  wrapper: typeof window.fetch;
                  armed: Array<{ id: string }>;
                }
              | undefined;
            if (!state) return;
            state.armed = state.armed.filter(
              (capture) => !ids.includes(capture.id),
            );
            if (state.armed.length > 0) return;
            if (window.fetch === state.wrapper)
              window.fetch = state.originalFetch;
            delete globals[stateName];
          },
          { stateName: CAPTURE_STATE, ids: captureSpecs.map(({ id }) => id) },
        );
      } catch {
        // Navigation may have closed the document before cleanup.
      }
    },
  };
}
