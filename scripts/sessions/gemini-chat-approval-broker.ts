import { randomUUID } from "node:crypto";
import type { GeminiChatPermissionOffer } from "../../types/gemini-chat-runtime";
import type {
  GeminiChatApprovalPage,
  GeminiChatDecisionIntent,
  GeminiChatDecisionReceipt,
  GeminiChatDecisionRequest,
  GeminiChatPrivateFrame,
} from "../../types/gemini-owned-chat";
import { ConversationError } from "../conversations/error";
import { geminiChatDecisionIntentSchema } from "./gemini-chat-owned-journal";
import {
  geminiChatApprovalSchema,
  parseGeminiChatDecision,
} from "./gemini-chat-owned-protocol";
import { privatePacketHash } from "./private-packet";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "./protocol";

type Address = { projectId: string; sessionId: string };
type Answer = { requestId: string; optionId: string | null };
type Approval = GeminiChatApprovalPage["pending"][number]["approval"];
type Live = Address & {
  turnRequestId: string;
  approval: Approval;
  signal: AbortSignal;
  persist(event: GeminiChatDecisionIntent): Promise<void>;
  resolve(value: Answer): void;
  reject(error: unknown): void;
  dispose(): void;
  pending: {
    request: GeminiChatDecisionRequest;
    result: Promise<GeminiChatDecisionReceipt>;
  } | null;
};
const sameAddress = (a: Address, b: Address) =>
  a.projectId === b.projectId && a.sessionId === b.sessionId;
const checked = (value: Address) => {
  if (
    !sessionProjectIdSchema.safeParse(value.projectId).success ||
    !ownedSessionIdSchema.safeParse(value.sessionId).success
  )
    throw new ConversationError(
      400,
      "Expected an owned project session address.",
    );
};

