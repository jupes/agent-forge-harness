import type {
  CodexChatApproval,
  CodexChatDecision,
} from "../../types/codex-chat";
import type {
  CodexChatApprovalPage,
  CodexChatDecisionIntent,
  CodexChatDecisionReceipt,
  CodexChatDecisionRequest,
} from "../../types/codex-owned-chat";
import { ConversationError } from "../conversations/error";
import { CODEX_APP_SERVER_VERSION } from "./codex-app-server-protocol";
import {
  codexChatApprovalSchema,
  codexChatDecisionIntentSchema,
} from "./codex-chat-owned-journal";
import {
  CODEX_FILE_DETAILS_UNAVAILABLE,
  parseCodexChatDecision,
} from "./codex-chat-owned-protocol";
import { privatePacketHash } from "./private-packet";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "./protocol";

type Address = { projectId: string; sessionId: string };
type Live = Address & {
  turnRequestId: string;
  approval: CodexChatApproval;
  version: string;
  signal: AbortSignal;
  persist(event: CodexChatDecisionIntent): Promise<void>;
  resolve(value: CodexChatDecision): void;
  reject(error: unknown): void;
  dispose(): void;
  pending: {
    request: CodexChatDecisionRequest;
    result: Promise<CodexChatDecisionReceipt>;
  } | null;
};
const sameAddress = (left: Address, right: Address) =>
  left.projectId === right.projectId && left.sessionId === right.sessionId;
const checkedAddress = (value: Address) => {
  if (
    !sessionProjectIdSchema.safeParse(value.projectId).success ||
    !ownedSessionIdSchema.safeParse(value.sessionId).success
  )
    throw new ConversationError(
      400,
      "Expected an owned project session address.",
    );
};

