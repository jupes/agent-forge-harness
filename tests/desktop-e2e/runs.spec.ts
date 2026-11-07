import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  expect,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
  type Route,
  type TestInfo,
  test,
} from "@playwright/test";
import { runsHref } from "../../apps/desktop/src/project-runs-model";

// Keep the fixed read bound local; hearth-read uses import.meta under Playwright.
const READ_TIMEOUT_MS = 45_000;

import type { ForgeState } from "../../scripts/forge/phases";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import {
  MAX_PROJECT_RUN_BYTES,
  projectRunArtifactSchema,
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../scripts/projects/run-protocol";
import type { ProjectRunDetail } from "../../types/project-runs";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";
import { seedObservationEvents } from "./observed-session-fixtures";
import { alpha, beta, seedProjects, workspace } from "./project-fixtures";

test.use({ channel: "chromium" });

const owned = new Map<string, string>();
const posts: string[] = [];
const releases: Array<() => void> = [];
let beforeDispatches: number[] = [];
let streams = 0;
let artifactReads = 0;
let fixture: ReturnType<typeof seedRuns>;
type RunsFilterEffectGate = {
  arm(): void;
  status(): {
    timerHeld: boolean;
    frameHeld: boolean;
    captures: number;
  };
  release(): Promise<void>;
};
type RunsFilterEffectGateWindow = Window & {
  __runsFilterEffectGate?: RunsFilterEffectGate;
};
type RunsAbortCallsite = { callsite: string | null };
type RunsAbortBrowserObserver = {
  (signal: AbortSignal): RunsAbortCallsite;
  armTarget(): void;
  snapshot(): {
    records: Array<{ stack: string | null }>;
    overflow: boolean;
    phase: "off" | "control" | "target";
    realm: "current-page-document";
    coverage: "target-phase" | "phase-gap";
    targetSignalCorrelation: "UNPROVEN";
    emptyRecordsInterpretation: "not-evidence-of-no-abort";
  };
  dispose(): void;
};
type RunsAbortObserverWindow = Window & {
  __runs107AbortProvenanceControlObserver?: RunsAbortBrowserObserver;
};
type RunsAbortRequestFacts = {
  response: boolean;
  finished: boolean;
  failure: "none" | "aborted" | "other" | "unreported";
};
const runsAbortCleanups = new WeakMap<Page, () => Promise<void>>();
type RunsBodyCapture = {
  status: number;
  url: string;
  redirected: boolean;
  text: string;
};
type RunsBodyOracle = {
  arm(id: string, url: string, budget: number): void;
  take(id: string): Promise<RunsBodyCapture>;
  complete(id: string): void;
  dispose(): void;
};
type RunsBodyOracleWindow = Window & {
  __runs1074BodyOracle?: RunsBodyOracle;
  __runs1074InitialBodyCleanup?: () => void;
};
type RunsBodyCleanup = {
  handle?: import("@playwright/test").JSHandle<RunsBodyOracle>;
  cleanup(): Promise<void>;
};
const runsBodyCleanups = new WeakMap<Page, RunsBodyCleanup>();

async function attemptRunsCleanups(cleanups: Array<() => unknown>) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Runs observer cleanup failed");
}
function throwRunsFailure(primary: unknown, additional: unknown[]): never {
  if (additional.length)
    throw new AggregateError(
      [primary, ...additional],
      "Runs primary and secondary failures",
    );
  throw primary;
}
async function installRunsBodyOracle(config: {
  mode: "install" | "controls";
  maxBytes: number;
  timeoutMs: number;
  fixtureBody?: unknown;
  initialArm?: { id: string; path: string };
}) {
  type BrowserFetch = Window["fetch"];
  const cancelReader = (phase: Phase) => {
    const reader = phase.reader;
    if (!reader) return;
    phase.reader = undefined;
    try {
      const cancellation = reader.cancel();
      void cancellation.catch((error: unknown) =>
        phase.cleanupErrors.push(error),
      );
    } catch (error) {
      phase.cleanupErrors.push(error);
    }
    try {
      reader.releaseLock();
    } catch (error) {
      phase.cleanupErrors.push(error);
    }
  };
  type Phase = {
    id: string;
    url: string;
    deadline: number;
    matches: number;
    taking: boolean;
    validated: boolean;
    error?: unknown;
    capture?: RunsBodyCapture;
    task?: Promise<RunsBodyCapture>;
    ready: Promise<void>;
    notify(): void;
    failure: Promise<never>;
    rejectFailure(error: unknown): void;
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    cleanupErrors: unknown[];
    timerCleared: boolean;
    timer?: number;
  };
  type Host = {
    fetch: BrowserFetch;
    __runs1074BodyOracle?: RunsBodyOracle;
  };
  function restoreOwned<T>(owner: T, installed: T, restore: () => void) {
    if (owner !== installed) throw Error("Runs fetch ownership changed");
    restore();
  }
  function create(delegate: BrowserFetch, maxBytes: number, timeoutMs: number) {
    let current: Phase | undefined;
    let previous: Phase | undefined;
    let disposed = false;
    const fail = (phase: Phase, error: unknown) => {
      if (phase.error) return;
      phase.error = error;
      phase.notify();
      phase.rejectFailure(error);
      cancelReader(phase);
    };
    const readClone = async (phase: Phase, response: Response) => {
      if (disposed || phase !== current)
        throw Error("Runs body response arrived in a retired phase");
      if (response.redirected || response.url !== phase.url)
        throw Error("Runs body response URL changed");
      if (response.status !== 200)
        throw Error("Runs body response was not HTTP 200");
      const reader = response.clone().body?.getReader();
      if (!reader) throw Error("Runs body response had no clone stream");
      phase.reader = reader;
      const chunks: Uint8Array[] = [];
      let size = 0;
      let eof = false;
      try {
        while (true) {
          if (phase.error) throw phase.error;
          if (Date.now() >= phase.deadline)
            throw Error("Runs body capture timed out");
          const part = await reader.read();
          if (phase.error || disposed)
            throw phase.error ?? Error("Runs observer is disposed");
          if (part.done) {
            eof = true;
            break;
          }
          size += part.value.byteLength;
          if (size > maxBytes)
            throw Error("Runs body response exceeded its byte limit");
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          status: response.status,
          url: response.url,
          redirected: response.redirected,
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
      } catch (error) {
        fail(phase, error);
        throw error;
      } finally {
        if (phase.reader === reader) {
          if (eof) {
            phase.reader = undefined;
            try {
              reader.releaseLock();
            } catch (error) {
              phase.cleanupErrors.push(error);
            }
          } else if (!phase.error) {
            fail(phase, Error("Runs clone read did not reach EOF"));
          }
        }
      }
    };
    const wrapped = function (
      this: unknown,
      ...args: Parameters<BrowserFetch>
    ) {
      let requestUrl = "";
      let method = "";
      try {
        const input = args[0];
        requestUrl =
          input instanceof Request
            ? input.url
            : new URL(String(input), location.href).href;
        method = (
          args[1]?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
      } catch {}
      const phase =
        current?.url === requestUrl && method === "GET"
          ? current
          : previous?.url === requestUrl && method === "GET"
            ? previous
            : undefined;
      const promise = Reflect.apply(delegate, this, args);
      if (!phase) return promise;
      phase.matches++;
      if (phase.matches > 1) {
        fail(phase, Error("Duplicate Runs body request"));
      } else if (disposed || phase !== current || phase.validated) {
        fail(phase, Error("Late Runs body request"));
      } else {
        void promise.then(
          (response) => {
            if (disposed || phase !== current || phase.error) {
              fail(phase, Error("Late Runs body response"));
              return;
            }
            phase.task = readClone(phase, response);
            void phase.task.then(
              (capture) => {
                if (disposed || phase !== current || phase.error) {
                  fail(
                    phase,
                    Error("Runs body capture completed after disposal"),
                  );
                  return;
                }
                phase.capture = capture;
                phase.notify();
              },
              (error: unknown) => fail(phase, error),
            );
          },
          (error: unknown) => fail(phase, error),
        );
      }
      return promise;
    };
    const makePhase = (id: string, url: string, budget: number): Phase => {
      let notify = () => {};
      let rejectFailure!: (error: unknown) => void;
      const ready = new Promise<void>((resolve) => (notify = resolve));
      const failure = new Promise<never>(
        (_, reject) => (rejectFailure = reject),
      );
      void failure.catch(() => {});
      const duration = Math.min(timeoutMs, budget);
      if (!Number.isFinite(duration) || duration <= 0)
        throw Error("Runs body budget must be finite and positive");
      const phase: Phase = {
        id,
        url,
        deadline: Date.now() + duration,
        matches: 0,
        taking: false,
        validated: false,
        ready,
        notify,
        failure,
        reader: undefined,
        cleanupErrors: [],
        timerCleared: false,
        rejectFailure,
      };
      phase.timer = window.setTimeout(
        () => fail(phase, Error("Runs body capture timed out")),
        duration,
      );
      return phase;
    };
    return {
      wrapped,
      arm(id: string, url: string, budget: number) {
        if (disposed) throw Error("Runs body observer is disposed");
        if (current && !current.validated)
          throw Error("Previous Runs body phase is not fully validated");
        if (previous)
          throw Error("Runs body observer supports only two sequential phases");
        if (current?.error) throw current.error;
        if (current?.id === id) throw Error("Runs body phase id was reused");
        const target = new URL(url);
        if (target.origin !== location.origin)
          throw Error("Runs body target must be same-origin");
        const next = makePhase(id, target.href, budget);
        if (current) previous = current;
        current = next;
      },
      async take(id: string) {
        const phase = current;
        if (
          disposed ||
          !phase ||
          phase.id !== id ||
          phase.taking ||
          phase.validated
        )
          throw Error(
            "Runs body phase is absent, active, complete, or disposed",
          );
        phase.taking = true;
        await Promise.race([phase.ready, phase.failure]);
        if (disposed || phase.error)
          throw phase.error ?? Error("Runs body observer is disposed");
        if (phase.matches !== 1 || !phase.task)
          throw Error("Runs body target was absent or ambiguous");
        const capture = await Promise.race([phase.task, phase.failure]);
        if (disposed || phase.error || phase !== current)
          throw phase.error ?? Error("Runs body phase changed during capture");
        phase.capture = capture;
        return capture;
      },
      complete(id: string) {
        const phase = current;
        if (
          disposed ||
          !phase ||
          phase.id !== id ||
          !phase.taking ||
          phase.validated
        )
          throw Error("Runs body phase cannot be completed");
        if (Date.now() >= phase.deadline)
          fail(phase, Error("Runs body validation timed out"));
        if (phase.error) throw phase.error;
        if (phase.cleanupErrors.length)
          throw new AggregateError(
            phase.cleanupErrors,
            "Runs body cleanup failed before validation",
          );
        if (phase.matches !== 1 || !phase.capture)
          throw Error("Runs body capture was not validated");
        phase.validated = true;
        if (phase.timer !== undefined && !phase.timerCleared) {
          clearTimeout(phase.timer);
          phase.timerCleared = true;
        }
      },
      dispose() {
        disposed = true;
        const errors: unknown[] = [];
        for (const phase of [previous, current]) {
          if (!phase) continue;
          if (!phase.validated && !phase.error)
            fail(phase, Error("Runs body observer was disposed while active"));
          if (phase.timer !== undefined && !phase.timerCleared) {
            clearTimeout(phase.timer);
            phase.timerCleared = true;
          }
          if (phase.reader) cancelReader(phase);
          if (phase.error) errors.push(phase.error);
          errors.push(...phase.cleanupErrors);
        }
        if (errors.length)
          throw new AggregateError(errors, "Runs body observer cleanup failed");
      },
    };
  }
  const installOn = (host: Host, delegate: BrowserFetch): RunsBodyOracle => {
    if (host.__runs1074BodyOracle)
      throw Error("Runs body oracle already installed");
    const engine = create(delegate, config.maxBytes, config.timeoutMs);
    const original = delegate;
    const wrapper = engine.wrapped as BrowserFetch;
    const handle: RunsBodyOracle = {
      arm: engine.arm,
      take: engine.take,
      complete: engine.complete,
      dispose() {
        const errors: unknown[] = [];
        try {
          engine.dispose();
        } catch (error) {
          errors.push(error);
        }
        try {
          restoreOwned(host.fetch, wrapper, () => {
            host.fetch = original;
          });
        } catch (error) {
          errors.push(error);
        }
        if (host.__runs1074BodyOracle === handle)
          delete host.__runs1074BodyOracle;
        else errors.push(Error("Runs body oracle ownership changed"));
        if (errors.length)
          throw new AggregateError(errors, "Runs body cleanup failed");
      },
    };
    host.fetch = wrapper;
    host.__runs1074BodyOracle = handle;
    return handle;
  };
  const response = (url: string, body: BodyInit, status = 200) => {
    const value = new Response(body, { status });
    Object.defineProperty(value, "url", { value: url });
    return value;
  };
  const assert = (value: unknown, message: string) => {
    if (!value) throw Error(message);
  };
  const errorMessage = (error: unknown): string =>
    error instanceof AggregateError
      ? error.errors.map(errorMessage).join(" ")
      : error instanceof Error
        ? error.message
        : String(error);
  type CloneFacts = {
    cancelCalls: number;
    releaseCalls: number;
    readCalls: number;
    cloneBody: ReadableStream<Uint8Array> | null;
    cancelFailure?: Error;
    releaseFailure?: Error;
    onRead?: (count: number) => void;
  };
  const instrumentNativeClone = (fixture: Response, facts: CloneFacts) => {
    const originalClone = fixture.clone.bind(fixture);
    Object.defineProperty(fixture, "clone", {
      value: () => {
        const cloned = originalClone();
        const body = cloned.body;
        facts.cloneBody = body;
        if (body) {
          const getReader = body.getReader.bind(body);
          Object.defineProperty(body, "getReader", {
            value: () => {
              const reader = getReader();
              return new Proxy(reader, {
                get(target, property) {
                  if (property === "read")
                    return () => {
                      facts.readCalls++;
                      const result = target.read();
                      facts.onRead?.(facts.readCalls);
                      return result;
                    };
                  if (property === "cancel")
                    return () => {
                      facts.cancelCalls++;
                      const actual = target.cancel();
                      if (facts.cancelFailure) {
                        void actual.catch(() => {});
                        return Promise.reject(facts.cancelFailure);
                      }
                      return actual;
                    };
                  if (property === "releaseLock")
                    return () => {
                      facts.releaseCalls++;
                      target.releaseLock();
                      if (facts.releaseFailure) throw facts.releaseFailure;
                    };
                  return Reflect.get(target, property, target);
                },
              });
            },
          });
        }
        return cloned;
      },
    });
  };
  if (config.mode === "controls") {
    const endpoint = new URL("/__runs-oracle-control", location.href).href;
    let calls = 0;
    const answer = response(
      endpoint,
      JSON.stringify(config.fixtureBody ?? { ok: true }),
    );
    let seenThis: unknown;
    let seenArgs: Parameters<BrowserFetch> | undefined;
    const expected = Promise.resolve(answer);
    const delegate = function (
      this: Window,
      ...args: Parameters<BrowserFetch>
    ) {
      calls++;
      seenThis = this;
      seenArgs = args;
      return expected;
    } as BrowserFetch;
    const engine = create(delegate, config.maxBytes, config.timeoutMs);
    engine.arm("success", endpoint, config.timeoutMs);
    const signal = new AbortController().signal;
    const request = new Request(endpoint, { method: "POST", signal });
    const requestSignal = request.signal;
    const init = { method: "GET", signal };
    const thisValue = {} as Window;
    const returned = Reflect.apply(engine.wrapped, thisValue, [request, init]);
    assert(returned === expected, "Fetch promise identity changed");
    assert(
      seenThis === thisValue &&
        seenArgs?.[0] === request &&
        seenArgs[1] === init,
      "Fetch this or argument identity changed",
    );
    const original = await returned;
    assert(
      calls === 1 && original === answer,
      "Fetch invocation or Response identity changed",
    );
    const capture = await engine.take("success");
    engine.complete("success");
    assert(
      capture.text === JSON.stringify(config.fixtureBody ?? { ok: true }),
      "Same-response capture changed raw text",
    );
    assert(
      request.signal === requestSignal && init.signal === signal,
      "Fetch signal identity changed",
    );
    engine.dispose();

    const unrelatedUrl = new URL("/unrelated", location.href).href;
    let interleavedCalls = 0;
    const interleaved = create(
      ((input) => {
        interleavedCalls++;
        const url =
          input instanceof Request
            ? input.url
            : new URL(String(input), location.href).href;
        return Promise.resolve(
          response(url, url === endpoint ? '{"ok":true}' : '{"ignored":true}'),
        );
      }) as BrowserFetch,
      config.maxBytes,
      config.timeoutMs,
    );
    interleaved.arm("interleave", endpoint, config.timeoutMs);
    await interleaved.wrapped(unrelatedUrl);
    await interleaved.wrapped(new Request(unrelatedUrl, { method: "POST" }));
    const override = new Request(endpoint, { method: "POST" });
    await interleaved.wrapped(override, { method: "GET" });
    const interleavedCapture = await interleaved.take("interleave");
    interleaved.complete("interleave");
    assert(
      interleavedCalls === 3 && interleavedCapture.url === endpoint,
      "Unrelated call or effective method handling failed",
    );
    interleaved.dispose();

    const reason = Error("control rejection");
    const rejectedPromise = Promise.reject(reason);
    void rejectedPromise.catch(() => {});
    const rejected = create(
      (() => rejectedPromise) as BrowserFetch,
      config.maxBytes,
      config.timeoutMs,
    );
    rejected.arm("rejection", endpoint, config.timeoutMs);
    const rejectedReturn = rejected.wrapped(endpoint);
    assert(
      rejectedReturn === rejectedPromise,
      "Rejected promise identity changed",
    );
    let sameReason = false;
    try {
      await rejectedReturn;
    } catch (error) {
      sameReason = error === reason;
    }
    let observerRejected = false;
    try {
      await rejected.take("rejection");
    } catch {
      observerRejected = true;
    }
    assert(
      sameReason && observerRejected,
      "Original rejection changed or was hidden",
    );
    try {
      rejected.dispose();
    } catch {}

    const zero = create(delegate, config.maxBytes, 5);
    zero.arm("zero", endpoint, 5);
    await zero.wrapped(unrelatedUrl);
    let zeroReason = "";
    try {
      await zero.take("zero");
    } catch (error) {
      zeroReason = error instanceof Error ? error.message : String(error);
    }
    assert(
      zeroReason.includes("timed out"),
      "Zero-match phase failed for the wrong reason",
    );
    try {
      zero.dispose();
    } catch {}

    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const stalledResponse = response(endpoint, stalled);
    const slow = create(
      (() => Promise.resolve(stalledResponse)) as BrowserFetch,
      config.maxBytes,
      10,
    );
    slow.arm("duplicate", endpoint, 10);
    slow.wrapped(endpoint);
    await Promise.resolve();
    slow.wrapped(endpoint);
    let duplicateReason = "";
    try {
      await slow.take("duplicate");
    } catch (error) {
      duplicateReason = error instanceof Error ? error.message : String(error);
    }
    assert(
      duplicateReason.includes("Duplicate"),
      "Pending duplicate failed for the wrong reason",
    );
    try {
      slow.dispose();
    } catch {}

    const oldUrl = endpoint + "?phase=old";
    const newUrl = endpoint + "?phase=new";
    const phases = create(
      ((input) => {
        const url =
          input instanceof Request
            ? input.url
            : new URL(String(input), location.href).href;
        return Promise.resolve(response(url, JSON.stringify({ url })));
      }) as BrowserFetch,
      config.maxBytes,
      config.timeoutMs,
    );
    phases.arm("old", oldUrl, config.timeoutMs);
    const firstResponse = phases.wrapped(oldUrl);
    const firstCapture = await phases.take("old");
    let prematureArmRejected = false;
    try {
      phases.arm("premature", endpoint + "?phase=premature", config.timeoutMs);
    } catch {
      prematureArmRejected = true;
    }
    assert(
      prematureArmRejected,
      "Observer accepted a new phase before validation",
    );
    phases.complete("old");
    assert(
      (await firstResponse).url === oldUrl && firstCapture.url === oldUrl,
      "First phase did not capture its forwarded response",
    );
    let invalidUrlRejected = false;
    let invalidBudgetRejected = false;
    try {
      phases.arm("bad-url", "https://example.invalid/runs", config.timeoutMs);
    } catch {
      invalidUrlRejected = true;
    }
    try {
      phases.arm("bad-budget", endpoint + "?phase=bad-budget", 0);
    } catch {
      invalidBudgetRejected = true;
    }
    assert(
      invalidUrlRejected && invalidBudgetRejected,
      "Invalid second phase was accepted",
    );
    phases.arm("new", newUrl, config.timeoutMs);
    phases.wrapped(oldUrl);
    phases.wrapped(newUrl);
    const secondCapture = await phases.take("new");
    phases.complete("new");
    assert(
      secondCapture.url === newUrl,
      "Second phase did not capture its own response",
    );
    const terminal = create(
      (() => Promise.resolve(response(endpoint, "{}"))) as BrowserFetch,
      config.maxBytes,
      config.timeoutMs,
    );
    terminal.arm("terminal", endpoint, config.timeoutMs);
    terminal.wrapped(endpoint);
    await terminal.take("terminal");
    terminal.complete("terminal");
    terminal.wrapped(endpoint);
    let terminalAuditReason = "";
    try {
      terminal.dispose();
    } catch (error) {
      terminalAuditReason = errorMessage(error);
    }
    assert(
      terminalAuditReason.includes("Duplicate"),
      "Post-validation duplicate escaped terminal audit",
    );
    let terminalDuplicateReason = "";
    try {
      phases.dispose();
    } catch (error) {
      terminalDuplicateReason = errorMessage(error);
    }
    assert(
      terminalDuplicateReason.includes("Duplicate"),
      "Duplicate after successful validation was not audited",
    );

    let finishLate!: (value: Response) => void;
    let lateCloneStarts = 0;
    const lateUrl = endpoint + "?phase=late";
    const latePromise = new Promise<Response>((resolve) => {
      finishLate = resolve;
    });
    const late = create(
      (() => latePromise) as BrowserFetch,
      config.maxBytes,
      config.timeoutMs,
    );
    late.arm("late", lateUrl, config.timeoutMs);
    late.wrapped(lateUrl);
    const lateResponse = response(
      lateUrl,
      new ReadableStream<Uint8Array>({ start() {} }),
    );
    const originalClone = lateResponse.clone.bind(lateResponse);
    Object.defineProperty(lateResponse, "clone", {
      value: () => {
        lateCloneStarts++;
        return originalClone();
      },
    });
    try {
      late.dispose();
    } catch {}
    finishLate(lateResponse);
    await Promise.resolve();
    await Promise.resolve();
    try {
      late.dispose();
    } catch {}
    assert(lateCloneStarts === 0, "Disposed phase started a late clone reader");
    let disposedArmRejected = false;
    try {
      late.arm("after-dispose", lateUrl, config.timeoutMs);
    } catch {
      disposedArmRejected = true;
    }
    assert(disposedArmRejected, "Disposed observer accepted another phase");
    const failures: Array<[string, Response, number]> = [
      ["non200", response(endpoint, "{}", 503), config.maxBytes],
      ["malformed-json", response(endpoint, "not-json"), config.maxBytes],
      ["truncated-json", response(endpoint, "{"), config.maxBytes],
      [
        "invalid-utf8",
        response(endpoint, new Uint8Array([255])),
        config.maxBytes,
      ],
      ["oversize", response(endpoint, "123456"), 4],
      [
        "body-rejection",
        response(
          endpoint,
          new ReadableStream({
            start(controller) {
              controller.error(Error("fixture body error"));
            },
          }),
        ),
        config.maxBytes,
      ],
      [
        "stall",
        response(endpoint, new ReadableStream<Uint8Array>({ start() {} })),
        config.maxBytes,
      ],
    ];
    for (const [name, fixtureResponse, bound] of failures) {
      const controlTimeout = name === "stall" ? 8 : 1000;
      const facts: CloneFacts = {
        cancelCalls: 0,
        releaseCalls: 0,
        readCalls: 0,
        cloneBody: null,
      };
      if (name === "oversize") {
        facts.cancelFailure = Error("observed cancel cleanup failure");
        facts.releaseFailure = Error("observed release cleanup failure");
      }
      instrumentNativeClone(fixtureResponse, facts);
      const failed = create(
        (() => Promise.resolve(fixtureResponse)) as BrowserFetch,
        bound,
        controlTimeout,
      );
      failed.arm(name, endpoint, controlTimeout);
      failed.wrapped(endpoint);
      let observed: unknown;
      try {
        const result = await failed.take(name);
        if (name === "malformed-json" || name === "truncated-json")
          JSON.parse(result.text);
      } catch (error) {
        observed = error;
      }
      const message =
        observed instanceof Error ? observed.message : String(observed);
      const expected =
        name === "non200"
          ? message.includes("HTTP 200")
          : name === "malformed-json" || name === "truncated-json"
            ? observed instanceof SyntaxError
            : name === "invalid-utf8"
              ? observed instanceof TypeError
              : name === "oversize"
                ? message.includes("byte limit")
                : name === "body-rejection"
                  ? message.includes("fixture body error")
                  : message.includes("timed out");
      assert(
        expected,
        name + " did not fail for its expected reason: " + message,
      );
      if (
        name === "invalid-utf8" ||
        name === "oversize" ||
        name === "body-rejection" ||
        name === "stall"
      )
        assert(
          facts.releaseCalls === 1 && facts.cloneBody?.locked === false,
          name + " did not release its actual clone reader lock",
        );
      if (name === "oversize" || name === "body-rejection" || name === "stall")
        assert(
          facts.cancelCalls === 1,
          name + " did not cancel its actual clone reader",
        );
      let cleanupFailure: unknown;
      if (name === "oversize") {
        await Promise.resolve();
        assert(
          (await fixtureResponse.text()) === "123456",
          "Clone cancellation changed the original response",
        );
      }
      try {
        failed.dispose();
      } catch (error) {
        cleanupFailure = error;
      }
      if (name === "oversize")
        assert(
          errorMessage(cleanupFailure).includes("byte limit") &&
            errorMessage(cleanupFailure).includes(
              "observed cancel cleanup failure",
            ) &&
            errorMessage(cleanupFailure).includes(
              "observed release cleanup failure",
            ),
          "Primary body and observed cleanup failures were not retained",
        );
    }

    const timerResponse = response(endpoint, "{}");
    const timerEngine = create(
      (() => Promise.resolve(timerResponse)) as BrowserFetch,
      config.maxBytes,
      100,
    );
    timerEngine.arm("timer-control", endpoint, 100);
    timerEngine.wrapped(endpoint);
    await timerEngine.take("timer-control");
    timerEngine.complete("timer-control");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 125));
    let timerCleanupError: unknown;
    try {
      timerEngine.dispose();
    } catch (error) {
      timerCleanupError = error;
    }
    assert(
      !timerCleanupError,
      "Completed phase timer fired after its deadline was cleared",
    );

    let pendingReadStarted!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      pendingReadStarted = resolve;
    });
    const activeUrl = endpoint + "?phase=active-dispose";
    const activeFixture = response(
      activeUrl,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
        },
      }),
    );
    const activeFacts: CloneFacts = {
      cancelCalls: 0,
      releaseCalls: 0,
      readCalls: 0,
      cloneBody: null,
      onRead(count) {
        if (count === 2) pendingReadStarted();
      },
    };
    instrumentNativeClone(activeFixture, activeFacts);
    const activeEngine = create(
      (() => Promise.resolve(activeFixture)) as BrowserFetch,
      config.maxBytes,
      1000,
    );
    activeEngine.arm("active-dispose", activeUrl, 1000);
    const activeResponse = activeEngine.wrapped(activeUrl);
    const activeTake = activeEngine.take("active-dispose");
    await activeResponse;
    let pendingReadTimeout: number | undefined;
    try {
      await Promise.race([
        pendingRead,
        new Promise<void>((_, reject) => {
          pendingReadTimeout = window.setTimeout(
            () => reject(Error("Active clone read control timed out")),
            1000,
          );
        }),
      ]);
    } finally {
      if (pendingReadTimeout !== undefined)
        window.clearTimeout(pendingReadTimeout);
    }
    try {
      activeEngine.dispose();
    } catch {}
    let activeTakeFailure: unknown;
    try {
      await activeTake;
    } catch (error) {
      activeTakeFailure = error;
    }
    let postDisposeTakeRejected = false;
    try {
      await activeEngine.take("active-dispose");
    } catch {
      postDisposeTakeRejected = true;
    }
    let postDisposeCompleteRejected = false;
    try {
      activeEngine.complete("active-dispose");
    } catch {
      postDisposeCompleteRejected = true;
    }
    assert(
      errorMessage(activeTakeFailure).includes("disposed while active") &&
        postDisposeTakeRejected &&
        postDisposeCompleteRejected,
      "Active disposal did not settle observer work or reject post-disposal calls",
    );
    assert(
      activeFacts.readCalls === 2 &&
        activeFacts.cancelCalls === 1 &&
        activeFacts.releaseCalls === 1 &&
        activeFacts.cloneBody?.locked === false &&
        activeFixture.body?.locked === false,
      "Active cancellation became EOF or leaked the owned reader lock",
    );

    const globalFetch = window.fetch;
    const inertHost: Host = { fetch: delegate };
    const installed = installOn(inertHost, delegate);
    installed.arm("installed", endpoint, config.timeoutMs);
    const installedPromise = inertHost.fetch(endpoint);
    const installedCapture = await installed.take("installed");
    installed.complete("installed");
    assert(
      (await installedPromise) === answer &&
        installedCapture.text === capture.text,
      "Shared installer changed forwarding or capture",
    );
    installed.dispose();
    assert(
      inertHost.fetch === delegate && !inertHost.__runs1074BodyOracle,
      "Owned inert cleanup did not restore both globals",
    );
    assert(
      window.fetch === globalFetch,
      "Inert install changed the real page fetch",
    );
    const foreignHost: Host = { fetch: delegate };
    let foreignDisposed = false;
    const ownedHandle = installOn(foreignHost, delegate);
    const foreignFetch = (() => Promise.resolve(answer)) as BrowserFetch;
    const foreignOracle: RunsBodyOracle = {
      arm() {},
      async take() {
        return capture;
      },
      complete() {},
      dispose() {
        foreignDisposed = true;
      },
    };
    foreignHost.fetch = foreignFetch;
    foreignHost.__runs1074BodyOracle = foreignOracle;
    let ownershipRejected = false;
    try {
      ownedHandle.dispose();
    } catch {
      ownershipRejected = true;
    }
    assert(
      ownershipRejected &&
        foreignHost.fetch === foreignFetch &&
        foreignHost.__runs1074BodyOracle === foreignOracle &&
        !foreignDisposed &&
        window.fetch === globalFetch,
      "Owned cleanup overwrote or disposed a foreign owner",
    );
    return { text: capture.text };
  }

  const installed = installOn(window as RunsBodyOracleWindow, window.fetch);
  if (config.initialArm) {
    let disposed = false;
    Object.defineProperty(window, "__runs1074InitialBodyCleanup", {
      value: () => {
        if (disposed) return;
        disposed = true;
        installed.dispose();
      },
      writable: false,
      configurable: false,
    });
    installed.arm(
      config.initialArm.id,
      new URL(config.initialArm.path, location.href).href,
      config.timeoutMs,
    );
  }
  return installed;
}
async function installRunsCaptureHandle(page: Page) {
  const handle = (await page.evaluateHandle(installRunsBodyOracle, {
    mode: "install" as const,
    maxBytes: MAX_PROJECT_RUN_BYTES + 1024,
    timeoutMs: READ_TIMEOUT_MS,
  })) as import("@playwright/test").JSHandle<RunsBodyOracle>;
  runsBodyCleanups.set(page, {
    handle,
    async cleanup() {
      await attemptRunsCleanups([
        async () => {
          await handle.evaluate((oracle) => oracle.dispose());
        },
        () => handle.dispose(),
      ]);
    },
  });
  return handle;
}
async function readRunsBodyCapture(
  page: Page,
  response: PlaywrightResponse,
  id: string,
  validate: (detail: ProjectRunDetail) => void,
  testInfo: TestInfo,
) {
  const request = response.request();
  expect(request.method()).toBe("GET");
  expect(request.url()).toBe(response.url());
  expect(request.frame()).toBe(page.mainFrame());
  const capture = await page.evaluate(async (phaseId) => {
    const oracle = (window as RunsBodyOracleWindow).__runs1074BodyOracle;
    if (!oracle) throw Error("Runs body oracle was not installed");
    return oracle.take(phaseId);
  }, id);
  try {
    expect(response.status()).toBe(200);
    expect(capture.status).toBe(response.status());
    expect(capture.url).toBe(response.url());
    expect(capture.redirected).toBe(false);
    const detail = runDetailFromEnvelope(JSON.parse(capture.text) as unknown);
    validate(detail);
    await page.evaluate((phaseId) => {
      const oracle = (window as RunsBodyOracleWindow).__runs1074BodyOracle;
      if (!oracle) throw Error("Runs body oracle was not installed");
      oracle.complete(phaseId);
    }, id);
    return detail;
  } catch (primaryError) {
    const failures: unknown[] = [primaryError];
    try {
      await testInfo.attach("runs-body-" + id + "-failure.json", {
        body: JSON.stringify({
          id,
          status: capture.status,
          url: capture.url,
          redirected: capture.redirected,
          text: capture.text,
          error:
            primaryError instanceof Error
              ? primaryError.message
              : String(primaryError),
        }),
        contentType: "application/json",
      });
    } catch (error) {
      failures.push(error);
    }
    throwRunsFailure(primaryError, failures.slice(1));
  }
}
function createRunsAbortObserver(page: Page, expectedPath: string) {
  let active = false,
    origin = "",
    after = 0,
    matches = 0,
    duplicate = false,
    overflow = false,
    eventCount = 0,
    navigation = false;
  const states = new Map<PlaywrightRequest, RunsAbortRequestFacts>();
  const tick = () => {
    if (eventCount < 8) eventCount++;
    else overflow = true;
  };
  const onRequest = (request: PlaywrightRequest) => {
    if (!active) return;
    try {
      const url = new URL(request.url());
      if (
        request.method() !== "GET" ||
        url.origin !== origin ||
        url.pathname !== expectedPath ||
        url.search !== "?after=" + after + "&limit=100"
      )
        return;
      if (states.has(request)) return;
      matches++;
      if (matches > 1) duplicate = true;
      if (states.size >= 2) {
        overflow = true;
        return;
      }
      states.set(request, {
        response: false,
        finished: false,
        failure: "none",
      });
      tick();
    } catch {
      overflow = true;
    }
  };
  const onResponse = (response: PlaywrightResponse) => {
    try {
      const facts = states.get(response.request());
      if (!active || !facts) return;
      tick();
      facts.response = true;
    } catch {
      overflow = true;
    }
  };
  const onFinished = (request: PlaywrightRequest) => {
    const facts = states.get(request);
    if (!active || !facts) return;
    tick();
    facts.finished = true;
  };
  const onFailed = (request: PlaywrightRequest) => {
    const facts = states.get(request);
    if (!active || !facts) return;
    tick();
    try {
      const errorText = request.failure()?.errorText;
      facts.failure =
        errorText === undefined
          ? "unreported"
          : errorText.includes("ERR_ABORTED")
            ? "aborted"
            : "other";
    } catch {
      facts.failure = "unreported";
    }
  };
  const onNavigation = (frame: import("@playwright/test").Frame) => {
    if (!active || frame !== page.mainFrame()) return;
    tick();
    navigation = true;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("framenavigated", onNavigation);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    active = false;
    try {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
      page.off("framenavigated", onNavigation);
    } catch {}
    try {
      await withinRunsDeadline(
        page.evaluate(() => {
          const observer = Reflect.get(
            window,
            "__runs107AbortProvenanceControlObserver",
          );
          if (observer && typeof observer.dispose === "function")
            observer.dispose();
        }),
        500,
      );
    } catch {}
  };
  runsAbortCleanups.set(page, dispose);
  return {
    install: () =>
      page.addInitScript(() => {
        const host = window as RunsAbortObserverWindow;
        let phase: "off" | "control" | "target" = "off";
        let control: RunsAbortCallsite = { callsite: null };
        const records: Array<{ stack: string | null }> = [];
        let overflow = false;
        const descriptor = Object.getOwnPropertyDescriptor(
          AbortController.prototype,
          "abort",
        );
        const original = descriptor?.value as
          | AbortController["abort"]
          | undefined;
        const wrapped = function (
          this: AbortController,
          ...args: Parameters<AbortController["abort"]>
        ) {
          if (!original) return;
          const result = Reflect.apply(original, this, args);
          try {
            if (phase === "off") return result;
            const raw = new Error().stack;
            const frames =
              typeof raw === "string"
                ? raw
                    .split("\n")
                    .slice(2, 6)
                    .map((frame) =>
                      frame
                        .replace(/\b[a-z][a-z\d+.-]*:[^\s)]+/gi, "[redacted]")
                        .slice(0, 128),
                    )
                : [];
            const stack = frames.length
              ? frames.join("\n").slice(0, 512)
              : null;
            if (phase === "control" && stack?.includes("controlledAbortProbe"))
              control.callsite = "controlledAbortProbe";
            else if (phase === "target") {
              if (records.length < 8) records.push({ stack });
              else overflow = true;
            }
          } catch {
            if (phase === "target") overflow = true;
          }
          return result;
        };
        if (descriptor && original)
          Object.defineProperty(AbortController.prototype, "abort", {
            ...descriptor,
            value: wrapped,
          });
        const observer = Object.assign(
          (_signal: AbortSignal) => {
            phase = "control";
            control = { callsite: null };
            return control;
          },
          {
            armTarget() {
              phase = "target";
            },
            snapshot() {
              return {
                records: records.slice(),
                overflow,
                phase,
                realm: "current-page-document",
                coverage: phase === "target" ? "target-phase" : "phase-gap",
                targetSignalCorrelation: "UNPROVEN",
                emptyRecordsInterpretation: "not-evidence-of-no-abort",
              };
            },
            dispose() {
              phase = "off";
              if (
                descriptor &&
                Object.getOwnPropertyDescriptor(
                  AbortController.prototype,
                  "abort",
                )?.value === wrapped
              )
                Object.defineProperty(
                  AbortController.prototype,
                  "abort",
                  descriptor,
                );
              if (host.__runs107AbortProvenanceControlObserver === observer)
                delete host.__runs107AbortProvenanceControlObserver;
            },
          },
        ) as RunsAbortBrowserObserver;
        host.__runs107AbortProvenanceControlObserver = observer;
      }),
    arm(afterValue: number) {
      after = afterValue;
      try {
        origin = new URL(page.url()).origin;
      } catch {
        overflow = true;
      }
      active = true;
    },
    facts(request: PlaywrightRequest) {
      const selected = states.get(request);
      return {
        matches,
        duplicate,
        overflow,
        eventCount,
        navigation,
        selectedTracked: !!selected,
        response: selected?.response ?? false,
        finished: selected?.finished ?? false,
        failure: selected?.failure ?? "unreported",
      };
    },
    dispose,
  };
}

