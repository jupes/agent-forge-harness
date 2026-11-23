import type {
  GeminiTaskCapabilities,
  GeminiTaskLaunch,
  GeminiTaskOutcome,
  GeminiTaskPrivateEvent,
} from "./gemini-task";
import type { ReportedText } from "./session-activity";

/** Private snapshot, never launch authority by itself. The owner authorizes scope and retries. */
export interface PreparedGeminiTask {
  version: 1;
  provider: "gemini";
  smith: string;
  canonicalRoot: string;
  canonicalCwd: string;
  command: readonly string[];
  /** Canonical selected directories/policy files, rechecked before dispatch. */
  paths: readonly string[];
  launch: GeminiTaskLaunch;
  capabilities: GeminiTaskCapabilities;
}
export type GeminiTaskRuntimeEvent =
  | GeminiTaskPrivateEvent
  | {
      kind: "process";
      pid: number;
      bootstrapPid: number;
      smith: string;
      requestedModel: string | null;
    }
  | {
      kind: "outcome";
      outcome: GeminiTaskOutcome;
      exitCode: number | null;
      stopped: boolean;
      timedOut: boolean;
      /** Bounded private diagnostic, never a ledger/audit body. */
      stderr: ReportedText;
    };
