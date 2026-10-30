import type { Disposable, Page } from "@playwright/test";
import type { ProjectCouncilMetadata } from "../../types/project-council";
import {
  type ProjectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../types/project-council-run-read";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_READS = 64;
const READ_TIMEOUT_MS = 10_000;
let nextObserverId = 0;

export type RunReadObservation =
  | { kind: "verified"; read: ProjectCouncilRunRead }
  | { kind: "interrupted"; reason: "aborted" }
  | { kind: "invalid"; message: string };

export type RunReadObservations = Array<Promise<RunReadObservation>> & {
  dispose(): Promise<void>;
};

type RunReadIdentity = Pick<
  ProjectCouncilMetadata,
  "projectId" | "requestId" | "intentHash" | "runId"
>;

type PendingRead = {
  documentToken: string;
  resolve(value: RunReadObservation): void;
  timer: ReturnType<typeof setTimeout>;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function responseData(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    value.ok !== true ||
    !("error" in value) ||
    value.error !== null ||
    !("data" in value) ||
    Object.keys(value).length !== 3
  )
    throw Error("The actual Council response envelope was not successful.");
  return value.data;
}

function installRunReadFetchObserver(options: {
  bindingName: string;
  stateName: string;
  origin: string;
  path: string;
  maxReadBytes: number;
  maxTotalBytes: number;
  maxReads: number;
  timeoutMs: number;
}) {
  if (window.top !== window) return;
  const globals = window as unknown as Record<string, unknown>;
  const existing = globals[options.stateName] as
    | { ready?: Promise<boolean> }
    | undefined;
  if (existing) return existing.ready;
  const binding = globals[options.bindingName];
  if (typeof binding !== "function") return;

  type BrowserState = {
    originalFetch: typeof window.fetch;
    wrapper: typeof window.fetch;
    accepting: boolean;
    token: string;
    ready: Promise<boolean>;
    reads: number;
    overflowed: boolean;
    bytes: number;
    active: Map<string, AbortController>;
  };
  const originalFetch = window.fetch;
  const token = crypto.randomUUID();
  const state: BrowserState = {
    originalFetch,
    wrapper: originalFetch,
    accepting: true,
    token,
    ready: Promise.resolve(false),
    reads: 0,
    overflowed: false,
    bytes: 0,
    active: new Map(),
  };
  const callBinding = (payload: Record<string, unknown>) =>
    Promise.resolve((binding as (value: unknown) => Promise<unknown>)(payload));
  const ready = callBinding({ kind: "ready", token }).then(
    (value) => value === true,
    () => false,
  );
  state.ready = ready;
  const sendFailure = (id: string, message: string) =>
    callBinding({ kind: "failure", id, token, message }).catch(() => false);
  const readClone = async (id: string, response: Response) => {
    const reader = response.body?.getReader();
    if (!reader) throw Error("The cloned Council result had no body.");
    const controller = new AbortController();
    state.active.set(id, controller);
    const chunks: Uint8Array[] = [];
    let length = 0;
    let timedOut = false;
    let completed = false;
    let timer: number | undefined;
    const abort = () => {
      timedOut = true;
      void reader.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    timer = window.setTimeout(abort, options.timeoutMs);
    try {
      for (;;) {
        const part = await reader.read();
        if (timedOut)
          throw Error("The Council result clone exceeded its time bound.");
        if (part.done) break;
        length += part.value.byteLength;
        state.bytes += part.value.byteLength;
        if (
          length > options.maxReadBytes ||
          state.bytes > options.maxTotalBytes
        ) {
          void reader.cancel().catch(() => undefined);
          throw Error("The Council result read exceeded its byte bound.");
        }
        chunks.push(part.value);
      }
      if (timedOut)
        throw Error("The Council result clone exceeded its time bound.");
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      completed = true;
      return text;
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      if (state.active.get(id) === controller) state.active.delete(id);
      if (!completed) void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // The clone reader never owns the application's original response.
      }
    }
  };
  const wrapper = Object.assign(async function (
    this: unknown,
    ...args: Parameters<typeof originalFetch>
  ): Promise<Response> {
    const input = args[0];
    let url: URL;
    let method: string;
    try {
      url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.href,
      );
      method =
        args[1]?.method ?? (input instanceof Request ? input.method : "GET");
    } catch {
      return Reflect.apply(originalFetch, this, args);
    }
    if (
      !state.accepting ||
      method.toUpperCase() !== "GET" ||
      url.origin !== options.origin ||
      url.pathname !== options.path ||
      url.search !== ""
    )
      return Reflect.apply(originalFetch, this, args);

    if (state.reads >= options.maxReads) {
      if (!state.overflowed) {
        state.overflowed = true;
        state.accepting = false;
        await callBinding({ kind: "overflow", token }).catch(() => false);
      }
      return Reflect.apply(originalFetch, this, args);
    }
    const id = `${token}:${++state.reads}`;
    let admitted = false;
    try {
      admitted =
        (await ready) &&
        (await callBinding({ kind: "begin", id, token })) === true;
    } catch {
      admitted = false;
    }
    if (!admitted) {
      state.accepting = false;
      return Reflect.apply(originalFetch, this, args);
    }

    let response: Response;
    try {
      response = await Reflect.apply(originalFetch, this, args);
    } catch (error) {
      const name =
        typeof error === "object" && error !== null && "name" in error
          ? String(error.name)
          : "";
      await callBinding({
        kind: name === "AbortError" ? "aborted" : "failure",
        id,
        token,
        message: name === "AbortError" ? "AbortError" : "Native fetch failed.",
      }).catch(() => false);
      throw error;
    }
    let clone: Response;
    try {
      const finalUrl = new URL(response.url);
      if (
        finalUrl.origin !== options.origin ||
        finalUrl.pathname !== options.path ||
        finalUrl.search !== ""
      )
        throw Error("The Council result response URL changed scope.");
      clone = response.clone();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The response could not be cloned.";
      await sendFailure(id, message);
      return response;
    }

    try {
      const text = await readClone(id, clone);
      await callBinding({
        kind: "complete",
        id,
        token,
        status: response.status,
        url: response.url,
        text,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The response clone failed.";
      await sendFailure(id, message);
    }
    return response;
  }, originalFetch);
  state.wrapper = wrapper;
  globals[options.stateName] = state;
  window.fetch = wrapper;
  return ready;
}

export async function observeRunReads(
  page: Page,
  path: string,
  expected: RunReadIdentity,
): Promise<RunReadObservations> {
  const origin = new URL(page.url()).origin;
  if (!path.startsWith("/") || path.includes("?") || path.includes("#"))
    throw Error("The Council result observation path is invalid.");
  const id = ++nextObserverId;
  const bindingName = `__councilRunReadBinding${id}`;
  const stateName = `__councilRunReadState${id}`;
  const pending = new Map<string, PendingRead>();
  const reads = Object.assign([] as Promise<RunReadObservation>[], {
    dispose: async () => undefined,
  }) as RunReadObservations;
  let disposed = false;
  let stopping = false;
  let documentToken: string | null = null;
  const seenDocumentTokens = new Set<string>();
  let count = 0;
  let overflowed = false;
  let totalBytes = 0;
  const recordOverflow = (
    message = "The Council result observer exceeded its read-count bound.",
  ) => {
    if (overflowed) return false;
    overflowed = true;
    reads.push(
      Promise.resolve({
        kind: "invalid",
        message,
      }),
    );
    return false;
  };
  const settle = (captureId: string, result: RunReadObservation) => {
    const capture = pending.get(captureId);
    if (!capture) return;
    clearTimeout(capture.timer);
    pending.delete(captureId);
    capture.resolve(result);
  };
  const invalidForPending = (token: string, message: string) => {
    for (const [captureId, capture] of pending) {
      if (capture.documentToken === token)
        settle(captureId, { kind: "invalid", message });
    }
  };
  const onClose = () => {
    for (const captureId of pending.keys())
      settle(captureId, {
        kind: "invalid",
        message: "The page closed during a Council result read.",
      });
  };
  const binding = await page.exposeBinding(
    bindingName,
    async (source, raw: unknown) => {
      if (disposed || source.frame !== page.mainFrame()) return false;
      let sourceOrigin: string;
      try {
        sourceOrigin = new URL(source.frame.url()).origin;
      } catch {
        return false;
      }
      if (sourceOrigin !== origin) return false;
      const payload = record(raw);
      if (!payload || typeof payload["kind"] !== "string") return false;
      const kind = payload["kind"];
      const token = payload["token"];
      if (kind === "ready") {
        if (stopping) return false;
        if (typeof token !== "string" || seenDocumentTokens.has(token))
          return false;
        if (seenDocumentTokens.size >= MAX_READS) {
          recordOverflow(
            "The Council result observer exceeded its document-epoch bound.",
          );
          return false;
        }
        if (documentToken && documentToken !== token)
          invalidForPending(
            documentToken,
            "The page changed during a Council result read.",
          );
        seenDocumentTokens.add(token);
        documentToken = token;
        return true;
      }
      if (kind === "overflow") {
        if (typeof token !== "string" || token !== documentToken) return false;
        return recordOverflow();
      }
      const captureId = payload["id"];
      if (
        typeof token !== "string" ||
        token !== documentToken ||
        typeof captureId !== "string"
      )
        return false;
      if (kind === "begin") {
        if (stopping || overflowed) return false;
        if (pending.has(captureId)) {
          settle(captureId, {
            kind: "invalid",
            message: "The Council result observer reused an identity.",
          });
          return false;
        }
        if (count >= MAX_READS) return recordOverflow();
        let resolve!: (value: RunReadObservation) => void;
        const observation = new Promise<RunReadObservation>((done) => {
          resolve = done;
        });
        void observation.catch(() => undefined);
        reads.push(observation);
        count++;
        const timer = setTimeout(() => {
          settle(captureId, {
            kind: "invalid",
            message: "The Council result read exceeded its time bound.",
          });
        }, READ_TIMEOUT_MS);
        pending.set(captureId, { documentToken: token, resolve, timer });
        return true;
      }
      if (kind === "aborted") {
        if (payload["message"] !== "AbortError") {
          settle(captureId, {
            kind: "invalid",
            message:
              "The Council result read reported an unknown interruption.",
          });
          return false;
        }
        settle(captureId, { kind: "interrupted", reason: "aborted" });
        return true;
      }
      if (kind === "failure") {
        settle(captureId, {
          kind: "invalid",
          message:
            typeof payload["message"] === "string"
              ? payload["message"]
              : "The actual Council result request failed.",
        });
        return false;
      }
      if (kind === "complete") {
        const url = payload["url"];
        const status = payload["status"];
        const text = payload["text"];
        if (
          typeof url !== "string" ||
          typeof status !== "number" ||
          typeof text !== "string"
        ) {
          settle(captureId, {
            kind: "invalid",
            message: "The actual Council result capture was malformed.",
          });
          return false;
        }
        try {
          const finalUrl = new URL(url);
          const byteLength = Buffer.byteLength(text, "utf8");
          if (
            finalUrl.origin !== origin ||
            finalUrl.pathname !== path ||
            finalUrl.search !== "" ||
            status !== 200 ||
            byteLength > MAX_READ_BYTES
          )
            throw Error(
              "The actual Council result response was out of scope or oversized.",
            );
          totalBytes += byteLength;
          if (totalBytes > MAX_TOTAL_BYTES)
            throw Error(
              "Council result observations exceeded their total byte bound.",
            );
          let rawRead: unknown;
          try {
            rawRead = JSON.parse(text);
          } catch {
            throw Error("The actual Council result body was not valid JSON.");
          }
          const read = projectCouncilRunReadSchema.parse(responseData(rawRead));
          if (
            read.provenance.projectId !== expected.projectId ||
            read.provenance.requestId !== expected.requestId ||
            read.provenance.intentHash !== expected.intentHash ||
            read.provenance.runId !== expected.runId
          )
            throw Error(
              "The actual Council result did not match its exact original.",
            );
          settle(captureId, { kind: "verified", read });
          return true;
        } catch (error) {
          settle(captureId, {
            kind: "invalid",
            message: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      }
      if (kind === "failure" || kind === "complete" || kind === "aborted")
        return false;
      settle(captureId, {
        kind: "invalid",
        message: "The Council result observer received an unknown event.",
      });
      return false;
    },
  );
  page.once("close", onClose);
  const options = {
    bindingName,
    stateName,
    origin,
    path,
    maxReadBytes: MAX_READ_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxReads: MAX_READS,
    timeoutMs: READ_TIMEOUT_MS,
  };
  let initScript: Disposable | undefined;
  try {
    initScript = await page.addInitScript(installRunReadFetchObserver, options);
    await page.evaluate(installRunReadFetchObserver, options);
  } catch (error) {
    page.off("close", onClose);
    try {
      await page.evaluate((stateKey) => {
        const state = (window as unknown as Record<string, unknown>)[
          stateKey
        ] as
          | { originalFetch: typeof window.fetch; wrapper: typeof window.fetch }
          | undefined;
        if (state && window.fetch === state.wrapper)
          window.fetch = state.originalFetch;
      }, stateName);
    } catch {
      // A closed page has already discarded the installed wrapper.
    }
    try {
      await initScript?.dispose();
    } finally {
      await binding.dispose();
    }
    throw error;
  }

  let disposedOnce = false;
  reads.dispose = async () => {
    if (disposedOnce) return;
    disposedOnce = true;
    try {
      await page.evaluate((stateKey) => {
        const state = (window as unknown as Record<string, unknown>)[
          stateKey
        ] as
          | {
              originalFetch: typeof window.fetch;
              wrapper: typeof window.fetch;
              accepting: boolean;
              active: Map<string, AbortController>;
            }
          | undefined;
        if (!state) return;
        state.accepting = false;
        if (window.fetch === state.wrapper) window.fetch = state.originalFetch;
        for (const controller of state.active.values()) controller.abort();
        state.active.clear();
      }, stateName);
    } catch {
      // A closed or reloaded page has already discarded the installed wrapper.
    }
    stopping = true;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let drained: RunReadObservation[] | undefined;
    try {
      drained = await Promise.race([
        Promise.all([...reads]),
        new Promise<undefined>((resolve) => {
          drainTimer = setTimeout(() => resolve(undefined), READ_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    }
    if (!drained) {
      for (const captureId of pending.keys())
        settle(captureId, {
          kind: "invalid",
          message: "The Council result observer drain timed out.",
        });
      drained = await Promise.all([...reads]);
    }
    disposed = true;
    page.off("close", onClose);
    const invalid = drained.find((read) => read.kind === "invalid");
    try {
      await initScript?.dispose();
    } finally {
      await binding.dispose();
    }
    if (invalid?.kind === "invalid")
      throw Error(`The Council result observer failed: ${invalid.message}`);
  };
  return reads;
}

export async function verifiedRunReads(
  observations: readonly Promise<RunReadObservation>[],
): Promise<ProjectCouncilRunRead[]> {
  const results = await Promise.all(observations);
  const invalid = results.find((result) => result.kind === "invalid");
  if (invalid?.kind === "invalid")
    throw Error(
      `The actual Council result read was invalid: ${invalid.message}`,
    );
  return results.flatMap((result) =>
    result.kind === "verified" ? [result.read] : [],
  );
}
