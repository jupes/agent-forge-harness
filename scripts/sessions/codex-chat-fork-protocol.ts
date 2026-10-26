/** Strict app-owned Fork intent and durable-record protocol; no provider effect. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  CodexChatForkCapture,
  CodexChatForkHeldReason,
  CodexChatForkIntent,
  CodexChatForkLink,
  CodexChatForkOriginal,
  CodexChatForkOriginalBase,
  CodexChatForkOriginalRef,
  CodexChatForkSourceSeal,
} from "../../types/codex-chat-fork";
import { workspaceKey } from "../projects/scope";
import {
  CODEX_CHAT_FORK_PROTOCOL_VERSION,
  codexChatForkOriginSchema,
} from "./codex-chat-fork-origin-protocol";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./protocol";

export { CODEX_CHAT_FORK_PROTOCOL_VERSION, codexChatForkOriginSchema };
export const CODEX_CHAT_FORK_HASH_VERSION = 1 as const;
export const CODEX_CHAT_FORK_DOMAIN = "agent-forge.codex-chat-fork.original.v1";
export const CODEX_CHAT_FORK_ZERO_HASH = "0".repeat(64);
export const CODEX_CHAT_FORK_LIMITS = Object.freeze({
  originals: 500,
  events: 2_000,
  eventBytes: 4_096,
  journalBytes: 8_388_608,
});

const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const workspaceKeySchema = boundedText(1_024).refine(
  (value) =>
    (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) &&
    workspaceKey(value) === value,
);
const nativeUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime();

export const codexChatForkIntentSchema: z.ZodType<CodexChatForkIntent> = z
  .object({
    requestId: sessionRequestIdSchema,
    throughTurnRequestId: sessionRequestIdSchema,
  })
  .strict();

export const codexChatForkOriginalHashInputSchema = z
  .object({
    kind: z.literal("codex-chat-fork"),
    hashVersion: z.literal(CODEX_CHAT_FORK_HASH_VERSION),
    projectId: sessionProjectIdSchema,
    workspaceKey: workspaceKeySchema,
    parentSessionId: ownedSessionIdSchema,
    throughTurnRequestId: sessionRequestIdSchema,
    requestId: sessionRequestIdSchema,
    protocolVersion: z.literal(CODEX_CHAT_FORK_PROTOCOL_VERSION),
  })
  .strict();
export type CodexChatForkOriginalHashInput = z.infer<
  typeof codexChatForkOriginalHashInputSchema
>;

export const codexChatForkCaptureSchema: z.ZodType<CodexChatForkCapture> = z
  .object({
    parentNativeThreadId: nativeUuidSchema,
    childNativeThreadId: nativeUuidSchema,
    throughNativeTurnId: nativeUuidSchema,
    protocolVersion: z.literal(CODEX_CHAT_FORK_PROTOCOL_VERSION),
  })
  .strict();
export const codexChatForkSourceSealSchema: z.ZodType<CodexChatForkSourceSeal> =
  z
    .object({
      parentRequestHash: hashSchema,
      parentTurnHash: hashSchema,
      parentNativeThreadId: nativeUuidSchema,
      throughNativeTurnId: nativeUuidSchema,
      sourceSettingsHash: hashSchema,
    })
    .strict();
export const codexChatForkLinkSchema: z.ZodType<CodexChatForkLink> = z
  .object({
    childAppSessionId: ownedSessionIdSchema,
    childRequestId: sessionRequestIdSchema,
    childRequestHash: hashSchema,
    captureHash: hashSchema,
  })
  .strict();

const baseRecordSchema = z
  .object({
    projectId: sessionProjectIdSchema,
    workspaceKey: workspaceKeySchema,
    requestId: sessionRequestIdSchema,
    requestHash: hashSchema,
    parentSessionId: ownedSessionIdSchema,
    throughTurnRequestId: sessionRequestIdSchema,
    protocolVersion: z.literal(CODEX_CHAT_FORK_PROTOCOL_VERSION),
    childAppSessionId: ownedSessionIdSchema,
    sourceSeal: codexChatForkSourceSealSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const codexChatForkOriginalSchema: z.ZodType<CodexChatForkOriginal> =
  z.discriminatedUnion("state", [
    baseRecordSchema.extend({ state: z.literal("reserved") }).strict(),
    baseRecordSchema.extend({ state: z.literal("attempted") }).strict(),
    baseRecordSchema
      .extend({
        state: z.literal("captured"),
        capture: codexChatForkCaptureSchema,
      })
      .strict(),
    baseRecordSchema
      .extend({
        state: z.literal("linked"),
        capture: codexChatForkCaptureSchema,
        link: codexChatForkLinkSchema,
      })
      .strict(),
    baseRecordSchema
      .extend({
        state: z.literal("held"),
        heldReason: z.enum([
          "unknown-native-outcome",
          "invalid-native-outcome",
        ]),
      })
      .strict(),
  ]);

export const codexChatForkOriginalRefSchema: z.ZodType<CodexChatForkOriginalRef> =
  z
    .object({
      projectId: sessionProjectIdSchema,
      workspaceKey: workspaceKeySchema,
      requestId: sessionRequestIdSchema,
      requestHash: hashSchema,
      parentSessionId: ownedSessionIdSchema,
      throughTurnRequestId: sessionRequestIdSchema,
      protocolVersion: z.literal(CODEX_CHAT_FORK_PROTOCOL_VERSION),
      childAppSessionId: ownedSessionIdSchema,
      sourceSeal: codexChatForkSourceSealSchema.optional(),
    })
    .strict();
export const codexChatForkHeldReasonSchema: z.ZodType<CodexChatForkHeldReason> =
  z.enum(["unknown-native-outcome", "invalid-native-outcome"]);

/** Rebuilds the exact domain object so caller object-key order never affects bytes. */
export function canonicalCodexChatForkOriginal(raw: unknown): string {
  const value = codexChatForkOriginalHashInputSchema.parse(raw);
  return JSON.stringify({
    kind: value.kind,
    hashVersion: value.hashVersion,
    projectId: value.projectId,
    workspaceKey: value.workspaceKey,
    parentSessionId: value.parentSessionId,
    throughTurnRequestId: value.throughTurnRequestId,
    requestId: value.requestId,
    protocolVersion: value.protocolVersion,
  });
}