async function withinRunsDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function attachRunsAbortFailure(
  page: Page,
  testInfo: TestInfo,
  response: PlaywrightResponse,
  observer: ReturnType<typeof createRunsAbortObserver>,
) {
  try {
    let browser: unknown;
    try {
      browser = await withinRunsDeadline(
        page.evaluate(() => {
          try {
            return (
              Reflect.get(
                window,
                "__runs107AbortProvenanceControlObserver",
              )?.snapshot?.() ?? null
            );
          } catch {
            return null;
          }
        }),
        500,
      );
    } catch {
      browser = undefined;
    }
    let finished = "unavailable";
    try {
      finished =
        (await withinRunsDeadline(
          response.finished().then(
            (error) => (error === null ? "complete" : "error"),
            () => "error",
          ),
          500,
        )) ?? "timeout";
    } catch {
      finished = "unavailable";
    }
    const body = JSON.stringify({
      read: "rejected",
      observation:
        "successful AbortController.abort calls in the current page realm only",
      targetSignalCorrelation: "UNPROVEN",
      browser: browser ?? {
        available: false,
        phase: "unavailable",
        realm: "unavailable",
        coverage: "phase-gap",
        targetSignalCorrelation: "UNPROVEN",
        emptyRecordsInterpretation: "not-evidence-of-no-abort",
        records: [],
        overflow: true,
      },
      request: observer.facts(response.request()),
      finished,
    });
    const boundedBody =
      Buffer.byteLength(body) <= 8192
        ? body
        : JSON.stringify({ truncated: true });
    await withinRunsDeadline(
      testInfo.attach("runs-abort-provenance.json", {
        body: boundedBody,
        contentType: "application/json",
      }),
      500,
    );
  } catch {}
}
function dispatches() {
  return (
    [
      ["codex-fixture-calls.jsonl", "task"],
      ["gemini-fixture-calls.jsonl", "task"],
      ["codex-chat-fixture-calls.jsonl", "process"],
      ["gemini-chat-fixture-calls.json", "start"],
      ["keeper-fixture-starts.jsonl", "started"],
      ["coding-fixture-starts.jsonl", "line"],
    ] as const
  ).map(([name, kind]) => {
    const path = join(HEARTH_HOME, name);
    if (!existsSync(path)) return 0;
    const text = readFileSync(path, "utf8");
    let values: unknown;
    try {
      values = name?.endsWith(".json")
        ? JSON.parse(text)
        : text
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    } catch {
      throw Error("Invalid inert provider dispatch recording");
    }
    if (!Array.isArray(values))
      throw Error("Incomplete inert provider dispatch recording");
    if (kind === "line") return values.length;
    return values.filter(
      (entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        (kind === "started"
          ? "started" in entry && entry.started === true
          : "kind" in entry && entry.kind === kind),
    ).length;
  });
}
function publish(path: string, data: unknown) {
  const bytes = JSON.stringify(data);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
  owned.set(path, bytes);
}
function remove(path: string) {
  const expected = owned.get(path);
  if (expected === undefined)
    throw Error("This is not an owned run fixture path");
  if (existsSync(path)) {
    expect(readFileSync(path, "utf8")).toBe(expected);
    unlinkSync(path);
  }
  owned.delete(path);
  expect(existsSync(path)).toBe(false);
}
function seedRuns() {
  const prefix = `e2e-inspect-${process.pid}-${randomUUID().slice(0, 8)}`;
  const checkout = realpathSync.native(process.cwd());
  const path = (slug: string) =>
    join(checkout, ".tmp", "work", "forge-runs", `${slug}.json`);
  const primary = `${prefix}-main`,
    shipped = `${prefix}-shipped`,
    legacy = `${prefix}-legacy`,
    foreign = `${prefix}-beta`;
  const base: ForgeState = {
    schemaVersion: 2,
    slug: primary,
    feature: "Scoped forge delivery",
    epic: "alpha-epic",
    phase: "plan",
    completed: ["research", "plan"],
    artifacts: { research: `plans/research/${primary}.md` },
    mode: "gated",
    checkout,
    updatedAt: "2026-10-23T13:00:00.000Z",
    reviews: [
      {
        phase: "plan",
        round: 1,
        verdict: "FAIL",
        findings: { blocker: 0, high: 1, medium: 2, low: 0 },
        summary: "Recorded review <script>must remain text</script>",
        at: "2026-10-23T12:15:00.000Z",
      },
    ],
  };
  const research = `# Verified research\n\n<script>must remain text</script>\n\n![inert image](https://example.com/image.png)\n\n[Safe link](https://example.com/research)\n`;
  const researchPath = join(checkout, `plans/research/${primary}.md`);
  mkdirSync(dirname(researchPath), { recursive: true });
  writeFileSync(researchPath, research, { flag: "wx" });
  owned.set(researchPath, research);
  publish(path(primary), base);
  publish(path(shipped), {
    ...base,
    slug: shipped,
    feature: "Shipped forge delivery",
    phase: "ship",
    completed: ["research", "plan", "implement", "ship"],
    reviews: [],
  });
  publish(path(legacy), {
    ...base,
    slug: legacy,
    feature: "Historical unattended run",
    mode: "auto",
    reviews: [],
  });
  publish(path(foreign), {
    ...base,
    slug: foreign,
    feature: "FOREIGN BETA RUN",
    epic: "beta-epic",
    reviews: [],
  });
  const gate = {
    schemaVersion: 2,
    event: "TaskCompleted",
    timestamp: "2026-10-23T13:00:00.000Z",
    checkout,
    branch: "fixture/run-inspection",
    beadsIssueId: "alpha-epic",
    executionRunId: primary,
    passed: false,
    checks: [
      { name: "typecheck", passed: true },
      {
        name: "lint",
        passed: false,
        output: "Recorded lint failure\nPRIVATE GATE OUTPUT",
      },
      {
        name: "tests",
        passed: true,
        skipped: true,
        skipReason: "Not requested",
      },
    ],
  };
  const logs = [
    {
      event: "TaskCompleted",
      timestamp: "2026-10-23T12:00:00.000Z",
      checkout,
      forgeSlug: primary,
      passed: true,
      checks: [],
    },
    gate,
    {
      ...gate,
      timestamp: "2026-10-23T14:00:00.000Z",
      beadsIssueId: "beta-epic",
      passed: true,
    },
    {
      ...gate,
      timestamp: "2026-10-23T14:01:00.000Z",
      checkout: join(checkout, "foreign"),
      passed: true,
    },
    {
      ...gate,
      timestamp: "2026-10-23T14:02:00.000Z",
      executionRunId: null,
      beadsIssueId: null,
      passed: true,
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const logPath = join(
    HEARTH_HOME,
    "run-gate-logs",
    "2026-10-23",
    "quality-gate.jsonl",
  );
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, logs, { flag: "wx" });
  owned.set(logPath, logs);
  return { primary, shipped, legacy, foreign, path, research };
}
function recordRunSessions(runId: string, count: number) {
  const worktree = realpathSync.native(process.cwd());
  const sessionIds: string[] = [];
  const events: import("../../types/hearth").LedgerEventInput[] = [];
  for (let index = 0; index < count; index++) {
    const sessionId = `run-session-${randomUUID()}`;
    events.push({
      kind: "session.started",
      workspace,
      beadId: "alpha-epic",
      runId,
      sessionId,
      payload: {
        source: "headless:claude",
        kind: "headless",
        worktree,
      },
    });
    sessionIds.push(sessionId);
  }
  seedObservationEvents(events);
  return sessionIds;
}
function held() {
  let release!: () => void;
  const wait = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
  releases.push(wait.release);
  return wait;
}
async function protectedRead(page: Page, path: string) {
  const token = await pageToken(page);
  return page.evaluate(
    async ({ path, token, header }) => {
      const response = await fetch(`/__agent-forge${path}`, {
        headers: { [header]: token },
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw Error("Incomplete protected read fixture");
      }
      return { status: response.status, body };
    },
    { path, token, header: OPERATOR_HEADER },
  );
}
function matchesRunDetailPage(response: PlaywrightResponse, after: number) {
  const url = new URL(response.url());
  if (
    url.pathname !==
      `/__agent-forge/projects/${alpha.id}/runs/${fixture.primary}` ||
    url.search !== `?after=${after}&limit=100`
  )
    return false;
  return true;
}
function runDetailFromEnvelope(body: unknown) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("ok" in body) ||
    body.ok !== true ||
    !("data" in body)
  )
    throw Error("Missing protected Run detail response");
  return projectRunDetailSchema.parse(body.data);
}
function assertRunMembership(
  history: ReturnType<typeof availableHistory>,
  expected: string,
) {
  if (history.membershipKey !== expected)
    throw Error("Recorded-session page did not match verified membership");
}
function availableHistory(detail: ProjectRunDetail, after: number) {
  const history = detail.sessionHistory;
  if (!history || history.status !== "available" || history.after !== after)
    throw Error("Recorded-session page did not match its requested cursor");
  return history;
}
/** Playwright's server-side forward must retain the browser's declared same-origin boundary. */
async function forwardRun(route: Route) {
  const response = await route.fetch({
    headers: {
      ...route.request().headers(),
      Origin: new URL(route.request().url()).origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });
  expect(response.status()).toBe(200);
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw Error("Incomplete forwarded run read");
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("data" in envelope)
  )
    throw Error("The forwarded run read was not a verified protected answer");
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.includes("/artifacts/"))
    projectRunArtifactSchema.parse(envelope.data);
  else if (pathname.endsWith("/runs"))
    projectRunsPageSchema.parse(envelope.data);
  else projectRunDetailSchema.parse(envelope.data);
  return response;
}
const href = (project = alpha.id, slug: string | null = null) =>
  `/index.html${runsHref(project, slug)}`;