/** The runtime's current callback/signal is the only authority. Receipts reconcile intent only. */
export function createGeminiChatApprovalBroker(options: {
  readIntents(address: Address): readonly GeminiChatDecisionIntent[];
  onChange?(address: Address): void;
  persistenceTimeoutMs?: number;
}) {
  const live = new Map<string, Live>(),
    persistenceMs = options.persistenceTimeoutMs ?? 5000;
  let publishing = 0;
  if (
    !Number.isSafeInteger(persistenceMs) ||
    persistenceMs <= 0 ||
    persistenceMs > 30_000
  )
    throw Error("Invalid private approval save bound.");
  const changed = (address: Address) => {
    try {
      options.onChange?.(address);
    } catch {
      /* Observers own no callback. */
    }
  };
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ConversationError(
                  503,
                  "Private permission persistence was not confirmed. Its original is held.",
                ),
              ),
            persistenceMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const intents = (address: Address) =>
    options.readIntents(address).map((raw) => {
      const parsed = geminiChatDecisionIntentSchema.safeParse(raw);
      if (!parsed.success || !sameAddress(address, parsed.data.receipt))
        throw new ConversationError(
          503,
          "The private Gemini permission history could not be verified. It has been kept.",
        );
      const {
        projectId,
        sessionId,
        requestId,
        turnRequestId,
        approvalId,
        optionId,
      } = parsed.data.receipt;
      if (
        parsed.data.requestHash !==
        privatePacketHash({
          projectId,
          sessionId,
          requestId,
          turnRequestId,
          approvalId,
          optionId,
        })
      )
        throw new ConversationError(
          503,
          "The saved permission intent hash could not be verified. It has been kept.",
        );
      return parsed.data;
    });
  return {
    async offer(
      input: Address & {
        turnRequestId: string;
        offer: Readonly<GeminiChatPermissionOffer>;
        signal: AbortSignal;
        persist(
          event: GeminiChatDecisionIntent | GeminiChatPrivateFrame,
        ): Promise<void>;
      },
    ): Promise<Answer> {
      checked(input);
      const native = structuredClone(input.offer);
      if (
        input.signal.aborted ||
        native.requestId !== input.turnRequestId ||
        !sessionRequestIdSchema.safeParse(input.turnRequestId).success ||
        live.size + publishing >= 128
      )
        throw new ConversationError(
          409,
          "This Gemini permission has no live accepted owner.",
        );
      const approval = geminiChatApprovalSchema.parse({
        id: randomUUID(),
        detail: native.detail,
        detailsComplete: native.detailsComplete,
        options: native.options,
      });
      // Persist opaque identity before exposing any action. A late save cannot revive an aborted callback.
      publishing++;
      try {
        await bounded(() =>
          input.persist({
            kind: "coding-gemini-chat",
            provider: "gemini",
            version: "0.65.0",
            event: {
              kind: "approval-offer",
              id: approval.id,
              requestId: input.turnRequestId,
              rpcId: native.rpcId,
              toolCallId: native.toolCallId,
            },
          }),
        );
      } finally {
        publishing--;
      }
      if (input.signal.aborted)
        throw new ConversationError(
          409,
          "This Gemini permission is no longer live.",
        );
      return new Promise<Answer>((resolve, reject) => {
        const invalidate = () => {
          entry.dispose();
          reject(
            new ConversationError(
              409,
              "This native Gemini permission is no longer live.",
            ),
          );
        };
        const entry: Live = {
          ...input,
          approval,
          pending: null,
          resolve,
          reject,
          dispose() {
            input.signal.removeEventListener("abort", invalidate);
            if (live.get(approval.id) === entry) live.delete(approval.id);
            changed(input);
          },
        };
        live.set(approval.id, entry);
        input.signal.addEventListener("abort", invalidate, { once: true });
        if (input.signal.aborted) invalidate();
        else changed(input);
      });
    },
    async decide(
      address: Address,
      raw: GeminiChatDecisionRequest,
    ): Promise<GeminiChatDecisionReceipt> {
      checked(address);
      const request = parseGeminiChatDecision(raw),
        hash = privatePacketHash({ ...address, ...request });
      const saved = intents(address),
        previous = saved.find(
          (item) => item.receipt.requestId === request.requestId,
        );
      if (previous) {
        if (previous.requestHash !== hash)
          throw new ConversationError(
            409,
            "This decision UUID already names different content or scope.",
          );
        return structuredClone(previous.receipt);
      }
      if (saved.some((item) => item.receipt.approvalId === request.approvalId))
        throw new ConversationError(
          409,
          "This permission already has recorded intent. It was not answered again.",
        );
      const pendingId = [...live.values()].find(
        (entry) =>
          sameAddress(entry, address) &&
          entry.pending?.request.requestId === request.requestId,
      );
      if (
        pendingId?.pending &&
        privatePacketHash(pendingId.pending.request) !==
          privatePacketHash(request)
      )
        throw new ConversationError(
          409,
          "This decision UUID already names different content in progress.",
        );
      const entry = live.get(request.approvalId);
      if (
        !entry ||
        !sameAddress(entry, address) ||
        entry.turnRequestId !== request.turnRequestId ||
        entry.signal.aborted
      )
        throw new ConversationError(
          409,
          "This permission has no matching live accepted turn. History cannot answer it.",
        );
      if (
        request.optionId !== null &&
        !entry.approval.options.some(
          (item) => item.optionId === request.optionId,
        )
      )
        throw new ConversationError(
          409,
          "The native permission did not offer that one-time option.",
        );
      if (entry.pending) {
        if (
          privatePacketHash(entry.pending.request) !==
          privatePacketHash(request)
        )
          throw new ConversationError(
            409,
            "This permission already has different intent in progress.",
          );
        return entry.pending.result;
      }
      const receipt: GeminiChatDecisionReceipt = {
        ...request,
        ...address,
        state: "recorded",
        recordedAt: new Date().toISOString(),
      };
      const event: GeminiChatDecisionIntent = {
        kind: "coding-gemini-chat-decision",
        provider: "gemini",
        version: "0.65.0",
        requestHash: hash,
        receipt,
      };
      // Reserve synchronously before the first await so only one callback can be released.
      const result = bounded(async () => {
        await entry.persist(structuredClone(event));
        return structuredClone(receipt);
      });
      entry.pending = { request, result };
      changed(address);
      try {
        const confirmed = await result;
        if (live.get(request.approvalId) === entry && !entry.signal.aborted) {
          entry.dispose();
          entry.resolve({
            requestId: request.requestId,
            optionId: request.optionId,
          });
        }
        return confirmed;
      } catch {
        entry.dispose();
        entry.reject(
          new ConversationError(
            503,
            "The decision intent is uncertain. No callback was released.",
          ),
        );
        throw new ConversationError(
          503,
          "The decision intent is uncertain. Read the original before doing anything else.",
        );
      }
    },
    read(address: Address, requestId?: string): GeminiChatApprovalPage {
      checked(address);
      if (
        requestId !== undefined &&
        !sessionRequestIdSchema.safeParse(requestId).success
      )
        throw new ConversationError(
          400,
          "Expected the original decision UUID.",
        );
      const saved = intents(address);
      return {
        pending:
          requestId === undefined
            ? [...live.values()]
                .filter(
                  (entry) =>
                    sameAddress(entry, address) &&
                    !entry.pending &&
                    !entry.signal.aborted,
                )
                .map((entry) => ({
                  turnRequestId: entry.turnRequestId,
                  actionable: true,
                  approval: structuredClone(entry.approval),
                }))
            : [],
        receipt: requestId
          ? structuredClone(
              saved.find((item) => item.receipt.requestId === requestId)
                ?.receipt ?? null,
            )
          : null,
      };
    },
  };
}
