import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { canonicalOwnedSessionStart } from "../../scripts/sessions/codex-owned-protocol";
import { ownedCodingPageSchema } from "../../scripts/sessions/codex-owned-journal";
import { ownedCodingStartReceiptSchema } from "../../scripts/sessions/codex-owned-wire-protocol";
import { geminiChatStartSchema } from "../../scripts/sessions/gemini-chat-owned-protocol";
import { loadConfig } from "../../scripts/config/load";
import { smithsViewSchema } from "../../apps/desktop/src/smiths-protocol";
import type { Smith } from "../../types/hearth";
import { HEARTH_HOME } from "../e2e/servers";

const SMITHS_READ_LIMIT = 1024 * 1024;
const START_REQUEST_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const CLONE_TIMEOUT_MS = 10_000;
const READBACK_HOLD_TIMEOUT_MS = 15_000;
let nextFixtureId = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Cache one authenticated catalog read and project the existing inert native fixture Smith for UI only. */
export async function installCachedGeminiSmithRead(
  page: Page,
  options: { token: string; header: string; smithName: string },
): Promise<Smith> {
  const origin = new URL(page.url()).origin;
  const path = "/__agent-forge/smiths";
  const live = await page.mainFrame().evaluate(
    async ({ path, token, header }) => {
      const response = await window.fetch(path, {
        method: "GET",
        headers: { [header]: token },
        signal: AbortSignal.timeout(10_000),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The live protected smith read had no body.");
      const chunks: Uint8Array[] = [];
      let length = 0,
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void reader.cancel().catch(() => undefined);
      }, 10_000);
      let text: string;
      try {
        while (true) {
          const next = await reader.read();
          if (timedOut)
            throw new Error("The live protected smith read timed out.");
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 1_048_576) {
            void reader.cancel().catch(() => undefined);
            throw new Error("The live protected smith read exceeded its bound.");
          }
          chunks.push(next.value);
        }
        if (timedOut)
          throw new Error("The live protected smith read timed out.");
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } finally {
        clearTimeout(timer);
        try {
          reader.releaseLock();
        } catch {
          // The bounded reader owns this one real fixture response.
        }
      }
      return { status: response.status, url: response.url, text };
    },
    { path, token: options.token, header: options.header },
  );
  let responseUrl: URL;
  try {
    responseUrl = new URL(live.url);
  } catch {
    throw new Error("The live protected smith response URL was invalid.");
  }
  if (
    live.status !== 200 ||
    responseUrl.origin !== origin ||
    responseUrl.pathname !== path ||
    responseUrl.search !== "" ||
    Buffer.byteLength(live.text, "utf8") > SMITHS_READ_LIMIT
  )
    throw new Error("The live protected smith read could not be verified.");
  let raw: unknown;
  try {
    raw = JSON.parse(live.text);
  } catch {
    throw new Error("The live protected smith read was not valid JSON.");
  }
  const envelope = z
    .object({
      ok: z.literal(true),
      data: smithsViewSchema,
      error: z.null(),
    })
    .strict()
    .safeParse(raw);
  if (!envelope.success)
    throw new Error("The live protected smith index did not match its schema.");
  const fixtureRoot = join(HEARTH_HOME, "gemini-native-fixture");
  const configuredSmith = loadConfig({
    harnessRoot: fixtureRoot,
    home: fixtureRoot,
    env: {},
  }).config.smiths[options.smithName];
  if (
    !configuredSmith ||
    configuredSmith.name !== "gemini-example" ||
    configuredSmith.provider !== "gemini" ||
    configuredSmith.model !== "configured-example" ||
    configuredSmith.effort !== "default" ||
    configuredSmith.enabled !== true ||
    configuredSmith.tags.length !== 0
  )
    throw new Error("The inert Gemini native config did not match its reviewed fixture.");
  const fixtureSmith: Smith = configuredSmith;
  const projectedView = smithsViewSchema.safeParse({
    ...envelope.data.data,
    smiths: [
      ...envelope.data.data.smiths.filter(
        (smith) => smith.name !== fixtureSmith.name,
      ),
      fixtureSmith,
    ],
  });
  if (!projectedView.success)
    throw new Error("The exact Gemini native fixture projection was invalid.");
  const cachedBody = JSON.stringify({
    ...envelope.data,
    data: projectedView.data,
  });
  await page.route("**/__agent-forge/smiths", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (
      request.frame() !== page.mainFrame() ||
      request.method() !== "GET" ||
      requestUrl.origin !== origin ||
      requestUrl.pathname !== path ||
      requestUrl.search !== ""
    ) {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: live.status,
      contentType: "application/json",
      body: cachedBody,
    });
  });
  return fixtureSmith;
}

