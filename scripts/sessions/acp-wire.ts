import { z } from "zod";

/** ACP SDK0.16.1 / protocol1. This codec grants no execution or permission authority. */
export const ACP_WIRE_LIMITS = {
  lineBytes: 2_097_152,
  depth: 32,
  nodes: 20_000,
} as const;
const invalid = () =>
  new Error("The message did not match the private ACP wire protocol.");
const id = z.union([
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value)),
]);
const params = z.record(z.string(), z.unknown());
const base = z.object({ jsonrpc: z.literal("2.0") });
const response = base.extend({ id, result: z.unknown() }).strict();
const failure = base
  .extend({
    id,
    error: z
      .object({
        code: z.number().int().min(-2_147_483_648).max(2_147_483_647),
        message: z.string().max(65_536),
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
const update = base
  .extend({ method: z.literal("session/update"), params })
  .strict();
const permission = base
  .extend({ id, method: z.literal("session/request_permission"), params })
  .strict();
const clientRequest = base
  .extend({
    id,
    method: z.enum([
      "initialize",
      "session/new",
      "session/load",
      "session/prompt",
      "session/set_mode",
      "session/set_model",
    ]),
    params,
  })
  .strict();
const clientCancel = base
  .extend({ method: z.literal("session/cancel"), params })
  .strict();
const decision = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cancelled") }).strict(),
  z
    .object({
      outcome: z.literal("selected"),
      optionId: z
        .string()
        .min(1)
        .max(200)
        .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value)),
    })
    .strict(),
]);
export type AcpRpcId = z.infer<typeof id>;
export type AcpPermissionOutcome = z.infer<typeof decision>;
export type AcpServerFrame =
  | z.infer<typeof response>
  | z.infer<typeof failure>
  | z.infer<typeof update>
  | z.infer<typeof permission>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bounded(value: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (
      !item ||
      ++nodes > ACP_WIRE_LIMITS.nodes ||
      item.depth > ACP_WIRE_LIMITS.depth
    )
      throw invalid();
    if (Array.isArray(item.value)) {
      if (item.value.length + nodes > ACP_WIRE_LIMITS.nodes) throw invalid();
      for (const child of item.value)
        stack.push({ value: child, depth: item.depth + 1 });
    } else if (object(item.value)) {
      const entries = Object.entries(item.value);
      if (entries.length + nodes > ACP_WIRE_LIMITS.nodes) throw invalid();
      for (const [key, child] of entries) {
        if (/[\p{Cc}\p{Cs}]/u.test(key)) throw invalid();
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}
function raw(line: string): Record<string, unknown> {
  try {
    if (new TextEncoder().encode(line).byteLength > ACP_WIRE_LIMITS.lineBytes)
      throw invalid();
    const value: unknown = JSON.parse(line);
    if (!object(value)) throw invalid();
    bounded(value);
    return value;
  } catch {
    throw invalid();
  }
}
function encoded(value: unknown): string {
  try {
    const line = JSON.stringify(value);
    raw(line);
    return `${line}\n`;
  } catch {
    throw invalid();
  }
}

/** Native results are validated against the pending method by the session state machine. */
export function decodeAcpServerFrame(line: string): AcpServerFrame {
  const value = raw(line);
  const has = (key: string) => Object.hasOwn(value, key);
  let parsed: z.ZodSafeParseResult<AcpServerFrame>;
  if (has("method")) {
    parsed =
      value.method === "session/update"
        ? update.safeParse(value)
        : permission.safeParse(value);
  } else {
    if (has("result") === has("error")) throw invalid();
    parsed = has("result")
      ? response.safeParse(value)
      : failure.safeParse(value);
  }
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/** Closed client direction only. Authentication, files, terminal, fork and MCP are absent. */
export function encodeAcpClientRequest(input: unknown): string {
  if (!object(input)) throw invalid();
  const value = { jsonrpc: "2.0", ...input };
  const parsed =
    input.method === "session/cancel"
      ? clientCancel.safeParse(value)
      : clientRequest.safeParse(value);
  if (!parsed.success) throw invalid();
  return encoded(parsed.data);
}

/** The runtime must first prove this exact offered once-only choice belongs to its live prompt. */
export function encodeAcpPermissionReply(
  requestId: AcpRpcId,
  outcome: AcpPermissionOutcome,
): string {
  const parsedId = id.safeParse(requestId),
    parsedDecision = decision.safeParse(outcome);
  if (!parsedId.success || !parsedDecision.success) throw invalid();
  return encoded({
    jsonrpc: "2.0",
    id: parsedId.data,
    result: { outcome: parsedDecision.data },
  });
}