/** A live callback is authority. Saved history only reconciles an immutable intent receipt. */
export function createCodexChatApprovalBroker(options: {
  readIntents(address: Address): readonly CodexChatDecisionIntent[];
  onChange?(address: Address): void;
  persistenceTimeoutMs?: number;
  approvalTimeoutMs?: number;
}) {
  const live = new Map<string, Live>();
  const persistenceMs = options.persistenceTimeoutMs ?? 5000,
    approvalMs = options.approvalTimeoutMs ?? 120_000;
  if (
    ![persistenceMs, approvalMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    persistenceMs > 30_000 ||
    approvalMs > 300_000
  )
    throw new Error("Invalid owned approval deadlines.");
  const changed = (address: Address) => {
    try {
      options.onChange?.(address);
    } catch {
      /* An observer cannot repeat a decision. */
    }
  };
  const intents = (address: Address) =>
    options.readIntents(address).map((raw) => {
      const parsed = codexChatDecisionIntentSchema.safeParse(raw);
      if (!parsed.success || !sameAddress(address, parsed.data.receipt))
        throw new ConversationError(
          503,
          "The private approval history could not be verified. It has been kept.",
        );
      const {
        projectId,
        sessionId,
        requestId,
        turnRequestId,
        approvalId,
        decision,
      } = parsed.data.receipt;
      if (
        parsed.data.requestHash !==
        privatePacketHash({
          projectId,
          sessionId,
          requestId,
          turnRequestId,
          approvalId,
          decision,
        })
      )
        throw new ConversationError(
          503,
          "The private approval intent hash could not be verified. Its history has been kept.",
        );
      return parsed.data;
    });
  return {
    offer(
      input: Address & {
        turnRequestId: string;
        approval: Readonly<CodexChatApproval>;
        version: string;
        signal: AbortSignal;
        persist(event: CodexChatDecisionIntent): Promise<void>;
      },
    ): Promise<CodexChatDecision> {
      checkedAddress(input);
      const approval = codexChatApprovalSchema.parse(
        structuredClone(input.approval),
      );
      if (approval.kind === "file-change")
        approval.availableDecisions = approval.availableDecisions.filter(
          (decision) => decision !== "accept",
        );
      if (
        input.version !== CODEX_APP_SERVER_VERSION ||
        !sessionRequestIdSchema.safeParse(input.turnRequestId).success ||
        input.signal.aborted ||
        approval.availableDecisions.length === 0 ||
        live.has(approval.id) ||
        live.size >= 128
      )
        return Promise.reject(
          new ConversationError(
            409,
            "This approval has no available live owner.",
          ),
        );
      return new Promise((resolve, reject) => {
        const invalidate = () => {
          entry.dispose();
          reject(
            new ConversationError(
              409,
              "This native approval is no longer live.",
            ),
          );
        };
        const timer = setTimeout(invalidate, approvalMs);
        const entry: Live = {
          ...input,
          approval,
          pending: null,
          resolve,
          reject,
          dispose() {
            clearTimeout(timer);
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
      raw: CodexChatDecisionRequest,
    ): Promise<CodexChatDecisionReceipt> {
      checkedAddress(address);
      const request = parseCodexChatDecision(raw),
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
          "This approval already has a recorded decision intent. It was not answered again.",
        );
      const pendingId = [...live.values()].find(
        (candidate) =>
          sameAddress(candidate, address) &&
          candidate.pending?.request.requestId === request.requestId,
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
          "This approval has no matching live accepted turn. History cannot answer it.",
        );
      if (!entry.approval.availableDecisions.includes(request.decision))
        throw new ConversationError(
          409,
          "This native approval did not offer that decision.",
        );
      if (entry.pending) {
        if (
          privatePacketHash(entry.pending.request) !==
          privatePacketHash(request)
        )
          throw new ConversationError(
            409,
            "This approval already has a different decision in progress.",
          );
        return entry.pending.result;
      }
      const receipt: CodexChatDecisionReceipt = {
        ...request,
        ...address,
        state: "recorded",
        recordedAt: new Date().toISOString(),
      };
      const event: CodexChatDecisionIntent = {
        kind: "coding-chat-decision",
        provider: "codex",
        version: entry.version,
        requestHash: hash,
        receipt,
      };
      // Reserve synchronously before yielding to persistence; concurrent decisions cannot both pass.
      let execute: () => void = () => {};
      const result = new Promise<CodexChatDecisionReceipt>(
        (resolve, reject) => {
          execute = () => {
            const timer = setTimeout(
              () =>
                reject(
                  new ConversationError(
                    503,
                    "Approval intent persistence was not confirmed. Read the original decision; it will not be resent.",
                  ),
                ),
              persistenceMs,
            );
            Promise.resolve()
              .then(() => entry.persist(structuredClone(event)))
              .then(
                () => {
                  clearTimeout(timer);
                  resolve(structuredClone(receipt));
                },
                (error: unknown) => {
                  clearTimeout(timer);
                  reject(error);
                },
              );
          };
        },
      );
      entry.pending = { request, result };
      changed(address);
      execute();
      try {
        const confirmed = await result;
        if (live.get(request.approvalId) === entry && !entry.signal.aborted) {
          entry.dispose();
          entry.resolve(request.decision);
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
          "The decision intent is uncertain. Read the original request before doing anything else.",
        );
      }
    },
    read(address: Address, requestId?: string): CodexChatApprovalPage {
      checkedAddress(address);
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
        pending: [...live.values()]
          .filter(
            (entry) =>
              sameAddress(entry, address) &&
              !entry.pending &&
              !entry.signal.aborted,
          )
          .map((entry) => {
            const { id, kind, command, cwd, reason, availableDecisions } =
              entry.approval;
            return {
              turnRequestId: entry.turnRequestId,
              actionable: true,
              detailsUnavailableReason:
                kind === "file-change" ? CODEX_FILE_DETAILS_UNAVAILABLE : null,
              approval: {
                id,
                kind,
                command,
                cwd,
                reason,
                availableDecisions: [...availableDecisions],
              },
            };
          }),
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
