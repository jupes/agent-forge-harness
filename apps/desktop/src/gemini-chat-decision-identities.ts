import { z } from "zod";
import { geminiChatDecisionRequestSchema } from "../../../scripts/sessions/gemini-chat-owned-protocol";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
} from "../../../scripts/sessions/protocol";
import type { GeminiChatDecisionRequest } from "../../../types/gemini-owned-chat";

export const GEMINI_CHAT_DECISION_IDENTITIES =
  "agent-forge.gemini-chat-decision-identities.v1";
const identitySchema = geminiChatDecisionRequestSchema
  .extend({
    projectId: sessionProjectIdSchema,
    sessionId: ownedSessionIdSchema,
  })
  .strict();
const schema = z
  .object({ version: z.literal(1), records: z.array(identitySchema).max(256) })
  .strict();
export type GeminiChatDecisionIdentity = z.infer<typeof identitySchema>;
export interface GeminiChatDecisionIdentities {
  read(projectId: string, sessionId: string): GeminiChatDecisionIdentity | null;
  reserve(
    input: Omit<GeminiChatDecisionIdentity, "requestId">,
    mint: () => string,
  ): Promise<{ identity: GeminiChatDecisionIdentity; created: boolean }>;
  release(identity: GeminiChatDecisionIdentity): Promise<void>;
}
export function decisionBody(
  identity: GeminiChatDecisionIdentity,
): GeminiChatDecisionRequest {
  return geminiChatDecisionRequestSchema.parse({
    requestId: identity.requestId,
    turnRequestId: identity.turnRequestId,
    approvalId: identity.approvalId,
    optionId: identity.optionId,
  });
}
/** Metadata only, reserved before POST. No eviction, private details or native selector authority. */
export function createGeminiChatDecisionIdentities(deps: {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}): GeminiChatDecisionIdentities {
  const read = () => {
    if (!deps.storage)
      throw Error("Original approval decision storage is unavailable.");
    const text = deps.storage.getItem(GEMINI_CHAT_DECISION_IDENTITIES);
    if (text === null) return schema.parse({ version: 1, records: [] });
    if (text.length > 100_000)
      throw Error(
        "Original approval decision storage exceeds its bound. Saved data was kept.",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Original approval decisions could not be verified. Saved data was kept.",
      );
    }
    const parsed = schema.safeParse(raw);
    if (
      !parsed.success ||
      new Set(
        parsed.data.records.map(
          (item) => `${item.projectId}:${item.sessionId}`,
        ),
      ).size !== parsed.data.records.length ||
      new Set(parsed.data.records.map((item) => item.requestId)).size !==
        parsed.data.records.length
    )
      throw Error(
        "Original approval decisions conflict or use an unsupported version. Saved data was kept.",
      );
    return parsed.data;
  };
  const save = (value: z.infer<typeof schema>) => {
    const text = JSON.stringify(schema.parse(value));
    if (text.length > 100_000 || !deps.storage)
      throw Error("The original approval decision could not be saved.");
    deps.storage.setItem(GEMINI_CHAT_DECISION_IDENTITIES, text);
    if (deps.storage.getItem(GEMINI_CHAT_DECISION_IDENTITIES) !== text)
      throw Error(
        "The original approval decision could not be saved and verified.",
      );
  };
  return {
    read(projectId, sessionId) {
      return structuredClone(
        read().records.find(
          (item) =>
            item.projectId === projectId && item.sessionId === sessionId,
        ) ?? null,
      );
    },
    reserve(input, mint) {
      const copied = structuredClone(input);
      return deps.withLock(() => {
        const value = read(),
          held = value.records.find(
            (item) =>
              item.projectId === copied.projectId &&
              item.sessionId === copied.sessionId,
          );
        if (held) return { identity: structuredClone(held), created: false };
        if (value.records.length >= 256)
          throw Error(
            "Original approval decision storage is full. Uncertain decisions were kept.",
          );
        const identity = identitySchema.parse({ ...copied, requestId: mint() });
        if (value.records.some((item) => item.requestId === identity.requestId))
          throw Error(
            "The new approval decision collides with another saved original.",
          );
        save({ version: 1, records: [...value.records, identity] });
        return { identity, created: true };
      });
    },
    release(identity) {
      const expected = identitySchema.parse(identity);
      return deps.withLock(() => {
        const value = read(),
          held = value.records.find(
            (item) =>
              item.projectId === expected.projectId &&
              item.sessionId === expected.sessionId,
          );
        if (!held) return;
        if (JSON.stringify(held) !== JSON.stringify(expected))
          throw Error("A different original approval decision is still held.");
        save({
          version: 1,
          records: value.records.filter((item) => item !== held),
        });
      });
    },
  };
}