type StartEvidence = {
  request: z.infer<typeof geminiChatStartSchema>;
  receipt: z.infer<typeof ownedCodingStartReceiptSchema>;
  requestHash: string;
};

type ReadbackEvidence = {
  requestId: string;
  sessionId: string;
  requestHash: string;
  turnHash: string;
};

type BrowserFetchOptions = {
  origin: string;
  projectId: string;
  sourceSessionId: string;
  handoff: string;
};

/** Observe one real Start and its automatic original read; never replay either request. */
export async function installGeminiContinuationFetchFixture(
  page: Page,
  options: BrowserFetchOptions,
) {
  const origin = new URL(options.origin).origin;
  const startPath = `/__agent-forge/projects/${encodeURIComponent(options.projectId)}/sessions`;
  const captureId = randomUUID();
  const bindingName = `__agentForgeContinuationCapture${++nextFixtureId}`;
  const stateName = `${bindingName}State`;
  const startEvidence = deferred<StartEvidence>();
  const readbackEvidence = deferred<ReadbackEvidence>();
  const readbackDelivered = deferred<void>();
  let expected: {
    requestId: string;
    sessionId: string;
    requestHash: string;
    turnHash: string;
  } | null = null;
  let readbackCaptured = false;
  let readbackRelease = () => {};
  let readbackReleased = new Promise<void>((resolve) => {
    readbackRelease = resolve;
  });
  let disposed = false;

  await page.exposeBinding(bindingName, async (source, value: unknown) => {
    if (disposed) throw new Error("The Gemini continuation capture was disposed.");
    if (source.frame !== page.mainFrame())
      throw new Error("The Gemini continuation capture did not come from the main frame.");
    if (new URL(source.frame.url()).origin !== origin)
      throw new Error("The Gemini continuation capture origin changed.");

    const startPayloadSchema = z
      .object({
        captureId: z.literal(captureId),
        kind: z.literal("start"),
        method: z.literal("POST"),
        requestUrl: z.string().url().max(2048),
        requestText: z.string().max(START_REQUEST_LIMIT),
        status: z.number().int().min(0).max(599),
        responseUrl: z.string().url().max(2048),
        responseText: z.string().max(RESPONSE_LIMIT),
      })
      .strict();
    const readbackPayloadSchema = z
      .object({
        captureId: z.literal(captureId),
        kind: z.literal("readback"),
        method: z.literal("GET"),
        requestUrl: z.string().url().max(2048),
        status: z.number().int().min(0).max(599),
        responseUrl: z.string().url().max(2048),
        responseText: z.string().max(RESPONSE_LIMIT),
      })
      .strict();

    const base = z
      .object({ captureId: z.string().uuid(), kind: z.string() })
      .passthrough()
      .safeParse(value);
    if (!base.success || base.data.captureId !== captureId)
      throw new Error("The Gemini continuation capture identity was invalid.");

    if (base.data.kind === "delivered") {
      const payload = z
        .object({
          captureId: z.literal(captureId),
          kind: z.literal("delivered"),
          requestId: z.string().uuid(),
          sessionId: z.string().min(1).max(200),
        })
        .strict()
        .parse(value);
      if (
        !expected ||
        !readbackCaptured ||
        payload.requestId !== expected.requestId ||
        payload.sessionId !== expected.sessionId
      )
        throw new Error("The original Gemini response delivery was not captured.");
      readbackDelivered.resolve();
      return { action: "observed-original-delivery" };
    }

    if (base.data.kind === "start") {
      try {
        const payload = startPayloadSchema.parse(value);
        const requestUrl = new URL(payload.requestUrl);
        const responseUrl = new URL(payload.responseUrl);
        if (
          requestUrl.origin !== origin ||
          requestUrl.pathname !== startPath ||
          requestUrl.search !== "" ||
          responseUrl.origin !== origin ||
          responseUrl.pathname !== startPath ||
          responseUrl.search !== "" ||
          payload.status !== 200 ||
          Buffer.byteLength(payload.requestText, "utf8") > START_REQUEST_LIMIT ||
          Buffer.byteLength(payload.responseText, "utf8") > RESPONSE_LIMIT
        )
          throw new Error("The native Start response did not match its target.");
        let rawRequest: unknown;
        let rawResponse: unknown;
        try {
          rawRequest = JSON.parse(payload.requestText);
          rawResponse = JSON.parse(payload.responseText);
        } catch {
          throw new Error("The native Start evidence was not valid JSON.");
        }
        const request = geminiChatStartSchema.safeParse(rawRequest);
        if (
          !request.success ||
          request.data.provider !== "gemini" ||
          request.data.launch.mode !== "chat" ||
          request.data.launch.prompt !== options.handoff ||
          !request.data.about?.some(
            (item) =>
              item.kind === "session" && item.id === options.sourceSessionId,
          )
        )
          throw new Error("The actual Gemini Start body did not match the reviewed request.");
        const envelope = z
          .object({
            ok: z.literal(true),
            data: ownedCodingStartReceiptSchema,
            error: z.null(),
          })
          .strict()
          .safeParse(rawResponse);
        if (!envelope.success)
          throw new Error("The actual Gemini Start receipt did not match its schema.");
        const receipt = envelope.data.data;
        if (
          receipt.session.provider !== "gemini" ||
          receipt.session.mode !== "chat" ||
          receipt.session.projectId !== options.projectId ||
          receipt.session.requestId !== request.data.requestId ||
          receipt.session.id !== receipt.receipt.conversationId ||
          receipt.receipt.turn.requestId !== request.data.requestId
        )
          throw new Error("The actual Gemini Start receipt did not identify this request.");
        const requestHash = createHash("sha256")
          .update(canonicalOwnedSessionStart(request.data))
          .digest("hex");
        if (receipt.session.requestHash !== requestHash)
          throw new Error("The actual Gemini Start receipt hash did not match the request.");
        const turnHash = receipt.receipt.turn.hash;
        expected = {
          requestId: request.data.requestId,
          sessionId: receipt.session.id,
          requestHash,
          turnHash,
        };
        startEvidence.resolve({ request: request.data, receipt, requestHash });
        return {
          action: "drop-accepted-start-response",
          requestId: expected.requestId,
          sessionId: expected.sessionId,
        };
      } catch (error) {
        startEvidence.reject(error);
        throw error;
      }
    }

    if (base.data.kind === "readback") {
      try {
        const payload = readbackPayloadSchema.parse(value);
        if (!expected) throw new Error("No verified Gemini Start preceded readback.");
        const requestUrl = new URL(payload.requestUrl);
        const responseUrl = new URL(payload.responseUrl);
        const targetPath = `${startPath}/${encodeURIComponent(expected.sessionId)}`;
        if (
          requestUrl.origin !== origin ||
          requestUrl.pathname !== targetPath ||
          requestUrl.searchParams.get("requestId") !== expected.requestId ||
          responseUrl.origin !== origin ||
          responseUrl.pathname !== targetPath ||
          responseUrl.search !== requestUrl.search ||
          payload.status !== 200 ||
          Buffer.byteLength(payload.responseText, "utf8") > RESPONSE_LIMIT
        )
          throw new Error("The protected original read did not match the accepted Start.");
        let raw: unknown;
        try {
          raw = JSON.parse(payload.responseText);
        } catch {
          throw new Error("The protected original read was not valid JSON.");
        }
        const envelope = z
          .object({
            ok: z.literal(true),
            data: ownedCodingPageSchema,
            error: z.null(),
          })
          .strict()
          .safeParse(raw);
        if (!envelope.success)
          throw new Error("The protected original read did not match its schema.");
        const saved = envelope.data.data;
        const turn =
          saved.request?.requestId === expected.requestId
            ? saved.request
            : saved.turns.find((item) => item.requestId === expected.requestId);
        const firstFrame = saved.frames.find((frame) => frame.seq === 1);
        if (
          saved.projectId !== options.projectId ||
          saved.conversationId !== expected.sessionId ||
          !turn ||
          turn.hash !== expected.turnHash ||
          !firstFrame ||
          firstFrame.turnId !== expected.requestId ||
          firstFrame.event.kind !== "user" ||
          firstFrame.event.text !== options.handoff ||
          !firstFrame.event.about?.some(
            (item) =>
              item.kind === "session" && item.id === options.sourceSessionId,
          )
        )
          throw new Error("The protected read did not prove the original Gemini request.");
        if (readbackCaptured)
          throw new Error("The original Gemini readback was captured more than once.");
        readbackCaptured = true;
        readbackEvidence.resolve({
          requestId: expected.requestId,
          sessionId: expected.sessionId,
          requestHash: expected.requestHash,
          turnHash: expected.turnHash,
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            readbackReleased,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("The original Gemini readback hold timed out.")),
                READBACK_HOLD_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        return { action: "deliver-original-response" };
      } catch (error) {
        readbackEvidence.reject(error);
        throw error;
      }
    }
    throw new Error("The Gemini continuation capture kind was unsupported.");
  });

  await page.evaluate(installNativeFetchObserver, {
    bindingName,
    stateName,
    captureId,
    origin,
    startPath,
    projectId: options.projectId,
    maxRequestBytes: START_REQUEST_LIMIT,
    maxResponseBytes: RESPONSE_LIMIT,
    cloneTimeoutMs: CLONE_TIMEOUT_MS,
  });

  return {
    waitForStart: () =>
      withTimeout(
        startEvidence.promise,
        CLONE_TIMEOUT_MS,
        "The accepted Gemini Start was not captured.",
      ),
    waitForOriginalReadback: () =>
      withTimeout(
        readbackEvidence.promise,
        CLONE_TIMEOUT_MS,
        "The original Gemini readback was not captured.",
      ),
    waitForOriginalReadbackDelivery: () =>
      withTimeout(
        readbackDelivered.promise,
        CLONE_TIMEOUT_MS,
        "The original Gemini response was not released.",
      ),
    releaseReadback() {
      readbackRelease();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      readbackRelease();
      try {
        await page.evaluate(({ stateName }) => {
          const globals = window as unknown as Record<string, unknown>;
          const state = globals[stateName] as
            | { originalFetch: typeof window.fetch; wrapper: typeof window.fetch }
            | undefined;
          if (state && window.fetch === state.wrapper)
            window.fetch = state.originalFetch;
          delete globals[stateName];
        }, { stateName });
      } catch {
        // Navigation may have replaced the document before cleanup.
      }
    },
  };
}

function installNativeFetchObserver(options: {
  bindingName: string;
  stateName: string;
  captureId: string;
  origin: string;
  startPath: string;
  projectId: string;
  maxRequestBytes: number;
  maxResponseBytes: number;
  cloneTimeoutMs: number;
}) {
  const globals = window as unknown as Record<string, unknown>;
  if (globals[options.stateName])
    throw new Error("A Gemini continuation fetch fixture is already installed.");
  const originalFetch = window.fetch;
  let target: { requestId: string; sessionId: string } | null = null;
  let startCaptured = false;
  let originalReadbackCaptured = false;

  const boundedText = async (
    stream: ReadableStream<Uint8Array> | null,
    maxBytes: number,
  ): Promise<string> => {
    if (!stream) return "";
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new Error("bounded-clone-size");
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    };
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => undefined);
            reject(new Error("bounded-clone-timeout"));
          }, options.cloneTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try {
        reader.releaseLock();
      } catch {
        // The clone reader never owns the application's original body.
      }
    }
  };

  const callBinding = (payload: unknown): Promise<unknown> => {
    const binding = globals[options.bindingName];
    if (typeof binding !== "function")
      return Promise.reject(new Error("The Gemini continuation binding is unavailable."));
    return (binding as (value: unknown) => Promise<unknown>)(payload);
  };

  const wrapper = async function (
    this: Window,
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const [input, init] = args;
    let url: URL;
    let method: string;
    try {
      url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
    } catch {
      return originalFetch.apply(this, args);
    }
    const isStart =
      !startCaptured &&
      method === "POST" &&
      url.origin === options.origin &&
      url.pathname === options.startPath &&
      url.search === "";
    const targetPath = target
      ? `${options.startPath}/${encodeURIComponent(target.sessionId)}`
      : "";
    const isReadback =
      method === "GET" &&
      target !== null &&
      !originalReadbackCaptured &&
      url.origin === options.origin &&
      url.pathname === targetPath &&
      url.searchParams.get("requestId") === target.requestId;
    if (!isStart && !isReadback) return originalFetch.apply(this, args);

    if (isStart) {
      startCaptured = true;
      let requestTextPromise: Promise<string>;
      try {
        requestTextPromise = boundedText(
          new Request(input, init).clone().body,
          options.maxRequestBytes,
        );
      } catch {
        return originalFetch.apply(this, args);
      }
      const response = await originalFetch.apply(this, args);
      let dropResponse = false;
      try {
        const [requestText, responseText] = await Promise.all([
          requestTextPromise,
          boundedText(response.clone().body, options.maxResponseBytes),
        ]);
        const rawRequest = JSON.parse(requestText) as { requestId?: unknown };
        const decision = await callBinding({
          captureId: options.captureId,
          kind: "start",
          method,
          requestUrl: url.href,
          requestText,
          status: response.status,
          responseUrl: response.url,
          responseText,
        }).catch(() => null);
        const result =
          typeof decision === "object" && decision !== null
            ? (decision as Record<string, unknown>)
            : null;
        if (
          result?.["action"] === "drop-accepted-start-response" &&
          typeof result["requestId"] === "string" &&
          result["requestId"] === rawRequest.requestId &&
          typeof result["sessionId"] === "string"
        ) {
          target = {
            requestId: result["requestId"],
            sessionId: result["sessionId"],
          };
          dropResponse = true;
        }
      } catch {
        // Failed evidence leaves the real native response untouched; the host test fails closed.
      }
      if (dropResponse)
        throw new TypeError("The accepted original Start response was lost.");
      return response;
    }

    originalReadbackCaptured = true;
    const response = await originalFetch.apply(this, args);
    try {
      const responseText = await boundedText(
        response.clone().body,
        options.maxResponseBytes,
      );
      const decision = await callBinding({
        captureId: options.captureId,
        kind: "readback",
        method,
        requestUrl: url.href,
        status: response.status,
        responseUrl: response.url,
        responseText,
      });
      if (
        typeof decision !== "object" ||
        decision === null ||
        (decision as Record<string, unknown>)["action"] !==
          "deliver-original-response"
      )
        return response;
      const delivered = await callBinding({
        captureId: options.captureId,
        kind: "delivered",
        requestId: target?.requestId,
        sessionId: target?.sessionId,
      });
      if (
        typeof delivered !== "object" ||
        delivered === null ||
        (delivered as Record<string, unknown>)["action"] !==
          "observed-original-delivery"
      )
        return response;
    } catch {
      return response;
    }
    return response;
  } as typeof window.fetch;
  const state = { originalFetch, wrapper };
  globals[options.stateName] = state;
  window.fetch = wrapper;
}
