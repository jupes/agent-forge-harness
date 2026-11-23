import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  type InteractiveSupervised,
  type InteractiveSuperviseOptions,
  supervise,
} from "../executors/supervisor";
import type { ChildExit } from "../executors/types";
import {
  ACP_WIRE_LIMITS,
  type AcpRpcId,
  type AcpServerFrame,
  decodeAcpServerFrame,
  encodeAcpClientRequest,
} from "./acp-wire";
import {
  type GrokConnectionState,
  reduceGrokInitialize,
} from "./grok-acp-initialize";

const PROTOCOL_DEADLINE_MS = 30_000;
const INTERACTIVE_LIFETIME_MS = 30 * 60_000;
const MAX_STDIN_BYTES = 1_048_576;
const STDIN_TIMEOUT_MS = 5_000;
const SESSION_ID_MAX_CODE_UNITS = 200;
const invalid = () =>
  new Error("The private Grok ACP session did not match its owned protocol.");
type SupervisorOwner = (
  options: InteractiveSuperviseOptions,
) => InteractiveSupervised;
type RpcMethod = "initialize" | "session/new";
type PendingRpc = {
  id: AcpRpcId;
  method: RpcMethod;
  settled: boolean;
  resolve(frame: AcpServerFrame): void;
  reject(error: Error): void;
};
type FailureCode =
  | "invalid-owner-input"
  | "spawn-failed"
  | "provider-exited"
  | "handshake-timeout"
  | "output-limit"
  | "invalid-frame"
  | "initialize-rejected"
  | "session-open-rejected"
  | "already-closing"
  | "closed";

class ActorFailure extends Error {
  constructor(readonly code: FailureCode) {
    super("The Grok ACP session could not be opened safely.");
  }
}

export type GrokStartFailure = FailureCode;
export type GrokCleanupResult = { kind: "released" } | { kind: "pending" };
const openedBrand: unique symbol = Symbol("GrokOpenedHandle");
export type GrokOpenedHandle = {
  readonly kind: "grok-opened-session";
  readonly authentication: "unknown";
  readonly identity: "unverified";
  readonly [openedBrand]: true;
};
export type GrokActorSnapshot = Readonly<
  | { state: "cold" }
  | { state: "initializing"; owner: "retained" }
  | { state: "opening"; owner: "retained" }
  | { state: "opened"; owner: "retained"; handle: GrokOpenedHandle }
  | { state: "closing"; owner: "retained"; invalidated: true }
  | { state: "closed"; owner: "released" }
  | { state: "cleanup-pending"; owner: "retained"; invalidated: true }
>;
export type GrokStartResult =
  | { kind: "opened"; handle: GrokOpenedHandle }
  | { kind: "failed"; reason: GrokStartFailure; cleanup: GrokCleanupResult };

function sameRpcId(left: AcpRpcId, right: AcpRpcId): boolean {
  return typeof left === typeof right && left === right;
}

function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= SESSION_ID_MAX_CODE_UNITS &&
    !/[\p{Cc}\p{Cs}]/u.test(value)
  );
}

