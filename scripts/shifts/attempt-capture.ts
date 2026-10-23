import type { CodexExecPrivateEvent } from "../../types/codex-task";
import type { ConversationEvent } from "../../types/conversation";
import {
  PrivateCaptureError,
  type PrivateExecCaptureFactory,
} from "../executors/private-capture";
import { createClaudeSessionParser } from "../sessions/claude-stream";
import { createCodexExecParser } from "../sessions/codex-exec-stream";
import { openShiftAttempt } from "./attempt-owner";

type PrivateEvent = Exclude<ConversationEvent, { kind: "user" }>;
type Options = Omit<
  Parameters<typeof openShiftAttempt>[0],
  "input" | "signal"
> & { deadlineMs?: number };

/** The canonical exec's exact input enters the private journal, never a metadata EventSink. */
export function createShiftAttemptCapture(
  options: Options,
): PrivateExecCaptureFactory {
  const deadlineMs = options.deadlineMs ?? 10_000;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 100 ||
    deadlineMs > 30_000
  )
    throw new PrivateCaptureError();
  const intent = structuredClone(options.intent);
  return {
    deadlineMs,
    async prepare(input, control) {
      const opened = await openShiftAttempt({
        ...options,
        intent,
        input,
        signal: control.signal,
      });
      const { owner, snapshot } = opened;
      const claude =
        snapshot.provider === "claude"
          ? createClaudeSessionParser({ version: snapshot.cliVersion })
          : null;
      const codex =
        snapshot.provider === "codex"
          ? createCodexExecParser({ version: snapshot.cliVersion })
          : null;
      let failed = false,
        heldTree = false,
        finished = false;
      let pendingBytes = 0,
        pendingFrames = 0;
      let writes = Promise.resolve();
      const fail = () => {
        failed = true;
        owner.abort();
        control.fail();
      };
      const persist = async (event: PrivateEvent) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            owner.append(event),
            new Promise<void>((_resolve, reject) => {
              timer = setTimeout(() => {
                fail();
                reject(new PrivateCaptureError());
              }, deadlineMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const enqueue = (event: PrivateEvent) => {
        if (failed || finished || control.signal.aborted)
          throw new PrivateCaptureError();
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (pendingFrames >= 255 || pendingBytes + bytes > 1_048_576) {
          fail();
          throw new PrivateCaptureError();
        }
        pendingFrames++;
        pendingBytes += bytes;
        writes = writes
          .then(async () => {
            if (failed || control.signal.aborted)
              throw new PrivateCaptureError();
            await persist(event);
          })
          .catch(fail)
          .finally(() => {
            pendingFrames--;
            pendingBytes -= bytes;
          });
        return writes;
      };
      const codexEvent = (event: CodexExecPrivateEvent): PrivateEvent => {
        if (event.kind === "identity")
          return {
            kind: "identity",
            provider: "codex",
            sessionId: event.threadId,
            version: event.version,
          };
        if (event.kind === "usage")
          return {
            kind: "coding-usage",
            provider: "codex",
            source: "exec.turn.completed",
            version: snapshot.cliVersion,
            usage: event.usage,
          };
        if (event.kind === "text")
          return { kind: "text", messageId: event.itemId, text: event.text };
        return event;
      };
      return {
        holdTree() {
          owner.processStarted();
          heldTree = true;
        },
        async started(pid) {
          await enqueue({
            kind: "process",
            pid,
            smith: snapshot.smith,
            requestedModel: snapshot.requestedModel,
            requestedEffort: snapshot.requestedEffort,
          });
          if (failed || control.signal.aborted) throw new PrivateCaptureError();
        },
        line(line) {
          try {
            if (claude) {
              for (const event of claude.line(line))
                if (event.kind !== "user") enqueue(event);
            } else if (codex)
              for (const event of codex.line(line)) enqueue(codexEvent(event));
            else throw new PrivateCaptureError();
          } catch {
            fail();
            throw new PrivateCaptureError();
          }
        },
        async finish(exit) {
          if (exit !== null) owner.processExited();
          else if (heldTree) {
            fail();
            throw new PrivateCaptureError();
          }
          try {
            if (!failed && !control.signal.aborted && exit) {
              if (claude)
                for (const event of claude.flush())
                  if (event.kind !== "user") enqueue(event);
              const parser = claude ?? codex;
              if (!parser) throw new PrivateCaptureError();
              await writes;
              if (failed || control.signal.aborted)
                throw new PrivateCaptureError();
              await persist(parser.outcome(exit));
              const result = parser.finish(exit);
              await owner.finish({
                phase: result.phase,
                reason: result.reason,
              });
              if (result.phase === "unknown") throw new PrivateCaptureError();
            } else {
              await writes;
              await owner.finish({
                phase: exit ? "unknown" : "failed",
                reason: exit
                  ? "The private attempt was interrupted. Its input was not resent."
                  : "No provider was dispatched.",
              });
            }
            if (failed) throw new PrivateCaptureError();
          } catch {
            fail();
            await owner.done.catch(() => {});
            throw new PrivateCaptureError();
          } finally {
            finished = true;
          }
        },
      };
    },
  };
}
