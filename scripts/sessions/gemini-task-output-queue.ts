import type { GeminiTaskOutcome } from "../../types/gemini-task";
import type { GeminiTaskRuntimeEvent } from "../../types/gemini-task-runtime";

type Failure = "skipped" | "write" | "pressure";
interface Options {
  ready: Promise<void>;
  persist(event: GeminiTaskRuntimeEvent): Promise<void>;
  mayPersist(): boolean;
  onFailure(cause: Failure): void;
}

/** Internal Gemini Task persistence queue; this is not a runtime embedding hook. */
export function createGeminiTaskOutputQueue(options: Options) {
  let writes = options.ready,
    incomplete = false,
    pendingBytes = 0,
    pendingFrames = 0;
  return {
    enqueue(event: GeminiTaskRuntimeEvent): boolean {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      pendingBytes += bytes;
      pendingFrames++;
      if (pendingBytes > 1_048_576 || pendingFrames >= 256) {
        incomplete = true;
        options.onFailure("pressure");
        return false;
      }
      writes = writes
        .then(async () => {
          if (!options.mayPersist()) {
            incomplete = true;
            options.onFailure("skipped");
            return;
          }
          await options.persist(event);
        })
        .catch(() => {
          incomplete = true;
          options.onFailure("write");
        })
        .finally(() => {
          pendingBytes -= bytes;
          pendingFrames--;
        });
      return true;
    },
    async drain() {
      await writes;
      return { incomplete };
    },
  };
}

export function settleGeminiTaskCapture(
  outcome: GeminiTaskOutcome,
  interrupted: boolean,
): GeminiTaskOutcome {
  return interrupted
    ? {
        ...outcome,
        phase: "unknown",
        reason:
          "The Gemini stream, input or private persistence was interrupted. This Task was not resent.",
      }
    : outcome;
}
