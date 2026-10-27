import type { Page } from "@playwright/test";

const CAPTURE_BINDING = "__agentForgeCaptureForkResponse";
const CAPTURE_STATE = "__agentForgeForkResponseState";
const CAPTURE_LIMIT = 1024 * 1024;

const installations = new WeakMap<Page, Promise<void>>();
const activeCaptures = new WeakMap<
  Page,
  {
    id: string;
    resolve(value: { status: number; text: string }): void;
    reject(error: Error): void;
  }
>();
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
    armed: ArmedCapture | null;
  };
  const globals = window as unknown as Record<string, unknown>;
  if (globals[options.stateName]) return;

  const originalFetch = window.fetch;
  const state: CaptureState = {
    originalFetch,
    wrapper: originalFetch,
    armed: null,
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
    const armed = state.armed;
    if (!armed) return originalFetch.apply(this, args);

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
    if (
      method.toUpperCase() !== armed.method ||
      url.origin !== armed.origin ||
      url.pathname !== armed.path ||
      url.search !== ""
    )
      return originalFetch.apply(this, args);

    state.armed = null;
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
      await page.exposeBinding(CAPTURE_BINDING, (_source, value: unknown) => {
        const active = activeCaptures.get(page);
        const payload = record(value);
        if (
          !active ||
          payload?.["captureId"] !== active.id ||
          payload["ok"] !== true ||
          typeof payload["status"] !== "number" ||
          !Number.isInteger(payload["status"]) ||
          typeof payload["text"] !== "string" ||
          Buffer.byteLength(payload["text"], "utf8") > CAPTURE_LIMIT
        ) {
          if (active && payload?.["captureId"] === active.id)
            active.reject(
              new Error("The browser response capture was invalid."),
            );
          return;
        }
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
  expected: { method: "GET" | "POST"; origin: string; path: string },
): Promise<{
  response: Promise<{ status: number; text: string }>;
  dispose(): Promise<void>;
}> {
  if (activeCaptures.has(page))
    throw new Error("A browser response capture is already active.");
  await installBrowserCapture(page);

  let resolveResponse!: (value: { status: number; text: string }) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    },
  );
  void response.catch(() => undefined);
  const captureTimer = setTimeout(
    () => rejectResponse(new Error("The browser response capture timed out.")),
    30_000,
  );
  captureTimer.unref?.();
  void response.then(
    () => clearTimeout(captureTimer),
    () => clearTimeout(captureTimer),
  );
  const captureId = `browser-response-${++nextCaptureId}`;
  activeCaptures.set(page, {
    id: captureId,
    resolve: resolveResponse,
    reject: rejectResponse,
  });
  try {
    await page.evaluate(
      ({ stateName, capture }) => {
        const state = (window as unknown as Record<string, unknown>)[
          stateName
        ] as { armed: unknown } | undefined;
        if (!state)
          throw new Error("The browser response capture is unavailable.");
        state.armed = capture;
      },
      {
        stateName: CAPTURE_STATE,
        capture: { id: captureId, ...expected },
      },
    );
  } catch (error) {
    rejectResponse(
      error instanceof Error
        ? error
        : new Error("The browser response capture could not be armed."),
    );
    activeCaptures.delete(page);
    throw error;
  }
  return {
    response,
    async dispose() {
      const active = activeCaptures.get(page);
      if (active?.id === captureId)
        active.reject(new Error("The browser response capture was disposed."));
      activeCaptures.delete(page);
      try {
        await page.evaluate((stateName) => {
          const globals = window as unknown as Record<string, unknown>;
          const state = globals[stateName] as
            | {
                originalFetch: typeof window.fetch;
                wrapper: typeof window.fetch;
              }
            | undefined;
          if (!state) return;
          if (window.fetch === state.wrapper)
            window.fetch = state.originalFetch;
          delete globals[stateName];
        }, CAPTURE_STATE);
      } catch {
        // Navigation may have closed the document before cleanup.
      }
    },
  };
}
