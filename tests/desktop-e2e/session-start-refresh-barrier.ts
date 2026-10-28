import { randomUUID } from "node:crypto";
import type { Page, Request } from "@playwright/test";
import { z } from "zod";
import { sessionStartIdentityPageSchema } from "../../scripts/sessions/identity-protocol";

const MAX_IDENTITY_BYTES = 256 * 1024;
const CLONE_BINDING_TIMEOUT_MS = 5_000;
const MAX_HOLD_MS = 15_000;
const SETTLE_FALLBACK_MS = CLONE_BINDING_TIMEOUT_MS + MAX_HOLD_MS + 1_000;

const successEnvelope = z
  .object({
    ok: z.literal(true),
    data: sessionStartIdentityPageSchema,
    error: z.null(),
  })
  .strict();

type ExpectedIdentity = {
  requestId?: string;
  requestHash?: string;
  provider?: "codex" | "claude" | "gemini";
  mode?: "task" | "chat";
  state?: "reserved" | "attempted" | "not-sent" | "admitted" | "retired";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Install a same-page fetch wrapper that validates a clone of the actual browser response. */
async function installIdentityFetchBarrier(
  page: Page,
  projectId: string,
  workspace: string,
  expected: ExpectedIdentity,
  options: {
    holdResponse: boolean;
    previewPath: string | null;
    initiallyArmed: boolean;
  },
) {
  const bindingName = `__agentForgeIdentityCapture_${randomUUID().replaceAll("-", "")}`;
  const controllerName = `${bindingName}_controller`;
  const identityPath = `/__agent-forge/projects/${projectId}/session-start-identities`;
  let observed = false;
  let observedReads = 0;
  let held = false;
  let captureSeen = false;
  let settleResolve: () => void = () => {};
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settledRead = new Promise<void>((resolve) => {
    settleResolve = resolve;
  });
  const markSettled = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = undefined;
    settleResolve();
  };
  const armSettleFallback = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(markSettled, SETTLE_FALLBACK_MS);
  };
  armSettleFallback();

  await page.exposeBinding(bindingName, (source, raw: unknown) => {
    if (!isRecord(raw) || typeof raw.kind !== "string") return false;
    if (raw.kind === "settled") {
      markSettled();
      return true;
    }
    if (raw.kind !== "capture") return false;
    captureSeen = true;
    armSettleFallback();

    try {
      const pageOrigin = new URL(source.frame.url()).origin;
      if (
        raw.method !== "GET" ||
        raw.pageOrigin !== pageOrigin ||
        typeof raw.requestUrl !== "string" ||
        typeof raw.responseUrl !== "string" ||
        raw.status !== 200 ||
        raw.readState !== "ok" ||
        typeof raw.body !== "string" ||
        Buffer.byteLength(raw.body) > MAX_IDENTITY_BYTES
      )
        return false;
      const requestUrl = new URL(raw.requestUrl);
      const responseUrl = new URL(raw.responseUrl);
      if (
        requestUrl.origin !== pageOrigin ||
        requestUrl.pathname !== identityPath ||
        requestUrl.search !== "" ||
        requestUrl.href !== responseUrl.href ||
        responseUrl.origin !== pageOrigin ||
        responseUrl.pathname !== identityPath ||
        responseUrl.search !== ""
      )
        return false;

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(raw.body);
      } catch {
        return false;
      }
      const envelope = successEnvelope.safeParse(parsedBody);
      if (
        !envelope.success ||
        envelope.data.data.scope.projectId !== projectId ||
        envelope.data.data.scope.workspace !== workspace
      )
        return false;
      if (expected.requestId !== undefined) {
        const identity = envelope.data.data.identities.find(
          (item) => item.requestId === expected.requestId,
        );
        if (
          !identity ||
          identity.requestHash !== expected.requestHash ||
          (expected.provider !== undefined &&
            identity.provider !== expected.provider) ||
          (expected.mode !== undefined && identity.mode !== expected.mode) ||
          (expected.state !== undefined && identity.state !== expected.state)
        )
          return false;
      }
      observed = true;
      observedReads++;
      held = options.holdResponse;
      return true;
    } catch {
      return false;
    }
  });

  try {
    await page.evaluate(
      (config) => {
        const binding = Reflect.get(window, config.bindingName);
        if (typeof binding !== "function")
          throw Error("Identity capture binding was not installed.");
        const previousFetch = window.fetch;
        let armed = config.initiallyArmed;
        let claimed = false;
        let releaseCurrentHold: (() => void) | null = null;

        const boundedCloneText = async (response: Response) => {
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let timeoutId: number | undefined;
          try {
            const clone = response.clone();
            if (!clone.body) return { readState: "no-body", body: null };
            reader = clone.body.getReader();
            const readTask = async () => {
              const chunks: Uint8Array[] = [];
              let total = 0;
              for (;;) {
                const next = await reader?.read();
                if (!next || next.done) break;
                total += next.value.byteLength;
                if (total > config.maxBytes) {
                  void reader?.cancel().catch(() => {});
                  return { readState: "over-limit", body: null };
                }
                chunks.push(next.value);
              }
              const bytes = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }
              try {
                return {
                  readState: "ok",
                  body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                };
              } catch {
                return { readState: "invalid-utf8", body: null };
              }
            };
            const readResult = await Promise.race([
              readTask().catch(() => ({ readState: "read-failed", body: null })),
              new Promise<{ readState: string; body: string | null }>((resolve) => {
                timeoutId = window.setTimeout(() => {
                  void reader?.cancel().catch(() => {});
                  resolve({ readState: "timeout", body: null });
                }, config.cloneBoundMs);
              }),
            ]);
            return readResult;
          } catch {
            return { readState: "clone-failed", body: null };
          } finally {
            if (timeoutId !== undefined) window.clearTimeout(timeoutId);
            try {
              reader?.releaseLock();
            } catch {
              // Releasing a clone reader must not change the original response.
            }
          }
        };

        const callBinding = (payload: unknown) =>
          Promise.resolve(
            Reflect.apply(binding, window, [payload]) as Promise<unknown>,
          );
        const withinBound = <T>(promise: Promise<T>, boundMs: number) => {
          let timerId: number | undefined;
          const timeout = new Promise<undefined>((resolve) => {
            timerId = window.setTimeout(() => resolve(undefined), boundMs);
          });
          return Promise.race([promise, timeout]).finally(() => {
            if (timerId !== undefined) window.clearTimeout(timerId);
          });
        };
        const reportClone = async (
          response: Response,
          requestUrl: string,
          method: string,
        ) => {
          const clone = await boundedCloneText(response);
          return callBinding({
            kind: "capture",
            method,
            pageOrigin: window.location.origin,
            requestUrl,
            responseUrl: response.url,
            status: response.status,
            ...clone,
          });
        };

        const wrapper: typeof window.fetch = function (
          this: Window,
          ...args: Parameters<typeof window.fetch>
        ) {
          let requestUrl = "";
          let method = "";
          let capture = false;
          let hold = false;
          try {
            const input = args[0];
            const init = args[1];
            const request = input instanceof Request ? input : null;
            const url = new URL(request ? request.url : String(input), window.location.href);
            requestUrl = url.href;
            method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
            if (
              config.previewPath !== null &&
              method === "POST" &&
              url.origin === window.location.origin &&
              url.pathname === config.previewPath &&
              url.search === ""
            )
              armed = true;
            capture =
              armed &&
              !claimed &&
              method === "GET" &&
              url.origin === window.location.origin &&
              url.pathname === config.identityPath &&
              url.search === "";
            if (capture) {
              claimed = true;
              armed = false;
              hold = config.holdResponse;
            }
          } catch {
            capture = false;
          }

          const original = previousFetch.apply(this, args);
          if (!capture) return original;
          return original.then((response) => {
            const report = reportClone(response, requestUrl, method);
            if (!hold) {
              void withinBound(
                report.then(() => callBinding({ kind: "settled" })),
                config.cloneBoundMs,
              ).catch(() => {});
              return response;
            }
            const heldResponse = new Promise<void>((resolve) => {
              let finished = false;
              const finish = () => {
                if (finished) return;
                finished = true;
                window.clearTimeout(timer);
                resolve();
              };
              const timer = window.setTimeout(finish, config.holdBoundMs);
              releaseCurrentHold = finish;
            });
            return (async () => {
              await withinBound(report.catch(() => false), config.cloneBoundMs);
              await heldResponse;
              try {
                await withinBound(
                  callBinding({ kind: "settled" }),
                  config.cloneBoundMs,
                );
              } catch {
                // Binding cleanup must not replace the original fetch response.
              }
              return response;
            })();
          });
        };

        const controller = {
          arm() {
            armed = true;
            claimed = false;
          },
          release() {
            releaseCurrentHold?.();
          },
          dispose() {
            releaseCurrentHold?.();
            if (window.fetch === wrapper) window.fetch = previousFetch;
            Reflect.deleteProperty(window, config.controllerName);
          },
        };
        if (!Reflect.set(window, config.controllerName, controller))
          throw Error("Identity capture controller could not be installed.");
        window.fetch = wrapper;
      },
      {
        bindingName,
        controllerName,
        identityPath,
        previewPath: options.previewPath,
        initiallyArmed: options.initiallyArmed,
        holdResponse: options.holdResponse,
        maxBytes: MAX_IDENTITY_BYTES,
        cloneBoundMs: CLONE_BINDING_TIMEOUT_MS,
        holdBoundMs: MAX_HOLD_MS,
      },
    );
  } catch (error) {
    if (settleTimer) clearTimeout(settleTimer);
    try {
      await page.removeExposedBinding(bindingName);
    } catch {
      // Preserve the installation error if the page closed during cleanup.
    }
    throw error;
  }

  let controllerOperation: Promise<void> = Promise.resolve();
  const invokeController = (method: "arm" | "release" | "dispose") =>
    page.evaluate(
      ({ controllerName, method }) => {
        const controller = Reflect.get(window, controllerName);
        if (typeof controller !== "object" || controller === null) return;
        const callable = Reflect.get(controller, method);
        if (typeof callable === "function") Reflect.apply(callable, controller, []);
      },
      { controllerName, method },
    );

  return {
    get isObserved() {
      return observed;
    },
    get observedReads() {
      return observedReads;
    },
    get isHeld() {
      return held;
    },
    get settledRead() {
      return settledRead;
    },
    arm() {
      return invokeController("arm");
    },
    release() {
      controllerOperation = invokeController("release").catch(() => {});
      if (!captureSeen) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(markSettled, CLONE_BINDING_TIMEOUT_MS + 1_000);
      }
    },
    async settleHeldReads() {
      this.release();
      await controllerOperation;
      await settledRead;
    },
    async dispose() {
      this.release();
      await controllerOperation;
      await settledRead;
      try {
        await invokeController("dispose");
      } catch {
        // A closed page has already discarded its wrapper and controller.
      }
      if (settleTimer) clearTimeout(settleTimer);
      try {
        await page.removeExposedBinding(bindingName);
      } catch {
        // A closed page has already discarded its exposed binding.
      }
    },
  };
}