test.beforeAll(async ({ browser }, testInfo) => {
  const observedBrowserVersion = browser.version();
  await testInfo.attach("runs-fixed-runtime.json", {
    body: JSON.stringify({
      requestedChannel: "chromium",
      observedBrowserVersion,
      expectedBrowserVersion: "153.0.8010.12",
    }),
    contentType: "application/json",
  });
  expect(observedBrowserVersion).toBe("153.0.8010.12");
});

test.beforeEach(({ page }) => {
  seedProjects();
  fixture = seedRuns();
  posts.length = 0;
  artifactReads = 0;
  streams = 0;
  beforeDispatches = dispatches();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/__agent-forge/stream") streams++;
    if (new URL(request.url()).pathname.includes("/artifacts/"))
      artifactReads++;
    if (
      request.method() === "POST" &&
      request.url().includes("/__agent-forge/")
    )
      posts.push(request.url());
  });
});
test.afterEach(async ({ page }) => {
  const errors: unknown[] = [];
  try {
    await attemptRunsCleanups([
      () => runsBodyCleanups.get(page)?.cleanup(),
      () => runsAbortCleanups.get(page)?.(),
    ]);
  } catch (error) {
    errors.push(error);
  }
  runsBodyCleanups.delete(page);
  runsAbortCleanups.delete(page);
  for (const release of releases.splice(0)) {
    try {
      release();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  } catch (error) {
    errors.push(error);
  }
  for (const path of [...owned.keys()]) {
    try {
      remove(path);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    expect(posts).toEqual([]);
  } catch (error) {
    errors.push(error);
  }
  try {
    expect(dispatches()).toEqual(beforeDispatches);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Runs observer and fixture cleanup failed",
    );
});
function checkpoint(
  id: string,
  issueType: "feature" | "task",
  status: "open" | "in_progress",
  parent: string,
  blocker?: string,
) {
  return {
    id,
    title: id,
    issue_type: issueType,
    status,
    priority: 2,
    created_at: "2026-10-29T00:00:00.000Z",
    updated_at: "2026-10-29T00:00:00.000Z",
    labels: ["project:alpha"],
    dependencies: [
      { issue_id: id, depends_on_id: parent, type: "parent-child" },
      ...(blocker
        ? [{ issue_id: id, depends_on_id: blocker, type: "blocks" }]
        : []),
    ],
  };
}

test("selected run shows its scoped checkpoints and prefills only the current bead in Council", async ({
  page,
}) => {
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    Object.assign(state, {
      "alpha-feature": checkpoint(
        "alpha-feature",
        "feature",
        "open",
        "alpha-epic",
      ),
      "alpha-active": checkpoint(
        "alpha-active",
        "task",
        "in_progress",
        "alpha-feature",
      ),
      "alpha-second": checkpoint(
        "alpha-second",
        "task",
        "in_progress",
        "alpha-feature",
      ),
      "alpha-next": checkpoint(
        "alpha-next",
        "task",
        "open",
        "alpha-feature",
        "alpha-active",
      ),
    });
    writeState(BD_STAND_IN_STATE, state);
  });
  await openSettled(page, href(alpha.id, fixture.primary));
  const detail = page.getByRole("article", { name: "Selected forge run" });
  const checkpoints = detail.getByRole("region", { name: "Run checkpoints" });
  const active = checkpoints.locator('[data-checkpoint-id="alpha-active"]');
  const second = checkpoints.locator('[data-checkpoint-id="alpha-second"]');
  const waiting = checkpoints.locator('[data-checkpoint-id="alpha-next"]');
  await expect(active).toContainText("In progress");
  await expect(second).toContainText("In progress");
  await expect(waiting).toContainText("Open");
  await expect(waiting).toContainText("waiting on alpha-active");
  await expect(
    waiting.getByRole("button", { name: "Send alpha-next to Council" }),
  ).toHaveCount(0);
  await active
    .getByRole("button", { name: "Send alpha-active to Council" })
    .click();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(page.getByLabel("Source type")).toHaveValue("bead");
  await expect(page.getByLabel("Beads issue ID")).toHaveValue("alpha-active");
  await page.goBack();
  await expect(detail).toBeVisible();
  const secondAction = second.getByRole("button", {
    name: "Send alpha-second to Council",
  });
  await expect(secondAction).toBeEnabled();
  await secondAction.click();
  const replace = page.getByRole("dialog", {
    name: "Replace Council draft source?",
  });
  await expect(replace).toBeVisible();
  await replace.getByRole("button", { name: "Replace source" }).click();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(page.getByLabel("Beads issue ID")).toHaveValue("alpha-second");
  expect(posts).toEqual([]);
});

