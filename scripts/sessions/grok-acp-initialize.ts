import type { AcpRpcId, AcpServerFrame } from "./acp-wire";
import { z } from "zod";

const boundedNativeString = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const authId = boundedNativeString(200);
const authMethod = z
  .object({
    id: authId,
    name: boundedNativeString(500),
    description: z.string().max(2_000).nullable().optional(),
    type: z.enum(["agent", "terminal"]).optional().default("agent"),
  })
  .transform((method) => ({
    id: method.id,
    name: method.name,
    ...(method.description === undefined || method.description === null
      ? {}
      : { description: method.description }),
    type: method.type,
  }));
const authMethods = z.array(authMethod).max(64).superRefine((methods, ctx) => {
  const ids = new Set<string>();
  methods.forEach((method, index) => {
    if (ids.has(method.id))
      ctx.addIssue({ code: "custom", path: [index, "id"], message: "duplicate" });
    ids.add(method.id);
  });
});
const capabilityBoolean = z.boolean().optional().default(false);
const initializeResult = z
  .object({
    protocolVersion: z.number().int(),
    agentCapabilities: z
      .object({
        loadSession: capabilityBoolean,
        promptCapabilities: z
          .object({
            image: capabilityBoolean,
            audio: capabilityBoolean,
            embeddedContext: capabilityBoolean,
          })
          .optional()
          .default({ image: false, audio: false, embeddedContext: false }),
        mcpCapabilities: z
          .object({ http: capabilityBoolean, sse: capabilityBoolean })
          .optional()
          .default({ http: false, sse: false }),
      })
      .optional()
      .default({
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: { http: false, sse: false },
      }),
    authMethods: authMethods.optional().default([]),
  })
  .transform((result) => ({
    protocolVersion: result.protocolVersion,
    capabilities: {
      loadSession: result.agentCapabilities.loadSession,
      promptImage: result.agentCapabilities.promptCapabilities.image,
      promptAudio: result.agentCapabilities.promptCapabilities.audio,
      embeddedContext:
        result.agentCapabilities.promptCapabilities.embeddedContext,
      mcpHttp: result.agentCapabilities.mcpCapabilities.http,
      mcpSse: result.agentCapabilities.mcpCapabilities.sse,
    },
    authMethods: result.authMethods,
  }));

type ParsedInitialize = z.infer<typeof initializeResult>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type GrokAuthMethod = {
  id: string;
  name: string;
  description?: string;
  type: "agent" | "terminal";
};

export type GrokAcpCapabilities = {
  loadSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  embeddedContext: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
};

export type GrokConnectionState =
  | { kind: "not-started" }
  | { kind: "initialize-pending"; requestId: AcpRpcId }
  | {
      kind: "initialized";
      authMethods: readonly GrokAuthMethod[];
      defaultAuthMethodId: string | null;
      capabilities: GrokAcpCapabilities;
      authentication: "unknown";
      identity: "unverified";
    }
  | {
      kind: "failed-closed";
      reason:
        | "mismatched-response"
        | "unsupported-version"
        | "invalid-initialize-result";
    };

/** Private Grok initialize transition; it performs no process or auth effects. */
export function reduceGrokInitialize(
  state: GrokConnectionState,
  frame: AcpServerFrame,
): GrokConnectionState {
  if (state.kind !== "initialize-pending") return state;
  if (!("id" in frame) || frame.id !== state.requestId || "method" in frame)
    return { kind: "failed-closed", reason: "mismatched-response" };
  if ("error" in frame)
    return { kind: "failed-closed", reason: "invalid-initialize-result" };

  const parsed = initializeResult.safeParse(frame.result);
  if (!parsed.success)
    return { kind: "failed-closed", reason: "invalid-initialize-result" };
  if (parsed.data.protocolVersion !== 1)
    return { kind: "failed-closed", reason: "unsupported-version" };

  const defaultAuthMethodId = getDefaultAuthMethodId(
    frame.result,
    parsed.data,
  );
  return {
    kind: "initialized",
    authMethods: parsed.data.authMethods,
    defaultAuthMethodId,
    capabilities: parsed.data.capabilities,
    authentication: "unknown",
    identity: "unverified",
  };
}

function getDefaultAuthMethodId(
  rawResult: unknown,
  parsed: ParsedInitialize,
): string | null {
  if (!record(rawResult) || !record(rawResult._meta)) return null;
  const candidate = rawResult._meta.defaultAuthMethodId;
  if (typeof candidate !== "string" || !authId.safeParse(candidate).success)
    return null;
  return parsed.authMethods.some((method) => method.id === candidate)
    ? candidate
    : null;
}