export function codexChatForkOriginalHash(raw: unknown): string {
  const canonical = canonicalCodexChatForkOriginal(raw);
  return createHash("sha256")
    .update(`${CODEX_CHAT_FORK_DOMAIN}\0${canonical}`, "utf8")
    .digest("hex");
}

export function codexChatForkOriginalHashInput(
  input: Omit<CodexChatForkOriginalHashInput, "kind" | "hashVersion">,
): CodexChatForkOriginalHashInput {
  return codexChatForkOriginalHashInputSchema.parse({
    kind: "codex-chat-fork",
    hashVersion: CODEX_CHAT_FORK_HASH_VERSION,
    ...input,
  });
}

export function codexChatForkCaptureHash(raw: unknown): string {
  const capture = codexChatForkCaptureSchema.parse(raw);
  return createHash("sha256")
    .update(JSON.stringify(orderedCapture(capture)), "utf8")
    .digest("hex");
}

export function codexChatForkSourceSettingsHash(raw: {
  modelProvider: string;
  serviceTier: string | null;
  reasoningEffort: string | null;
}): string {
  const settings = z
    .object({
      modelProvider: boundedText(256),
      serviceTier: boundedText(256).nullable(),
      reasoningEffort: boundedText(256).nullable(),
    })
    .strict()
    .parse(raw);
  return createHash("sha256")
    .update(
      `agent-forge.codex-chat-fork.source-settings.v1\0${JSON.stringify({
        modelProvider: settings.modelProvider,
        serviceTier: settings.serviceTier,
        reasoningEffort: settings.reasoningEffort,
      })}`,
      "utf8",
    )
    .digest("hex");
}

function orderedCapture(value: CodexChatForkCapture): CodexChatForkCapture {
  return {
    parentNativeThreadId: value.parentNativeThreadId,
    childNativeThreadId: value.childNativeThreadId,
    throughNativeTurnId: value.throughNativeTurnId,
    protocolVersion: value.protocolVersion,
  };
}

