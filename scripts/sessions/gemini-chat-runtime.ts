import { z } from "zod";
import type { GeminiAcpEvent } from "../../types/gemini-acp";
import type {
  GeminiChatLaunch,
  GeminiChatOutcome,
  GeminiChatPermissionOffer,
  GeminiChatRuntimeEvent,
  PreparedGeminiChat,
} from "../../types/gemini-chat-runtime";
import { type InteractiveSupervised, supervise } from "../executors/supervisor";
import { ACP_WIRE_LIMITS, type AcpRpcId } from "./acp-wire";
import { reportedText } from "./activity-protocol";
import { createGeminiAcpSession } from "./gemini-acp-session";
import {
  preparedGeminiChatLaunchSchema,
  preparedGeminiChatSchema,
} from "./gemini-chat-runtime-protocol";
import {
  createGeminiNativeAccess,
  type GeminiNativeOptions,
} from "./gemini-native";
import { serializeGeminiChat } from "./gemini-task";

export interface GeminiChatRuntimeOptions extends GeminiNativeOptions {
  timeoutMs?: number;
  persistenceTimeoutMs?: number;
  permissionTimeoutMs?: number;
  cancellationTimeoutMs?: number;
}
const unavailable = (reason: string) =>
  new Error(`${reason} No Gemini Chat prompt was started.`);
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
async function bounded<T>(
  work: () => Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw Error("Private operation stopped");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw Error("Private operation stopped");
        return work();
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("Private operation deadline")),
          ms,
        );
        abort = () => reject(Error("Private operation stopped"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
const resultSchema = z
  .object({
    requestId: z.uuid(),
    optionId: z.string().min(1).max(200).nullable(),
  })
  .strict();

/** One explicitly accepted prompt per owned process. A trusted owner supplies originals and late-write lease fencing. */
export function createGeminiChatRuntime(options: GeminiChatRuntimeOptions) {
  const { root, canonical, ready, inspect } = createGeminiNativeAccess(
    options,
    unavailable,
  );
  const timeoutMs = options.timeoutMs ?? 15 * 60_000,
    persistenceMs = options.persistenceTimeoutMs ?? 5000,
    permissionMs = options.permissionTimeoutMs ?? 120_000,
    cancellationMs = options.cancellationTimeoutMs ?? 2000;
  for (const [value, maximum] of [
    [timeoutMs, 29 * 60_000],
    [persistenceMs, 30_000],
    [permissionMs, 300_000],
    [cancellationMs, 10_000],
  ])
    if (
      value === undefined ||
      maximum === undefined ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > maximum
    )
      throw unavailable("The Gemini Chat deadlines are invalid.");
  const paths = (launch: GeminiChatLaunch) => [
    ...(launch.context
      ? [
          canonical(launch.context.repository, "directory"),
          canonical(launch.context.worktree, "directory"),
        ]
      : []),
    ...(launch.includeDirectories ?? []).map((path) =>
      canonical(path, "directory"),
    ),
    ...(launch.policyFiles ?? []).map((path) => canonical(path, "file")),
  ];
  const validate = (snapshot: PreparedGeminiChat) => {
    if (
      canonical(options.root, "directory") !== root ||
      snapshot.canonicalRoot !== root ||
      canonical(snapshot.launch.cwd, "directory") !== snapshot.canonicalCwd ||
      JSON.stringify(paths(snapshot.launch)) !==
        JSON.stringify(snapshot.paths) ||
      (snapshot.launch.context &&
        canonical(snapshot.launch.context.worktree, "directory") !==
          snapshot.canonicalCwd)
    )
      throw unavailable("The prepared Gemini Chat scope changed.");
    serializeGeminiChat(snapshot.launch, snapshot.capabilities);
  };
  return {
    async prepare(input: {
      smith: string;
      launch: GeminiChatLaunch;
    }): Promise<PreparedGeminiChat> {
      const launch = preparedGeminiChatLaunchSchema.parse(input.launch),
        runtime = ready(input.smith),
        canonicalCwd = canonical(launch.cwd, "directory"),
        capturedPaths = paths(launch),
        capabilities = await inspect(runtime);
      const snapshot = preparedGeminiChatSchema.parse({
        version: 1,
        provider: "gemini",
        smith: input.smith,
        canonicalRoot: root,
        canonicalCwd,
        command: runtime.command,
        paths: capturedPaths,
        launch,
        capabilities,
      });
      validate(snapshot);
      freeze(snapshot);
      return snapshot;
    },
    async run(
      input: {
        prepared: PreparedGeminiChat;
        requestId: string;
        resume: { sessionId: string; version: string } | null;
      },
      persist: (event: GeminiChatRuntimeEvent) => Promise<void>,
      signal: AbortSignal,
      callbacks: {
        requestPermission(
          offer: Readonly<GeminiChatPermissionOffer>,
          signal: AbortSignal,
        ): Promise<{ requestId: string; optionId: string | null }>;
      },
    ): Promise<GeminiChatOutcome> {
      const snapshot = preparedGeminiChatSchema.parse(input.prepared),
        requestId = z.uuid().parse(input.requestId);
      const resume = z
        .object({ sessionId: z.uuid(), version: z.literal("0.65.0") })
        .strict()
        .nullable()
        .parse(input.resume);
      validate(snapshot);
      const notStarted = (): GeminiChatOutcome => ({
        phase: "failed",
        reason: "The Gemini Chat prompt was stopped before dispatch.",
        sessionId: resume?.sessionId ?? null,
        stopReason: null,
        usage: null,
      });
      if (signal.aborted) return notStarted();
      let runtime = ready(snapshot.smith);
      if (JSON.stringify(runtime.command) !== JSON.stringify(snapshot.command))
        throw unavailable("The Gemini command changed.");
      try {
        serializeGeminiChat(snapshot.launch, await inspect(runtime, signal));
      } catch (error) {
        if (signal.aborted) return notStarted();
        throw error;
      }
      validate(snapshot);
      runtime = ready(snapshot.smith);
      if (JSON.stringify(runtime.command) !== JSON.stringify(snapshot.command))
        throw unavailable("The Gemini command changed during preparation.");
      if (signal.aborted) return notStarted();
      runtime.env.AGENT_FORGE_SMITH = snapshot.smith;
      if (snapshot.launch.context?.beadId)
        runtime.env.AGENT_FORGE_BEAD_ID = snapshot.launch.context.beadId;
      const serialized = serializeGeminiChat(
        snapshot.launch,
        snapshot.capabilities,
      );
      const protocol = createGeminiAcpSession({
        cwd: snapshot.canonicalCwd,
        ...(resume ? { resumeSessionId: resume.sessionId } : {}),
      });
      const first = protocol.start();
      const observed: {
        sessionId: string | null;
        result: Extract<GeminiAcpEvent, { kind: "result" }> | null;
        error: Extract<GeminiAcpEvent, { kind: "error" }> | null;
      } = { sessionId: resume?.sessionId ?? null, result: null, error: null };
      let child: InteractiveSupervised | undefined,
        pid = 0,
        wireStarted = false,
        promptSent = false,
        failure = false,
        storageFailed = false,
        lostFrames = false,
        stopped = false,
        timedOut = false,
        terminalSeen = false,
        exited = false;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined,
        operationTimer: ReturnType<typeof setTimeout> | undefined;
      let writes = Promise.resolve(),
        pendingBytes = 0,
        pendingFrames = 0;
      const offers = new Map<
          AcpRpcId,
          { controller: AbortController; toolCallId: string }
        >(),
        tasks = new Set<Promise<void>>(),
        decisions = new Set<string>();
      const invalidate = () => {
        for (const offer of offers.values()) offer.controller.abort();
        offers.clear();
      };
      const fail = () => {
        failure = true;
        invalidate();
        protocol.invalidate();
        void child?.stop("Gemini Chat protocol or private persistence failed");
      };
      const save = async (event: GeminiChatRuntimeEvent) => {
        try {
          await bounded(() => persist(structuredClone(event)), persistenceMs);
        } catch (error) {
          storageFailed = true;
          throw error;
        }
      };
      const queue = (
        work: () => Promise<void>,
        bytes: number,
        essential = false,
      ) => {
        if (failure) return Promise.resolve();
        if (pendingFrames >= 255 || pendingBytes + bytes > 1_048_576) {
          fail();
          return Promise.resolve();
        }
        pendingFrames++;
        pendingBytes += bytes;
        const next = writes
          .then(async () => {
            if (failure) return;
            if ((stopped || timedOut) && !essential) {
              lostFrames = true;
              return;
            }
            try {
              await work();
            } catch {
              fail();
            }
          })
          .finally(() => {
            pendingFrames--;
            pendingBytes -= bytes;
          });
        writes = next;
        return next;
      };
      const store = (event: GeminiChatRuntimeEvent, essential = false) =>
        queue(
          () => save(event),
          Buffer.byteLength(JSON.stringify(event)),
          essential,
        );
      const cancel = (timeout: boolean) => {
        if (stopped || timedOut) return;
        if (timeout) timedOut = true;
        else stopped = true;
        if (operationTimer) clearTimeout(operationTimer);
        invalidate();
        if (!child || !promptSent || terminalSeen || failure) {
          void child?.stop("Gemini Chat stopped before a live prompt");
          return;
        }
        try {
          const frame = protocol.cancel(requestId);
          if (frame) void child.write(frame).catch(fail);
          cancelTimer = setTimeout(() => {
            failure = true;
            void child?.stop("Gemini cancellation was not acknowledged");
          }, cancellationMs);
        } catch {
          fail();
        }
      };
      const abort = () => cancel(false);
      const permission = (
        event: Extract<GeminiAcpEvent, { kind: "permission" }>,
      ) => {
        const controller = new AbortController();
        offers.set(event.rpcId, { controller, toolCallId: event.toolCallId });
        let task: Promise<void>;
        task = (async () => {
          await store(event);
          if (
            failure ||
            controller.signal.aborted ||
            stopped ||
            timedOut ||
            !observed.sessionId
          )
            return;
          const offer: GeminiChatPermissionOffer = {
            ...structuredClone(event),
            processId: pid,
            sessionId: observed.sessionId,
          };
          freeze(offer);
          const decision = resultSchema.parse(
            await bounded(
              () => callbacks.requestPermission(offer, controller.signal),
              permissionMs,
              controller.signal,
            ),
          );
          if (failure || controller.signal.aborted) return;
          if (decisions.has(decision.requestId))
            throw Error("A decision original was reused");
          const frame = protocol.answerPermission({
            rpcId: event.rpcId,
            requestId,
            optionId: decision.optionId,
          });
          decisions.add(decision.requestId);
          await store({
            kind: "permission-intent",
            requestId,
            decisionRequestId: decision.requestId,
            rpcId: event.rpcId,
            toolCallId: event.toolCallId,
            optionId: decision.optionId,
          });
          if (!failure && !controller.signal.aborted) {
            validate(snapshot);
            await child?.write(frame);
          }
        })()
          .catch(() => {
            if (!controller.signal.aborted) fail();
          })
          .finally(() => tasks.delete(task));
        tasks.add(task);
      };
      try {
        child = supervise({
          command: [...runtime.command, ...serialized.argv],
          cwd: snapshot.canonicalCwd,
          env: runtime.env,
          stdinMode: "interactive",
          maxStdinBytes: 4_194_304,
          stdinTimeoutMs: 5000,
          timeoutMs: timeoutMs + cancellationMs + 1000,
          maxLineBytes: ACP_WIRE_LIMITS.lineBytes,
          onOutputError: fail,
          onLine(line) {
            if (failure) return;
            try {
              if (!wireStarted) throw Error("Unsolicited native output");
              const next = protocol.read(line);
              for (const event of next.events) {
                if (event.kind === "identity") {
                  observed.sessionId = event.sessionId;
                  void queue(
                    async () => {
                      await save(event);
                      if (failure || stopped || timedOut || promptSent) return;
                      validate(snapshot);
                      const frame = protocol.prompt({
                        requestId,
                        text: serialized.stdin,
                      });
                      promptSent = true;
                      await child?.write(frame);
                    },
                    Buffer.byteLength(JSON.stringify(event)),
                  );
                } else if (event.kind === "permission") permission(event);
                else {
                  if (
                    event.kind === "tool" &&
                    ["completed", "failed"].includes(event.status)
                  )
                    for (const offer of offers.values())
                      if (offer.toolCallId === event.toolCallId)
                        offer.controller.abort();
                  if (event.kind === "result" || event.kind === "error") {
                    terminalSeen = true;
                    invalidate();
                    if (cancelTimer) clearTimeout(cancelTimer);
                    if (operationTimer) clearTimeout(operationTimer);
                    if (event.kind === "result") observed.result = event;
                    else observed.error = event;
                    void queue(
                      async () => {
                        await save(event);
                        await child?.end();
                        // An acknowledged prompt does not prove the native RPC process or its helpers exited.
                        cancelTimer = setTimeout(() => {
                          void child?.stop(
                            "Gemini did not exit after its terminal native result",
                          );
                        }, cancellationMs);
                      },
                      Buffer.byteLength(JSON.stringify(event)),
                      true,
                    );
                  } else void store(event);
                }
              }
              for (const frame of next.send)
                void queue(async () => {
                  await child?.write(frame);
                }, Buffer.byteLength(frame));
            } catch {
              fail();
            }
          },
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          pid = await child.providerPid;
          await save({
            kind: "process",
            pid,
            bootstrapPid: child.pid,
            smith: snapshot.smith,
            requestId,
          });
          if (!failure && !stopped && !timedOut) {
            validate(snapshot);
            wireStarted = true;
            operationTimer = setTimeout(() => cancel(true), timeoutMs);
            await child.write(first);
          }
        } catch {
          fail();
        }
        const exit = await child.done;
        exited = true;
        invalidate();
        await Promise.allSettled([...tasks]);
        await writes;
        const native = observed.result;
        const uncertain =
          failure ||
          storageFailed ||
          lostFrames ||
          (!native && !observed.error && exit.exitCode === 0);
        let outcome: GeminiChatOutcome = {
          phase: uncertain
            ? "unknown"
            : native?.stopReason === "end_turn" &&
                exit.exitCode === 0 &&
                !stopped &&
                !timedOut &&
                !exit.stopped &&
                !exit.timedOut &&
                !observed.error
              ? "completed"
              : "failed",
          reason: uncertain
            ? "The Gemini Chat protocol, cancellation or private save was interrupted. The prompt was not resent."
            : (observed.error?.message.text ??
              (timedOut
                ? "The Gemini Chat prompt timed out."
                : stopped
                  ? "The Gemini Chat prompt was stopped."
                  : exit.exitCode !== 0
                    ? `Gemini exited with code ${exit.exitCode}.`
                    : native?.stopReason !== "end_turn"
                      ? `Gemini stopped with ${native?.stopReason ?? "no native result"}.`
                      : null)),
          sessionId: observed.sessionId,
          stopReason: native?.stopReason ?? null,
          usage: native?.usage ?? null,
        };
        if (!storageFailed)
          try {
            await save({
              kind: "outcome",
              outcome,
              exitCode: exit.exitCode,
              stopped: stopped || exit.stopped,
              timedOut: timedOut || exit.timedOut,
              stderr: reportedText(exit.stderr),
            });
          } catch {
            outcome = {
              ...outcome,
              phase: "unknown",
              reason:
                "The final Gemini Chat outcome could not be saved. The prompt was not resent.",
            };
          }
        return outcome;
      } finally {
        signal.removeEventListener("abort", abort);
        invalidate();
        if (cancelTimer) clearTimeout(cancelTimer);
        if (operationTimer) clearTimeout(operationTimer);
        if (child && !exited) await child.stop("Gemini Chat runtime cleanup");
        if (child) await child.done;
        await Promise.allSettled([...tasks]);
        await writes;
      }
    },
  };
}
