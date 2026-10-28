import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { sessionStartIdentityPageSchema } from "../../scripts/sessions/identity-protocol";

const MAX_IDENTITY_BYTES = 256 * 1024;
const CLONE_BINDING_TIMEOUT_MS = 5_000;
const MAX_HOLD_MS = 15_000;
const PROOF_TIMEOUT_MS = CLONE_BINDING_TIMEOUT_MS + MAX_HOLD_MS + 1_000;
const CLEANUP_TIMEOUT_MS = 1_000;

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

async function withinCleanupBound<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser capture cleanup timed out.")),
          CLEANUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const captureId = randomUUID();
  let observed = false;
  let observedReads = 0;
  let held = false;
  let active = true;
  let disposed = false;
  let armed = false;
  let captureStarted = false;
  let captureSeen = false;
  let captureValid = false;
  let proofFinished = false;
  let proofTimer: ReturnType<typeof setTimeout> | undefined;
  let proofResolve: () => void = () => {};
  let proofReject: (error: Error) => void = () => {};
  const settledRead = new Promise<void>((resolve, reject) => {
    proofResolve = resolve;
    proofReject = reject;
  });
  void settledRead.catch(() => {});
  const clearProofTimer = () => {
    if (proofTimer) clearTimeout(proofTimer);
    proofTimer = undefined;
  };
  const failProof = (message: string) => {
    if (proofFinished) return;
    proofFinished = true;
    clearProofTimer();
    proofReject(new Error(message));
  };
  const passProof = () => {
    if (proofFinished || !captureSeen || !captureValid) return false;
    proofFinished = true;
    active = false;
    clearProofTimer();
    proofResolve();
    return true;
  };
  const armProofTimeout = () => {
    clearProofTimer();
    proofTimer = setTimeout(
      () => failProof("The browser identity witness did not settle in time."),
      PROOF_TIMEOUT_MS,
    );
  };
  const onPageClose = () => {
    active = false;
    failProof("The page closed before the browser identity witness settled.");
  };
  page.on("close", onPageClose);
  armProofTimeout();

  let bindingDisposable: Awaited<ReturnType<Page["exposeBinding"]>>;
  try {
    bindingDisposable = await page.exposeBinding(
    bindingName,
    (source, raw: unknown) => {
      if (
        !active ||
        disposed ||
        proofFinished ||
        source.frame !== page.mainFrame() ||
        !isRecord(raw) ||
        raw.captureId !== captureId ||
        typeof raw.kind !== "string"
      )
        return false;
      if (raw.kind === "armed") {
        if (captureSeen || raw.armed !== true) return false;
        armed = true;
        armProofTimeout();
        return true;
      }
      if (raw.kind === "claimed") {
        if (!armed || raw.armed !== true || captureStarted || captureSeen)
          return false;
        captureStarted = true;
        armProofTimeout();
        return true;
      }
      if (raw.kind === "fetch-rejected" || raw.kind === "capture-failed") {
        if (captureSeen || raw.armed !== true) return false;
        armed = true;
        captureStarted = true;
        captureSeen = true;
        failProof(
          raw.kind === "fetch-rejected"
            ? "The original browser identity fetch rejected."
            : "The browser identity response could not be verified.",
        );
        return true;
      }
      if (raw.kind === "settled") {
        if (!captureSeen || !captureValid) return false;
        return passProof();
      }
      if (raw.kind !== "capture" || captureSeen || raw.armed !== true)
        return false;
      armed = true;
      captureStarted = true;
      captureSeen = true;
      armProofTimeout();

      const invalid = () => {
        failProof("The actual browser identity response failed validation.");
        return false;
      };
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
          return invalid();
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
          return invalid();

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(raw.body);
        } catch {
          return invalid();
        }
        const envelope = successEnvelope.safeParse(parsedBody);
        if (
          !envelope.success ||
          envelope.data.data.scope.projectId !== projectId ||
          envelope.data.data.scope.workspace !== workspace
        )
          return invalid();
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
            return invalid();
        }
        observed = true;
        observedReads++;
        captureValid = true;
        held = options.holdResponse;
        armProofTimeout();
        return true;
      } catch {
        return invalid();
      }
    },
    );
  } catch (error) {
    active = false;
    disposed = true;
    page.off("close", onPageClose);
    failProof("The browser identity validation binding could not be installed.");
    clearProofTimer();
    throw error;
  }

  try {
    await page.evaluate(
      (config) => {
        const binding = Reflect.get(window, config.bindingName);
        if (typeof binding !== "function")
          throw Error("Identity capture binding was not installed.");
        const previousFetch = window.fetch;
        let armed = config.initiallyArmed;
        let claimed = false;
        let active = true;
        let disposed = false;
        let releaseRequested = false;
        let releaseCurrentHold: (() => void) | null = null;
        let cancelCurrentClone: (() => void) | null = null;

        const boundedCloneText = async (response: Response) => {
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let timeoutId: number | undefined;
          try {
            const clone = response.clone();
            if (!clone.body) return { readState: "no-body", body: null };
            reader = clone.body.getReader();
            const cancel = () => {
              void reader?.cancel().catch(() => {});
            };
            cancelCurrentClone = cancel;
            const readTask = async () => {
              const chunks: Uint8Array[] = [];
              let total = 0;
              for (;;) {
                const next = await reader?.read();
                if (!next || next.done) break;
                total += next.value.byteLength;
                if (total > config.maxBytes) {
                  cancel();
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
                  cancel();
                  resolve({ readState: "timeout", body: null });
                }, config.cloneBoundMs);
              }),
            ]);
            return readResult;
          } catch {
            return { readState: "clone-failed", body: null };
          } finally {
            if (timeoutId !== undefined) window.clearTimeout(timeoutId);
            cancelCurrentClone = null;
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
        const notify = (kind: string, extra: Record<string, unknown> = {}) =>
          callBinding({ kind, captureId: config.captureId, ...extra });
        const withinBound = <T>(promise: Promise<T>, boundMs: number) => {
          let timerId: number | undefined;
          const timeout = new Promise<undefined>((resolve) => {
            timerId = window.setTimeout(() => resolve(undefined), boundMs);
          });
          return Promise.race([promise, timeout]).finally(() => {
            if (timerId !== undefined) window.clearTimeout(timerId);
          });
        };
        const notifyBounded = (
          kind: string,
          extra: Record<string, unknown> = {},
        ) => withinBound(notify(kind, extra), config.cloneBoundMs);
        const reportClone = async (
          response: Response,
          requestUrl: string,
          method: string,
        ) => {
          const clone = await boundedCloneText(response);
          return notifyBounded("capture", {
            method,
            armed: true,
            pageOrigin: window.location.origin,
            requestUrl,
            responseUrl: response.url,
            status: response.status,
            ...clone,
          });
        };

        type BrowserFetchCallable = (
          this: Window,
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => Promise<Response>;
        const wrapper: BrowserFetchCallable = function (
          this: Window,
          ...args: Parameters<BrowserFetchCallable>
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
            ) {
              armed = true;
              void notifyBounded("armed", { armed: true }).catch(() => {});
            }
            capture =
              active &&
              !disposed &&
              !releaseRequested &&
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
              void notifyBounded("claimed", { armed: true }).catch(() => {});
            }
          } catch {
            capture = false;
          }

          let original: Promise<Response>;
          try {
            original = previousFetch.apply(this, args);
          } catch (error) {
            if (capture) {
              void notifyBounded("fetch-rejected", { armed: true }).catch(
                () => {},
              );
              restoreOwned();
            }
            throw error;
          }
          if (!capture) return original;
          return original.then(
            (response) => {
              if (!active || disposed || releaseRequested) {
                restoreOwned();
                return response;
              }
            const report = reportClone(response, requestUrl, method);
            if (!hold) {
              void (async () => {
                const accepted = await withinBound(report, config.cloneBoundMs);
                if (accepted === true) {
                  const settled = await withinBound(
                    notifyBounded("settled"),
                    config.cloneBoundMs,
                  );
                  if (settled !== true)
                    void notifyBounded("capture-failed", { armed: true }).catch(
                      () => {},
                    );
                } else {
                  void notifyBounded("capture-failed", { armed: true }).catch(
                    () => {},
                  );
                }
                restoreOwned();
              })().catch(() => {
                void notifyBounded("capture-failed", { armed: true }).catch(() => {});
                restoreOwned();
              });
              return response;
            }
            const heldResponse = new Promise<void>((resolve) => {
              let finished = false;
              const finish = () => {
                if (finished) return;
                finished = true;
                window.clearTimeout(timer);
                releaseCurrentHold = null;
                resolve();
              };
              const timer = window.setTimeout(finish, config.holdBoundMs);
              releaseCurrentHold = finish;
            });
            return (async () => {
              const accepted = await withinBound(
                report.catch(() => false),
                config.cloneBoundMs,
              );
              if (accepted !== true)
                void notifyBounded("capture-failed", { armed: true }).catch(() => {});
              if (accepted === true && !releaseRequested && !disposed) {
                await heldResponse;
              } else {
                releaseCurrentHold?.();
              }
              try {
                if (accepted === true && !disposed) {
                  const settled = await withinBound(
                    notifyBounded("settled"),
                    config.cloneBoundMs,
                  );
                  if (settled !== true)
                    void notifyBounded("capture-failed", { armed: true }).catch(
                      () => {},
                    );
                }
              } catch {
                void notifyBounded("capture-failed", { armed: true }).catch(() => {});
              }
              restoreOwned();
              return response;
            })();
            },
            (error: unknown) => {
              void notifyBounded("fetch-rejected", { armed: true }).catch(() => {});
              restoreOwned();
              throw error;
            },
          );
        };

        const restoreOwned = () => {
          active = false;
          if (window.fetch === wrapper) window.fetch = previousFetch;
          Reflect.deleteProperty(window, config.controllerName);
        };

        const controller = {
          arm() {
            if (disposed || !active) return;
            armed = true;
            claimed = false;
          },
          release() {
            releaseRequested = true;
            releaseCurrentHold?.();
          },
          dispose() {
            disposed = true;
            active = false;
            releaseRequested = true;
            cancelCurrentClone?.();
            releaseCurrentHold?.();
            if (window.fetch === wrapper) window.fetch = previousFetch;
            Reflect.deleteProperty(window, config.controllerName);
          },
        };
        if (!Reflect.set(window, config.controllerName, controller))
          throw Error("Identity capture controller could not be installed.");
        if (!Reflect.set(window, "fetch", wrapper))
          throw Error("Identity fetch wrapper could not be installed.");
      },
      {
        captureId,
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
    failProof("The browser identity fetch wrapper could not be installed.");
    active = false;
    disposed = true;
    page.off("close", onPageClose);
    clearProofTimer();
    try {
      await withinCleanupBound(
        page.evaluate((controllerName) => {
          const controller = Reflect.get(window, controllerName);
          if (typeof controller === "object" && controller !== null) {
            const dispose = Reflect.get(controller, "dispose");
            if (typeof dispose === "function")
              Reflect.apply(dispose, controller, []);
          }
        }, controllerName),
      );
    } catch {
      // Preserve the installation error if the page closed during cleanup.
    }
    try {
      await withinCleanupBound(Promise.resolve(bindingDisposable.dispose()));
    } catch {
      // Preserve the installation error if the page closed during cleanup.
    }
    throw error;
  }

  const invokeController = (method: "arm" | "release" | "dispose") =>
    withinCleanupBound(
      page.evaluate(
        ({ controllerName, method }) => {
          const controller = Reflect.get(window, controllerName);
          if (typeof controller !== "object" || controller === null) return;
          const callable = Reflect.get(controller, method);
          if (typeof callable === "function")
            Reflect.apply(callable, controller, []);
        },
        { controllerName, method },
      ),
    );

  let controllerOperation: Promise<void> = Promise.resolve();
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
      if (!active || disposed) return Promise.reject(new Error("Capture is inactive."));
      armed = true;
      armProofTimeout();
      return invokeController("arm").catch((error: unknown) => {
        failProof("The browser identity capture could not be armed.");
        throw error;
      });
    },
    release() {
      if (!captureSeen)
        failProof("The browser identity observer was released without a verified read.");
      controllerOperation = invokeController("release").catch(() => {});
    },
    async settleHeldReads() {
      this.release();
      await controllerOperation;
      await settledRead;
    },
    async dispose() {
      if (!proofFinished)
        failProof("The browser identity observer was disposed before settlement.");
      disposed = true;
      active = false;
      page.off("close", onPageClose);
      clearProofTimer();
      try {
        await invokeController("dispose");
      } catch {
        // A closed page has already discarded its wrapper and controller.
      }
      try {
        await withinCleanupBound(Promise.resolve(bindingDisposable.dispose()));
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

/** Hold the next armed real identity read and validate its original response. */
export async function holdNextVerifiedIdentityRead(
  page: Page,
  projectId: string,
  workspace: string,
  expected: { requestId: string; requestHash: string },
) {
  return installIdentityFetchBarrier(
    page,
    projectId,
    workspace,
    {
      ...expected,
      provider: "codex",
      mode: "task",
      state: "reserved",
    },
    { holdResponse: true, previewPath: null, initiallyArmed: false },
  );
}