function orderedLink(value: CodexChatForkLink): CodexChatForkLink {
  return {
    childAppSessionId: value.childAppSessionId,
    childRequestId: value.childRequestId,
    childRequestHash: value.childRequestHash,
    captureHash: value.captureHash,
  };
}

function orderedRecord(value: CodexChatForkOriginal): CodexChatForkOriginal {
  const base: CodexChatForkOriginalBase = {
    projectId: value.projectId,
    workspaceKey: value.workspaceKey,
    requestId: value.requestId,
    requestHash: value.requestHash,
    parentSessionId: value.parentSessionId,
    throughTurnRequestId: value.throughTurnRequestId,
    protocolVersion: value.protocolVersion,
    childAppSessionId: value.childAppSessionId,
    ...(value.sourceSeal === undefined ? {} : { sourceSeal: value.sourceSeal }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.state === "reserved" || value.state === "attempted")
    return { ...base, state: value.state };
  if (value.state === "captured")
    return {
      ...base,
      state: value.state,
      capture: orderedCapture(value.capture),
    };
  if (value.state === "linked")
    return {
      ...base,
      state: value.state,
      capture: orderedCapture(value.capture),
      link: orderedLink(value.link),
    };
  if (value.state === "held")
    return { ...base, state: value.state, heldReason: value.heldReason };
  throw new Error("Expected a strict Codex Fork original state.");
}

export function canonicalCodexChatForkOriginalRecord(raw: unknown): string {
  const value = codexChatForkOriginalSchema.parse(raw);
  return JSON.stringify(orderedRecord(value));
}

export function canonicalCodexChatForkCapture(raw: unknown): string {
  const value = codexChatForkCaptureSchema.parse(raw);
  return JSON.stringify(orderedCapture(value));
}

export function canonicalCodexChatForkLink(raw: unknown): string {
  const value = codexChatForkLinkSchema.parse(raw);
  return JSON.stringify(orderedLink(value));
}

export interface CodexChatForkJournalEventBody {
  version: 1;
  sequence: number;
  previousEventHash: string;
  previousOperationHash: string | null;
  transition: CodexChatForkOriginal["state"];
  record: CodexChatForkOriginal;
}
export type CodexChatForkJournalEvent = CodexChatForkJournalEventBody & {
  eventHash: string;
};

const journalEventFieldsSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().min(1).max(CODEX_CHAT_FORK_LIMITS.events),
  previousEventHash: hashSchema,
  previousOperationHash: hashSchema.nullable(),
  transition: z.enum(["reserved", "attempted", "captured", "linked", "held"]),
  record: codexChatForkOriginalSchema,
});
export const codexChatForkJournalEventBodySchema: z.ZodType<CodexChatForkJournalEventBody> =
  journalEventFieldsSchema
    .strict()
    .refine((value) => value.transition === value.record.state);
export const codexChatForkJournalEventSchema: z.ZodType<CodexChatForkJournalEvent> =
  journalEventFieldsSchema
    .extend({ eventHash: hashSchema })
    .strict()
    .refine((value) => value.transition === value.record.state);

export function canonicalCodexChatForkJournalEvent(raw: unknown): string {
  const event = codexChatForkJournalEventSchema.parse(raw);
  const body: CodexChatForkJournalEventBody = {
    version: event.version,
    sequence: event.sequence,
    previousEventHash: event.previousEventHash,
    previousOperationHash: event.previousOperationHash,
    transition: event.transition,
    record: orderedRecord(event.record),
  };
  const eventHash = createHash("sha256")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  if (eventHash !== event.eventHash)
    throw new Error("The private Codex Fork event hash is invalid.");
  return JSON.stringify({ ...body, eventHash: event.eventHash });
}

export function codexChatForkJournalEventHash(
  body: CodexChatForkJournalEventBody,
): string {
  const parsed = codexChatForkJournalEventBodySchema.parse(body);
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: parsed.version,
        sequence: parsed.sequence,
        previousEventHash: parsed.previousEventHash,
        previousOperationHash: parsed.previousOperationHash,
        transition: parsed.transition,
        record: orderedRecord(parsed.record),
      }),
      "utf8",
    )
    .digest("hex");
}