/** Observe, and optionally hold, one real identity read correlated to this page's preview POST. */
export async function observePreviewIdentityRefresh(
  page: Page,
  projectId: string,
  workspace: string,
  options: { holdResponse?: boolean } = {},
) {
  const capture = await installIdentityFetchBarrier(
    page,
    projectId,
    workspace,
    {},
    {
      holdResponse: options.holdResponse === true,
      previewPath: `/__agent-forge/projects/${projectId}/sessions/preview`,
      initiallyArmed: false,
    },
  );
  return {
    get settledRead() {
      return capture.settledRead;
    },
    get isHeld() {
      return capture.isHeld;
    },
    get isObserved() {
      return capture.isObserved;
    },
    release() {
      capture.release();
    },
    async dispose() {
      await capture.dispose();
    },
  };
}

/** Hold Alpha's real identity read after an explicit preview in a sibling project. */
export async function observeSiblingPreviewIdentityRefresh(
  alphaPage: Page,
  betaPage: Page,
  alphaProjectId: string,
  betaProjectId: string,
  workspace: string,
  expected: { requestId: string; requestHash: string },
) {
  let previewObserved = false;
  const onBetaRequest = (request: Request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/__agent-forge/projects/${betaProjectId}/sessions/preview`
    )
      previewObserved = true;
  };
  betaPage.on("request", onBetaRequest);
  let capture: Awaited<ReturnType<typeof installIdentityFetchBarrier>>;
  try {
    capture = await installIdentityFetchBarrier(
      alphaPage,
      alphaProjectId,
      workspace,
      {
        ...expected,
        provider: "codex",
        mode: "task",
        state: "reserved",
      },
      { holdResponse: true, previewPath: null, initiallyArmed: false },
    );
  } catch (error) {
    betaPage.off("request", onBetaRequest);
    throw error;
  }
  return {
    get isObserved() {
      return capture.isObserved;
    },
    get observedReads() {
      return capture.observedReads;
    },
    get isPreviewObserved() {
      return previewObserved;
    },
    arm() {
      return capture.arm();
    },
    release() {
      capture.release();
    },
    async settleHeldReads() {
      await capture.settleHeldReads();
    },
    async dispose() {
      betaPage.off("request", onBetaRequest);
      await capture.dispose();
    },
  };
}
