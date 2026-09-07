import { sanitizeContent } from "./context";
import { parseIndependentOutput } from "./output-validation";
import {
  type ChairOutput,
  type CouncilSeat,
  type IndependentOutput,
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  ModelTransportError,
  type PeerOutput,
  type SeatRecord,
} from "./types";

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeContent(raw, "redact").text.slice(0, 800);
}

async function generateWithDeadline(
  transport: ModelTransport,
  request: ModelRequest,
  outerSignal: AbortSignal | undefined,
): Promise<ModelResult> {
  const controller = new AbortController();
  let timeoutReached = false;
  let outerAborted = false;
  const onOuterAbort = (): void => {
    outerAborted = true;
    controller.abort();
  };
  if (outerSignal?.aborted) onOuterAbort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutReached = true;
      controller.abort();
      reject(new Error(`timeout after ${request.seat.timeoutMs}ms`));
    }, request.seat.timeoutMs);
  });
  const cancelled = new Promise<never>((_, reject) => {
    if (outerAborted) {
      reject(new Error("council run cancelled"));
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!timeoutReached) reject(new Error("council run cancelled"));
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([
      transport.generate(request, controller.signal),
      deadline,
      cancelled,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

type ParseOutput<T extends IndependentOutput | PeerOutput | ChairOutput> = (
  value: unknown,
) => T;

export async function callSeat<
  T extends IndependentOutput | PeerOutput | ChairOutput,
>(
  request: ModelRequest,
  resolveTransport: (seat: CouncilSeat) => ModelTransport,
  parseOutput: ParseOutput<T>,
  signal: AbortSignal | undefined,
  emit: (type: string, payload: Record<string, unknown>) => void,
): Promise<SeatRecord> {
  emit("seat.started", {
    stage: request.stage,
    seatId: request.seat.id,
    provider: request.seat.provider,
    model: request.seat.model,
  });
  const started = performance.now();
  let reportedUsage: ModelResult["usage"];
  let reportedCostUsd: number | undefined;
  let estimatedUsageCostUsd: number | undefined;
  let routing: ModelResult["routing"];
  const captureAccounting = (
    result: Pick<
      ModelResult,
      "usage" | "costUsd" | "estimatedUsageCostUsd" | "routing"
    >,
  ): void => {
    if (result.routing) routing = result.routing;
    if (result.usage) {
      if (
        !Number.isInteger(result.usage.inputTokens) ||
        result.usage.inputTokens < 0 ||
        !Number.isInteger(result.usage.outputTokens) ||
        result.usage.outputTokens < 0
      )
        throw new Error("transport returned invalid token usage");
      reportedUsage = result.usage;
    }
    if (result.costUsd !== undefined) {
      if (!Number.isFinite(result.costUsd) || result.costUsd < 0)
        throw new Error("transport returned invalid cost");
      reportedCostUsd = result.costUsd;
    }
    if (result.estimatedUsageCostUsd !== undefined) {
      if (
        !Number.isFinite(result.estimatedUsageCostUsd) ||
        result.estimatedUsageCostUsd < 0
      )
        throw new Error("transport returned invalid usage cost estimate");
      estimatedUsageCostUsd = result.estimatedUsageCostUsd;
    }
  };
  const accounting = (): Pick<
    SeatRecord,
    | "usage"
    | "costUsd"
    | "estimatedUsageCostUsd"
    | "accountedCostUsd"
    | "routing"
  > => ({
    ...(routing ? { routing } : {}),
    ...(reportedUsage ? { usage: reportedUsage } : {}),
    ...(reportedCostUsd === undefined ? {} : { costUsd: reportedCostUsd }),
    ...(estimatedUsageCostUsd === undefined ? {} : { estimatedUsageCostUsd }),
    accountedCostUsd:
      reportedCostUsd ??
      Math.max(reserveRequestCost(request), estimatedUsageCostUsd ?? 0),
  });
  try {
    const transport = resolveTransport(request.seat);
    const result = await generateWithDeadline(transport, request, signal);
    captureAccounting(result);
    const output = parseOutput(result.output);
    const record: SeatRecord = {
      stage: request.stage,
      ...(request.round === undefined ? {} : { round: request.round }),
      seatId: request.seat.id,
      provider: request.seat.provider,
      model: request.seat.model,
      status: "completed",
      latencyMs: Math.round(performance.now() - started),
      output,
      ...accounting(),
    };
    if (reportedUsage) record.usage = reportedUsage;
    if (reportedCostUsd !== undefined) record.costUsd = reportedCostUsd;
    emit("seat.completed", {
      stage: request.stage,
      seatId: request.seat.id,
      latencyMs: record.latencyMs,
    });
    return record;
  } catch (error) {
    if (error instanceof ModelTransportError) {
      try {
        captureAccounting(error);
      } catch {
        /* Invalid accounting remains conservatively estimated. */
      }
    }
    const cancelled = signal?.aborted === true;
    const message = safeError(error);
    const record: SeatRecord = {
      stage: request.stage,
      ...(request.round === undefined ? {} : { round: request.round }),
      seatId: request.seat.id,
      provider: request.seat.provider,
      model: request.seat.model,
      status: cancelled ? "cancelled" : "failed",
      latencyMs: Math.round(performance.now() - started),
      error: message,
      ...accounting(),
    };
    if (reportedUsage) record.usage = reportedUsage;
    if (reportedCostUsd !== undefined) record.costUsd = reportedCostUsd;
    emit(cancelled ? "seat.cancelled" : "seat.failed", {
      stage: request.stage,
      seatId: request.seat.id,
      error: message,
    });
    return record;
  }
}

export async function runIndependentReview(
  request: ModelRequest,
  resolveTransport: (seat: CouncilSeat) => ModelTransport,
  signal?: AbortSignal,
): Promise<SeatRecord> {
  if (request.stage !== "independent")
    throw new Error("Single review requires the independent stage");
  return callSeat(
    request,
    resolveTransport,
    (value) =>
      parseIndependentOutput(
        value,
        new Set(request.context.evidence.map((item) => item.id)),
      ),
    signal,
    () => {},
  );
}

export function reportedCost(records: SeatRecord[]): number {
  return Number(
    records
      .reduce((total, record) => total + record.accountedCostUsd, 0)
      .toFixed(6),
  );
}

export function reserveRequestCost(request: ModelRequest): number {
  const rates = request.seat.tokenRatesUsdPerMillion;
  if (!rates) return request.seat.estimatedCostUsd;
  // UTF-8 bytes conservatively bound input tokens, with allowance for protocol
  // framing and the response schema. Output is capped by the provider request.
  const inputBound =
    Buffer.byteLength(request.system + request.prompt, "utf8") + 4096;
  return Math.max(
    request.seat.estimatedCostUsd,
    (inputBound * rates.input + request.seat.maxOutputTokens * rates.output) /
      1_000_000,
  );
}
