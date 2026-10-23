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
  /** Trusted owner budget, bounded from 100ms to 30s. Production defaults to 10s. */
  deadlineMs?: number;
  prepare(
    input: PrivateExecInput,
    control: { fail(): void; signal: AbortSignal },
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

export interface BoundedPrivateExecCapture extends PrivateExecCapture {
  /** Fences private work after an output/protocol failure, including queued writes. */
  abort(): void;
}

function bounded<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => stop(), timeoutMs);
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(new PrivateCaptureError());
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    work.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        reject(new PrivateCaptureError());
      },
    );
  });
}

/** The adapter owns both waits: an uncooperative private writer cannot hold Stop or child done. */
export async function preparePrivateExecCapture(
  factory: PrivateExecCaptureFactory,
  input: PrivateExecInput,
  fail: () => void,
  signal?: AbortSignal,
): Promise<BoundedPrivateExecCapture> {
  const deadlineMs = factory.deadlineMs ?? 10_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 100 || deadlineMs > 30_000)
    throw new PrivateCaptureError();
  const controller = new AbortController();
  let abandoned = false,
    abandonedOwner = false,
    preparedOwner: PrivateExecCapture | undefined;
  const finishAbandoned = () => {
    if (!preparedOwner || abandonedOwner) return;
    abandonedOwner = true;
    const late = preparedOwner;
    void bounded(
      Promise.resolve().then(() => late.finish(null)),
      deadlineMs,
    ).catch(() => {});
  };
  const abort = () => controller.abort();
  const failed = () => {
    abort();
    fail();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const preparing = Promise.resolve().then(async () => {
    if (controller.signal.aborted) throw new PrivateCaptureError();
    const owner = await factory.prepare(input, {
      fail: failed,
      signal: controller.signal,
    });
    preparedOwner = owner;
    if (abandoned) {
      // The original caller has already returned. A late owner may release its
      // lease and preserve its unknown original, but never starts a provider.
      finishAbandoned();
      throw new PrivateCaptureError();
    }
    return owner;
  });
  let owner: PrivateExecCapture;
  try {
    owner = await bounded(preparing, deadlineMs, controller.signal);
  } catch {
    abandoned = true;
    abort();
    finishAbandoned();
    throw new PrivateCaptureError();
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  let completion: Promise<void> | undefined;
  return {
    abort,
    started(pid) {
      try {
        owner.started(pid);
      } catch {
        failed();
        throw new PrivateCaptureError();
      }
    },
    line(line) {
      try {
        owner.line(line);
      } catch {
        failed();
        throw new PrivateCaptureError();
      }
    },
    finish(exit) {
      completion ??= bounded(
        Promise.resolve().then(() => owner.finish(exit)),
        deadlineMs,
      ).catch(() => {
        failed();
        throw new PrivateCaptureError();
      });
      return completion;
    },
  };
}