export function createGrokAcpSessionActor(options: {
  executable: string;
  cwd: string;
  env: Record<string, string>;
  supervise?: SupervisorOwner;
}) {
  const executable = options.executable;
  const cwd = options.cwd;
  const env = Object.freeze({ ...options.env });
  const supervisor = options.supervise ?? supervise;
  let state: GrokActorSnapshot = Object.freeze({ state: "cold" });
  let child: InteractiveSupervised | null = null;
  let startPromise: Promise<GrokStartResult> | null = null;
  let doneOutcome: "pending" | "released" | "unknown" = "pending";
  let stopCalled = false;
  let currentHandle: GrokOpenedHandle | null = null;
  let sessionId: string | null = null;
  let nextId = 0;
  let pending: PendingRpc | null = null;
  let failure: FailureCode | null = null;
  let closeActor: () => Promise<GrokCleanupResult> = async () => ({
    kind: "pending",
  });
  let invalidateSignal: (error: ActorFailure) => void = () => undefined;
  const invalidation = new Promise<never>((_, reject) => {
    invalidateSignal = reject;
  });
  void invalidation.catch(() => undefined);
  let doneSettled = false;

  const publish = (next: GrokActorSnapshot) => {
    state = Object.freeze({ ...next });
  };
  const snapshot = (): GrokActorSnapshot => Object.freeze({ ...state });
  const currentState = (): GrokActorSnapshot => state;
  const invalidate = (reason: FailureCode) => {
    if (state.state === "closed") return;
    failure ??= reason;
    invalidateSignal(new ActorFailure(failure));
    currentHandle = null;
    sessionId = null;
    pending?.reject(new ActorFailure(reason));
    pending = null;
    if (doneOutcome === "released") {
      publish({ state: "closed", owner: "released" });
      return;
    }
    publish({ state: "closing", owner: "retained", invalidated: true });
    void closeActor();
  };

  const observeDone = (owned: InteractiveSupervised) => {
    void owned.done.then(
      (result: ChildExit) => {
        if (doneSettled) return;
        doneSettled = true;
        doneOutcome =
          result.ownedTreeReleased === true ? "released" : "unknown";
        currentHandle = null;
        sessionId = null;
        if (pending) {
          pending.reject(new ActorFailure("provider-exited"));
          pending = null;
        }
        if (!failure) failure = "provider-exited";
        invalidateSignal(new ActorFailure(failure));
        publish(
          doneOutcome === "released"
            ? { state: "closed", owner: "released" }
            : {
                state: "cleanup-pending",
                owner: "retained",
                invalidated: true,
              },
        );
        if (doneOutcome !== "released") void closeActor();
      },
      () => {
        if (doneSettled) return;
        doneSettled = true;
        doneOutcome = "unknown";
        currentHandle = null;
        sessionId = null;
        pending?.reject(new ActorFailure("provider-exited"));
        pending = null;
        if (!failure) failure = "provider-exited";
        invalidateSignal(new ActorFailure(failure));
        publish({
          state: "cleanup-pending",
          owner: "retained",
          invalidated: true,
        });
        void closeActor();
      },
    );
  };

  closeActor = async (): Promise<GrokCleanupResult> => {
    if (doneOutcome === "released") {
      publish({ state: "closed", owner: "released" });
      return { kind: "released" };
    }
    const owned = child;
    currentHandle = null;
    sessionId = null;
    pending?.reject(new ActorFailure("already-closing"));
    pending = null;
    if (!owned) {
      publish({ state: "closed", owner: "released" });
      doneOutcome = "released";
      return { kind: "released" };
    }
    publish({ state: "cleanup-pending", owner: "retained", invalidated: true });
    if (!stopCalled) {
      stopCalled = true;
      try {
        void owned.stop("Grok ACP owner closing").catch(() => undefined);
      } catch {
        // Keep this exact owner until its done result proves tree release.
      }
    }
    return { kind: "pending" };
  };

  const failureResult = async (code: FailureCode): Promise<GrokStartResult> => {
    failure ??= code;
    const cleanup = await closeActor();
    return { kind: "failed", reason: failure, cleanup };
  };

  const allocateId = (): AcpRpcId => {
    if (!Number.isSafeInteger(nextId + 1))
      throw new ActorFailure("invalid-frame");
    nextId += 1;
    return nextId;
  };

  const assertActive = () => {
    if (
      failure ||
      (state.state !== "initializing" && state.state !== "opening")
    )
      throw new ActorFailure(failure ?? "provider-exited");
  };

  const awaitLifecycle = async <T>(work: Promise<T>): Promise<T> => {
    const observed = Promise.resolve(work);
    void observed.catch(() => undefined);
    const value = await Promise.race([observed, invalidation]);
    assertActive();
    return value;
  };

  const withinDeadline = async <T>(
    work: Promise<T>,
    deadlineAt: number,
  ): Promise<T> => {
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) throw new ActorFailure("handshake-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ActorFailure("handshake-timeout")),
        remaining,
      );
    });
    try {
      const guardedWork = Promise.resolve(work);
      void guardedWork.catch(() => undefined);
      const value = await Promise.race([guardedWork, invalidation, timeout]);
      assertActive();
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const send = async (
    owned: InteractiveSupervised,
    method: RpcMethod,
    params: Record<string, unknown>,
    deadlineAt: number,
  ): Promise<{ id: AcpRpcId; frame: AcpServerFrame }> => {
    const id = allocateId();
    let resolveFrame: (frame: AcpServerFrame) => void = () => undefined;
    let rejectFrame: (error: Error) => void = () => undefined;
    const response = new Promise<AcpServerFrame>((resolve, reject) => {
      resolveFrame = resolve;
      rejectFrame = reject;
    });
    pending = {
      id,
      method,
      settled: false,
      resolve: resolveFrame,
      reject: rejectFrame,
    };
    void response.catch(() => undefined);
    const wire = encodeAcpClientRequest({ id, method, params });
    try {
      const write = owned.write(wire);
      void Promise.resolve(write).catch(() => undefined);
      await withinDeadline(Promise.resolve(write), deadlineAt);
      assertActive();
      const frame = await withinDeadline(response, deadlineAt);
      assertActive();
      return { id, frame };
    } finally {
      if (pending?.id === id) pending = null;
    }
  };

  const readLine = (line: string) => {
    let frame: AcpServerFrame;
    try {
      frame = decodeAcpServerFrame(line);
    } catch {
      invalidate("invalid-frame");
      return;
    }
    const current = pending;
    if (
      !current ||
      current.settled ||
      !("id" in frame) ||
      "method" in frame ||
      !sameRpcId(frame.id, current.id)
    ) {
      invalidate("invalid-frame");
      return;
    }
    current.settled = true;
    current.resolve(frame);
  };

  const close = (): Promise<GrokCleanupResult> => {
    if (state.state !== "closed") {
      failure ??= "already-closing";
      invalidateSignal(new ActorFailure(failure));
      currentHandle = null;
      sessionId = null;
      pending?.reject(new ActorFailure(failure));
      pending = null;
      publish({ state: "closing", owner: "retained", invalidated: true });
    }
    return closeActor();
  };

  const startAndOpen = (): Promise<GrokStartResult> => {
    if (state.state === "initializing" || state.state === "opening") {
      return (
        startPromise ??
        Promise.resolve({
          kind: "failed",
          reason: "already-closing",
          cleanup: { kind: "pending" },
        })
      );
    }
    if (state.state === "opened" && startPromise) return startPromise;
    if (state.state !== "cold") {
      return Promise.resolve({
        kind: "failed",
        reason: state.state === "closed" ? "closed" : "already-closing",
        cleanup:
          state.state === "closed" ? { kind: "released" } : { kind: "pending" },
      });
    }
    if (
      !isAbsolute(executable) ||
      resolvePath(executable) !== executable ||
      !isAbsolute(cwd) ||
      resolvePath(cwd) !== cwd ||
      executable.includes("\0") ||
      cwd.includes("\0") ||
      Object.entries(env).some(
        ([key, value]) => !key || key.includes("\0") || value.includes("\0"),
      )
    ) {
      state = { state: "closed", owner: "released" };
      return Promise.resolve({
        kind: "failed",
        reason: "invalid-owner-input",
        cleanup: { kind: "released" },
      });
    }
    publish({ state: "initializing", owner: "retained" });
    startPromise = (async () => {
      try {
        const launch: InteractiveSuperviseOptions = {
          command: [executable, "--no-auto-update", "agent", "stdio"],
          cwd,
          env: { ...env },
          stdinMode: "interactive",
          timeoutMs: INTERACTIVE_LIFETIME_MS,
          maxStdinBytes: MAX_STDIN_BYTES,
          stdinTimeoutMs: STDIN_TIMEOUT_MS,
          maxLineBytes: ACP_WIRE_LIMITS.lineBytes,
          onLine: readLine,
          onOutputError() {
            invalidate("output-limit");
          },
        };
        child = supervisor(launch);
        const owned = child;
        observeDone(owned);
        await awaitLifecycle(Promise.resolve(owned.providerPid));
        assertActive();
        const deadlineAt = performance.now() + PROTOCOL_DEADLINE_MS;
        const initialize = await send(
          owned,
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "agent-forge-harness", version: "1" },
          },
          deadlineAt,
        );
        assertActive();
        if (currentState().state !== "initializing")
          throw new ActorFailure(failure ?? "provider-exited");
        if ("error" in initialize.frame)
          throw new ActorFailure("initialize-rejected");
        const initialized: GrokConnectionState = reduceGrokInitialize(
          { kind: "initialize-pending", requestId: initialize.id },
          initialize.frame,
        );
        if (initialized.kind !== "initialized")
          throw new ActorFailure("initialize-rejected");
        assertActive();
        publish({ state: "opening", owner: "retained" });
        const opened = await send(
          owned,
          "session/new",
          {
            cwd,
            mcpServers: [],
          },
          deadlineAt,
        );
        assertActive();
        if (currentState().state !== "opening")
          throw new ActorFailure(failure ?? "provider-exited");
        if ("error" in opened.frame || !("result" in opened.frame))
          throw new ActorFailure("session-open-rejected");
        const body = opened.frame.result;
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          !("sessionId" in body) ||
          !isSessionId(body.sessionId)
        )
          throw new ActorFailure("session-open-rejected");
        sessionId = body.sessionId;
        const handle = Object.freeze<GrokOpenedHandle>({
          kind: "grok-opened-session",
          authentication: "unknown",
          identity: "unverified",
          [openedBrand]: true,
        });
        assertActive();
        currentHandle = handle;
        publish({ state: "opened", owner: "retained", handle });
        return { kind: "opened", handle };
      } catch (error) {
        const code =
          error instanceof ActorFailure
            ? error.code
            : child
              ? "provider-exited"
              : "spawn-failed";
        return await failureResult(code);
      }
    })();
    return startPromise;
  };

  return {
    startAndOpen,
    snapshot,
    status: snapshot,
    close,
    dispose: close,
  };
}
