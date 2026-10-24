import { z } from "zod";
import type {
  CodexTaskPreviewReceipt,
  CodexTaskStartReceipt,
} from "../../types/codex-owned-task";
import { conversationReceiptSchema } from "../conversations/protocol";
import {
  codexChatOwnedSessionSchema,
  codexOwnedSessionSchema,
} from "./codex-owned-metadata";
import { serializeCodexTask } from "./codex-task";
import { preparedCodexTaskSchema } from "./codex-task-runtime-protocol";
import {
  geminiChatOwnedSessionSchema,
  geminiOwnedSessionSchema,
} from "./gemini-owned-metadata";
import {
  ownedSessionSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
  sessionStartReceiptSchema,
} from "./protocol";

export const ownedCodingSessionSchema = z.union([
  ownedSessionSchema,
  codexOwnedSessionSchema,
  codexChatOwnedSessionSchema,
  geminiOwnedSessionSchema,
  geminiChatOwnedSessionSchema,
]);
const codexStartReceiptSchema = z
  .object({
    session: codexOwnedSessionSchema,
    receipt: conversationReceiptSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.session.id === value.receipt.conversationId &&
      value.session.requestId === value.receipt.turn.requestId,
  ) satisfies z.ZodType<CodexTaskStartReceipt>;
export const ownedCodingStartReceiptSchema = z.union([
  z
    .object({
      session: geminiChatOwnedSessionSchema,
      receipt: conversationReceiptSchema,
    })
    .strict()
    .refine(
      (value) =>
        value.session.id === value.receipt.conversationId &&
        value.session.requestId === value.receipt.turn.requestId,
    ),
  sessionStartReceiptSchema,
  codexStartReceiptSchema,
  z
    .object({
      session: codexChatOwnedSessionSchema,
      receipt: conversationReceiptSchema,
    })
    .strict()
    .refine(
      (value) =>
        value.session.id === value.receipt.conversationId &&
        value.session.requestId === value.receipt.turn.requestId,
    ),
  z
    .object({
      session: geminiOwnedSessionSchema,
      receipt: conversationReceiptSchema,
    })
    .strict()
    .refine(
      (value) =>
        value.session.id === value.receipt.conversationId &&
        value.session.requestId === value.receipt.turn.requestId,
    ),
]);
export const codexTaskPreviewReceiptSchema = z
  .object({
    provider: z.literal("codex"),
    projectId: sessionProjectIdSchema,
    requestId: sessionRequestIdSchema,
    snapshot: preparedCodexTaskSchema,
    serialized: z
      .object({
        argv: z.array(z.string().max(65_536)).max(256),
        stdin: z.string().max(2_097_152),
        inputFormat: z.literal("text"),
        equivalentCommand: z.string().max(65_536),
        stdinNote: z.string().max(1024),
        requiredFlags: z.array(z.string().max(100)).max(128),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      if (
        value.snapshot.launch.context?.projectId !== value.projectId ||
        value.snapshot.launch.context.worktree !== value.snapshot.cwd
      )
        throw Error("Foreign context");
      const expected = serializeCodexTask(
        value.snapshot.launch,
        value.snapshot.capabilities,
      );
      if (JSON.stringify(expected) !== JSON.stringify(value.serialized))
        throw Error("Changed preview");
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "The Codex Task preview differs from its exact private preparation.",
      });
    }
  }) satisfies z.ZodType<CodexTaskPreviewReceipt>;
