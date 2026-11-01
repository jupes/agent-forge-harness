import { isAbsolute } from "node:path";
import {
  ACP_WIRE_LIMITS,
  type AcpRpcId,
  type AcpServerFrame,
  decodeAcpServerFrame,
  encodeAcpClientRequest,
} from "./acp-wire";
import { reduceGrokInitialize, type GrokConnectionState } from "./grok-acp-initialize";
import { supervise, type InteractiveSuperviseOptions, type InteractiveSupervised } from "../executors/supervisor";
import type { ChildExit } from "../executors/types";

const PROTOCOL_DEADLINE_MS = 30_000;
const INTERACTIVE_LIFETIME_MS = 30 * 60_000;
const MAX_STDIN_BYTES = 1_048_576;
const STDIN_TIMEOUT_MS = 5_000;
const SESSION_ID_MAX = 200;
const invalid = () => new Error("The private Grok ACP session did not match its owned protocol.");
type Owner = (options: InteractiveSuperviseOptions) => InteractiveSupervised;
export type GrokStartFailure = "invalid-owner-input" | "spawn-failed" | "provider-exited" | "handshake-timeout" | "output-limit" | "invalid-frame" | "initialize-rejected" | "session-open-rejected" | "already-closing" | "closed";
export type GrokCleanupResult = { kind: "released" } | { kind: "pending" };
const openedBrand: unique symbol = Symbol("GrokOpenedHandle");
export type GrokOpenedHandle = {
  readonly kind: "grok-opened-session";
  readonly authentication: "unknown";
  readonly identity: "unverified";
  readonly [openedBrand]: true;
};
export type GrokActorSnapshot =
  | { state: "cold" }
  | { state: "initializing"; owner: "retained" }
  | { state: "opening"; owner: "retained" }
  | { state: "opened"; owner: "retained"; handle: GrokOpenedHandle }
  | { state: "closing"; owner: "retained"; invalidated: true }
  | { state: "closed"; owner: "released" }
  | { state: "cleanup-pending"; owner: "retained"; invalidated: true };
export type GrokStartResult =
  | { kind: "opened"; handle: GrokOpenedHandle }
  | { kind: "failed"; reason: GrokStartFailure; cleanup: GrokCleanupResult };

