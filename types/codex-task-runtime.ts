import type {
  CodexExecCapabilities,
  CodexExecPrivateEvent,
  CodexTaskLaunch,
} from "./codex-task";

/** Trusted private preparation, never a public wire request or an execution authorization. */
export interface PreparedCodexTask {
  readonly version: 1;
  readonly provider: "codex";
  readonly smith: string;
  readonly cwd: string;
  readonly launch: CodexTaskLaunch;
  readonly capabilities: CodexExecCapabilities;
}

export type CodexTaskRuntimeEvent =
  | CodexExecPrivateEvent
  | {
      kind: "process";
      pid: number;
      smith: string;
      requestedModel: string;
      /** null selects CLI configuration behavior; never an observed execution effort. */
      requestedEffort: string | null;
    };
