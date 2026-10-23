import type { Provider, Smith } from "../../types/hearth";
import type { ChildExit } from "./types";

/** The exact prepared execution input. Environment values never enter this channel. */
export interface PrivateExecInput {
  provider: Provider;
  beadId: string;
  runId: string | null;
  workspace: string;
  cwd: string;
  smith: Smith;
  command: string[];
  stdin: string;
  timeoutMs: number | null;
}

/** An owner holds its private journal lease until finish, including on a failed spawn. */
export interface PrivateExecCapture {
  started(pid: number): void;
  line(line: string): void;
  finish(exit: ChildExit | null): Promise<void>;
}

/** Trusted only; private bodies never pass through the metadata EventSink. */
export interface PrivateExecCaptureFactory {
  prepare(
    input: PrivateExecInput,
    control: { fail(): void; signal?: AbortSignal },
  ): Promise<PrivateExecCapture>;
}

export const PRIVATE_CAPTURE_FAILURE =
  "The private provider transcript could not be verified. The shift must stop before another attempt.";

export class PrivateCaptureError extends Error {
  constructor() {
    super(PRIVATE_CAPTURE_FAILURE);
    this.name = "PrivateCaptureError";
  }
}