test("scoped Runs keyboard inspection preserves real phase, review and gate truth through Activity, Back and reload without writes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, href());
  const runs = page.getByRole("region", { name: "Project forge runs" });
  await expect(
    runs.getByRole("table", { name: "Recorded forge runs" }),
  ).toBeVisible();
  await expect(runs.getByText("FOREIGN BETA RUN", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    runs.getByRole("button", { name: "New forge run" }),
  ).toBeEnabled();
  const link = runs.getByRole("link", {
    name: "Scoped forge delivery",
    exact: true,
  });
  await link.focus();
  await expect(link).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const detail = page.getByRole("article", { name: "Selected forge run" });
  await expect(
    detail.getByRole("heading", { name: "Scoped forge delivery", exact: true }),
  ).toBeVisible();
  const showInspector = page.getByRole("button", {
    name: "Show inspector",
    exact: true,
  });
  if (await showInspector.isVisible()) {
    await showInspector.focus();
    await expect(showInspector).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
  }
  const inspector = page.getByRole("complementary", {
    name: "Inspector",
    exact: true,
  });
  await expect(inspector).toBeVisible();
  const runMetadata = inspector.getByRole("region", {
    name: "Run metadata",
    exact: true,
  });
  await expect(runMetadata).toBeVisible();
  await expect(runMetadata).toContainText("Scoped forge delivery");
  await expect(runMetadata).toContainText(fixture.primary);
  for (const [phase, state] of [
    ["research", "complete"],
    ["plan", "complete"],
    ["implement", "active"],
    ["ship", "locked"],
  ] as const)
    await expect(detail.locator(`[data-phase="${phase}"]`)).toHaveAttribute(
      "data-state",
      state,
    );
  expect(artifactReads).toBe(0);
  const readArtifact = detail.getByRole("button", {
    name: "Read research artifact",
  });
  await readArtifact.focus();
  await expect(readArtifact).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const artifact = page.getByRole("region", { name: "Verified run artifact" });
  await expect(
    artifact.getByText("Verified research", { exact: true }),
  ).toBeVisible();
  await expect(
    artifact.getByText("<script>must remain text</script>", { exact: true }),
  ).toBeVisible();
  await expect(artifact.locator("script, img")).toHaveCount(0);
  await expect(
    artifact.getByRole("link", { name: "Safe link" }),
  ).toHaveAttribute("href", "https://example.com/research");
  expect(artifactReads).toBe(1);
  const shotDir = process.env["SHOT_DIR"];
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    await artifact.screenshot({
      path: join(shotDir, "runs-artifact.png"),
      animations: "disabled",
    });
  }
  await expect(detail.getByText("Gate failed", { exact: true })).toBeVisible();
  const checks = detail.getByRole("table", { name: "Gate checks" }).first();
  await expect(
    checks.getByRole("row", { name: "typecheck Pass No detail reported." }),
  ).toBeVisible();
  await expect(
    checks.getByRole("row", { name: "lint Fail Recorded lint failure" }),
  ).toBeVisible();
  await expect(
    checks.getByRole("row", { name: "tests Skipped Not requested" }),
  ).toBeVisible();
  await expect(
    checks.getByRole("row", {
      name: "clean-tree Not run No matching check was recorded.",
    }),
  ).toBeVisible();
  await expect(
    detail.getByText("Full or Mini is not recorded.", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("Start time is not recorded.", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("Recorded review <script>must remain text</script>", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(detail.locator("script")).toHaveCount(0);
  await expect(
    page.getByText("PRIVATE GATE OUTPUT", { exact: false }),
  ).toHaveCount(0);
  const earlier = detail.locator("summary");
  await earlier.focus();
  await page.keyboard.press("Enter");
  await expect(earlier).toHaveCSS("outline-width", "2px");
  expect(streams).toBe(1);
  await expect(
    detail.getByRole("table", { name: "Gate checks" }).nth(1),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/runs-gate-history.png",
    fullPage: true,
    mask: [
      page.locator(".af-runs-source code"),
      page.locator(".af-run-artifact code"),
    ],
    maskColor: "#3f424d",
    style: ".af-project-runs time { visibility: hidden !important; }",
  });
  // The shell scrolls its main pane, so fullPage alone cannot reveal the heading/phases.
  // Capture the overview separately after the functional compact-layout/focus checks.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.locator("main").evaluate((element) => element.scrollTo(0, 0));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const researchPhase = detail.locator('[data-phase="research"]');
  const researchArtifactButton = researchPhase.getByRole("button", {
    name: "Read research artifact",
  });
  await expect(researchArtifactButton).toBeVisible();
  const phaseBox = await researchPhase.boundingBox();
  const artifactButtonBox = await researchArtifactButton.boundingBox();
  expect(phaseBox).not.toBeNull();
  expect(artifactButtonBox).not.toBeNull();
  if (!phaseBox || !artifactButtonBox)
    throw new Error("Research artifact layout could not be measured.");
  expect(artifactButtonBox.x).toBeGreaterThanOrEqual(phaseBox.x - 1);
  expect(artifactButtonBox.x + artifactButtonBox.width).toBeLessThanOrEqual(
    phaseBox.x + phaseBox.width + 1,
  );
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/runs-inspection.png",
    fullPage: true,
    mask: [
      page.locator(".af-runs-source code"),
      page.locator(".af-run-artifact code"),
    ],
    maskColor: "#3f424d",
    style: ".af-project-runs time { visibility: hidden !important; }",
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await detail.getByRole("link", { name: "Open run Activity" }).click();
  await expect(page.getByLabel("Run filter", { exact: true })).toHaveValue(
    fixture.primary,
  );
  await page.goBack();
  await expect(
    detail.getByRole("heading", { name: "Scoped forge delivery", exact: true }),
  ).toBeVisible();
  await reloadSettled(page);
  await expect(
    detail.getByRole("heading", { name: "Scoped forge delivery", exact: true }),
  ).toBeVisible();
  const answer = await protectedRead(
    page,
    `/projects/${alpha.id}/runs/${fixture.primary}`,
  );
  expect(answer.status).toBe(200);
  const envelope = answer.body;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("data" in envelope)
  )
    throw Error("Protected run was not verified");
  const actual = projectRunDetailSchema.parse(envelope.data);
  expect(actual.run.gatePassed).toBe(false);
  expect(actual.gateHistory.map((gate) => gate.link)).toEqual([
    "linked",
    "legacy",
  ]);
  await openSettled(page, href(beta.id, fixture.foreign));
  const betaDetail = page.getByRole("article", {
    name: "Selected forge run",
  });
  await expect(
    betaDetail.getByRole("heading", { name: "FOREIGN BETA RUN", exact: true }),
  ).toBeVisible();
  const showBetaInspector = page.getByRole("button", {
    name: "Show inspector",
    exact: true,
  });
  if (await showBetaInspector.isVisible()) await showBetaInspector.click();
  const betaMetadata = page
    .getByRole("complementary", { name: "Inspector", exact: true })
    .getByRole("region", { name: "Run metadata", exact: true });
  await expect(betaMetadata).toContainText("FOREIGN BETA RUN");
  await expect(betaMetadata).not.toContainText("Scoped forge delivery");
});

test("recorded run sessions page in the served project and open only admitted metadata", async ({
  page,
}) => {
  const sessions = recordRunSessions(fixture.primary, 101);
  await openSettled(page, href(alpha.id, fixture.primary));
  const history = page.getByRole("region", {
    name: "Recorded sessions for this run",
  });
  await expect(history.getByText(sessions[0]!, { exact: true })).toBeVisible();
  await expect(history.getByText(sessions[100]!, { exact: true })).toHaveCount(
    0,
  );
  await history
    .getByRole("button", { name: "Load more recorded sessions" })
    .click();
  await expect(
    history.getByText(sessions[100]!, { exact: true }),
  ).toBeVisible();
  await history
    .getByRole("heading", { name: "Sessions", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("recorded-run-sessions.png"),
  });

  await history
    .getByRole("link", { name: "Open session metadata" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Session metadata", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", {
        name: "Session metadata details",
        exact: true,
      })
      .getByText(sessions[0]!, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Session start recorded", { exact: true }),
  ).toBeVisible();

  await openSettled(page, href(beta.id, fixture.foreign));
  const betaHistory = page.getByRole("region", {
    name: "Recorded sessions for this run",
  });
  await expect(
    betaHistory.getByText(sessions[0]!, { exact: true }),
  ).toHaveCount(0);
  expect(posts).toEqual([]);
  expect(dispatches()).toEqual(beforeDispatches);
});

test("a changed run-session admission key keeps the old page stale and disables metadata links and paging", async ({
  page,
}, testInfo) => {
  const sessions = recordRunSessions(fixture.primary, 101);
  const abortObserver = createRunsAbortObserver(
    page,
    "/__agent-forge/projects/" + alpha.id + "/runs/" + fixture.primary,
  );
  await abortObserver.install();
  runsBodyCleanups.set(page, {
    async cleanup() {
      await page.evaluate(() =>
        (window as RunsBodyOracleWindow).__runs1074InitialBodyCleanup?.(),
      );
    },
  });
  await page.addInitScript(installRunsBodyOracle, {
    mode: "install" as const,
    maxBytes: MAX_PROJECT_RUN_BYTES + 1024,
    timeoutMs: READ_TIMEOUT_MS,
    initialArm: {
      id: "initial-page",
      path: `/__agent-forge/projects/${alpha.id}/runs/${fixture.primary}?after=0&limit=100`,
    },
  });
  const initialPageResponse = page.waitForResponse((response) =>
    matchesRunDetailPage(response, 0),
  );
  await openSettled(page, href(alpha.id, fixture.primary));
  const initialDetail = await readRunsBodyCapture(
    page,
    await initialPageResponse,
    "initial-page",
    (detail) => {
      availableHistory(detail, 0);
    },
    testInfo,
  );
  const initialHistory = availableHistory(initialDetail, 0);
  await runsBodyCleanups.get(page)!.cleanup();
  runsBodyCleanups.delete(page);
  const nextAfter = initialHistory.nextAfter;
  const history = page.getByRole("region", {
    name: "Recorded sessions for this run",
  });
  await expect(history.getByText(sessions[0]!, { exact: true })).toBeVisible();
  await expect(
    history.getByRole("link", { name: "Open session metadata" }).first(),
  ).toBeVisible();

  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    Object.assign(state, {
      "alpha-membership-added": checkpoint(
        "alpha-membership-added",
        "feature",
        "open",
        "alpha-epic",
      ),
    });
    writeState(BD_STAND_IN_STATE, state);
  });

  const changedRead = await protectedRead(
    page,
    `/projects/${alpha.id}/runs/${fixture.primary}?after=0&limit=100`,
  );
  expect(changedRead.status).toBe(200);
  const changedDetail = runDetailFromEnvelope(changedRead.body);
  expect(changedDetail.run.slug).toBe(fixture.primary);
  expect(changedDetail.run.epic).toBe("alpha-epic");
  const changedHistory = availableHistory(changedDetail, 0);
  expect(changedHistory.membershipKey).not.toBe(initialHistory.membershipKey);

  const controlResult = await page.evaluate(installRunsBodyOracle, {
    mode: "controls" as const,
    maxBytes: MAX_PROJECT_RUN_BYTES + 1024,
    timeoutMs: READ_TIMEOUT_MS,
    fixtureBody: changedRead.body,
  });
  if (
    !controlResult ||
    typeof controlResult !== "object" ||
    !("text" in controlResult) ||
    typeof controlResult.text !== "string"
  )
    throw Error("Runs browser-body controls did not return their capture");
  const controlDetail = runDetailFromEnvelope(
    JSON.parse(controlResult.text) as unknown,
  );
  const controlHistory = availableHistory(controlDetail, 0);
  expect(controlHistory.membershipKey).toBe(changedHistory.membershipKey);
  let wrongMembershipRejected = false;
  try {
    assertRunMembership(controlHistory, "wrong-membership");
  } catch {
    wrongMembershipRejected = true;
  }
  expect(wrongMembershipRejected).toBe(true);
  expect(controlHistory.membershipKey).not.toBe(initialHistory.membershipKey);
  expect(() => availableHistory(controlDetail, nextAfter)).toThrow();
  expect(() => runDetailFromEnvelope({ ok: true, data: {} })).toThrow();
  expect(() => runDetailFromEnvelope({ ok: false, data: null })).toThrow();
  let secondCleanupAttempted = false;
  let cleanupControlError: unknown;
  const firstCleanupFailure = Error("owned observer cleanup control");
  const secondCleanupFailure = Error("JSHandle cleanup control");
  try {
    await attemptRunsCleanups([
      () => {
        throw firstCleanupFailure;
      },
      () => {
        secondCleanupAttempted = true;
        throw secondCleanupFailure;
      },
    ]);
  } catch (error) {
    cleanupControlError = error;
  }
  expect(secondCleanupAttempted).toBe(true);
  expect(cleanupControlError).toBeInstanceOf(AggregateError);
  if (!(cleanupControlError instanceof AggregateError))
    throw Error("Dual cleanup failures were not retained");
  expect(cleanupControlError.errors).toEqual([
    firstCleanupFailure,
    secondCleanupFailure,
  ]);
  const primaryFailure = Error("primary validation failure");
  const secondaryFailure = Error("evidence attachment failure");
  let retainedFailure: unknown;
  try {
    throwRunsFailure(primaryFailure, [secondaryFailure]);
  } catch (error) {
    retainedFailure = error;
  }
  expect(retainedFailure).toBeInstanceOf(AggregateError);
  if (!(retainedFailure instanceof AggregateError))
    throw Error("Primary failure was not retained");
  expect(retainedFailure.errors).toEqual([primaryFailure, secondaryFailure]);
  await installRunsCaptureHandle(page);
  const abortControl = await page.evaluate(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal]);
    const read = Reflect.get(
      window,
      "__runs107AbortProvenanceControlObserver",
    )?.(signal);
    const controlledAbortProbe = () => controller.abort();
    controlledAbortProbe();
    return read ?? null;
  });
  expect(abortControl).toMatchObject({ callsite: "controlledAbortProbe" });
  await page.evaluate(() => {
    const observer = Reflect.get(
      window,
      "__runs107AbortProvenanceControlObserver",
    );
    if (typeof observer === "function") observer.armTarget();
  });
  abortObserver.arm(nextAfter);
  const changedPageUrl = new URL(
    "/__agent-forge/projects/" +
      alpha.id +
      "/runs/" +
      fixture.primary +
      "?after=" +
      nextAfter +
      "&limit=100",
    page.url(),
  ).href;
  const changedPhaseTimeout = READ_TIMEOUT_MS;
  await page.evaluate(
    ({ id, url, budget }) => {
      const oracle = (window as RunsBodyOracleWindow).__runs1074BodyOracle;
      if (!oracle) throw Error("Runs body oracle was not installed");
      oracle.arm(id, url, budget);
    },
    { id: "changed-page", url: changedPageUrl, budget: changedPhaseTimeout },
  );

  const nextPageResponse = page.waitForResponse((response) =>
    matchesRunDetailPage(response, nextAfter),
  );
  await history
    .getByRole("button", { name: "Load more recorded sessions" })
    .click();
  const selectedResponse = await nextPageResponse;
  let nextHistory: ReturnType<typeof availableHistory> | undefined;
  try {
    await readRunsBodyCapture(
      page,
      selectedResponse,
      "changed-page",
      (detail) => {
        const historyPage = availableHistory(detail, nextAfter);
        nextHistory = historyPage;
        assertRunMembership(historyPage, changedHistory.membershipKey);
        expect(historyPage.membershipKey).not.toBe(
          initialHistory.membershipKey,
        );
      },
      testInfo,
    );
  } catch (originalError) {
    try {
      await attachRunsAbortFailure(
        page,
        testInfo,
        selectedResponse,
        abortObserver,
      );
    } catch {}
    throw originalError;
  }
  if (!nextHistory) throw Error("Changed page body was not validated");
  assertRunMembership(nextHistory, changedHistory.membershipKey);
  expect(nextHistory.membershipKey).not.toBe(initialHistory.membershipKey);

  await expect(history).toContainText(
    "Project or session membership changed while reading this run",
  );
  await expect(history.getByText(sessions[0]!, { exact: true })).toBeVisible();
  await expect(history.getByText(sessions[100]!, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    history.getByRole("link", { name: "Open session metadata" }),
  ).toHaveCount(0);
  await expect(
    history.getByRole("button", { name: "Load more recorded sessions" }),
  ).toBeDisabled();

  const refreshedPageResponse = page.waitForResponse((response) =>
    matchesRunDetailPage(response, 0),
  );
  await runsBodyCleanups.get(page)!.cleanup();
  runsBodyCleanups.delete(page);
  const bodyHandle = await installRunsCaptureHandle(page);
  await bodyHandle.evaluate(
    (oracle, config) => oracle.arm(config.id, config.url, config.budget),
    {
      id: "refreshed-page",
      url: new URL(
        `/__agent-forge/projects/${alpha.id}/runs/${fixture.primary}?after=0&limit=100`,
        page.url(),
      ).href,
      budget: READ_TIMEOUT_MS,
    },
  );
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  const refreshedDetail = await readRunsBodyCapture(
    page,
    await refreshedPageResponse,
    "refreshed-page",
    (detail) => {
      assertRunMembership(
        availableHistory(detail, 0),
        changedHistory.membershipKey,
      );
    },
    testInfo,
  );
  const refreshedHistory = availableHistory(refreshedDetail, 0);
  expect(refreshedHistory.membershipKey).toBe(changedHistory.membershipKey);
  await expect(history).not.toContainText(
    "Project or session membership changed while reading this run",
  );
  await expect(
    history.getByRole("link", { name: "Open session metadata" }).first(),
  ).toBeVisible();
  await expect(
    history.getByRole("button", { name: "Load more recorded sessions" }),
  ).toBeEnabled();

  const recoveredPageResponse = page.waitForResponse((response) =>
    matchesRunDetailPage(response, refreshedHistory.nextAfter),
  );
  const recoveredPageUrl = new URL(
    "/__agent-forge/projects/" +
      alpha.id +
      "/runs/" +
      fixture.primary +
      "?after=" +
      refreshedHistory.nextAfter +
      "&limit=100",
    page.url(),
  ).href;
  const recoveredPhaseTimeout = READ_TIMEOUT_MS;
  await page.evaluate(
    ({ id, url, budget }) => {
      const oracle = (window as RunsBodyOracleWindow).__runs1074BodyOracle;
      if (!oracle) throw Error("Runs body oracle was not installed");
      oracle.arm(id, url, budget);
    },
    {
      id: "recovered-page",
      url: recoveredPageUrl,
      budget: recoveredPhaseTimeout,
    },
  );
  await history
    .getByRole("button", { name: "Load more recorded sessions" })
    .click();
  const recoveredResponse = await recoveredPageResponse;
  let recoveredHistory: ReturnType<typeof availableHistory> | undefined;
  try {
    await readRunsBodyCapture(
      page,
      recoveredResponse,
      "recovered-page",
      (detail) => {
        const historyPage = availableHistory(
          detail,
          refreshedHistory.nextAfter,
        );
        recoveredHistory = historyPage;
        assertRunMembership(historyPage, changedHistory.membershipKey);
      },
      testInfo,
    );
  } catch (originalError) {
    try {
      await attachRunsAbortFailure(
        page,
        testInfo,
        recoveredResponse,
        abortObserver,
      );
    } catch {}
    throw originalError;
  }
  if (!recoveredHistory) throw Error("Recovered page body was not validated");
  assertRunMembership(recoveredHistory, changedHistory.membershipKey);
  await expect(
    history.getByText(sessions[100]!, { exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([]);
  expect(dispatches()).toEqual(beforeDispatches);
});

test("Runs filters and verified empty/loading/error states never claim unavailable sources are empty", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalSetTimeout = (
      window.setTimeout as unknown as (
        callback: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) => number
    ).bind(window);
    const originalClearTimeout = (
      window.clearTimeout as unknown as (id?: number) => void
    ).bind(window);
    const originalRequestAnimationFrame =
      window.requestAnimationFrame.bind(window);
    const originalCancelAnimationFrame =
      window.cancelAnimationFrame.bind(window);
    const heldTimerId = -1;
    const heldFrameId = -2;
    let armed = false;
    let heldTimer:
      | { callback: TimerHandler; delay: number; args: unknown[] }
      | undefined;
    let heldFrame: FrameRequestCallback | undefined;
    let captures = 0;

    window.setTimeout = ((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (
        armed &&
        delay === 35 &&
        typeof callback === "function" &&
        !heldTimer
      ) {
        const candidate = { callback, delay, args };
        heldTimer = candidate;
        queueMicrotask(() => {
          if (armed && heldTimer === candidate && !heldFrame) {
            heldTimer = undefined;
            originalSetTimeout(callback, delay, ...args);
          }
        });
        return heldTimerId;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as unknown as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== heldTimerId) originalClearTimeout(id);
    }) as unknown as typeof window.clearTimeout;
    window.requestAnimationFrame = ((callback) => {
      if (armed && heldTimer && !heldFrame) {
        heldFrame = callback;
        captures += 1;
        return heldFrameId;
      }
      return originalRequestAnimationFrame(callback);
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id) => {
      if (id !== heldFrameId) originalCancelAnimationFrame(id);
    }) as typeof window.cancelAnimationFrame;

    (window as RunsFilterEffectGateWindow).__runsFilterEffectGate = {
      arm() {
        heldTimer = undefined;
        heldFrame = undefined;
        captures = 0;
        armed = true;
      },
      status() {
        return {
          timerHeld: !!heldTimer,
          frameHeld: !!heldFrame,
          captures,
        };
      },
      async release() {
        armed = false;
        const timer = heldTimer;
        const frame = heldFrame;
        heldTimer = undefined;
        heldFrame = undefined;
        window.setTimeout =
          originalSetTimeout as unknown as typeof window.setTimeout;
        window.clearTimeout =
          originalClearTimeout as unknown as typeof window.clearTimeout;
        window.requestAnimationFrame = originalRequestAnimationFrame;
        window.cancelAnimationFrame = originalCancelAnimationFrame;
        if (frame) frame(performance.now());
        else if (timer)
          originalSetTimeout(timer.callback, timer.delay, ...timer.args);
        await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
      },
    };
  });
  const entered = held(),
    release = held();
  let fail = false;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/runs`,
    async (route) => {
      if (fail) {
        await route.fulfill({
          status: 503,
          json: {
            ok: false,
            data: null,
            error: "Fixture current membership unavailable",
          },
        });
        return;
      }
      const response = await forwardRun(route);
      entered.release();
      await release.promise;
      await route.fulfill({ response });
    },
  );
  const opening = page.goto(href());
  await entered.promise;
  await expect(
    page.getByText("Loading project runs…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No forge runs in this served checkout", { exact: true }),
  ).toHaveCount(0);
  release.release();
  await opening;
  const table = page.getByRole("table", { name: "Recorded forge runs" });
  await expect(table).toBeVisible();
  await page.getByLabel("Find runs", { exact: true }).fill("no matching title");
  await page.getByRole("button", { name: "Apply run filters" }).click();
  await expect(
    page.getByRole("heading", { name: "No runs match these filters" }),
  ).toBeVisible();
  await reloadSettled(page);
  await expect(page.getByLabel("Find runs", { exact: true })).toHaveValue(
    "no matching title",
  );
  const runMode = page.getByRole("combobox", { name: "Run mode", exact: true });
  await page.evaluate(() => {
    const gate = (window as RunsFilterEffectGateWindow).__runsFilterEffectGate;
    if (!gate) throw new Error("Runs filter effect gate was not installed");
    gate.arm();
  });
  try {
    await page.getByRole("button", { name: "Clear run filters" }).click();
    await expect(
      table.getByRole("link", { name: "Scoped forge delivery", exact: true }),
    ).toBeVisible();
    const heldEffect = await page.evaluate(() => {
      const gate = (window as RunsFilterEffectGateWindow)
        .__runsFilterEffectGate;
      if (!gate) throw new Error("Runs filter effect gate was not installed");
      return gate.status();
    });
    console.log(`Runs filter effect gate: ${JSON.stringify(heldEffect)}`);
    expect([
      { timerHeld: false, frameHeld: false, captures: 0 },
      { timerHeld: true, frameHeld: true, captures: 1 },
    ]).toContainEqual(heldEffect);
    await runMode.focus();
    await runMode.selectOption("auto");
    await page.evaluate(async () => {
      const gate = (window as RunsFilterEffectGateWindow)
        .__runsFilterEffectGate;
      if (!gate) throw new Error("Runs filter effect gate was not installed");
      await gate.release();
    });
  } finally {
    await page.evaluate(async () => {
      const gate = (window as RunsFilterEffectGateWindow)
        .__runsFilterEffectGate;
      if (!gate) throw new Error("Runs filter effect gate was not installed");
      await gate.release();
    });
  }
  await expect(runMode).toHaveValue("auto");
  await expect(runMode).toBeFocused();
  await page.getByRole("button", { name: "Apply run filters" }).click();
  await expect(page).toHaveURL(/runMode=auto/);
  await expect(
    table.getByRole("link", { name: "Historical unattended run", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "Scoped forge delivery", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear run filters" }).click();
  fail = true;
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Fixture current membership unavailable" }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "Scoped forge delivery", exact: true }),
  ).toBeVisible();
  fail = false;
  for (const slug of [fixture.primary, fixture.shipped, fixture.legacy])
    remove(fixture.path(slug));
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
      exact: true,
    }),
  ).toBeVisible();
});

test("late run and project answers cannot replace a newer scoped selection and foreign detail stays unavailable", async ({
  page,
}) => {
  const entered = held(),
    release = held(),
    finished = held();
  let primaryDetailRequests = 0;
  await page.route(
    new RegExp(
      `^https?://[^/]+/__agent-forge/projects/${alpha.id}/runs/${fixture.primary}\\?after=0&limit=100$`,
    ),
    async (route) => {
      primaryDetailRequests++;
      try {
        const response = await forwardRun(route);
        entered.release();
        await release.promise;
        await route.fulfill({ response });
      } finally {
        finished.release();
      }
    },
  );
  await openSettled(page, href());
  await page
    .getByRole("link", { name: "Scoped forge delivery", exact: true })
    .click();
  await entered.promise;
  expect(primaryDetailRequests).toBe(1);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, runsHref(alpha.id, fixture.shipped).slice(1));
  await expect(
    page
      .getByRole("article", { name: "Selected forge run" })
      .getByRole("heading", { name: "Shipped forge delivery", exact: true }),
  ).toBeVisible();
  release.release();
  await finished.promise;
  await expect(
    page
      .getByRole("article", { name: "Selected forge run" })
      .getByRole("heading", { name: "Scoped forge delivery", exact: true }),
  ).toHaveCount(0);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, runsHref(beta.id, fixture.primary).slice(1));
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "not in this project's current run list" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Selected forge run" }),
  ).toHaveCount(0);
  const answer = await protectedRead(
    page,
    `/projects/${beta.id}/runs/${fixture.primary}`,
  );
  expect(answer.status).toBe(404);
  expect(JSON.stringify(answer.body)).not.toContain("Scoped forge delivery");
  const list = await protectedRead(page, `/projects/${beta.id}/runs`);
  if (
    !list.body ||
    typeof list.body !== "object" ||
    !("ok" in list.body) ||
    list.body.ok !== true ||
    !("data" in list.body)
  )
    throw Error("Missing protected foreign project list");
  expect(
    projectRunsPageSchema.parse(list.body.data).runs.map((run) => run.slug),
  ).toEqual([fixture.foreign]);
});

test("a failed initial read stays unknown and a held old project list cannot populate the new project's Runs", async ({
  page,
}) => {
  const entered = held(),
    release = held(),
    finished = held();
  let initialFailure = true;
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/runs`,
    async (route) => {
      if (initialFailure) {
        await route.fulfill({
          status: 503,
          json: {
            ok: false,
            data: null,
            error: "Fixture initial membership unavailable",
          },
        });
        return;
      }
      try {
        const response = await forwardRun(route);
        entered.release();
        await release.promise;
        await route.fulfill({ response });
      } finally {
        finished.release();
      }
    },
  );
  await openSettled(page, href());
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Fixture initial membership unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
    }),
  ).toHaveCount(0);
  initialFailure = false;
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await entered.promise;
  await page.evaluate((hash) => {
    location.hash = hash;
  }, runsHref(beta.id, null).slice(1));
  const table = page.getByRole("table", { name: "Recorded forge runs" });
  await expect(
    table.getByRole("link", { name: "FOREIGN BETA RUN", exact: true }),
  ).toBeVisible();
  release.release();
  await finished.promise;
  await expect(
    table.getByRole("link", { name: "Scoped forge delivery", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Fixture initial membership unavailable" }),
  ).toHaveCount(0);
});