export function createGrokAcpSessionActor(options: {
  executable: string;
  cwd: string;
  env: Record<string, string>;
  supervise?: Owner;
}) {
  let state: GrokActorSnapshot = { state: "cold" };
  let child: InteractiveSupervised | null = null;
  let startPromise: Promise<GrokStartResult> | null = null;
  let cleanupStarted = false;
  let stopCalled = false;
  let pending: { id: AcpRpcId; method: "initialize" | "session/new"; resolve(frame: AcpServerFrame): void; reject(error: Error): void } | null = null;
  let nextId = 0;
  let protocolFailure = false;
  let sessionId: string | null = null;
  const snapshot = () => state;
  const observeCleanup = (owned: InteractiveSupervised) => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void owned.done.then(
      (result: ChildExit) => {
        if (result.ownedTreeReleased === true) {
          state = { state: "closed", owner: "released" };
          sessionId = null;
        } else state = { state: "cleanup-pending", owner: "retained", invalidated: true };
      },
      () => { state = { state: "cleanup-pending", owner: "retained", invalidated: true }; },
    );
  };
  const close = async (): Promise<GrokCleanupResult> => {
    if (state.state === "closed") return { kind: "released" };
    const owned = child;
    if (!owned) {
      state = { state: "closed", owner: "released" };
      return { kind: "released" };
    }
    if (state.state !== "cleanup-pending") state = { state: "closing", owner: "retained", invalidated: true };
    if (!stopCalled) {
      stopCalled = true;
      void owned.stop("Grok ACP owner closing").catch(() => undefined);
    }
    observeCleanup(owned);
    return { kind: "pending" };
  };
  const fail = async (reason: GrokStartFailure): Promise<GrokStartResult> => ({ kind: "failed", reason, cleanup: await close() });
  const send = async (owned: InteractiveSupervised, method: "initialize" | "session/new", params: Record<string, unknown>, deadlineAt: number): Promise<AcpServerFrame> => {
    const id = ++nextId;
    let resolveFrame: (frame: AcpServerFrame) => void = () => undefined;
    let rejectFrame: (error: Error) => void = () => undefined;
    const response = new Promise<AcpServerFrame>((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; });
    pending = { id, method, resolve: resolveFrame, reject: rejectFrame };
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw invalid();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(invalid()), remaining);
    });
    try {
      await Promise.race([owned.write(encodeAcpClientRequest({ id, method, params })), timeout]);
      return await Promise.race([response, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (pending?.id === id) pending = null;
    }
  };
  const readLine = (line: string) => {
    try {
      const frame = decodeAcpServerFrame(line);
      const current = pending;
      if (!current || !("id" in frame) || "method" in frame || frame.id !== current.id) {
        protocolFailure = true;
        current?.reject(invalid());
        return;
      }
      current.resolve(frame);
    } catch {
      protocolFailure = true;
      pending?.reject(invalid());
    }
  };
  const startAndOpen = (): Promise<GrokStartResult> => {
    if (startPromise) return startPromise;
    if (state.state !== "cold") return Promise.resolve({
      kind: "failed",
      reason: state.state === "closed" ? "closed" : "already-closing",
      cleanup: state.state === "closed" ? { kind: "released" } : { kind: "pending" },
    });
    if (!isAbsolute(options.executable) || !isAbsolute(options.cwd) || options.executable.includes("\0") || options.cwd.includes("\0") || Object.entries(options.env).some(([key, value]) => !key || key.includes("\0") || value.includes("\0"))) {
      state = { state: "closed", owner: "released" };
      return Promise.resolve({ kind: "failed", reason: "invalid-owner-input", cleanup: { kind: "released" } });
    }
    state = { state: "initializing", owner: "retained" };
    startPromise = (async () => {
      try {
        const launch: InteractiveSuperviseOptions = {
          command: [options.executable, "--no-auto-update", "agent", "stdio"],
          cwd: options.cwd,
          env: { ...options.env },
          stdinMode: "interactive",
          timeoutMs: INTERACTIVE_LIFETIME_MS,
          maxStdinBytes: MAX_STDIN_BYTES,
          stdinTimeoutMs: STDIN_TIMEOUT_MS,
          maxLineBytes: ACP_WIRE_LIMITS.lineBytes,
          onLine: readLine,
          onOutputError() { protocolFailure = true; pending?.reject(invalid()); },
        };
        child = (options.supervise ?? supervise)(launch);
        const owned = child;
        await owned.providerPid;
        const deadlineAt = Date.now() + PROTOCOL_DEADLINE_MS;
        const initFrame = await send(owned, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "agent-forge-harness", version: "1" },
        }, deadlineAt);
        if (protocolFailure || !("id" in initFrame) || "error" in initFrame) return await fail("initialize-rejected");
        const initialized: GrokConnectionState = reduceGrokInitialize({ kind: "initialize-pending", requestId: initFrame.id }, initFrame);
        if (initialized.kind !== "initialized") return await fail("initialize-rejected");
        state = { state: "opening", owner: "retained" };
        const openFrame = await send(owned, "session/new", { cwd: options.cwd, mcpServers: [] }, deadlineAt);
        if (protocolFailure || !("id" in openFrame) || "error" in openFrame) return await fail("session-open-rejected");
        const body = openFrame.result;
        if (typeof body !== "object" || body === null || Array.isArray(body) || !("sessionId" in body) || typeof body.sessionId !== "string" || body.sessionId.length < 1 || body.sessionId.length > SESSION_ID_MAX || /[\p{Cc}\p{Cs}]/u.test(body.sessionId)) return await fail("session-open-rejected");
        sessionId = body.sessionId;
        // RED scaffold deliberately withholds the open capability until reviewed GREEN work.
        return await fail("session-open-rejected");
      } catch {
        return await fail(protocolFailure ? "invalid-frame" : "handshake-timeout");
      }
    })();
    return startPromise;
  };
  return { startAndOpen, snapshot, status: snapshot, close, dispose: close };
}
